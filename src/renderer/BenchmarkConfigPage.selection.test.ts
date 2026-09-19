import { describe, expect, it } from "vitest";
import { addNumber, toggleValue } from "./BenchmarkConfigPage";
import { defaultModelsForBackend, isLlamaCppBackend, isOpenAiCompatibleBackend, DEFAULT_LLAMACPP_MODELS, DEFAULT_MODELS } from "../shared/types";

describe("Benchmark configuration selections", () => {
  it("keeps an available input length when it is deselected", () => {
    const available = [10, 100, 1_000];
    const selected = toggleValue(available, 100);

    expect(available).toEqual([10, 100, 1_000]);
    expect(selected).toEqual([10, 1_000]);
  });

  it("adds a custom choice to available and selected values", () => {
    const available = addNumber("300", [10, 100]);

    expect(available).toEqual([10, 100, 300]);
  });
});

describe("default model suggestions by backend", () => {
  it("returns Ollama-style defaults for Ollama and undefined/auto backends", () => {
    expect(defaultModelsForBackend("ollama")).toBe(DEFAULT_MODELS);
    expect(defaultModelsForBackend(undefined)).toBe(DEFAULT_MODELS);
  });

  it("returns .gguf-style defaults for the OpenAI-compatible family", () => {
    for (const backend of ["llama.cpp", "openai-compatible"] as const) {
      const models = defaultModelsForBackend(backend);
      expect(models).toBe(DEFAULT_LLAMACPP_MODELS);
      expect(models.every((model) => model.endsWith(".gguf"))).toBe(true);
      expect(models.some((model) => model.includes(":"))).toBe(false);
      expect(models.some((model) => DEFAULT_MODELS.includes(model as never))).toBe(false);
    }
  });
});

describe("protocol family classification", () => {
  it("treats llama.cpp and remote OpenAI-compatible services as the same request format", () => {
    expect(isOpenAiCompatibleBackend("llama.cpp")).toBe(true);
    expect(isOpenAiCompatibleBackend("openai-compatible")).toBe(true);
    expect(isOpenAiCompatibleBackend("ollama")).toBe(false);
    expect(isOpenAiCompatibleBackend(undefined)).toBe(false);
  });

  it("keeps llama.cpp distinct from the remote OpenAI-compatible option", () => {
    expect(isLlamaCppBackend("llama.cpp")).toBe(true);
    expect(isLlamaCppBackend("openai-compatible")).toBe(false);
    expect(isLlamaCppBackend(undefined)).toBe(false);
  });
});


