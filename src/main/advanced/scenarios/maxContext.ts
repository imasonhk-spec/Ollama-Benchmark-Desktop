/**
 * Scenario C — Maximum context probe (plan section "场景 C").
 *
 * Input length climbs 1K → 128K at low concurrency with a tiny output budget.
 * The first failure (413 / context_length_exceeded / timeout / 5xx) records the
 * critical point and stops the sweep — probing beyond it only wastes minutes.
 */

import type {
  AdvancedRunConfig,
  ContextProbePoint,
  MaxContextScenarioResult,
  ScenarioRequestOutcome,
} from "../../../shared/AdvancedScenarios";
import { buildFillerPrompt } from "../AdvancedFiller";
import { mean, prefillTps, successful } from "../AdvancedStats";
import type { ScenarioClient } from "../ScenarioClient";

export type MaxContextScenarioDeps = {
  client: ScenarioClient;
  config: AdvancedRunConfig;
  signal?: AbortSignal;
  onPoint?: (point: ContextProbePoint) => void;
};

function summarizePoint(inputTokens: number, outcomes: ScenarioRequestOutcome[]): ContextProbePoint {
  const ok = successful(outcomes);
  // The plan requires ≥99% success; at these tiny sample sizes any failure counts.
  if (!ok.length) {
    const failure = outcomes.find((outcome) => !outcome.ok);
    return {
      inputTokens,
      ok: false,
      errorKind: failure?.errorKind ?? "unknown",
      errorMessage: failure?.errorMessage ?? "所有请求均失败",
    };
  }
  const point: ContextProbePoint = {
    inputTokens,
    ok: ok.length === outcomes.length,
    ttftMs: mean(ok.flatMap((outcome) => (outcome.ttftMs === undefined ? [] : [outcome.ttftMs]))),
    e2eMs: mean(ok.flatMap((outcome) => (outcome.e2eMs === undefined ? [] : [outcome.e2eMs]))),
    prefillTps: mean(ok.flatMap((outcome) => { const value = prefillTps(outcome); return value === undefined ? [] : [value]; })),
    actualInputTokens: mean(ok.flatMap((outcome) => (outcome.inputTokens === undefined ? [] : [outcome.inputTokens]))),
  };
  if (!point.ok) {
    const failure = outcomes.find((outcome) => !outcome.ok);
    point.errorKind = failure?.errorKind ?? "unknown";
    point.errorMessage = failure?.errorMessage;
  }
  return point;
}

export async function runMaxContextScenario(deps: MaxContextScenarioDeps): Promise<MaxContextScenarioResult> {
  const { client, config, signal } = deps;
  const settings = config.maxContext;
  const levels = [...settings.levels].sort((a, b) => a - b);
  const points: ContextProbePoint[] = [];
  let limitTokens: number | undefined;
  let firstFailTokens: number | undefined;

  for (const [levelIndex, inputTokens] of levels.entries()) {
    if (signal?.aborted) break;
    const outcomes = await Promise.all(
      Array.from({ length: Math.max(1, settings.concurrency) }, (_, worker) =>
        client.execute({
          model: config.model,
          prompt: buildFillerPrompt(config.seed + levelIndex * 977 + worker * 7, inputTokens),
          maxOutputTokens: settings.maxOutputTokens,
          temperature: 0,
          timeoutMs: settings.requestTimeoutMs,
          // The context window must cover prompt + output or Ollama silently truncates.
          numCtx: inputTokens + settings.maxOutputTokens + 512,
          signal,
        }),
      ),
    );
    const point = summarizePoint(inputTokens, outcomes);
    points.push(point);
    deps.onPoint?.(point);
    if (point.ok) {
      limitTokens = inputTokens;
    } else {
      firstFailTokens = inputTokens;
      break;
    }
  }

  return { points, limitTokens, firstFailTokens };
}
