/**
 * Scenario E — Fairness analysis (plan `llm_bench/scenarios/fairness.py`).
 *
 * A mean latency of 3s hides the case where half the requests answer in 1s and
 * the rest wait 12s behind a scheduler. This scenario is pure post-processing:
 * it reuses the per-request latencies already captured by the concurrency ladder
 * and reports dispersion plus starved requests.
 */

import type {
  ConcurrencyScenarioResult,
  FairnessScenarioResult,
  FairnessStat,
} from "../../../shared/AdvancedScenarios";
import { FAIRNESS_THRESHOLDS } from "../../../shared/AdvancedScenarios";
import { coefficientOfVariation, mean, percentile } from "../AdvancedStats";

export function analyzeFairness(concurrency: number, latenciesMs: number[]): FairnessStat | undefined {
  if (latenciesMs.length < 2) return undefined;
  const average = mean(latenciesMs) ?? 0;
  const median = percentile(latenciesMs, 0.5) ?? 0;
  const p95 = percentile(latenciesMs, 0.95) ?? 0;
  const p99 = percentile(latenciesMs, 0.99) ?? 0;
  const max = Math.max(...latenciesMs);
  const cv = coefficientOfVariation(latenciesMs);
  const starved = median > 0
    ? latenciesMs.filter((value) => value > median * FAIRNESS_THRESHOLDS.starvationMultiplier).length
    : 0;
  const verdict: FairnessStat["verdict"] = cv >= FAIRNESS_THRESHOLDS.unfairCv || starved > 0
    ? "unfair"
    : cv >= FAIRNESS_THRESHOLDS.warnCv
      ? "warn"
      : "fair";

  return {
    concurrency,
    samples: latenciesMs.length,
    meanE2eMs: average,
    medianE2eMs: median,
    p95E2eMs: p95,
    p99E2eMs: p99,
    maxE2eMs: max,
    cv,
    maxOverMedian: median > 0 ? max / median : 0,
    p99OverP50: median > 0 ? p99 / median : 0,
    starved,
    verdict,
  };
}

/**
 * Derives fairness stats for every non-steady concurrency level that has at
 * least two samples. Steady re-measurements are skipped so a level is not
 * double-counted.
 */
export function runFairnessScenario(concurrency: ConcurrencyScenarioResult | undefined): FairnessScenarioResult {
  if (!concurrency) return { stats: [] };
  const stats = concurrency.levels
    .filter((level) => !level.steady)
    .flatMap((level) => {
      const stat = analyzeFairness(level.concurrency, level.latenciesMs);
      return stat ? [stat] : [];
    });
  return { stats };
}
