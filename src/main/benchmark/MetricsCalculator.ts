import type { BenchmarkSample, BenchmarkSummary } from "../../shared/types";

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function percentile(values: number[], percentileValue: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function summarizeSamples(
  model: string,
  inputTokens: number,
  concurrency: number,
  samples: BenchmarkSample[],
): BenchmarkSummary {
  const successful = samples.filter((sample) => sample.status === "success");
  const ttft = successful.flatMap((sample) => sample.ttftMs === undefined ? [] : [sample.ttftMs]);
  const decode = successful.flatMap((sample) => sample.decodeTokensPerSecond === undefined ? [] : [sample.decodeTokensPerSecond]);
  const prefill = successful.flatMap((sample) => sample.serverPrefillMs === undefined ? [] : [sample.serverPrefillMs]);
  const generatedTokens = successful.reduce((sum, sample) => sum + (sample.generatedTokens ?? 0), 0);
  const decodeSeconds = successful.reduce((sum, sample) => {
    if (!sample.decodeTokensPerSecond || !sample.generatedTokens) return sum;
    return sum + sample.generatedTokens / sample.decodeTokensPerSecond;
  }, 0);

  return {
    model,
    inputTokens,
    concurrency,
    sampleCount: samples.length,
    successCount: successful.length,
    failureCount: samples.length - successful.length,
    ttftMeanMs: mean(ttft),
    ttftP50Ms: percentile(ttft, 0.5),
    ttftP95Ms: percentile(ttft, 0.95),
    decodeMeanTokensPerSecond: mean(decode),
    decodeP50TokensPerSecond: percentile(decode, 0.5),
    aggregateDecodeTokensPerSecond: decodeSeconds ? generatedTokens / decodeSeconds : undefined,
    serverPrefillMeanMs: mean(prefill),
  };
}
