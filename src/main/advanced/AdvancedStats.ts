/**
 * Statistics and error taxonomy shared by every advanced scenario.
 *
 * Ported from the `llm-bench` plan: percentile/derived-metric definitions come
 * from `llm_bench/probe.py::_derive_metrics`, the context-overflow patterns from
 * `llm_bench/scenarios/max_context.py::_CTX_ERR_PATTERNS`.
 */

import type { ScenarioErrorKind, ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";

export function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

/** Linear-interpolation percentile; `ratio` is 0..1 (0.95 = P95). */
export function percentile(values: number[], ratio: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, ratio));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Population standard deviation; returns 0 for fewer than two samples. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Coefficient of variation (stddev / mean); 0 when the mean is not usable. */
export function coefficientOfVariation(values: number[]): number {
  const average = mean(values);
  if (!average || !Number.isFinite(average) || average <= 0) return 0;
  return stddev(values) / average;
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context_length/,
  /context length/,
  /maximum context/,
  /too long/,
  /\b413\b/,
  /prompt is too long/,
  /exceeds? the (model )?context/,
  /input.*too long/,
  /max.*context/,
  /num_ctx/,
  /n_ctx/,
];

/**
 * Maps a transport/API failure onto the plan's error taxonomy so a report can
 * separate "the server refused the load" from "the context did not fit".
 */
export function classifyError(message: string | undefined, options: { aborted?: boolean } = {}): ScenarioErrorKind {
  if (options.aborted) return "cancelled";
  if (!message) return "unknown";
  const text = message.toLowerCase();
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("timed out") || text.includes("timeout") || text.includes("etimedout")) return "timeout";
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return "context-overflow";
  if (/\b429\b/.test(text) || text.includes("rate limit") || text.includes("too many requests")) return "rate-limit";
  if (/\b5\d{2}\b/.test(text) || text.includes("internal server error")) return "server-error";
  if (/\b4\d{2}\b/.test(text)) return "client-error";
  if (text.includes("no streamed token") || text.includes("empty response") || text.includes("no completion chunk")) {
    return "empty-response";
  }
  return "unknown";
}

export function isContextOverflow(message: string | undefined): boolean {
  return classifyError(message) === "context-overflow";
}

export function errorBreakdown(outcomes: ScenarioRequestOutcome[]): Partial<Record<ScenarioErrorKind, number>> {
  const breakdown: Partial<Record<ScenarioErrorKind, number>> = {};
  for (const outcome of outcomes) {
    if (outcome.ok) continue;
    const kind = outcome.errorKind ?? "unknown";
    breakdown[kind] = (breakdown[kind] ?? 0) + 1;
  }
  return breakdown;
}

export function successful(outcomes: ScenarioRequestOutcome[]): ScenarioRequestOutcome[] {
  return outcomes.filter((outcome) => outcome.ok);
}

export function latenciesMs(outcomes: ScenarioRequestOutcome[]): number[] {
  return successful(outcomes).flatMap((outcome) => (outcome.e2eMs === undefined ? [] : [outcome.e2eMs]));
}

export function ttftsMs(outcomes: ScenarioRequestOutcome[]): number[] {
  return successful(outcomes).flatMap((outcome) => (outcome.ttftMs === undefined ? [] : [outcome.ttftMs]));
}

/** Mean time per output token: (E2E - TTFT) / (outputTokens - 1). */
export function tpotMs(outcome: ScenarioRequestOutcome): number | undefined {
  const tokens = outcome.outputTokens ?? 0;
  if (outcome.e2eMs === undefined || outcome.ttftMs === undefined || tokens < 2) return undefined;
  const decodeMs = outcome.e2eMs - outcome.ttftMs;
  return decodeMs > 0 ? decodeMs / (tokens - 1) : undefined;
}

/** Mean inter-token latency measured directly from streamed token timestamps. */
export function itlMs(outcome: ScenarioRequestOutcome): number | undefined {
  return mean(outcome.interTokenLatenciesMs);
}

/** Decode throughput: (outputTokens - 1) / (E2E - TTFT) in tokens per second. */
export function decodeTps(outcome: ScenarioRequestOutcome): number | undefined {
  const tokens = outcome.outputTokens ?? 0;
  if (outcome.e2eMs === undefined || outcome.ttftMs === undefined || tokens < 2) return undefined;
  const decodeSeconds = (outcome.e2eMs - outcome.ttftMs) / 1_000;
  return decodeSeconds > 0 ? (tokens - 1) / decodeSeconds : undefined;
}

/** Prefill throughput approximation: inputTokens / TTFT (includes scheduling). */
export function prefillTps(outcome: ScenarioRequestOutcome): number | undefined {
  const tokens = outcome.inputTokens ?? 0;
  if (!tokens || outcome.ttftMs === undefined || outcome.ttftMs <= 0) return undefined;
  return tokens / (outcome.ttftMs / 1_000);
}

/** Overall throughput: outputTokens / E2E, i.e. prefill and decode combined. */
export function overallTps(outcome: ScenarioRequestOutcome): number | undefined {
  const tokens = outcome.outputTokens ?? 0;
  if (!tokens || outcome.e2eMs === undefined || outcome.e2eMs <= 0) return undefined;
  return tokens / (outcome.e2eMs / 1_000);
}

export function successRatePercent(outcomes: ScenarioRequestOutcome[]): number {
  if (!outcomes.length) return 0;
  return (successful(outcomes).length / outcomes.length) * 100;
}

/** Averages a derived per-request metric across the successful outcomes. */
export function averageDerived(
  outcomes: ScenarioRequestOutcome[],
  derive: (outcome: ScenarioRequestOutcome) => number | undefined,
): number | undefined {
  const values = successful(outcomes).flatMap((outcome) => {
    const value = derive(outcome);
    return value === undefined || !Number.isFinite(value) ? [] : [value];
  });
  return mean(values);
}
