import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { AdvancedRunResult } from '../../shared/AdvancedScenarios';
import type { ReportFormat } from '../../shared/types';
import { accelerationLabel, backendLabel } from '../../shared/types';
import { ADVANCED_SCENARIO_LABELS, JUDGE_DEFAULTS, SCENARIO_ERROR_LABELS } from '../../shared/AdvancedScenarios';
import type { HtmlPdfRenderer } from './ReportExporter';

export type AdvancedReportInput = { result: AdvancedRunResult };
const stamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const escapeMd = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
const number = (value: number | undefined, digits = 1) => value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);
const pct = (value: number | undefined, digits = 1) => value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`;
const size = (value: number | undefined) => { if (!value) return '未获取'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let n = value; let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; } return `${n.toFixed(i ? 2 : 0)} ${units[i]}`; };
const tableMd = (headers: string[], rows: string[][]) => [`| ${headers.map(escapeMd).join(' | ')} |`, `|${headers.map((_, i) => i ? '---:' : '---').join('|')}|`, ...rows.map((row) => `| ${row.map(escapeMd).join(' | ')} |`)];
const tableHtml = (headers: string[], rows: string[][]) => `<table><thead><tr>${headers.map((x) => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

function environmentRows(result: AdvancedRunResult): string[][] {
  const env = result.environment; const system = env.systemInfo;
  return [['推理后端', backendLabel(env.backend)], ['部署方式', env.deployment], ['运行程序', env.binary], ['版本', env.version ?? '未获取'], ['API', `${env.apiHost}:${env.apiPort}`], ['加速实测', accelerationLabel(env.acceleration)], ['GPU', env.gpuModels.join(', ') || env.gpuVendor], ['芯片平台', system?.chipPlatform ?? '未获取'], ['CPU', system?.cpuModel ?? '未获取'], ['内存', size(system?.memoryBytes)], ['存储', size(system?.storageTotalBytes)], ['操作系统', system?.osName ?? '未获取'], ['内核 / 架构', [system?.kernel, system?.architecture].filter(Boolean).join(' / ') || '未获取']];
}

function configRows(result: AdvancedRunResult): string[][] {
  const config = result.config;
  const scenarioList = config.scenarios.map((scenario) => ADVANCED_SCENARIO_LABELS[scenario]).join('、') || '（未选择）';
  return [['评测模型', config.model], ['启用场景', scenarioList], ['测试方案版本', result.planVersion], ['每请求超时', `${Math.round(config.requestTimeoutMs / 1000)} 秒`], ['确定性种子', String(config.seed)], ['并发档位', config.concurrency.levels.join(', ')], ['上下文档位', config.maxContext.levels.join(', ')], ['长文本长度档', config.needle.lengths.join(', ')]];
}

function latencyRows(result: AdvancedRunResult): string[][] {
  if (!result.latency) return [];
  return result.latency.combos.map((combo) => [String(combo.inputTokens), String(combo.outputTokens), String(combo.success), String(combo.failed), number(combo.avgTtftMs, 0), number(combo.avgE2eMs, 0), number(combo.p95E2eMs, 0), number(combo.avgTpotMs, 1), number(combo.avgItlMs, 1), number(combo.decodeTps), number(combo.prefillTps), number(combo.overallTps), number(combo.avgInputTokens, 0), number(combo.avgOutputTokens, 0)]);
}

function concurrencyRows(result: AdvancedRunResult): string[][] {
  if (!result.concurrency) return [];
  return result.concurrency.levels.map((level) => [String(level.concurrency), level.steady ? '稳态复测' : '探测', String(level.success), String(level.failed), number(level.successRatePercent, 1), number(level.avgTtftMs, 0), number(level.p95TtftMs, 0), number(level.avgE2eMs, 0), number(level.p50E2eMs, 0), number(level.p95E2eMs, 0), number(level.p99E2eMs, 0), number(level.avgTpotMs, 1), number(level.avgItlMs, 1), number(level.qps, 2), number(level.outputTokensPerSecond), String(level.totalOutputTokens), level.verdict.passed ? '通过' : '未过', level.verdict.reasons.join('；')]);
}

function maxContextRows(result: AdvancedRunResult): string[][] {
  if (!result.maxContext) return [];
  return result.maxContext.points.map((point) => [String(point.inputTokens), point.ok ? '成功' : '失败', number(point.ttftMs, 0), number(point.e2eMs, 0), number(point.prefillTps), point.actualInputTokens ? String(point.actualInputTokens) : '-', point.errorKind ? SCENARIO_ERROR_LABELS[point.errorKind] : '-', point.errorMessage ?? '-']);
}

function stabilityRows(result: AdvancedRunResult): string[][] {
  if (!result.stability) return [];
  return result.stability.buckets.map((bucket) => [String(bucket.index), `${bucket.startSeconds}s`, String(bucket.success), String(bucket.failed), number(bucket.p50E2eMs, 0), number(bucket.p95E2eMs, 0), number(bucket.p99E2eMs, 0), number(bucket.avgTtftMs, 0), number(bucket.p95TtftMs, 0), String(bucket.outputTokens), number(bucket.decodeTps)]);
}

function fairnessRows(result: AdvancedRunResult): string[][] {
  if (!result.fairness) return [];
  return result.fairness.stats.map((stat) => [String(stat.concurrency), String(stat.samples), number(stat.meanE2eMs, 0), number(stat.medianE2eMs, 0), number(stat.p95E2eMs, 0), number(stat.p99E2eMs, 0), number(stat.maxE2eMs, 0), number(stat.cv, 3), number(stat.maxOverMedian, 2), number(stat.p99OverP50, 2), String(stat.starved), stat.verdict === 'fair' ? '公平' : stat.verdict === 'warn' ? '需关注' : '不公平']);
}

function needleRows(result: AdvancedRunResult): string[][] {
  if (!result.needle) return [];
  return result.needle.recallByLength.map((recall) => [String(recall.lengthTokens), String(recall.correct), String(recall.total), pct(recall.recall, 1)]);
}

function degradationRows(result: AdvancedRunResult): string[][] {
  if (!result.degradation) return [];
  const degradation = result.degradation;
  return [['样本总数', String(degradation.sampleCount)], ['空响应率', pct(degradation.emptyResponseRate)], ['重复率', pct(degradation.duplicateRate)], ['finishReason 分布', Object.entries(degradation.finishReasonBreakdown).map(([key, value]) => `${key}: ${value}`).join('；') || '无'], ['退化标记', degradation.flags.length ? degradation.flags.join('；') : '无']];
}

function executiveSummary(result: AdvancedRunResult): string {
  const parts: string[] = [];
  parts.push(result.cancelled ? '本轮高级评测已提前结束，以下结论基于已完成的场景。' : '本轮高级评测已完成。');
  if (result.concurrency?.recommendedConcurrency !== undefined) {
    parts.push(`并发阶梯：基线 P95 ${number(result.concurrency.baselineP95Ms, 0)}ms，推荐并发 ${result.concurrency.recommendedConcurrency}（最大通过 ${result.concurrency.maxPassingConcurrency ?? '-'}）。`);
  }
  if (result.maxContext?.limitTokens !== undefined) {
    parts.push(`最大上下文：${result.maxContext.limitTokens} tokens（首个失败档 ${result.maxContext.firstFailTokens ?? '未触发'}）。`);
  }
  if (result.stability) {
    const verdict = result.stability.verdict === 'stable' ? '稳态' : result.stability.verdict === 'minor' ? '轻微漂移' : '明显退化';
    parts.push(`稳态压测：${verdict}，P95 漂移 ${number(result.stability.driftPercent, 1)}%，TPM ${number(result.stability.tpm, 0)}。`);
  }
  if (result.fairness) {
    const worst = result.fairness.stats.find((stat) => stat.verdict === 'unfair');
    parts.push(worst ? `公平性：并发 ${worst.concurrency} 出现不公平（CV ${number(worst.cv, 3)}，饿死 ${worst.starved}）。` : '公平性：各并发档位均处于公平或需关注区间。');
  }
  if (result.needle) {
    parts.push(`长文本召回：综合召回率 ${pct(result.needle.overallRecall)}。`);
  }
  if (result.errors.length) {
    parts.push(`运行错误 ${result.errors.length} 条，详见文末错误附录。`);
  }
  return parts.join('');
}

export function renderAdvancedMarkdown(input: AdvancedReportInput): string {
  const result = input.result; const lines: string[] = [];
  lines.push('# Ollama 模型高级评测报告', '', `> 测试方案版本：${result.planVersion}；状态：${result.cancelled ? '部分完成（已取消或中断）' : '完成'}；模型：${result.config.model}`, '');
  lines.push('## 一、测试环境与配置', '', '### 服务器环境', '', ...tableMd(['项目', '内容'], environmentRows(result)), '', '### 测试配置', '', ...tableMd(['项目', '配置'], configRows(result)), '');
  lines.push('## 二、评测总结', '', executiveSummary(result), '');
  if (result.degradation) {
    lines.push('## 三、响应退化检测', '', ...tableMd(['指标', '数值'], degradationRows(result)), '');
  }
  if (result.latency) {
    lines.push('## 四、Latency 基准', '', '固定并发 1，扫描 input×output 档位，摸单请求性能基线。', '', ...tableMd(['输入', '输出', '成功', '失败', 'TTFT(ms)', 'E2E(ms)', 'P95-E2E(ms)', 'TPOT(ms)', 'ITL(ms)', 'Decode(t/s)', 'Prefill(t/s)', 'Overall(t/s)', '平均in', '平均out'], latencyRows(result)), '');
  }
  if (result.concurrency) {
    lines.push('## 五、并发阶梯压测', '', `判定门槛：成功率 ≥ ${JUDGE_DEFAULTS.minSuccessRatePercent}% 且 P95-E2E ≤ 基线 × ${JUDGE_DEFAULTS.p95LatencyMultiplier}。`, '', ...tableMd(['并发', '阶段', '成功', '失败', '成功率%', 'TTFT', 'P95-TTFT', 'E2E', 'P50', 'P95', 'P99', 'TPOT', 'ITL', 'QPS', 'out t/s', '输出tokens', '判定', '原因'], concurrencyRows(result)), '');
    if (result.concurrency.autotune) {
      lines.push(`自适应压测阶梯：${result.concurrency.autotune.laddered.join(' → ')}；二分收敛：${result.concurrency.autotune.refined.join(' → ')}。`, '');
    }
  }
  if (result.maxContext) {
    lines.push('## 六、最大上下文探测', '', '输入长度递增探临界点，首个失败即停。', '', ...tableMd(['输入tokens', '结果', 'TTFT', 'E2E', 'Prefill(t/s)', '实际输入', '错误类型', '错误信息'], maxContextRows(result)), '');
  }
  if (result.stability) {
    lines.push('## 七、稳态漂移', '', `按 ${result.stability.durationMinutes} 分钟分桶监测 P95 漂移。`, '', ...tableMd(['桶', '起点', '成功', '失败', 'P50', 'P95', 'P99', 'TTFT', 'P95-TTFT', '输出tokens', 'Decode(t/s)'], stabilityRows(result)), '');
  }
  if (result.fairness) {
    lines.push('## 八、公平性分析', '', '复用并发压测样本，分析请求间延迟离散度与饿死请求。', '', ...tableMd(['并发', '样本', '均值', '中位', 'P95', 'P99', '最大', 'CV', 'max/med', 'P99/P50', '饿死数', '判定'], fairnessRows(result)), '');
  }
  if (result.needle) {
    lines.push('## 九、长文本召回', '', '长文本中埋入关键事实，按长度档统计召回率。', '', ...tableMd(['长度tokens', '正确', '总数', '召回率'], needleRows(result)), '');
  }
  if (result.errors.length) {
    lines.push('## 十、错误附录', '', ...result.errors.map((error) => `- ${error}`), '');
  }
  return lines.join('\n');
}

export function renderAdvancedHtml(input: AdvancedReportInput): string {
  const result = input.result;
  const section = (title: string, html: string) => `<h2>${escapeHtml(title)}</h2>${html}`;
  let body = `<h1>Ollama 模型高级评测报告</h1><p class="notice">测试方案版本：${escapeHtml(result.planVersion)}；状态：${result.cancelled ? '部分完成（已取消或中断）' : '完成'}；模型：${escapeHtml(result.config.model)}</p>`;
  body += section('一、测试环境与配置', `<h3>服务器环境</h3>${tableHtml(['项目', '内容'], environmentRows(result))}<h3>测试配置</h3>${tableHtml(['项目', '配置'], configRows(result))}`);
  body += section('二、评测总结', `<p class="summary-narrative">${escapeHtml(executiveSummary(result))}</p>`);
  if (result.degradation) body += section('三、响应退化检测', tableHtml(['指标', '数值'], degradationRows(result)));
  if (result.latency) body += section('四、Latency 基准', tableHtml(['输入', '输出', '成功', '失败', 'TTFT(ms)', 'E2E(ms)', 'P95-E2E(ms)', 'TPOT(ms)', 'ITL(ms)', 'Decode(t/s)', 'Prefill(t/s)', 'Overall(t/s)', '平均in', '平均out'], latencyRows(result)));
  if (result.concurrency) {
    let html = `<p>判定门槛：成功率 ≥ ${JUDGE_DEFAULTS.minSuccessRatePercent}% 且 P95-E2E ≤ 基线 × ${JUDGE_DEFAULTS.p95LatencyMultiplier}。</p>${tableHtml(['并发', '阶段', '成功', '失败', '成功率%', 'TTFT', 'P95-TTFT', 'E2E', 'P50', 'P95', 'P99', 'TPOT', 'ITL', 'QPS', 'out t/s', '输出tokens', '判定', '原因'], concurrencyRows(result))}`;
    if (result.concurrency.autotune) html += `<p>自适应压测阶梯：${result.concurrency.autotune.laddered.join(' → ')}；二分收敛：${result.concurrency.autotune.refined.join(' → ')}。</p>`;
    body += section('五、并发阶梯压测', html);
  }
  if (result.maxContext) body += section('六、最大上下文探测', tableHtml(['输入tokens', '结果', 'TTFT', 'E2E', 'Prefill(t/s)', '实际输入', '错误类型', '错误信息'], maxContextRows(result)));
  if (result.stability) body += section('七、稳态漂移', tableHtml(['桶', '起点', '成功', '失败', 'P50', 'P95', 'P99', 'TTFT', 'P95-TTFT', '输出tokens', 'Decode(t/s)'], stabilityRows(result)));
  if (result.fairness) body += section('八、公平性分析', tableHtml(['并发', '样本', '均值', '中位', 'P95', 'P99', '最大', 'CV', 'max/med', 'P99/P50', '饿死数', '判定'], fairnessRows(result)));
  if (result.needle) body += section('九、长文本召回', tableHtml(['长度tokens', '正确', '总数', '召回率'], needleRows(result)));
  if (result.errors.length) body += section('十、错误附录', result.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join(''));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Ollama 模型高级评测报告</title><style>@page{size:A4;margin:14mm}body{font:13px system-ui,"Microsoft YaHei",sans-serif;max-width:1180px;margin:24px auto;color:#17202a;line-height:1.55}h1{color:#1d4ed8}h2{margin-top:28px;color:#1e3a8a;border-bottom:2px solid #dbe4ee;padding-bottom:5px}h3{color:#1d4ed8;margin-top:20px}table{border-collapse:collapse;width:100%;font-size:10px;margin:10px 0 18px}th,td{border:1px solid #d7dee5;padding:5px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#e7eefb;color:#1e3a8a}.env td:first-child,.config td:first-child{width:180px;font-weight:700;background:#f8fafc}.notice{background:#fff7ed;border-left:4px solid #f59e0b;padding:10px}.summary-narrative{background:#f8fafc;border-left:4px solid #1d4ed8;padding:12px 14px;border-radius:6px}</style></head><body>${body}</body></html>`;
}

function wordTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D7DEE5' }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'E7EDF2' }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'E7EDF2' } },
    rows: [headers, ...rows].map((row, rowIndex) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: cell, bold: rowIndex === 0, font: 'Microsoft YaHei', size: 16 })] })] })) })),
  });
}
const heading = (text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level, spacing: { before: 220, after: 100 } });
const body = (text: string) => new Paragraph({ children: [new TextRun({ text, font: 'Microsoft YaHei' })], spacing: { after: 100 } });

