import { describe, expect, it } from "vitest";
import {
  buildFillerPrompt,
  buildFillerPrompts,
  buildHaystack,
  checkNeedleAnswer,
  createRandom,
  estimateTokens,
  NEEDLES,
} from "./AdvancedFiller";

describe("createRandom (mulberry32)", () => {
  it("is deterministic for a given seed", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
  it("produces different streams for different seeds", () => {
    const a = createRandom(1);
    const b = createRandom(2);
    expect(a()).not.toEqual(b());
  });
});

describe("estimateTokens", () => {
  it("uses the 4-char fallback", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(1);
  });
});

describe("buildFillerPrompt / buildFillerPrompts", () => {
  it("aligns the seed step of 7 with the Python CLI", () => {
    const prompts = buildFillerPrompts(3, 16, 42);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toBe(buildFillerPrompt(42 + 2 * 7, 16));
  });
  it("is reproducible across calls", () => {
    expect(buildFillerPrompts(4, 16, 7)).toEqual(buildFillerPrompts(4, 16, 7));
  });
  it("includes a task prefix and the CONTEXT marker", () => {
    const prompt = buildFillerPrompt(42, 64);
    expect(prompt).toContain("CONTEXT:");
  });
});

describe("needle helpers", () => {
  it("exposes three needles", () => {
    expect(NEEDLES).toHaveLength(3);
  });
  it("verifies needle 0 (access code)", () => {
    expect(checkNeedleAnswer("the code is 7-3-9-2-5", 0)).toBe(true);
    expect(checkNeedleAnswer("73925", 0)).toBe(true);
    expect(checkNeedleAnswer("no idea", 0)).toBe(false);
  });
  it("verifies needle 1 (birthplace)", () => {
    expect(checkNeedleAnswer("Born in Lisbon on March 14, 1981", 1)).toBe(true);
    expect(checkNeedleAnswer("unknown", 1)).toBe(false);
  });
  it("verifies needle 2 (buried location)", () => {
    expect(checkNeedleAnswer("under the third oak tree", 2)).toBe(true);
    expect(checkNeedleAnswer("nowhere", 2)).toBe(false);
  });
  it("embeds the needle into the haystack", () => {
    const haystack = buildHaystack(200, NEEDLES[0].fact, 50);
    expect(haystack).toContain(NEEDLES[0].fact);
  });
});
