import { describe, expect, it } from "vitest";
import { summarizeSamples } from "./MetricsCalculator";

describe("summarizeSamples", () => {
  it("calculates average and percentile metrics from successful samples", () => {
    const result = summarizeSamples("demo", 100, 2, [
      { model: "demo", targetInputTokens: 100, concurrency: 2, round: 1, workerIndex: 0, status: "success", ttftMs: 10, serverPrefillMs: 8, generatedTokens: 50, decodeTokensPerSecond: 10 },
      { model: "demo", targetInputTokens: 100, concurrency: 2, round: 1, workerIndex: 1, status: "success", ttftMs: 20, serverPrefillMs: 12, generatedTokens: 50, decodeTokensPerSecond: 20 },
      { model: "demo", targetInputTokens: 100, concurrency: 2, round: 2, workerIndex: 0, status: "timeout" },
    ]);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.ttftMeanMs).toBe(15);
    expect(result.ttftP50Ms).toBe(15);
    expect(result.serverPrefillMeanMs).toBe(10);
    expect(result.decodeMeanTokensPerSecond).toBe(15);
    expect(result.aggregateDecodeTokensPerSecond).toBeCloseTo(13.333333);
  });
});
