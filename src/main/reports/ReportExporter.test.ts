import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportPdfReport, renderHtml, renderMarkdown, type ReportInput } from "./ReportExporter";

const input: ReportInput = {
  environment: {
    deployment: "native",
    binary: "ollama",
    apiHost: "127.0.0.1",
    apiPort: 11434,
    version: "0.1",
    gpuVendor: "none",
    gpuModels: [],
    installedModels: [],
    warnings: [],
    systemInfo: { osName: "Ubuntu", cpuModel: "Demo CPU", memoryBytes: 16 * 1024 ** 3, storageTotalBytes: 512 * 1024 ** 3 },
  },
  result: {
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T00:01:00.000Z",
    cancelled: false,
    config: { models: ["demo"], inputLengths: [100], concurrencies: [2], rounds: 5, maxOutputTokens: 50, temperature: 0, warmupEnabled: true, timeoutMs: 600_000, contextWindow: "auto-fixed" },
    samples: [],
    summaries: [{ model: "demo", inputTokens: 100, concurrency: 2, sampleCount: 2, successCount: 2, failureCount: 0, ttftMeanMs: 10, ttftP95Ms: 12, decodeMeanTokensPerSecond: 20 }],
  },
};

describe("report rendering", () => {
  it("contains the required environment, metric, summary, and model sections", () => {
    const markdown = renderMarkdown(input);
    expect(markdown).toContain("一、测试环境与配置");
    expect(markdown).toContain("二、指标定义");
    expect(markdown).toContain("三、测试结果");
    expect(markdown).toContain("### 模型：demo");
    expect(markdown).toContain("平均 TTFT(s)");
    expect(markdown).toContain("本轮测试已完成");
    expect(markdown).not.toContain("| 模型 | 输入 tokens");
    expect(renderHtml(input)).toContain("测试配置");
    expect(renderHtml(input)).toContain("summary-narrative");
  });

  it("writes a PDF using the supplied HTML-to-PDF renderer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ollama-benchmark-report-"));
    try {
      const path = await exportPdfReport(input, directory, async (html) => {
        expect(html).toContain("模型：demo");
        return Buffer.from("%PDF-test");
      });
      expect(path.endsWith(".pdf")).toBe(true);
      await expect(readFile(path, "utf8")).resolves.toBe("%PDF-test");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
