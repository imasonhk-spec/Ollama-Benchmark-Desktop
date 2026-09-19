import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import type { BenchmarkSample, BenchmarkSummary, OllamaEnvironment, ReportFormat as SharedReportFormat } from "../../shared/types";
import { accelerationLabel, backendLabel } from "../../shared/types";
import type { BenchmarkRunResult } from "../benchmark/BenchmarkRunner";

export type ReportFormat = SharedReportFormat;
export type HtmlPdfRenderer = (html: string) => Promise<Uint8Array>;
export type ReportInput = { environment: OllamaEnvironment; result: BenchmarkRunResult };

const reportWidth = 9_360;
const resultHeaders = ["输入 tokens", "并发", "样本数", "成功数", "失败率", "平均 TTFT(s)", "P95 TTFT(s)", "Decode(tok/s)"];
const modelWidths = [1_300, 700, 700, 700, 700, 1_200, 1_200, 2_860];
const failureWidths = [1_800, 900, 900, 900, 900, 3_960];
const left = AlignmentType.LEFT;
const right = AlignmentType.RIGHT;

function number(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function seconds(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "-" : (value / 1_000).toFixed(3);
}

function size(value: number | undefined): string {
  if (!value || value < 0) return "未获取";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unit = 0;
  while (current >= 1_024 && unit < units.length - 1) {
    current /= 1_024;
    unit += 1;
  }
  return `${current.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function duration(start: string, end: string): string {
  const milliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  const totalSeconds = Math.round(milliseconds / 1_000);
  return totalSeconds < 60 ? `${totalSeconds} 秒` : `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}

function status(sample: BenchmarkSample): string {
  if (sample.status === "success") return "成功";
  if (sample.status === "timeout") return "超时";
  if (sample.status === "cancelled") return "已取消";
  return "失败";
}

function failRate(summary: BenchmarkSummary): string {
  return `${number(summary.failureCount / Math.max(1, summary.sampleCount) * 100)}%`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function resultRows(summaries: BenchmarkSummary[]): string[][] {
  return summaries.map((item) => [
    item.inputTokens.toLocaleString(),
    String(item.concurrency),
    String(item.sampleCount),
    String(item.successCount),
    failRate(item),
    seconds(item.ttftMeanMs),
    seconds(item.ttftP95Ms),
    number(item.decodeMeanTokensPerSecond),
  ]);
}

function summaryNarrative(input: ReportInput): string {
  const { result } = input;
  const totalSamples = result.samples.length;
  const successfulSamples = result.samples.filter((sample) => sample.status === "success").length;
  const modelCount = new Set(result.summaries.map((item) => item.model)).size || result.config.models.length;
  const combinations = result.summaries.length;
  const state = result.cancelled ? "本轮测试已提前结束，以下总结基于已经完成的请求。" : "本轮测试已完成。";
  const requestSentence = totalSamples > 0
    ? `共测试 ${modelCount} 个模型，记录 ${successfulSamples}/${totalSamples} 个独立请求成功，形成 ${combinations} 个模型、输入长度与并发组合结果。`
    : `共配置 ${modelCount} 个模型，但本轮尚未产生可用请求样本。`;
  const ttftBest = [...result.summaries].filter((item) => item.ttftMeanMs !== undefined).sort((a, b) => (a.ttftMeanMs ?? Infinity) - (b.ttftMeanMs ?? Infinity))[0];
  const decodeBest = [...result.summaries].filter((item) => item.decodeMeanTokensPerSecond !== undefined).sort((a, b) => (b.decodeMeanTokensPerSecond ?? -Infinity) - (a.decodeMeanTokensPerSecond ?? -Infinity))[0];
  const highlights: string[] = [];
  if (ttftBest) highlights.push(`最低平均 TTFT 为 ${seconds(ttftBest.ttftMeanMs)} 秒，出现在 ${ttftBest.model}（输入 ${ttftBest.inputTokens.toLocaleString()} tokens、并发 ${ttftBest.concurrency}）`);
  if (decodeBest) highlights.push(`最高平均 Decode 速度为 ${number(decodeBest.decodeMeanTokensPerSecond)} tok/s，出现在 ${decodeBest.model}（输入 ${decodeBest.inputTokens.toLocaleString()} tokens、并发 ${decodeBest.concurrency}）`);
  return `${state}${requestSentence}${highlights.length ? `${highlights.join("；")}。` : "当前没有足够的成功指标用于比较 TTFT 和 Decode 速度。"} 详细数据按模型分类列出，并单独标示失败、超时或取消的样本。`;
}

function groups(input: ReportInput): Map<string, BenchmarkSummary[]> {
  const output = new Map<string, BenchmarkSummary[]>();
  for (const summary of input.result.summaries) output.set(summary.model, [...(output.get(summary.model) ?? []), summary]);
  return output;
}

function environmentRows(environment: OllamaEnvironment): string[][] {
  const system = environment.systemInfo;
  const chip = system?.chipPlatform || environment.gpuModels.join(", ") || environment.gpuVendor;
  return [
    ["推理后端", backendLabel(environment.backend)],
    ["部署方式", environment.deployment],
    ["运行程序", environment.binary],
    ["版本", environment.version ?? "未获取"],
    ["推理 API", `${environment.apiHost}:${environment.apiPort}`],
    ["加速实测", accelerationLabel(environment.acceleration)],
    ["芯片平台", chip],
    ["CPU", system?.cpuModel ?? "未获取"],
    ["CPU 核心数", system?.cpuCores ? String(system.cpuCores) : "未获取"],
    ["内存总量", size(system?.memoryBytes)],
    ["存储总量", size(system?.storageTotalBytes)],
    ["存储可用", size(system?.storageAvailableBytes)],
    ["操作系统", system?.osName ?? "未获取"],
    ["内核 / 架构", [system?.kernel, system?.architecture].filter(Boolean).join(" / ") || "未获取"],
  ];
}

function configRows(input: ReportInput): string[][] {
  const config = input.result.config;
  return [
    ["测试模型", config.models.join(", ")],
    ["输入长度", `${config.inputLengths.map((value) => value.toLocaleString()).join(", ")} tokens`],
    ["并发数", config.concurrencies.join(", ")],
    ["每组轮次", String(config.rounds)],
    ["最大输出", `${config.maxOutputTokens} tokens`],
    ["温度", String(config.temperature)],
    ["预热", config.warmupEnabled ? "启用（不计入统计）" : "关闭"],
    ["上下文窗口", config.contextWindow === "auto-fixed" ? "自动固定" : "服务器端默认"],
    ["单请求超时", `${Math.round(config.timeoutMs / 1_000)} 秒`],
  ];
}

function errorRows(samples: BenchmarkSample[]): string[][] {
  return samples.filter((sample) => sample.status !== "success").map((sample) => [
    sample.model,
    sample.targetInputTokens.toLocaleString(),
    String(sample.concurrency),
    String(sample.round),
    status(sample),
    sample.errorMessage ?? "-",
  ]);
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

function mdTable(headers: string[], rows: string[][], keyValue = false): string[] {
  const separators = headers.map((_, index) => keyValue || index === 0 ? "---" : "---:");
  return [
    `| ${headers.map(escapeMarkdown).join(" | ")} |`,
    `|${separators.join("|")}|`,
    ...rows.map((row) => `| ${row.map(escapeMarkdown).join(" | ")} |`),
  ];
}

function htmlTable(headers: string[], rows: string[][], className?: string): string {
  const attribute = className ? ` class="${className}"` : "";
  return `<table${attribute}><thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((item) => `<td>${escapeHtml(item)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function heading(text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1): Paragraph {
  return new Paragraph({ text, heading: level, alignment: left, spacing: { before: 240, after: 120 } });
}

function body(text: string): Paragraph {
  return new Paragraph({ alignment: left, children: [new TextRun({ text, font: "Microsoft YaHei" })], spacing: { after: 100 } });
}

type WordTableOptions = { columnWidths: number[]; alignments: Array<typeof AlignmentType[keyof typeof AlignmentType]> };

function wordTable(rows: string[][], options: WordTableOptions): Table {
  return new Table({
    width: { size: reportWidth, type: WidthType.DXA },
    indent: { size: 120, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: options.columnWidths,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE5" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE5" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE5" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE5" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "E7EDF2" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "E7EDF2" },
    },
    rows: rows.map((row, rowIndex) => new TableRow({
      children: row.map((cell, columnIndex) => new TableCell({
        width: { size: options.columnWidths[columnIndex], type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
        shading: rowIndex === 0 ? { fill: "E8EEF5" } : undefined,
        children: [new Paragraph({
          alignment: options.alignments[columnIndex] ?? left,
          spacing: { after: 0 },
          children: [new TextRun({
            text: cell,
            bold: rowIndex === 0,
            color: rowIndex === 0 ? "1F4D78" : "17202A",
            font: "Microsoft YaHei",
            size: 20,
          })],
        })],
      })),
    })),
  });
}

const keyValueOptions: WordTableOptions = { columnWidths: [2_700, 6_660], alignments: [left, left] };
const modelOptions: WordTableOptions = { columnWidths: modelWidths, alignments: [right, right, right, right, right, right, right, right] };
const failuresOptions: WordTableOptions = { columnWidths: failureWidths, alignments: [left, right, right, right, left, left] };

export function renderMarkdown(input: ReportInput): string {
  const modelSections = [...groups(input).entries()].flatMap(([model, summaries]) => [
    `### 模型：${model}`,
    "",
    ...mdTable(resultHeaders, resultRows(summaries)),
    "",
  ]);
  const failures = errorRows(input.result.samples);
  return [
    "# Ollama 模型性能测试报告",
    "",
    "## 一、测试环境与配置",
    "",
    "### 服务器环境",
    "",
    ...mdTable(["项目", "内容"], environmentRows(input.environment), true),
    "",
    "### 测试配置",
    "",
    ...mdTable(["项目", "配置"], configRows(input), true),
    "",
    `- 测试开始：${input.result.startedAt}`,
    `- 测试结束：${input.result.finishedAt}`,
    `- 总耗时：${duration(input.result.startedAt, input.result.finishedAt)}`,
    "",
    "## 二、指标定义",
    "",
    "- **TTFT（秒）**：从请求发出到首个有效流式分块到达的时间，包含 SSH 隧道、网络、排队和 Prefill 影响。",
    "- **Decode 速度（tok/s）**：`eval_count / eval_duration`。",
    "- 每个输入长度、并发数和轮次使用独立请求及不同提示词；预热不纳入统计。",
    "",
    "## 三、测试结果",
    "",
    "### （1）测试总结",
    "",
    summaryNarrative(input),
    "",
    "### （2）按模型分类结果",
    "",
    ...modelSections,
    "### 异常样本",
    "",
    ...(failures.length ? mdTable(["模型", "输入", "并发", "轮次", "状态", "错误"], failures) : ["无异常样本。"]),
    "",
    ...(input.environment.warnings.length ? ["### 环境提示", "", ...input.environment.warnings.map((warning) => `- ${warning}`), ""] : []),
  ].join("\n");
}

export function renderHtml(input: ReportInput): string {
  const modelSections = [...groups(input).entries()].map(([model, summaries]) => `<section><h3>模型：${escapeHtml(model)}</h3>${htmlTable(resultHeaders, resultRows(summaries))}</section>`).join("");
  const failures = errorRows(input.result.samples);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Ollama 模型性能测试报告</title><style>@page{size:A4;margin:16mm}body{font:14px system-ui,"Microsoft YaHei",sans-serif;max-width:1200px;margin:32px auto;color:#17202a;line-height:1.55}h1{color:#0f766e}h2{margin-top:28px;color:#164e63;border-bottom:2px solid #d9eeeb;padding-bottom:5px}h3{margin-top:22px;color:#0f766e}table{border-collapse:collapse;width:100%;font-size:12px;margin:10px 0 18px}th,td{border:1px solid #d7dee5;padding:7px;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}th{background:#e5f3f1;color:#124e4a}td:last-child{max-width:260px;overflow-wrap:anywhere}.key-value-table th,.key-value-table td{ text-align:left }.key-value-table td:nth-child(2){text-align:left}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;background:#f4faf9;padding:14px;border-radius:8px}.summary-narrative{background:#f8fafc;border-left:4px solid #0f766e;padding:12px 14px;border-radius:6px}</style></head><body><h1>Ollama 模型性能测试报告</h1><h2>一、测试环境与配置</h2><h3>服务器环境</h3>${htmlTable(["项目", "内容"], environmentRows(input.environment), "key-value-table")}<h3>测试配置</h3>${htmlTable(["项目", "配置"], configRows(input), "key-value-table")}<div class="meta"><div><b>测试开始：</b>${escapeHtml(input.result.startedAt)}</div><div><b>测试结束：</b>${escapeHtml(input.result.finishedAt)}</div><div><b>总耗时：</b>${duration(input.result.startedAt, input.result.finishedAt)}</div><div><b>状态：</b>${input.result.cancelled ? "已取消（部分结果）" : "完成"}</div></div><h2>二、指标定义</h2><ul><li><b>TTFT（秒）</b>：从请求发出到首个有效流式分块到达的时间。</li><li><b>Decode 速度（tok/s）</b>：<code>eval_count / eval_duration</code>。</li><li>每个输入长度、并发数和轮次使用独立请求及不同提示词；预热不计入统计。</li></ul><h2>三、测试结果</h2><h3>（1）测试总结</h3>${`<p class="summary-narrative">${escapeHtml(summaryNarrative(input))}</p>`}<h3>（2）按模型分类结果</h3>${modelSections}<h3>异常样本</h3>${failures.length ? htmlTable(["模型", "输入", "并发", "轮次", "状态", "错误"], failures) : "<p>无异常样本。</p>"}</body></html>`;
}

export async function renderDocx(input: ReportInput): Promise<Buffer> {
  const failures = errorRows(input.result.samples);
  const byModel = [...groups(input).entries()].flatMap(([model, summaries]) => [
    heading(`模型：${model}`, HeadingLevel.HEADING_2),
    wordTable([resultHeaders, ...resultRows(summaries)], modelOptions),
  ]);
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 260 }, children: [new TextRun({ text: "Ollama 模型性能测试报告", bold: true, size: 32, color: "0F766E", font: "Microsoft YaHei" })] }),
    heading("一、测试环境与配置"),
    heading("服务器环境", HeadingLevel.HEADING_2),
    wordTable([["项目", "内容"], ...environmentRows(input.environment)], keyValueOptions),
    heading("测试配置", HeadingLevel.HEADING_2),
    wordTable([["项目", "配置"], ...configRows(input)], keyValueOptions),
    body(`测试开始：${input.result.startedAt}`),
    body(`测试结束：${input.result.finishedAt}`),
    body(`总耗时：${duration(input.result.startedAt, input.result.finishedAt)}`),
    heading("二、指标定义"),
    body("TTFT（秒）：从请求发出到首个有效流式分块到达的时间，包含 SSH 隧道、网络、排队和 Prefill 影响。"),
    body("Decode 速度（tok/s）：eval_count / eval_duration，表示 Prefill 完成后的持续生成速度。"),
    body("每个输入长度、并发数和轮次使用独立请求及不同提示词；预热请求不纳入统计。"),
    heading("三、测试结果"),
    heading("（1）测试总结", HeadingLevel.HEADING_2),
    body(summaryNarrative(input)),
    heading("（2）按模型分类结果", HeadingLevel.HEADING_2),
    ...byModel,
    heading("异常样本", HeadingLevel.HEADING_2),
    ...(failures.length ? [wordTable([["模型", "输入", "并发", "轮次", "状态", "错误"], ...failures], failuresOptions)] : [body("无异常样本。")]),
    ...(input.environment.warnings.length ? [heading("环境提示", HeadingLevel.HEADING_2), ...input.environment.warnings.map((warning) => body(warning))] : []),
  ];
  return Packer.toBuffer(new Document({
    sections: [{
      properties: { page: { size: { width: 11_906, height: 16_838 }, margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
      children,
    }],
  }));
}

export async function exportPdfReport(input: ReportInput, outputDirectory: string, renderPdf: HtmlPdfRenderer): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, `ollama-benchmark-${stamp()}.pdf`);
  await writeFile(path, await renderPdf(renderHtml(input)));
  return path;
}

export async function exportReports(input: ReportInput, formats: ReportFormat[], outputDirectory: string): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const currentStamp = stamp();
  const paths: string[] = [];
  if (formats.includes("markdown")) {
    const path = join(outputDirectory, `ollama-benchmark-${currentStamp}.md`);
    await writeFile(path, renderMarkdown(input), "utf8");
    paths.push(path);
  }
  if (formats.includes("html")) {
    const path = join(outputDirectory, `ollama-benchmark-${currentStamp}.html`);
    await writeFile(path, renderHtml(input), "utf8");
    paths.push(path);
  }
  if (formats.includes("docx")) {
    const path = join(outputDirectory, `ollama-benchmark-${currentStamp}.docx`);
    await writeFile(path, await renderDocx(input));
    paths.push(path);
  }
  return paths;
}
