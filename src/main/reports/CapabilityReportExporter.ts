import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { CapabilityDimensionMeta, CapabilityModelSummary, CapabilityRunResult, ReportFormat } from '../../shared/types';
import { accelerationLabel, backendLabel } from '../../shared/types';
import { resolveCapabilityDimensionLabels, resolveCapabilityDimensions } from '../../shared/CapabilityDimensions';
import { getCapabilityQuestions } from '../../shared/CapabilityDefaultQuestions';
import { renderCapabilityBarChart, renderCapabilityRadarChart } from '../../shared/CapabilityCharts';
import type { HtmlPdfRenderer } from './ReportExporter';

export type CapabilityReportInput = { result: CapabilityRunResult };
const stamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const escapeMd = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
const number = (value: number | undefined, digits = 1) => value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);
/** 满分/题数这类整数量：去掉多余的 .0，读起来更像报告而不是日志。 */
const scoreText = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '-' : String(Number(Number(value).toFixed(2)));
const size = (value: number | undefined) => { if (!value) return '未获取'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let n = value; let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; } return `${n.toFixed(i ? 2 : 0)} ${units[i]}`; };
const tableMd = (headers: string[], rows: string[][]) => [`| ${headers.map(escapeMd).join(' | ')} |`, `|${headers.map((_, i) => i ? '---:' : '---').join('|')}|`, ...rows.map((row) => `| ${row.map(escapeMd).join(' | ')} |`)];
const tableHtml = (headers: string[], rows: string[][]) => `<table><thead><tr>${headers.map((x) => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

function environmentRows(result: CapabilityRunResult): string[][] {
  const env = result.environment; const system = env.systemInfo;
return [['推理后端', backendLabel(env.backend)], ['部署方式', env.deployment], ['运行程序', env.binary], ['版本', env.version ?? '未获取'], ['API', `${env.apiHost}:${env.apiPort}`], ['加速实测', accelerationLabel(env.acceleration)], ['GPU', env.gpuModels.join(', ') || env.gpuVendor], ['芯片平台', system?.chipPlatform ?? '未获取'], ['CPU', system?.cpuModel ?? '未获取'], ['内存', size(system?.memoryBytes)], ['存储', size(system?.storageTotalBytes)], ['操作系统', system?.osName ?? '未获取'], ['内核 / 架构', [system?.kernel, system?.architecture].filter(Boolean).join(' / ') || '未获取']];
}

function configRows(result: CapabilityRunResult): string[][] {
  const config = result.config; const builtInCount = getCapabilityQuestions().length; const total = config.questions?.length ?? (result.questions.length ? result.questions.length / Math.max(1, config.models.length) : builtInCount);
  return [['题库版本', result.suiteVersion], ['评测模型', config.models.join(', ')], ['每题最大输出', `${config.maxOutputTokens} tokens`], ['温度', String(config.temperature)], ['思考模式', config.thinkingMode === 'on' ? '开启' : '关闭'], ['请求超时', `${Math.round(config.timeoutMs / 1000)} 秒`], ['题库总题数', `${total} 题/模型`], ['自定义题目', `${Math.max(0, total - builtInCount)} 道`]];
}
function summaryRows(summaries: CapabilityModelSummary[], dimensions: CapabilityDimensionMeta[]): string[][] {
  return summaries.map((summary) => [String(summary.rank), summary.model, `${number(summary.totalScore)}/${summary.maxScore}`, ...dimensions.map((dimension) => number(summary.dimensionScores[dimension.key])), `${summary.completedCount}/${summary.questionCount}`, number(summary.averageResponseMs, 0), number(summary.averageDecodeTokensPerSecond)]);
}

/** 维度定义行：把每个维度的满分、题数写进报告，避免"满分是多少"只能靠猜。 */
function dimensionRows(dimensions: CapabilityDimensionMeta[], labels: Record<string, string>): string[][] {
  return dimensions.map((dimension) => [labels[dimension.key] ?? dimension.label, dimension.key, `${scoreText(dimension.maxScore)} 分`, `${dimension.questionCount} 题`]);
}

/** 优势维度按"得分率"取，避免各维度满分不同时用绝对分数比较。 */
function strongestDimension(summary: CapabilityModelSummary, dimensions: CapabilityDimensionMeta[]): CapabilityDimensionMeta | undefined {
  return dimensions.slice().sort((left, right) => {
    const leftMax = Number(summary.dimensionMaxScores?.[left.key]) > 0 ? Number(summary.dimensionMaxScores[left.key]) : left.maxScore;
    const rightMax = Number(summary.dimensionMaxScores?.[right.key]) > 0 ? Number(summary.dimensionMaxScores[right.key]) : right.maxScore;
    return (Number(summary.dimensionScores?.[right.key] ?? 0) / Math.max(rightMax, 1e-9)) - (Number(summary.dimensionScores?.[left.key] ?? 0) / Math.max(leftMax, 1e-9));
  })[0];
}

function dimensionTotal(summary: CapabilityModelSummary, dimension: CapabilityDimensionMeta): number {
  const value = Number(summary.dimensionMaxScores?.[dimension.key]);
  return Number.isFinite(value) && value > 0 ? value : dimension.maxScore;
}

function summaryNarrative(result: CapabilityRunResult, dimensions: CapabilityDimensionMeta[], labels: Record<string, string>): string {
  const total = result.questions.length;
  const completed = result.questions.filter((item) => item.status === 'success').length;
  const top = result.summaries[0];
  const state = result.cancelled ? '本轮能力横评已提前结束，以下总结基于已经完成的题目。' : '本轮能力横评已完成。';
  const completion = `共评测 ${result.config.models.length} 个模型，覆盖 ${dimensions.length} 个维度、完成 ${completed}/${total} 道模型题目`;
  if (!top) return `${state}${completion}，当前没有可比较的模型得分。`;
  const strongest = strongestDimension(top, dimensions);
  const scoreLine = `综合排名第一为 ${top.model}，得分 ${scoreText(top.totalScore)}/${scoreText(top.maxScore)}`;
  if (!strongest) return `${state}${completion}。${scoreLine}。详细分维度分数、图表和逐题证据见后续章节。`;
  return `${state}${completion}。${scoreLine}；其当前优势维度为${labels[strongest.key] ?? strongest.label}（${scoreText(top.dimensionScores[strongest.key])}/${scoreText(dimensionTotal(top, strongest))}）。详细分维度分数、图表和逐题证据见后续章节。`;
}
function insights(summaries: CapabilityModelSummary[], dimensions: CapabilityDimensionMeta[], labels: Record<string, string>): string[] {
  if (!summaries.length) return ['没有可用于分析的模型结果。'];
  const top = summaries[0]; const strongest = strongestDimension(top, dimensions);
  const lines = [`综合排名第一：${top.model}，得分 ${scoreText(top.totalScore)}/${scoreText(top.maxScore)}。`];
  if (strongest) lines.push(`${top.model} 当前最突出维度为“${labels[strongest.key] ?? strongest.label}”（${scoreText(top.dimensionScores[strongest.key])}/${scoreText(dimensionTotal(top, strongest))}）。`);
  return [...lines, ...summaries.filter((summary) => summary.totalScore < summary.maxScore * 0.5).map((summary) => `建议谨慎使用 ${summary.model}：总分低于满分的一半，应结合具体任务复核输出。`)];
}

export function renderCapabilityMarkdown(input: CapabilityReportInput, assets = { bar: 'capability-score-bar.svg', radar: 'capability-radar.svg' }): string {
  const result = input.result; const summaries = result.summaries;
  const dimensions = resolveCapabilityDimensions(result); const labels = resolveCapabilityDimensionLabels(result);
  const questionRows = result.questions.map((item) => [item.model, labels[item.dimension] ?? item.dimension, item.title, `${number(item.score)}/${item.maxScore}`, item.status === 'success' ? '成功' : item.status === 'cancelled' ? '取消' : '失败', item.response.slice(0, 220), item.evidence.join('；') || item.errorMessage || '-']);
  return [`# Ollama 模型能力横评报告`, ``, `> 题库版本：${result.suiteVersion}；状态：${result.cancelled ? '部分完成（已取消或中断）' : '完成'}`, ``, `## 一、测试环境与配置`, ``, `### 服务器环境`, ``, ...tableMd(['项目', '内容'], environmentRows(result)), ``, `### 测试配置`, ``, ...tableMd(['项目', '配置'], configRows(result)), ``, `## 二、指标定义与评分方法`, ``, `- 评估维度由导入的题库决定，本轮共 ${dimensions.length} 维：${dimensions.map((x) => `${x.label}（满分 ${scoreText(x.maxScore)}）`).join('、')}。`, ``, `### 维度定义`, ``, ...tableMd(['维度', 'dimension', '满分', '题数'], dimensionRows(dimensions, labels)), ``, `- 内置题库 ${getCapabilityQuestions().length} 道题；导入的自定义题目会追加进来，因此维度数量与单模型满分随题库变化；评分由本地规则完成，不调用外部裁判模型。`, `- 维度不限于内置：题库 dimension 列写什么，评测、图表与报告就用什么维度。`, `- 代码题按函数结构与关键实现检查；翻译和文言文按关键词组；数学按数值容差；常识与逻辑按标准答案。`, `- 雷达图每根轴按该维度自身满分映射，半径 = 真实得分 ÷ 该维度量程；若某模型超出声明满分，会自动扩量程而不是截断，图上标注的数字与逐题结果逐一对应。`, `- 本报告中的响应耗时为请求完成耗时，Decode 速度来自当前推理后端返回的 token 计数与耗时，仅作辅助观测。`, ``, `## 三、测试结果`, ``, `### （1）测试总结`, ``, summaryNarrative(result, dimensions, labels), ``, `### （2）模型评分总览`, ``, ...tableMd(['排名', '模型', '总分', ...dimensions.map((x) => labels[x.key] ?? x.label), '完成度', '平均响应(ms)', '平均 Decode(tok/s)'], summaryRows(summaries, dimensions)), ``, `![模型能力总分柱状图](${assets.bar})`, ``, `![${dimensions.length}维能力雷达图](${assets.radar})`, ``, `### （3）结论与推荐`, ``, ...insights(summaries, dimensions, labels).map((x) => `- ${x}`), ``, `### （4）逐题结果`, ``, ...tableMd(['模型', '维度', '题目', '得分', '状态', '回答摘要', '评分依据'], questionRows), ``].join('\n');
}

