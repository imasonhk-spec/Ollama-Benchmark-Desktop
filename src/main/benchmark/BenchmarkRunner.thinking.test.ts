import { describe, expect, it, vi } from "vitest";
import type { BenchmarkConfig, OllamaEnvironment } from "../../shared/types";
import { BenchmarkRunner } from "./BenchmarkRunner";

const config: BenchmarkConfig = {
  models: ["qwen3.6:35b"],
  inputLengths: [10],
  concurrencies: [1],
  rounds: 1,
  maxOutputTokens: 50,
  temperature: 0,
  warmupEnabled: false,
  timeoutMs: 1_000,
  contextWindow: "auto-fixed",
};

const environment: OllamaEnvironment = {
  deployment: "docker",
  binary: "ollama-rocm",
  apiHost: "172.18.0.3",
  apiPort: 11434,
  gpuVendor: "amd",
  gpuModels: ["AMD GPU"],
  installedModels: ["qwen3.6:35b"],
  warnings: [],
};

describe("BenchmarkRunner thinking responses", () => {
  it("measures the first streamed thinking chunk as TTFT", async () => {
    let now = 100;
    const requestStreamLines = vi.fn(async (_request, onLine) => {
      now += 12;
      onLine({ thinking: "先分析问题", done: false });
      now += 36;
      onLine({ done: true, prompt_eval_count: 10, prompt_eval_duration: 8_000_000, eval_count: 50, eval_duration: 5_000_000_000 });
    });

    const result = await new BenchmarkRunner({ requestStreamLines } as never, environment, () => now).run(config);

    expect(result.samples[0]).toMatchObject({ status: "success", ttftMs: 12, decodeTokensPerSecond: 10 });
  });
});
