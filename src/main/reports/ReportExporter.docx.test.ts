import { describe, expect, it } from "vitest";
import { renderDocx, type ReportInput } from "./ReportExporter";

const input: ReportInput = {
  environment: {
    deployment: "docker",
    binary: "ollama-rocm",
    apiHost: "172.18.0.3",
    apiPort: 11434,
    version: "0.21.1",
    gpuVendor: "amd",
    gpuModels: ["AMD Instinct"],
    installedModels: ["qwen3.6:35b"],
    warnings: [],
    systemInfo: { osName: "Ubuntu 24.04", chipPlatform: "AMD Instinct / x86_64", memoryBytes: 128 * 1024 ** 3, storageTotalBytes: 2 * 1024 ** 4 },
  },
  result: {
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T00:02:00.000Z",
    cancelled: false,
    config: { models: ["qwen3.6:35b"], inputLengths: [100], concurrencies: [2], rounds: 5, maxOutputTokens: 50, temperature: 0, warmupEnabled: true, timeoutMs: 600_000, contextWindow: "auto-fixed" },
    summaries: [{ model: "qwen3.6:35b", inputTokens: 100, concurrency: 2, sampleCount: 2, successCount: 1, failureCount: 1, ttftMeanMs: 10, ttftP95Ms: 12, decodeMeanTokensPerSecond: 20 }],
    samples: [
      { model: "qwen3.6:35b", targetInputTokens: 100, concurrency: 2, round: 1, workerIndex: 0, status: "success", ttftMs: 10, decodeTokensPerSecond: 20 },
      { model: "qwen3.6:35b", targetInputTokens: 100, concurrency: 2, round: 1, workerIndex: 1, status: "error", errorMessage: "demo failure" },
    ],
  },
};

describe("Word report", () => {
  it("contains the full formal report structure", async () => {
    const document = await renderDocx(input);
    expect(document.subarray(0, 2).toString()).toBe("PK");
    expect(document.byteLength).toBeGreaterThan(9_000);
  });
});
