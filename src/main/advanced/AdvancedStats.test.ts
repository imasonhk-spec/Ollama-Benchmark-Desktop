import { describe, expect, it } from "vitest";
import {
  classifyError,
  coefficientOfVariation,
  decodeTps,
  mean,
  overallTps,
  percentile,
  prefillTps,
  stddev,
  successRatePercent,
  tpotMs,
} from "./AdvancedStats";
import type { ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";

describe("percentile", () => {
  it("returns undefined for empty input", () => {
    expect(percentile([], 0.95)).toBeUndefined();
  });
  it("computes the median and extrema", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
  it("linearly interpolates between ranks", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
  });
});

describe("stddev / cv", () => {
  it("stddev is zero for a single sample", () => {
    expect(stddev([10])).toBe(0);
  });
  it("cv is zero when there is no variation", () => {
    expect(coefficientOfVariation([10, 10, 10])).toBe(0);
  });
  it("cv is positive for spread samples", () => {
    expect(coefficientOfVariation([10, 12, 14])).toBeGreaterThan(0);
  });
});

describe("classifyError", () => {
  it("maps context overflow patterns", () => {
    expect(classifyError("maximum context length exceeded")).toBe("context-overflow");
    expect(classifyError("prompt is too long for num_ctx")).toBe("context-overflow");
  });
  it("maps rate limit and timeouts", () => {
    expect(classifyError("429 Too Many Requests")).toBe("rate-limit");
    expect(classifyError("Request timed out after 30s")).toBe("timeout");
  });
  it("maps 5xx and 4xx", () => {
    expect(classifyError("500 internal server error")).toBe("server-error");
    expect(classifyError("400 bad request")).toBe("client-error");
  });
  it("honors the aborted flag over the message", () => {
    expect(classifyError("500 internal server error", { aborted: true })).toBe("cancelled");
  });
  it("falls back to unknown", () => {
    expect(classifyError("something strange happened")).toBe("unknown");
  });
});

describe("derived throughput metrics", () => {
  const outcome: ScenarioRequestOutcome = {
    ok: true,
    startOffsetMs: 0,
    ttftMs: 100,
    e2eMs: 1_000,
    inputTokens: 40,
    outputTokens: 10,
    interTokenLatenciesMs: [],
    responseText: "x",
  };
  it("computes TPOT", () => {
    expect(tpotMs(outcome)).toBeCloseTo(100, 6);
  });
  it("computes decode TPS", () => {
    expect(decodeTps(outcome)).toBeCloseTo(10, 6);
  });
  it("computes prefill TPS", () => {
    expect(prefillTps(outcome)).toBeCloseTo(400, 6);
  });
  it("computes overall TPS", () => {
    expect(overallTps(outcome)).toBeCloseTo(10, 6);
  });
  it("returns undefined when tokens are too few", () => {
    expect(tpotMs({ ...outcome, outputTokens: 1 })).toBeUndefined();
  });
});

describe("aggregate helpers", () => {
  it("mean and successRate", () => {
    expect(mean([2, 4, 6])).toBe(4);
    const outcomes: ScenarioRequestOutcome[] = [
      { ok: true, startOffsetMs: 0, interTokenLatenciesMs: [], responseText: "a" },
      { ok: false, startOffsetMs: 0, interTokenLatenciesMs: [], responseText: "" },
    ];
    expect(successRatePercent(outcomes)).toBeCloseTo(50, 6);
  });
});
