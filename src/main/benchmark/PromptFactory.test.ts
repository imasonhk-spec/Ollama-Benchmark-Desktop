import { describe, expect, it } from "vitest";
import { createBenchmarkPrompt } from "./PromptFactory";

describe("createBenchmarkPrompt", () => {
  it("includes a unique nonce and grows with the target length", () => {
    const short = createBenchmarkPrompt(10, "case-short");
    const long = createBenchmarkPrompt(1_000, "case-long");
    expect(short.prompt).toContain("case-short");
    expect(long.prompt).toContain("case-long");
    expect(long.prompt.length).toBeGreaterThan(short.prompt.length);
    expect(long.targetInputTokens).toBe(1_000);
  });

  it("normalizes invalid targets to one token", () => {
    expect(createBenchmarkPrompt(0, "case").targetInputTokens).toBe(1);
    expect(createBenchmarkPrompt(-2, "case").targetInputTokens).toBe(1);
  });
});
