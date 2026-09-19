import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { renderDocx, renderHtml, renderMarkdown, type ReportInput } from "./ReportExporter";

const input: ReportInput = {
  environment: {
    deployment: "docker",
    binary: "ollama-rocm",
    apiHost: "172.18.0.3",
    apiPort: 11434,
    version: "0.11.0",
    gpuVendor: "amd",
    gpuModels: ["AMD Instinct"],
    installedModels: ["qwen3.6:35b"],
    warnings: [],
    systemInfo: { osName: "Ubuntu", cpuModel: "AMD EPYC", memoryBytes: 128 * 1024 ** 3, storageTotalBytes: 2 * 1024 ** 4 },
  },
  result: {
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T00:01:00.000Z",
    cancelled: false,
    config: { models: ["qwen3.6:35b"], inputLengths: [100], concurrencies: [2], rounds: 5, maxOutputTokens: 50, temperature: 0, warmupEnabled: true, timeoutMs: 600_000, contextWindow: "auto-fixed" },
    samples: [],
    summaries: [{ model: "qwen3.6:35b", inputTokens: 100, concurrency: 2, sampleCount: 2, successCount: 2, failureCount: 0, ttftMeanMs: 10, ttftP95Ms: 12, decodeMeanTokensPerSecond: 20 }],
  },
};

describe("report key-value tables", () => {
  it("left-aligns environment and configuration values in Markdown, HTML/PDF, and Word", async () => {
    const markdown = renderMarkdown(input);
    expect(markdown).toContain("| 项目 | 内容 |\n|---|---|");
    expect(markdown).toContain("| 项目 | 配置 |\n|---|---|");

    const html = renderHtml(input);
    expect(html).toContain('<table class="key-value-table">');
    expect(html).toContain(".key-value-table td:nth-child(2){text-align:left}");

    const zip = await JSZip.loadAsync(await renderDocx(input));
    const xml = await zip.file("word/document.xml")?.async("string");
    expect(xml).toContain('<w:jc w:val="left"/>');
  });
});
