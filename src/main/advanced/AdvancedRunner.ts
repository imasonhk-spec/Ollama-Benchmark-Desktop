/**
 * Advanced evaluation orchestrator.
 *
 * Owns the end-to-end flow for one model: build the `ScenarioClient`, walk the
 * scenarios selected in `AdvancedRunConfig.scenarios` in order, reuse the
 * concurrency samples for fairness, run stability at 50% of the confirmed
 * maximum, accumulate every request outcome for degradation analysis, and
 * assemble a single `AdvancedRunResult`.
 *
 * The module is transport-agnostic: it takes a `StreamingTransport` (the
 * structural subset of `SshSession.requestStreamLines` the scenarios need), so
 * it is fully unit-testable with an in-memory fake and is reused verbatim by
 * the IPC layer added in the main-process integration step.
 */

import {
  ADVANCED_PLAN_VERSION,
  ADVANCED_SCENARIO_LABELS,
  type AdvancedRunConfig,
  type AdvancedRunResult,
  type AdvancedScenario,
  type ScenarioRequestOutcome,
} from "../../shared/AdvancedScenarios";
import type { AdvancedProgress } from "../../shared/ipc";
import type { OllamaEnvironment } from "../../shared/types";
import { ScenarioClient, type StreamingTransport } from "./ScenarioClient";
import { runLatencyScenario } from "./scenarios/latency";
import { runConcurrencyScenario } from "./scenarios/concurrency";
import { runMaxContextScenario } from "./scenarios/maxContext";
import { runStabilityScenario } from "./scenarios/stability";
import { runFairnessScenario } from "./scenarios/fairness";
import { runNeedleScenario } from "./scenarios/needle";
import { buildDegradationReport } from "./diff";

export type AdvancedRunDeps = {
  transport: StreamingTransport;
  environment: OllamaEnvironment;
  config: AdvancedRunConfig;
  signal?: AbortSignal;
  now?: () => number;
  onProgress?: (progress: AdvancedProgress) => void;
  onLog?: (message: string) => void;
};

function formatLatency(value: number | undefined): string {
  return value === undefined ? "-" : `${(value / 1_000).toFixed(2)}s`;
}

/**
 * Runs the full advanced evaluation plan for one model. Never throws for a
 * per-scenario failure: each scenario is isolated, errors are recorded in
 * `result.errors`, and the run still produces a complete result object.
 */
export async function runAdvanced(deps: AdvancedRunDeps): Promise<AdvancedRunResult> {
  const { transport, environment, config, signal } = deps;
  const now = deps.now ?? (() => Date.now());
  const client = new ScenarioClient(transport, environment, now);
  const startedAt = new Date(now()).toISOString();

  const errors: string[] = [];
  const allOutcomes: ScenarioRequestOutcome[] = [];

  const result: AdvancedRunResult = {
    startedAt,
    finishedAt: startedAt,
    cancelled: false,
    planVersion: ADVANCED_PLAN_VERSION,
    config,
    environment,
    errors,
  };

  const emit = (progress: AdvancedProgress): void => {
    deps.onProgress?.(progress);
  };
  const log = (scenario: AdvancedScenario, message: string): void => {
    deps.onLog?.(message);
    emit({ scenario, label: ADVANCED_SCENARIO_LABELS[scenario], stage: "progress", message });
  };
  const collect = (outcome: ScenarioRequestOutcome): void => {
    allOutcomes.push(outcome);
  };

  const total = config.scenarios.length;
  for (let index = 0; index < total; index += 1) {
    const scenario = config.scenarios[index];
    if (signal?.aborted) break;

    emit({ scenario, label: ADVANCED_SCENARIO_LABELS[scenario], stage: "start", index: index + 1, total });
    try {
      switch (scenario) {
        case "latency": {
          const comboCount = config.latency.combos.length;
          const perCombo = config.latency.repeat;
          const totalUnits = comboCount * perCombo;
          let done = 0;
          result.latency = await runLatencyScenario({
            client,
            config,
            signal,
            onOutcome: (outcome) => {
              collect(outcome);
              done += 1;
              emit({
                scenario,
                label: ADVANCED_SCENARIO_LABELS[scenario],
                stage: "progress",
                message: `组合 ${done}/${totalUnits}`,
                current: done,
                totalUnits,
              });
            },
          });
          break;
        }
        case "concurrency": {
          result.concurrency = await runConcurrencyScenario({
            client,
            config,
            signal,
            now,
            onLevel: (level) =>
              log(
                "concurrency",
                `并发 ${level.concurrency}：成功率 ${level.successRatePercent.toFixed(1)}%，P95 ${formatLatency(level.p95E2eMs)}，判定 ${level.verdict.passed ? "通过" : "不通过"}`,
              ),
            onLog: (message) => log("concurrency", message),
          });
          break;
        }
        case "max-context": {
          result.maxContext = await runMaxContextScenario({
            client,
            config,
            signal,
            onPoint: (point) =>
              log("max-context", `输入 ${point.inputTokens.toLocaleString("en-US")} tok：${point.ok ? "通过" : `失败（${point.errorKind ?? "未知"}）`}`),
          });
          break;
        }
        case "stability": {
          // Plan section 5: stability runs at 50% of the confirmed maximum.
          const concurrencyOverride = result.concurrency?.recommendedConcurrency;
          result.stability = await runStabilityScenario({
            client,
            config,
            signal,
            now,
            concurrencyOverride,
            onBucket: (bucket) =>
              log("stability", `桶 ${bucket.index}（${bucket.startSeconds}s）：P95 ${formatLatency(bucket.p95E2eMs)}`),
          });
          break;
        }
        case "fairness": {
          // Pure post-processing over the concurrency latencies (no network).
          result.fairness = runFairnessScenario(result.concurrency);
          break;
        }
        case "needle": {
          result.needle = await runNeedleScenario({
            client,
            config,
            signal,
            onPoint: (point) =>
              log(
                "needle",
                `长度 ${point.lengthTokens.toLocaleString("en-US")} / 深度 ${point.depthPercent}%：${point.correct ? "命中" : point.answered ? "答错" : "无响应"}`,
              ),
          });
          break;
        }
        default: {
          log(scenario, "未识别的场景，已跳过");
          break;
        }
      }
      emit({ scenario, label: ADVANCED_SCENARIO_LABELS[scenario], stage: "done", index: index + 1, total });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`[${scenario}] ${message}`);
      log(scenario, `场景异常：${message}`);
    }
  }

  // Degradation is computed over every captured request outcome, regardless of
  // which scenarios actually ran, so a partial plan still yields a signal.
  result.degradation = buildDegradationReport(allOutcomes);
  result.finishedAt = new Date(now()).toISOString();
  result.cancelled = Boolean(signal?.aborted);
  return result;
}
