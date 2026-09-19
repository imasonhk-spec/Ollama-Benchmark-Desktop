/**
 * Scenario B — Adaptive concurrency stress (plan section "场景 B").
 *
 * 1. Measure the parallel=1 baseline P95 first.
 * 2. Walk the ladder 1→2→4→8→16→32 (doubling past the ladder if nothing fails).
 * 3. Binary-refine between the last passing and first failing level.
 * 4. Re-measure the confirmed level over a longer steady window.
 *
 * A level passes only under the dual threshold in `AdvancedJudge`.
 */

import type {
  AdvancedRunConfig,
  ConcurrencyLevelResult,
  ConcurrencyScenarioResult,
  ScenarioRequestOutcome,
} from "../../../shared/AdvancedScenarios";
import { buildFillerPrompt } from "../AdvancedFiller";
import { autotuneConcurrency, judgeOutcomes } from "../AdvancedJudge";
import {
  averageDerived,
  errorBreakdown,
  itlMs,
  latenciesMs,
  mean,
  percentile,
  successRatePercent,
  successful,
  tpotMs,
  ttftsMs,
} from "../AdvancedStats";
import type { ScenarioClient } from "../ScenarioClient";

export type ConcurrencyScenarioDeps = {
  client: ScenarioClient;
  config: AdvancedRunConfig;
  signal?: AbortSignal;
  now?: () => number;
  onLevel?: (level: ConcurrencyLevelResult) => void;
  onLog?: (message: string) => void;
};

/**
 * Requests to issue for a level. The plan uses `max(base, concurrency × 4)` so
 * every worker completes several requests and the window is statistically sound.
 */
export function resolveRequestCount(concurrency: number, base: number): number {
  return Math.max(base, concurrency * 4);
}

export function summarizeConcurrencyLevel(
  concurrency: number,
  requested: number,
  outcomes: ScenarioRequestOutcome[],
  wallClockMs: number,
  baselineP95Ms: number | undefined,
  steady = false,
): ConcurrencyLevelResult {
  const ok = successful(outcomes);
  const latencies = latenciesMs(outcomes);
  const totalOutputTokens = ok.reduce((sum, outcome) => sum + (outcome.outputTokens ?? 0), 0);
  const seconds = wallClockMs / 1_000;
  return {
    concurrency,
    requested,
    success: ok.length,
    failed: outcomes.length - ok.length,
    successRatePercent: successRatePercent(outcomes),
    wallClockMs,
    avgTtftMs: mean(ttftsMs(outcomes)),
    p95TtftMs: percentile(ttftsMs(outcomes), 0.95),
    avgE2eMs: mean(latencies),
    p50E2eMs: percentile(latencies, 0.5),
    p95E2eMs: percentile(latencies, 0.95),
    p99E2eMs: percentile(latencies, 0.99),
    avgTpotMs: averageDerived(outcomes, tpotMs),
    avgItlMs: averageDerived(outcomes, itlMs),
    qps: seconds > 0 ? ok.length / seconds : undefined,
    outputTokensPerSecond: seconds > 0 ? totalOutputTokens / seconds : undefined,
    totalOutputTokens,
    latenciesMs: latencies,
    errorBreakdown: errorBreakdown(outcomes),
    verdict: judgeOutcomes(outcomes, baselineP95Ms),
    ...(steady ? { steady: true } : {}),
  };
}

/**
 * Drives `concurrency` workers for at most `durationMs` or `requested` requests,
 * whichever comes first, giving every request a distinct prompt.
 */
async function driveLevel(options: {
  client: ScenarioClient;
  config: AdvancedRunConfig;
  concurrency: number;
  requested: number;
  durationMs: number;
  signal?: AbortSignal;
  now: () => number;
  seedBase: number;
}): Promise<{ outcomes: ScenarioRequestOutcome[]; wallClockMs: number }> {
  const { client, config, concurrency, requested, durationMs, signal, now, seedBase } = options;
  const startedAt = now();
  const deadline = startedAt + durationMs;
  const outcomes: ScenarioRequestOutcome[] = [];
  let issued = 0;

  const worker = async (workerIndex: number): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      if (issued >= requested) return;
      // Time budget only stops *new* requests; in-flight requests still finish.
      if (outcomes.length > 0 && now() >= deadline) return;
      const index = issued;
      issued += 1;
      const outcome = await client.execute({
        model: config.model,
        prompt: buildFillerPrompt(seedBase + index * 7 + workerIndex, config.concurrency.inputTokens),
        maxOutputTokens: config.concurrency.outputTokens,
        temperature: config.concurrency.temperature,
        timeoutMs: config.requestTimeoutMs,
        startOffsetMs: now() - startedAt,
        signal,
      });
      outcomes.push(outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, index) => worker(index)));
  return { outcomes, wallClockMs: Math.max(1, now() - startedAt) };
}