export function renderCapabilityHtml(input: CapabilityReportInput): string {
  const result = input.result; const dimensions = resolveCapabilityDimensions(result); const labels = resolveCapabilityDimensionLabels(result);
  const bar = renderCapabilityBarChart(result.summaries, dimensions); const radar = renderCapabilityRadarChart(result.summaries, dimensions);
  const questionRows = result.questions.map((item) => [item.model, labels[item.dimension] ?? item.dimension, item.title, `${number(item.score)}/${item.maxScore}`, item.status === 'success' ? '成功' : item.status === 'cancelled' ? '取消' : '失败', item.response.slice(0, 300), item.evidence.join('；') || item.errorMessage || '-']);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Ollama 模型能力横评报告</title><style>@page{size:A4;margin:14mm}body{font:14px system-ui,"Microsoft YaHei",sans-serif;max-width:1180px;margin:24px auto;color:#17202a;line-height:1.55}h1{color:#0f766e}h2{margin-top:28px;color:#164e63;border-bottom:2px solid #d9eeeb;padding-bottom:5px}h3{color:#0f766e;margin-top:20px}table{border-collapse:collapse;width:100%;font-size:11px;margin:10px 0 18px}th,td{border:1px solid #d7dee5;padding:6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#e5f3f1;color:#124e4a}.env td:first-child,.config td:first-child{width:180px;font-weight:700;background:#f8fafc}.chart{border:1px solid #dbe4ee;border-radius:8px;padding:8px;margin:12px 0;break-inside:avoid}.chart svg{max-width:100%;height:auto}.notice{background:#fff7ed;border-left:4px solid #f59e0b;padding:10px}.summary-narrative{background:#f8fafc;border-left:4px solid #0f766e;padding:12px 14px;border-radius:6px}</style></head><body><h1>Ollama 模型能力横评报告</h1><p class="notice">题库版本：${escapeHtml(result.suiteVersion)}；状态：${result.cancelled ? '部分完成（已取消或中断）' : '完成'}</p><h2>一、测试环境与配置</h2><h3>服务器环境</h3><div class="env">${tableHtml(['项目', '内容'], environmentRows(result))}</div><h3>测试配置</h3><div class="config">${tableHtml(['项目', '配置'], configRows(result))}</div><h2>二、指标定义与评分方法</h2><ul><li>评估维度由导入的题库决定，本轮共 ${dimensions.length} 维：${dimensions.map((x) => `${escapeHtml(x.label)}（满分 ${scoreText(x.maxScore)}）`).join('、')}。</li><li>内置题库 ${getCapabilityQuestions().length} 道题；导入的自定义题目会追加进来，维度与单模型满分随题库变化；评分由本地规则完成，不调用外部裁判模型。</li><li>代码按结构检查，翻译/文言文按关键词组，数学按数值容差，逻辑/常识按标准答案。</li><li>响应耗时为请求完成耗时，Decode 速度来自当前推理后端返回的 token 计数与耗时，仅作辅助观测。</li></ul><h2>三、测试结果</h2><h3>（1）测试总结</h3><p class="summary-narrative">${escapeHtml(summaryNarrative(result, dimensions, labels))}</p><h3>（2）模型评分总览</h3>${tableHtml(['排名','模型','总分',...dimensions.map((x) => labels[x.key] ?? x.label),'完成度','平均响应(ms)','平均 Decode(tok/s)'], summaryRows(result.summaries, dimensions))}<div class="chart">${bar}</div><div class="chart">${radar}</div><h3>（3）结论与推荐</h3><ul>${insights(result.summaries, dimensions, labels).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul><h3>（4）逐题结果</h3>${tableHtml(['模型','维度','题目','得分','状态','回答摘要','评分依据'], questionRows)}</body></html>`;
}

function wordTable(headers: string[], rows: string[][]): Table { return new Table({ width: { size: 9360, type: WidthType.DXA }, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'E7EDF2' }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'E7EDF2' } }, rows: [headers, ...rows].map((row, rowIndex) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: cell, bold: rowIndex === 0, font: 'Microsoft YaHei', size: 18 })] })] })) })) }); }
const heading = (text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level, spacing: { before: 220, after: 100 } });
const body = (text: string) => new Paragraph({ children: [new TextRun({ text, font: 'Microsoft YaHei' })], spacing: { after: 100 } });

