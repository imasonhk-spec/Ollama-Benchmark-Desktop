import { describe, expect, it, vi } from "vitest";
import type { BenchmarkConfig, OllamaEnvironment } from "../../shared/types";
import { BenchmarkRunner, type BenchmarkProgress } from "./BenchmarkRunner";

const config: BenchmarkConfig = {
  models: ["demo"], inputLengths: [100], concurrencies: [2], rounds: 1,
  maxOutputTokens: 50, temperature: 0, warmupEnabled: false, timeoutMs: 1_000, contextWindow: "auto-fixed",
};

const environment: OllamaEnvironment = {
  deployment: "native", binary: "ollama", apiHost: "127.0.0.1", apiPort: 11434,
  gpuVendor: "none", gpuModels: [], installedModels: ["demo"], warnings: [],
};

describe("BenchmarkRunner progress", () => {
  it("emits one result-bearing progress event for every completed request", async () => {
    let now = 0;
    const requestStreamLines = vi.fn(async (_request, onLine) => {
      now += 10;
      onLine({ response: "token" });
      now += 10;
      onLine({ done: true, eval_count: 20, eval_duration: 2_000_000_000, total_duration: 20_000_000 });
    });
    const progress: BenchmarkProgress[] = [];

    await new BenchmarkRunner({ requestStreamLines } as never, environment, () => now).run(config, (value) => progress.push(value));

    expect(progress).toHaveLength(2);
    expect(progress.map((item) => item.completed)).toEqual([1, 2]);
    expect(progress.every((item) => item.sample?.status === "success")).toBe(true);
    expect(progress.every((item) => item.sample?.decodeTokensPerSecond === 10)).toBe(true);
  });
});
