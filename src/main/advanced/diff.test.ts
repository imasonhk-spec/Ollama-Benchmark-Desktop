import { describe, expect, it } from "vitest";
import { buildDegradationReport, diffRuns } from "./diff";
import type { AdvancedRunResult, ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";

function outcome(over: Partial<ScenarioRequestOutcome>): ScenarioRequestOutcome {
  return { ok: true, startOffsetMs: 0, interTokenLatenciesMs: [], responseText: "x", ...over };
}

describe("buildDegradationReport", () => {
  it("reports clean outcomes with no flags", () => {
    const outcomes = [
      outcome({ responseText: "alpha" }),
      outcome({ responseText: "beta" }),
      outcome({ responseText: "gamma" }),
    ];
    const report = buildDegradationReport(outcomes);
    expect(report.emptyResponseRate).toBe(0);
    expect(report.duplicateRate).toBe(0);
    expect(report.flags).toHaveLength(0);
    expect(report.finishReasonBreakdown).toHaveProperty("none");
  });

  it("flags empty responses and duplicates", () => {
    const outcomes = [
      outcome({ responseText: "" }),
      outcome({ responseText: "same" }),
      outcome({ responseText: "same" }),
      outcome({ responseText: "same" }),
      outcome({ responseText: "different" }),
    ];
    const report = buildDegradationReport(outcomes);
    expect(report.flags.some((flag) => flag.includes("空响应"))).toBe(true);
    expect(report.flags.some((flag) => flag.includes("重复"))).toBe(true);
  });

  it("flags context overflow errors", () => {
    const outcomes = [outcome({ ok: false, errorKind: "context-overflow", errorMessage: "max context exceeded" })];
    const report = buildDegradationReport(outcomes);
    expect(report.flags.some((flag) => flag.includes("上下文"))).toBe(true);
    expect(report.flags.some((flag) => flag.includes("成功率"))).toBe(true);
  });
});

describe("diffRuns", () => {
  const base: AdvancedRunResult = {
    startedAt: "t0",
    finishedAt: "t1",
    cancelled: false,
    planVersion: "llm-bench-2026.08",
    config: {} as AdvancedRunResult["config"],
    environment: {} as AdvancedRunResult["environment"],
    latency: { combos: [{ inputTokens: 1024, outputTokens: 256, success: 5, failed: 0, avgTtftMs: 100, avgE2eMs: 400, p95E2eMs: 600, avgTpotMs: 10, avgItlMs: 10, avgInputTokens: 1024, avgOutputTokens: 256, decodeTps: 50, prefillTps: 200, overallTps: 40, errorBreakdown: {} }] },
    concurrency: { levels: [], baselineP95Ms: 600, maxPassingConcurrency: 4, recommendedConcurrency: 2 },
    needle: { points: [], recallByLength: [], overallRecall: 0.5 },
    errors: [],
  };

  it("detects a latency regression", () => {
    const next: AdvancedRunResult = {
      ...base,
      latency: { combos: [{ ...base.latency!.combos[0], avgTtftMs: 300, avgE2eMs: 900, p95E2eMs: 1400 }] },
    };
    const diff = diffRuns(base, next);
    expect(diff.regressions.length).toBeGreaterThan(0);
    expect(diff.regressions.join(" ")).toContain("基准 P95");
  });

  it("detects an improvement in max concurrency", () => {
    const next: AdvancedRunResult = { ...base, concurrency: { ...base.concurrency!, maxPassingConcurrency: 8, recommendedConcurrency: 4 } };
    const diff = diffRuns(base, next);
    expect(diff.improvements.some((line) => line.includes("最大可用并发"))).toBe(true);
  });
});