export async function renderCapabilityDocx(input: CapabilityReportInput): Promise<Buffer> {
  const result = input.result; const dimensions = resolveCapabilityDimensions(result); const labels = resolveCapabilityDimensionLabels(result);
  const bar = renderCapabilityBarChart(result.summaries, dimensions); const radar = renderCapabilityRadarChart(result.summaries, dimensions);
  const barImage = new ImageRun({ type: 'svg', data: Buffer.from(bar), fallback: { type: 'png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }, transformation: { width: 620, height: 343 } });
  const radarImage = new ImageRun({ type: 'svg', data: Buffer.from(radar), fallback: { type: 'png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }, transformation: { width: 620, height: 465 } });
  const dimensionSummary = `本轮评估维度由导入的题库决定，共 ${dimensions.length} 维：${dimensions.map((x) => `${x.label}（满分 ${scoreText(x.maxScore)}、${x.questionCount} 题）`).join('、')}。评分使用本地确定性规则，不调用外部裁判模型。`;
  const children: Paragraph[] = [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Ollama 模型能力横评报告', bold: true, size: 30, color: '0F766E', font: 'Microsoft YaHei' })] }), heading('一、测试环境与配置'), heading('服务器环境', HeadingLevel.HEADING_2), wordTable(['项目', '内容'], environmentRows(result)) as unknown as Paragraph, heading('测试配置', HeadingLevel.HEADING_2), wordTable(['项目', '配置'], configRows(result)) as unknown as Paragraph, heading('二、指标定义与评分方法'), body(dimensionSummary), body('维度不限于内置 7 个：题库 dimension 列写什么维度，评测、图表与报告就用什么维度。雷达图每根轴按该维度自身满分映射，半径 = 真实得分 ÷ 该维度量程；超出声明满分时自动扩量程而不截断，图上数字与逐题结果逐一对应。'), body('响应耗时为请求完成耗时；Decode 速度来自当前推理后端返回的 token 计数与耗时，仅作辅助观测。'), heading('三、测试结果'), heading('（1）测试总结', HeadingLevel.HEADING_2), body(summaryNarrative(result, dimensions, labels)), heading('（2）模型评分总览', HeadingLevel.HEADING_2), wordTable(['排名','模型','总分',...dimensions.map((x) => labels[x.key] ?? x.label),'完成度','平均响应(ms)','平均 Decode(tok/s)'], summaryRows(result.summaries, dimensions)) as unknown as Paragraph, new Paragraph({ children: [barImage] }), new Paragraph({ children: [radarImage] }), heading('（3）结论与推荐', HeadingLevel.HEADING_2), ...insights(result.summaries, dimensions, labels).map(body), heading('（4）逐题结果', HeadingLevel.HEADING_2), wordTable(['模型','维度','题目','得分','状态','回答摘要','评分依据'], result.questions.map((item) => [item.model, labels[item.dimension] ?? item.dimension, item.title, `${number(item.score)}/${item.maxScore}`, item.status, item.response.slice(0, 180), item.evidence.join('；') || item.errorMessage || '-'])) as unknown as Paragraph];
  return Packer.toBuffer(new Document({ sections: [{ properties: { page: { margin: { top: 900, right: 800, bottom: 900, left: 800 } } }, children: children as unknown as Paragraph[] }] }));
}

export async function exportCapabilityReports(input: CapabilityReportInput, formats: ReportFormat[], outputDirectory: string, renderPdf: HtmlPdfRenderer): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true }); const current = stamp(); const paths: string[] = []; const barPath = join(outputDirectory, `ollama-capability-score-${current}.svg`); const radarPath = join(outputDirectory, `ollama-capability-radar-${current}.svg`);
  if (formats.includes('markdown')) { const dimensions = resolveCapabilityDimensions(input.result); await writeFile(barPath, renderCapabilityBarChart(input.result.summaries, dimensions), 'utf8'); await writeFile(radarPath, renderCapabilityRadarChart(input.result.summaries, dimensions), 'utf8'); const path = join(outputDirectory, `ollama-capability-${current}.md`); await writeFile(path, renderCapabilityMarkdown(input, { bar: barPath.split(/[/\\]/).pop() ?? 'capability-score.svg', radar: radarPath.split(/[/\\]/).pop() ?? 'capability-radar.svg' }), 'utf8'); paths.push(path, barPath, radarPath); }
  if (formats.includes('html')) { const path = join(outputDirectory, `ollama-capability-${current}.html`); await writeFile(path, renderCapabilityHtml(input), 'utf8'); paths.push(path); }
  if (formats.includes('docx')) { const path = join(outputDirectory, `ollama-capability-${current}.docx`); await writeFile(path, await renderCapabilityDocx(input)); paths.push(path); }
  if (formats.includes('pdf')) { const path = join(outputDirectory, `ollama-capability-${current}.pdf`); await writeFile(path, await renderPdf(renderCapabilityHtml(input))); paths.push(path); }
  return paths;
}
