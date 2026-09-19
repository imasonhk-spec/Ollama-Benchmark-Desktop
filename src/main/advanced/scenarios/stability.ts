/**
 * Scenario D — Steady-state drift (plan sections "场景 D / 场景 E").
 *
 * Holds a fixed concurrency for N minutes, buckets every request by its start
 * offset and compares the late-window P95 against the early window. Slow thermal
 * throttling, KV-cache fragmentation and memory pressure all show up here and
 * nowhere else.
 */

import type {
  AdvancedRunConfig,
  ScenarioRequestOutcome,
  StabilityBucket,
  StabilityScenarioResult,
} from "../../../shared/AdvancedScenarios";
import { DRIFT_THRESHOLDS } from "../../../shared/AdvancedScenarios";
import { buildFillerPrompt } from "../AdvancedFiller";
import { latenciesMs, mean, percentile, successful, ttftsMs } from "../AdvancedStats";
import type { ScenarioClient } from "../ScenarioClient";

export type StabilityScenarioDeps = {
  client: ScenarioClient;
  config: AdvancedRunConfig;
  signal?: AbortSignal;
  now?: () => number;
  /** Overrides the configured concurrency, e.g. 50% of the confirmed maximum. */
  concurrencyOverride?: number;
  onBucket?: (bucket: StabilityBucket) => void;
};

/** Groups outcomes into fixed-width time buckets (the plan buckets per minute). */
export function bucketize(outcomes: ScenarioRequestOutcome[], bucketSeconds: number): StabilityBucket[] {
  const width = Math.max(1, bucketSeconds) * 1_000;
  const groups = new Map<number, ScenarioRequestOutcome[]>();
  for (const outcome of outcomes) {
    const index = Math.floor(outcome.startOffsetMs / width);
    groups.set(index, [...(groups.get(index) ?? []), outcome]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, group]) => {
      const ok = successful(group);
      const latencies = latenciesMs(group);
      const outputTokens = ok.reduce((sum, outcome) => sum + (outcome.outputTokens ?? 0), 0);
      const spanSeconds = width / 1_000;
      return {
        index,
        startSeconds: (index * width) / 1_000,
        success: ok.length,
        failed: group.length - ok.length,
        p50E2eMs: percentile(latencies, 0.5),
        p95E2eMs: percentile(latencies, 0.95),
        p99E2eMs: percentile(latencies, 0.99),
        avgTtftMs: mean(ttftsMs(group)),
        p95TtftMs: percentile(ttftsMs(group), 0.95),
        outputTokens,
        decodeTps: spanSeconds > 0 ? outputTokens / spanSeconds : undefined,
      } satisfies StabilityBucket;
    });
}

/**
 * Drift = (late-window P95 − early-window P95) / early-window P95. The early
 * window is the first bucket, the late window the last; both must be populated.
 */
export function analyzeDrift(buckets: StabilityBucket[]): { driftPercent: number; verdict: StabilityScenarioResult["verdict"] } {
  const usable = buckets.filter((bucket) => bucket.p95E2eMs !== undefined);
  if (usable.length < 2) return { driftPercent: 0, verdict: "stable" };
  const first = usable[0].p95E2eMs!;
  const last = usable[usable.length - 1].p95E2eMs!;
  if (first <= 0) return { driftPercent: 0, verdict: "stable" };
  const driftPercent = ((last - first) / first) * 100;
  const verdict = driftPercent >= DRIFT_THRESHOLDS.degradedPercent
    ? "degraded"
    : driftPercent >= DRIFT_THRESHOLDS.minorPercent
      ? "minor"
      : "stable";
  return { driftPercent, verdict };
}

export async function runStabilityScenario(deps: StabilityScenarioDeps): Promise<StabilityScenarioResult> {
  const { client, config, signal } = deps;
  const now = deps.now ?? (() => Date.now());
  const settings = config.stability;
  const concurrency = Math.max(1, deps.concurrencyOverride ?? settings.concurrency);
  const durationMs = settings.durationMinutes * 60_000;
  const startedAt = now();
  const deadline = startedAt + durationMs;
  const outcomes: ScenarioRequestOutcome[] = [];
  let issued = 0;

  const worker = async (workerIndex: number): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      if (now() >= deadline) return;
      const index = issued;
      issued += 1;
      const outcome = await client.execute({
        model: config.model,
        prompt: buildFillerPrompt(config.seed + 50_021 + index * 7 + workerIndex, settings.inputTokens),
        maxOutputTokens: settings.outputTokens,
        temperature: settings.temperature,
        timeoutMs: config.requestTimeoutMs,
        startOffsetMs: now() - startedAt,
        signal,
      });
      outcomes.push(outcome);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));

  const elapsedMs = Math.max(1, now() - startedAt);
  const buckets = bucketize(outcomes, settings.bucketSeconds);
  for (const bucket of buckets) deps.onBucket?.(bucket);
  const ok = successful(outcomes);
  const totalOutputTokens = ok.reduce((sum, outcome) => sum + (outcome.outputTokens ?? 0), 0);
  const latencies = latenciesMs(outcomes);
  const { driftPercent, verdict } = analyzeDrift(buckets);
  const steadyBuckets = buckets.slice(Math.floor(buckets.length / 2));
  const steadyLatencies = steadyBuckets.flatMap((bucket) => (bucket.p95E2eMs === undefined ? [] : [bucket.p95E2eMs]));

  return {
    concurrency,
    durationMinutes: settings.durationMinutes,
    totalSuccess: ok.length,
    totalFailed: outcomes.length - ok.length,
    totalOutputTokens,
    tpm: totalOutputTokens / (elapsedMs / 60_000),
    qps: ok.length / (elapsedMs / 1_000),
    overallP95E2eMs: percentile(latencies, 0.95),
    steadyP95E2eMs: mean(steadyLatencies),
    driftPercent,
    buckets,
    verdict,
  };
}
