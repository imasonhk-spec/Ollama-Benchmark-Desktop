/**
 * Response-degradation detection and run-to-run diffing for the advanced
 * scenarios (plan "退化检测").
 *
 * Two responsibilities:
 *   1. `buildDegradationReport` — scan every captured request outcome for the
 *      classic signs of model/service degradation: empty responses, verbatim
 *      repeats, and an unbalanced finish-reason mix.
 *   2. `diffRuns` — compare two `AdvancedRunResult` snapshots (e.g. before and
 *      after a model/engine upgrade) and surface the regressions that matter.
 */

import type { AdvancedRunResult, DegradationReport, ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";

/* -------------------------------------------------------------------------- */
/* Degradation report                                                          */
/* -------------------------------------------------------------------------- */

const EMPTY_RESPONSE_FLAG_THRESHOLD = 0.01;
const DUPLICATE_FLAG_THRESHOLD = 0.2;
const SUCCESS_RATE_FLOOR = 99;

export function buildDegradationReport(outcomes: ScenarioRequestOutcome[]): DegradationReport {
  const total = outcomes.length;
  const ok = outcomes.filter((outcome) => outcome.ok);

  // Empty response: the request "succeeded" yet produced no usable text.
  const emptyResponses = ok.filter((outcome) => !outcome.responseText || !outcome.responseText.trim()).length;
  const emptyResponseRate = total ? emptyResponses / total : 0;

  // Duplicate rate among successful responses: verbatim repeats across requests
  // are a strong signal the server fell back to a cached/canned answer.
  const counts = new Map<string, number>();
  for (const outcome of ok) {
    const key = (outcome.responseText ?? "").trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const distinct = counts.size;
  const duplicates = ok.length - distinct;
  const duplicateRate = ok.length ? duplicates / ok.length : 0;

  const finishReasonBreakdown: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = outcome.finishReason ?? "none";
    finishReasonBreakdown[key] = (finishReasonBreakdown[key] ?? 0) + 1;
  }

  const flags: string[] = [];
  if (emptyResponseRate > EMPTY_RESPONSE_FLAG_THRESHOLD) {
    flags.push(`空响应率 ${(emptyResponseRate * 100).toFixed(1)}% 偏高`);
  }
  if (duplicateRate > DUPLICATE_FLAG_THRESHOLD) {
    flags.push(`回复重复率 ${(duplicateRate * 100).toFixed(1)}% 偏高`);
  }
  if (outcomes.some((outcome) => outcome.errorKind === "context-overflow")) {
    flags.push("出现上下文超限");
  }
  const successRate = total ? (ok.length / total) * 100 : 0;
  if (successRate < SUCCESS_RATE_FLOOR) {
    flags.push(`整体成功率 ${successRate.toFixed(1)}% 低于 ${SUCCESS_RATE_FLOOR}%`);
  }

  return {
    sampleCount: total,
    emptyResponseRate,
    duplicateRate,
    finishReasonBreakdown,
    flags,
  };
}

/* -------------------------------------------------------------------------- */
/* Run-to-run diff                                                            */
/* -------------------------------------------------------------------------- */

export type MetricDelta = {
  key: string;
  label: string;
  before: string;
  after: string;
  /** When true, a larger numeric value is a regression (latency, drift, CV). */
  betterWhenLower: boolean;
  delta?: number;
  regression: boolean;
};

export type RunDiff = {
  generatedAt: string;
  prevPlanVersion: string;
  nextPlanVersion: string;
  metrics: MetricDelta[];
  regressions: string[];
  improvements: string[];
};

function fmtMs(value: number | undefined): string {
  return value === undefined ? "-" : `${(value / 1_000).toFixed(2)}s`;
}

function fmtPercent(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function fmtTokens(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toLocaleString("en-US")} tok`;
}

function worstCv(run: AdvancedRunResult | undefined): number | undefined {
  const stats = run?.fairness?.stats ?? [];
  if (!stats.length) return undefined;
  return Math.max(...stats.map((stat) => stat.cv));
}

/**
 * Compares two run results and lists regressions (worse metrics) and
 * improvements (better metrics). Metrics absent in either run are reported
 * with a dash and skipped from the delta math.
 */
export function diffRuns(prev: AdvancedRunResult, next: AdvancedRunResult): RunDiff {
  const metrics: MetricDelta[] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];

  const push = (
    key: string,
    label: string,
    before: string,
    after: string,
    betterWhenLower: boolean,
    beforeNum?: number,
    afterNum?: number,
  ): void => {
    let delta: number | undefined;
    let regression = false;
    if (beforeNum !== undefined && afterNum !== undefined && Math.abs(beforeNum - afterNum) > 1e-9) {
      delta = afterNum - beforeNum;
      if (betterWhenLower ? delta > 0 : delta < 0) {
        regression = true;
        regressions.push(`${label}: ${before} → ${after}（变差）`);
      } else {
        improvements.push(`${label}: ${before} → ${after}`);
      }
    }
    metrics.push({ key, label, before, after, betterWhenLower, delta, regression });
  };

  const findCombo = (run: AdvancedRunResult | undefined, inputTokens: number, outputTokens: number) =>
    run?.latency?.combos.find((combo) => combo.inputTokens === inputTokens && combo.outputTokens === outputTokens);
  const prevCombo = findCombo(prev, 1_024, 256);
  const nextCombo = findCombo(next, 1_024, 256);
  push("latency.ttft", "基准 TTFT", fmtMs(prevCombo?.avgTtftMs), fmtMs(nextCombo?.avgTtftMs), true, prevCombo?.avgTtftMs, nextCombo?.avgTtftMs);
  push("latency.e2e", "基准 E2E", fmtMs(prevCombo?.avgE2eMs), fmtMs(nextCombo?.avgE2eMs), true, prevCombo?.avgE2eMs, nextCombo?.avgE2eMs);
  push("latency.p95", "基准 P95 E2E", fmtMs(prevCombo?.p95E2eMs), fmtMs(nextCombo?.p95E2eMs), true, prevCombo?.p95E2eMs, nextCombo?.p95E2eMs);

  push(
    "concurrency.max",
    "最大可用并发",
    String(prev.concurrency?.maxPassingConcurrency ?? "-"),
    String(next.concurrency?.maxPassingConcurrency ?? "-"),
    false,
    prev.concurrency?.maxPassingConcurrency,
    next.concurrency?.maxPassingConcurrency,
  );
  push(
    "concurrency.baselineP95",
    "并发基线 P95",
    fmtMs(prev.concurrency?.baselineP95Ms),
    fmtMs(next.concurrency?.baselineP95Ms),
    true,
    prev.concurrency?.baselineP95Ms,
    next.concurrency?.baselineP95Ms,
  );

  push(
    "maxContext.limit",
    "最大上下文",
    fmtTokens(prev.maxContext?.limitTokens),
    fmtTokens(next.maxContext?.limitTokens),
    false,
    prev.maxContext?.limitTokens,
    next.maxContext?.limitTokens,
  );

  push(
    "stability.drift",
    "稳态漂移",
    fmtPercent(prev.stability?.driftPercent),
    fmtPercent(next.stability?.driftPercent),
    true,
    prev.stability?.driftPercent,
    next.stability?.driftPercent,
  );
  push("stability.verdict", "稳态判定", prev.stability?.verdict ?? "-", next.stability?.verdict ?? "-", true);

  const prevCv = worstCv(prev);
  const nextCv = worstCv(next);
  push(
    "fairness.worstCv",
    "公平性最差 CV",
    prevCv === undefined ? "-" : prevCv.toFixed(3),
    nextCv === undefined ? "-" : nextCv.toFixed(3),
    true,
    prevCv,
    nextCv,
  );

  push(
    "needle.recall",
    "长文本召回率",
    fmtPercent(prev.needle?.overallRecall),
    fmtPercent(next.needle?.overallRecall),
    false,
    prev.needle?.overallRecall,
    next.needle?.overallRecall,
  );

  return {
    generatedAt: new Date().toISOString(),
    prevPlanVersion: prev.planVersion,
    nextPlanVersion: next.planVersion,
    metrics,
    regressions,
    improvements,
  };
}
