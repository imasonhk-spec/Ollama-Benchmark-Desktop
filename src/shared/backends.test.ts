import { describe, expect, it } from "vitest";
import { sshConfigSchema } from "./schemas";
import {
  BACKEND_HINTS,
  BACKEND_LABELS,
  BACKEND_OPTIONS,
  DEFAULT_LLAMACPP_MODELS,
  DEFAULT_MODELS,
  type BackendPreference,
  defaultModelsForBackend,
  isLlamaCppBackend,
  isOpenAiCompatibleBackend,
  normalizeBackendPreference,
} from "./types";

const ALL_BACKENDS: BackendPreference[] = ["ollama", "llama.cpp", "openai-compatible"];

describe("backend registry", () => {
  it("offers exactly the three protocol families in display order", () => {
    expect(BACKEND_OPTIONS).toEqual(ALL_BACKENDS);
  });

  it("has a human-readable label and hint for every backend", () => {
    for (const backend of ALL_BACKENDS) {
      expect(BACKEND_LABELS[backend]).toBeTruthy();
      expect(BACKEND_HINTS[backend]).toBeTruthy();
    }
  });

  it("no longer offers GPU-variant options", () => {
    // 加速实现（ROCm / Vulkan）是端点的运行时属性，V2.5 起不再让用户猜。
    expect(BACKEND_OPTIONS.some((backend) => /rocm|vulkan/i.test(backend))).toBe(false);
    expect(BACKEND_OPTIONS.map((backend) => BACKEND_LABELS[backend]).join(" ")).not.toMatch(/ROCm|Vulkan/);
  });

  it("classifies llama.cpp separately from the OpenAI-compatible family", () => {
    expect(isLlamaCppBackend("llama.cpp")).toBe(true);
    expect(isLlamaCppBackend("openai-compatible")).toBe(false);
    expect(isLlamaCppBackend("ollama")).toBe(false);
    expect(isLlamaCppBackend(undefined)).toBe(false);

    for (const backend of ["llama.cpp", "openai-compatible"] as const) {
      expect(isOpenAiCompatibleBackend(backend)).toBe(true);
    }
    expect(isOpenAiCompatibleBackend("ollama")).toBe(false);
    expect(isOpenAiCompatibleBackend(undefined)).toBe(false);
  });

  it("scopes default model suggestions to the protocol family", () => {
    expect(defaultModelsForBackend("ollama")).toBe(DEFAULT_MODELS);
    expect(defaultModelsForBackend(undefined)).toBe(DEFAULT_MODELS);
    for (const backend of ["llama.cpp", "openai-compatible"] as const) {
      expect(defaultModelsForBackend(backend)).toBe(DEFAULT_LLAMACPP_MODELS);
    }
  });
});

describe("legacy backend preference migration", () => {
  it("maps V2.4 GPU variants onto V2.5 protocol families", () => {
    expect(normalizeBackendPreference("ollama-rocm")).toBe("ollama");
    expect(normalizeBackendPreference("llama.cpp-rocm")).toBe("llama.cpp");
    expect(normalizeBackendPreference("llama.cpp-vulkan")).toBe("llama.cpp");
  });

  it("passes through V2.5 values and defaults unknown ones to ollama", () => {
    for (const backend of ALL_BACKENDS) expect(normalizeBackendPreference(backend)).toBe(backend);
    expect(normalizeBackendPreference(undefined)).toBe("ollama");
    expect(normalizeBackendPreference("")).toBe("ollama");
    expect(normalizeBackendPreference("vllm")).toBe("ollama");
  });
});

describe("sshConfigSchema", () => {
  const base = { host: "192.168.1.10", port: 22, username: "u", password: "p", connectTimeoutMs: 10_000 };

  it("accepts every supported backend preference", () => {
    for (const backendPreference of ALL_BACKENDS) {
      expect(sshConfigSchema.parse({ ...base, backendPreference }).backendPreference).toBe(backendPreference);
    }
  });

  it("still accepts the V2.4 GPU-specific preferences so saved configs keep working", () => {
    for (const legacy of ["ollama-rocm", "llama.cpp-rocm", "llama.cpp-vulkan"] as const) {
      expect(sshConfigSchema.parse({ ...base, backendPreference: legacy }).backendPreference).toBe(legacy);
    }
  });

  it("accepts apiHost / apiPort / apiKey for authenticated or remote endpoints", () => {
    const parsed = sshConfigSchema.parse({ ...base, apiHost: "192.168.6.90", apiPort: 8082, apiKey: "occamy" });
    expect(parsed.apiHost).toBe("192.168.6.90");
    expect(parsed.apiPort).toBe(8082);
    expect(parsed.apiKey).toBe("occamy");
  });

  it("accepts a config with no backend preference", () => {
    expect(sshConfigSchema.parse(base).backendPreference).toBeUndefined();
  });

  it("rejects an unknown backend preference", () => {
    expect(() => sshConfigSchema.parse({ ...base, backendPreference: "vllm" })).toThrow();
  });
});
