import { describe, expect, it } from "vitest";
import { autotuneConcurrency, judgeOutcomes } from "./AdvancedJudge";
import type { ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";

function outcomesWith(count: number, e2eMs: number, ok = true): ScenarioRequestOutcome[] {
  return Array.from({ length: count }, (_, index) => ({
    ok,
    startOffsetMs: index * 10,
    e2eMs,
    interTokenLatenciesMs: [],
    responseText: "x",
  }));
}

describe("judgeOutcomes (dual threshold)", () => {
  it("passes when rate >= 99% and P95 <= baseline * 1.5", () => {
    const verdict = judgeOutcomes(outcomesWith(100, 196, true), 196);
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toHaveLength(0);
  });
  it("fails when P95 exceeds the latency ceiling", () => {
    const verdict = judgeOutcomes(outcomesWith(100, 400, true), 196);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("P95");
  });
  it("fails when the success rate is below the floor", () => {
    const mixed = [...outcomesWith(95, 196, true), ...outcomesWith(5, 196, false)];
    const verdict = judgeOutcomes(mixed, 196);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("成功率");
  });
});

describe("autotuneConcurrency", () => {
  it("walks the ladder, finds the first failure, then binary-refines", async () => {
    const pass = new Set([1, 2, 3, 4, 5, 6]);
    const probe = async (concurrency: number) => pass.has(concurrency);
    const result = await autotuneConcurrency({
      ladder: [1, 2, 4, 8],
      maxConcurrency: 64,
      refineSteps: 3,
      probe,
    });
    expect(result.laddered).toEqual([1, 2, 4, 8]);
    expect(result.maxPassing).toBe(6);
    expect(result.firstFailing).toBe(7);
    expect(result.refined).toContain(6);
    expect(result.refined).toContain(7);
  });

  it("caps the ladder at maxConcurrency", async () => {
    const probe = async () => true;
    const result = await autotuneConcurrency({ ladder: [1, 2, 4, 8], maxConcurrency: 4, probe });
    expect(result.laddered).toEqual([1, 2, 4]);
    expect(result.maxPassing).toBe(4);
  });

  it("respects shouldStop", async () => {
    let calls = 0;
    const probe = async () => { calls += 1; return true; };
    const result = await autotuneConcurrency({
      ladder: [1, 2, 4, 8],
      maxConcurrency: 64,
      probe,
      shouldStop: () => calls >= 2,
    });
    expect(result.laddered).toEqual([1, 2]);
    expect(result.maxPassing).toBe(2);
  });
});