export async function runConcurrencyScenario(deps: ConcurrencyScenarioDeps): Promise<ConcurrencyScenarioResult> {
  const { client, config, signal } = deps;
  const now = deps.now ?? (() => Date.now());
  const settings = config.concurrency;
  const levels: ConcurrencyLevelResult[] = [];
  const measured = new Map<number, ConcurrencyLevelResult>();
  let seedCursor = config.seed;

  for (let warm = 0; warm < settings.warmup; warm += 1) {
    if (signal?.aborted) break;
    await client.execute({
      model: config.model,
      prompt: buildFillerPrompt(config.seed + 313 + warm, settings.inputTokens),
      maxOutputTokens: settings.outputTokens,
      temperature: settings.temperature,
      timeoutMs: config.requestTimeoutMs,
      signal,
    });
  }

  const measureLevel = async (concurrency: number, durationMs: number, steady = false): Promise<ConcurrencyLevelResult> => {
    const requested = resolveRequestCount(concurrency, settings.requestsPerLevel);
    seedCursor += 10_007;
    const { outcomes, wallClockMs } = await driveLevel({
      client, config, concurrency, requested, durationMs, signal, now, seedBase: seedCursor,
    });
    const baseline = measured.get(1)?.p95E2eMs;
    const level = summarizeConcurrencyLevel(concurrency, requested, outcomes, wallClockMs, baseline, steady);
    levels.push(level);
    if (!steady) measured.set(concurrency, level);
    deps.onLevel?.(level);
    deps.onLog?.(
      `并发 ${concurrency}：成功率 ${level.successRatePercent.toFixed(1)}%，P95 ${(level.p95E2eMs ?? 0) / 1_000 > 0 ? ((level.p95E2eMs ?? 0) / 1_000).toFixed(2) : "-"}s，判定 ${level.verdict.passed ? "通过" : "不通过"}`,
    );
    return level;
  };

  // Baseline (parallel=1) must exist before any verdict can be computed.
  const baselineLevel = await measureLevel(1, settings.probeDurationMs);
  const baselineP95Ms = baselineLevel.p95E2eMs;
  // Re-judge the baseline against itself so the table is internally consistent.
  baselineLevel.verdict = judgeOutcomes(
    baselineLevel.latenciesMs.map((value) => ({ ok: true, startOffsetMs: 0, e2eMs: value, interTokenLatenciesMs: [], responseText: "" })),
    baselineP95Ms,
  );
  baselineLevel.verdict.successRatePercent = baselineLevel.successRatePercent;
  baselineLevel.verdict.passed = baselineLevel.successRatePercent >= 99;

  const ladder = settings.levels.filter((value) => value > 1);
  let autotune: ConcurrencyScenarioResult["autotune"];
  let maxPassing = baselineLevel.verdict.passed ? 1 : undefined;
  let firstFailing: number | undefined;

  if (settings.autotune) {
    const probe = async (concurrency: number): Promise<boolean> => {
      const level = measured.get(concurrency) ?? (await measureLevel(concurrency, settings.probeDurationMs));
      return level.verdict.passed;
    };
    const tuned = await autotuneConcurrency({
      ladder,
      maxConcurrency: settings.maxConcurrency,
      probe,
      shouldStop: () => Boolean(signal?.aborted),
    });
    autotune = { laddered: tuned.laddered, refined: tuned.refined };
    maxPassing = tuned.maxPassing ?? maxPassing;
    firstFailing = tuned.firstFailing;
  } else {
    for (const concurrency of ladder) {
      if (signal?.aborted) break;
      const level = await measureLevel(concurrency, settings.probeDurationMs);
      if (level.verdict.passed) maxPassing = concurrency;
      else if (firstFailing === undefined) firstFailing = concurrency;
    }
  }

  // Confirmed level gets a longer steady-state re-measurement (plan: 60s).
  if (maxPassing && settings.steadyDurationMs > 0 && !signal?.aborted) {
    await measureLevel(maxPassing, settings.steadyDurationMs, true);
    if (autotune) autotune.steadyConcurrency = maxPassing;
  }

  levels.sort((a, b) => (a.concurrency - b.concurrency) || (a.steady ? 1 : 0) - (b.steady ? 1 : 0));

  return {
    levels,
    baselineP95Ms,
    maxPassingConcurrency: maxPassing,
    firstFailingConcurrency: firstFailing,
    // Downstream scenarios run at 50% of the maximum (plan section 5).
    recommendedConcurrency: maxPassing ? Math.max(1, Math.floor(maxPassing / 2)) : undefined,
    autotune,
  };
}
