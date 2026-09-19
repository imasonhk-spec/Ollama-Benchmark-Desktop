/**
 * Scenario A — Latency baseline (plan section "场景 A").
 *
 * Fixed parallel=1, sweeping the input×output matrix. Produces the single-request
 * floor for TTFT / E2E / TPOT / ITL / decode / prefill that every other scenario
 * is compared against.
 */

import type {
  AdvancedRunConfig,
  LatencyComboResult,
  LatencyScenarioResult,
  ScenarioRequestOutcome,
} from "../../../shared/AdvancedScenarios";
import { buildFillerPrompt } from "../AdvancedFiller";
import {
  averageDerived,
  decodeTps,
  errorBreakdown,
  itlMs,
  latenciesMs,
  mean,
  overallTps,
  percentile,
  prefillTps,
  successful,
  tpotMs,
  ttftsMs,
} from "../AdvancedStats";
import type { ScenarioClient } from "../ScenarioClient";

export type LatencyScenarioDeps = {
  client: ScenarioClient;
  config: AdvancedRunConfig;
  signal?: AbortSignal;
  onOutcome?: (outcome: ScenarioRequestOutcome, context: { inputTokens: number; outputTokens: number; index: number }) => void;
};

export function summarizeLatencyCombo(
  inputTokens: number,
  outputTokens: number,
  outcomes: ScenarioRequestOutcome[],
): LatencyComboResult {
  const ok = successful(outcomes);
  return {
    inputTokens,
    outputTokens,
    success: ok.length,
    failed: outcomes.length - ok.length,
    avgTtftMs: mean(ttftsMs(outcomes)),
    avgE2eMs: mean(latenciesMs(outcomes)),
    p95E2eMs: percentile(latenciesMs(outcomes), 0.95),
    avgTpotMs: averageDerived(outcomes, tpotMs),
    avgItlMs: averageDerived(outcomes, itlMs),
    avgInputTokens: mean(ok.flatMap((outcome) => (outcome.inputTokens === undefined ? [] : [outcome.inputTokens]))),
    avgOutputTokens: mean(ok.flatMap((outcome) => (outcome.outputTokens === undefined ? [] : [outcome.outputTokens]))),
    decodeTps: averageDerived(outcomes, decodeTps),
    prefillTps: averageDerived(outcomes, prefillTps),
    overallTps: averageDerived(outcomes, overallTps),
    errorBreakdown: errorBreakdown(outcomes),
  };
}

export async function runLatencyScenario(deps: LatencyScenarioDeps): Promise<LatencyScenarioResult> {
  const { client, config, signal } = deps;
  const combos: LatencyComboResult[] = [];

  for (const [comboIndex, combo] of config.latency.combos.entries()) {
    if (signal?.aborted) break;
    // Warmup requests are executed but excluded from the statistics, matching
    // the plan's `number = repeat + warmup` with warmup discarded.
    for (let warm = 0; warm < config.latency.warmup; warm += 1) {
      if (signal?.aborted) break;
      await client.execute({
        model: config.model,
        prompt: buildFillerPrompt(config.seed + comboIndex * 1_009 + warm, combo.inputTokens),
        maxOutputTokens: combo.outputTokens,
        temperature: 0,
        timeoutMs: config.requestTimeoutMs,
        signal,
      });
    }

    const outcomes: ScenarioRequestOutcome[] = [];
    for (let index = 0; index < config.latency.repeat; index += 1) {
      if (signal?.aborted) break;
      const outcome = await client.execute({
        model: config.model,
        // Distinct seed per request so a shared prefix cannot hit the KV cache.
        prompt: buildFillerPrompt(config.seed + comboIndex * 7_919 + index * 7, combo.inputTokens),
        maxOutputTokens: combo.outputTokens,
        temperature: 0,
        timeoutMs: config.requestTimeoutMs,
        signal,
      });
      outcomes.push(outcome);
      deps.onOutcome?.(outcome, { inputTokens: combo.inputTokens, outputTokens: combo.outputTokens, index });
    }
    if (outcomes.length) combos.push(summarizeLatencyCombo(combo.inputTokens, combo.outputTokens, outcomes));
  }

  return { combos };
}
