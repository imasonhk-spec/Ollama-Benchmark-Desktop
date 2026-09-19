/**
 * Dual-threshold pass/fail judge (plan section 6.1).
 *
 * evalscope's built-in `check_sla` only compares absolute latency numbers, which
 * says nothing about whether a server degraded under load. The plan replaces it
 * with a relative rule:
 *
 *   pass = successRate >= 99%  AND  P95(E2E) <= baselineP95 * 1.5
 *
 * `baselineP95` is measured once at parallel=1 before the ladder starts, so the
 * verdict is "did concurrency make this materially worse", not "is this fast".
 */

import { JUDGE_DEFAULTS, type JudgeVerdict, type ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";
import { percentile, successRatePercent } from "./AdvancedStats";

export type JudgeThresholds = {
  minSuccessRatePercent: number;
  p95LatencyMultiplier: number;
};

export function judgeOutcomes(
  outcomes: ScenarioRequestOutcome[],
  baselineP95Ms: number | undefined,
  thresholds: JudgeThresholds = JUDGE_DEFAULTS,
): JudgeVerdict {
  const latencies = outcomes
    .filter((outcome) => outcome.ok)
    .flatMap((outcome) => (outcome.e2eMs === undefined ? [] : [outcome.e2eMs]));
  const rate = successRatePercent(outcomes);
  const p95 = percentile(latencies, 0.95);
  const thresholdP95 = baselineP95Ms === undefined ? undefined : baselineP95Ms * thresholds.p95LatencyMultiplier;
  const reasons: string[] = [];

  if (!outcomes.length) reasons.push("没有采集到任何请求样本");
  if (rate < thresholds.minSuccessRatePercent) {
    reasons.push(`成功率 ${rate.toFixed(1)}% 低于门槛 ${thresholds.minSuccessRatePercent}%`);
  }
  if (thresholdP95 !== undefined && p95 !== undefined && p95 > thresholdP95) {
    reasons.push(
      `P95 端到端 ${(p95 / 1_000).toFixed(2)}s 超过基线 ${(baselineP95Ms! / 1_000).toFixed(2)}s × ${thresholds.p95LatencyMultiplier}`,
    );
  }
  if (thresholdP95 !== undefined && p95 === undefined && outcomes.length) {
    reasons.push("没有成功请求可用于计算 P95");
  }

  return {
    passed: reasons.length === 0,
    successRatePercent: rate,
    p95E2eMs: p95,
    baselineP95Ms,
    thresholdP95Ms: thresholdP95,
    reasons,
  };
}

/**
 * Stepped probe + binary refinement, the TypeScript equivalent of
 * `SLAAutoTuner._tune_constraint`: double the ladder until a level fails, then
 * binary-search the gap between the last passing and first failing level.
 *
 * `probe` must return whether the level passed; the caller owns measurement and
 * result bookkeeping. Values already measured are never re-probed.
 */
export async function autotuneConcurrency(options: {
  ladder: number[];
  maxConcurrency: number;
  refineSteps?: number;
  probe: (concurrency: number) => Promise<boolean>;
  shouldStop?: () => boolean;
}): Promise<{ laddered: number[]; refined: number[]; maxPassing?: number; firstFailing?: number }> {
  const { probe, maxConcurrency } = options;
  const refineSteps = options.refineSteps ?? 3;
  const shouldStop = options.shouldStop ?? (() => false);
  const ladder = [...new Set(options.ladder.filter((value) => value > 0 && value <= maxConcurrency))]
    .sort((a, b) => a - b);
  const laddered: number[] = [];
  const refined: number[] = [];
  let maxPassing: number | undefined;
  let firstFailing: number | undefined;

  for (const level of ladder) {
    if (shouldStop()) return { laddered, refined, maxPassing, firstFailing };
    laddered.push(level);
    if (await probe(level)) maxPassing = level;
    else { firstFailing = level; break; }
  }

  // Nothing failed inside the ladder: keep doubling until the ceiling.
  while (firstFailing === undefined && maxPassing !== undefined && maxPassing * 2 <= maxConcurrency) {
    if (shouldStop()) return { laddered, refined, maxPassing, firstFailing };
    const next = maxPassing * 2;
    laddered.push(next);
    if (await probe(next)) maxPassing = next;
    else firstFailing = next;
  }

  // Binary-refine the window between the last pass and the first failure.
  let low = maxPassing ?? 0;
  let high = firstFailing ?? maxPassing ?? 0;
  for (let step = 0; step < refineSteps && high - low > 1; step += 1) {
    if (shouldStop()) break;
    const middle = Math.floor((low + high) / 2);
    if (middle <= low || middle >= high) break;
    refined.push(middle);
    if (await probe(middle)) { low = middle; maxPassing = middle; }
    else { high = middle; firstFailing = middle; }
  }

  return { laddered, refined, maxPassing, firstFailing };
}