export async function renderAdvancedDocx(input: AdvancedReportInput): Promise<Buffer> {
  const result = input.result; const children: Paragraph[] = [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Ollama 模型高级评测报告', bold: true, size: 30, color: '1D4ED8', font: 'Microsoft YaHei' })] }), body(`测试方案版本：${result.planVersion}；状态：${result.cancelled ? '部分完成（已取消或中断）' : '完成'}；模型：${result.config.model}`), heading('一、测试环境与配置'), heading('服务器环境', HeadingLevel.HEADING_2), wordTable(['项目', '内容'], environmentRows(result)) as unknown as Paragraph, heading('测试配置', HeadingLevel.HEADING_2), wordTable(['项目', '配置'], configRows(result)) as unknown as Paragraph, heading('二、评测总结'), body(executiveSummary(result))];
  if (result.degradation) { children.push(heading('三、响应退化检测', HeadingLevel.HEADING_2), wordTable(['指标', '数值'], degradationRows(result)) as unknown as Paragraph); }
  if (result.latency) { children.push(heading('四、Latency 基准', HeadingLevel.HEADING_2), wordTable(['输入', '输出', '成功', '失败', 'TTFT(ms)', 'E2E(ms)', 'P95-E2E(ms)', 'TPOT(ms)', 'ITL(ms)', 'Decode(t/s)', 'Prefill(t/s)', 'Overall(t/s)', '平均in', '平均out'], latencyRows(result)) as unknown as Paragraph); }
  if (result.concurrency) { children.push(heading('五、并发阶梯压测', HeadingLevel.HEADING_2), wordTable(['并发', '阶段', '成功', '失败', '成功率%', 'TTFT', 'P95-TTFT', 'E2E', 'P50', 'P95', 'P99', 'TPOT', 'ITL', 'QPS', 'out t/s', '输出tokens', '判定', '原因'], concurrencyRows(result)) as unknown as Paragraph); }
  if (result.maxContext) { children.push(heading('六、最大上下文探测', HeadingLevel.HEADING_2), wordTable(['输入tokens', '结果', 'TTFT', 'E2E', 'Prefill(t/s)', '实际输入', '错误类型', '错误信息'], maxContextRows(result)) as unknown as Paragraph); }
  if (result.stability) { children.push(heading('七、稳态漂移', HeadingLevel.HEADING_2), wordTable(['桶', '起点', '成功', '失败', 'P50', 'P95', 'P99', 'TTFT', 'P95-TTFT', '输出tokens', 'Decode(t/s)'], stabilityRows(result)) as unknown as Paragraph); }
  if (result.fairness) { children.push(heading('八、公平性分析', HeadingLevel.HEADING_2), wordTable(['并发', '样本', '均值', '中位', 'P95', 'P99', '最大', 'CV', 'max/med', 'P99/P50', '饿死数', '判定'], fairnessRows(result)) as unknown as Paragraph); }
  if (result.needle) { children.push(heading('九、长文本召回', HeadingLevel.HEADING_2), wordTable(['长度tokens', '正确', '总数', '召回率'], needleRows(result)) as unknown as Paragraph); }
  if (result.errors.length) { children.push(heading('十、错误附录', HeadingLevel.HEADING_2), ...result.errors.map((error) => body(`• ${error}`))); }
  return Packer.toBuffer(new Document({ sections: [{ properties: { page: { margin: { top: 900, right: 800, bottom: 900, left: 800 } } }, children: children as unknown as Paragraph[] }] }));
}

export async function exportAdvancedReports(input: AdvancedReportInput, formats: ReportFormat[], outputDirectory: string, renderPdf: HtmlPdfRenderer): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true }); const current = stamp(); const paths: string[] = [];
  if (formats.includes('markdown')) { const path = join(outputDirectory, `ollama-advanced-${current}.md`); await writeFile(path, renderAdvancedMarkdown(input), 'utf8'); paths.push(path); }
  if (formats.includes('html')) { const path = join(outputDirectory, `ollama-advanced-${current}.html`); await writeFile(path, renderAdvancedHtml(input), 'utf8'); paths.push(path); }
  if (formats.includes('docx')) { const path = join(outputDirectory, `ollama-advanced-${current}.docx`); await writeFile(path, await renderAdvancedDocx(input)); paths.push(path); }
  if (formats.includes('pdf')) { const path = join(outputDirectory, `ollama-advanced-${current}.pdf`); await writeFile(path, await renderPdf(renderAdvancedHtml(input))); paths.push(path); }
  return paths;
}
