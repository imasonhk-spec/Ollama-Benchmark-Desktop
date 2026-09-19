import { axisTicks, capabilityDimensionLabel, resolveAxisMax, resolveCapabilityDimensions } from './CapabilityDimensions';
import type { CapabilityDimensionMeta, CapabilityModelSummary } from './types';

/* 12 色，够 12 个模型同时叠加仍可区分 */
const COLORS = ['#ef476f', '#06b6d4', '#f59e0b', '#64748b', '#8b5cf6', '#10b981', '#0ea5e9', '#d946ef', '#84cc16', '#f97316', '#14b8a6', '#6366f1'];
const xml = (value: string): string => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const num = (value: number | undefined, digits = 1): string => value === undefined || !Number.isFinite(value) ? '-' : String(Number(value.toFixed(digits)));

type DimensionInput = CapabilityDimensionMeta[] | undefined;

/** 图表可接受的维度入参：既支持显式传入，也支持从汇总结果反推（兼容旧结果）。 */
function resolveDimensions(dimensions: DimensionInput, summaries: CapabilityModelSummary[]): CapabilityDimensionMeta[] {
  if (dimensions?.length) return dimensions;
  return resolveCapabilityDimensions({ dimensions: undefined, questions: [], summaries });
}

function score(summary: CapabilityModelSummary, key: string): number {
  const value = Number(summary.dimensionScores?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function declaredMax(summary: CapabilityModelSummary, key: string, fallback: number): number {
  const value = Number(summary.dimensionMaxScores?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type CapabilityChartDiagnostics = {
  key: string;
  label: string;
  declaredMax: number;
  axisMax: number;
  expanded: boolean;
  best?: string;
  worst?: string;
  bestScore?: number;
  worstScore?: number;
  /** 各模型在该维度上的得分率极差（百分点） */
  spreadPoints: number;
};

/**
 * 图表的数值诊断：让"图上体现不出差异"这件事变成可解释、可核对的数据。
 * spreadPoints 使用**图上实际半径**所对应的得分率，而不是绝对分数，避免量纲不同的维度互相误导。
 */
export function capabilityChartDiagnostics(summaries: CapabilityModelSummary[], dimensions?: DimensionInput): CapabilityChartDiagnostics[] {
  const dims = resolveDimensions(dimensions, summaries);
  return dims.map((dimension) => {
    const entries = summaries.map((summary) => ({ model: summary.model, value: score(summary, dimension.key), max: declaredMax(summary, dimension.key, dimension.maxScore) }));
    const observed = entries.reduce((max, entry) => Math.max(max, entry.value), 0);
    const { axisMax, expanded } = resolveAxisMax(dimension.maxScore, observed);
    const ratios = entries.map((entry) => ({ model: entry.model, value: entry.value, ratio: (entry.value / axisMax) * 100 }));
    const sorted = [...ratios].sort((left, right) => right.ratio - left.ratio);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    return {
      key: dimension.key, label: dimension.label, declaredMax: dimension.maxScore, axisMax, expanded,
      best: best?.model, worst: worst?.model, bestScore: best?.value, worstScore: worst?.value,
      spreadPoints: best && worst ? best.ratio - worst.ratio : 0,
    };
  });
}

/** 图注：把"量程、是否被扩过、哪几个维度区分度低"写在图上，避免看图的人误判。 */
function caption(diagnostics: CapabilityChartDiagnostics[], hasData: boolean): string[] {
  const expanded = diagnostics.filter((item) => item.expanded);
  const low = diagnostics.filter((item) => item.spreadPoints < 5);
  const lines = ['每根轴的 0 → 100% 按该维度自身满分映射（轴末端灰字为该维度满分），顶点标注为真实得分。'];
  if (expanded.length) lines.push(`⚠ 已自动扩量程（未截断任何数值）：${expanded.map((item) => `${item.label} ${num(item.declaredMax)}→${num(item.axisMax)}`).join('、')}。`);
  if (!hasData) return lines;
  if (low.length) lines.push(`⚠ 区分度偏低（各模型得分率极差 < 5pt）：${low.map((item) => `${item.label}(${num(item.spreadPoints)}pt)`).join('、')}，这些维度上多边形几乎重合，是数据本身差异小。`);
  else lines.push('各维度得分率极差均 ≥ 5pt，雷达形状可分辨模型差异。');
  return lines;
}

export function renderCapabilityBarChart(summaries: CapabilityModelSummary[], dimensions?: DimensionInput): string {
  const dims = resolveDimensions(dimensions, summaries);
  const width = 760; const height = 420; const left = 62; const top = 42; const bottom = 92;
  const chartHeight = height - top - bottom; const chartWidth = width - left - 26;
  const declared = summaries.length ? Math.max(...summaries.map((item) => Number(item.maxScore) || 0)) : 0;
  const observed = summaries.length ? Math.max(...summaries.map((item) => Number(item.totalScore) || 0)) : 0;
  const { axisMax, expanded } = resolveAxisMax(declared, observed);
  const slot = chartWidth / Math.max(1, summaries.length); const barWidth = Math.min(90, slot * 0.62);
  const bars = summaries.map((summary, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    const value = Number(summary.totalScore) || 0;
    const barHeight = Math.max(value > 0 ? 2 : 0, (value / axisMax) * chartHeight); const y = top + chartHeight - barHeight;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="5" fill="${COLORS[index % COLORS.length]}"><title>${xml(`${summary.model}：${num(value)}/${num(summary.maxScore)}（得分率 ${num((value / axisMax) * 100)}%）`)}</title></rect><text x="${(x + barWidth / 2).toFixed(1)}" y="${Math.max(20, y - 8).toFixed(1)}" text-anchor="middle" font-size="15" font-weight="700">${xml(num(value))}</text><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 58}" text-anchor="middle" font-size="12">${xml(summary.model)}</text><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 38}" text-anchor="middle" font-size="11">完成 ${summary.completedCount}/${summary.questionCount}</text>`;
  }).join('');
  // 刻度按实际量程生成，不再写死 0/15/30/45/60
  const gridValues = axisTicks(axisMax);
  const grid = gridValues.map((value) => { const y = top + chartHeight - (value / axisMax) * chartHeight; return `<line x1="${left}" x2="${width - 26}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#dbe4ee"${value === axisMax ? ' stroke-width="1.5"' : ''}><title>${xml(`${num(value)} 分`)}</title></line><text x="${left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#475569">${xml(num(value))}</text>`; }).join('');
  const note = expanded ? `<text x="${width - 26}" y="${height - 18}" text-anchor="end" font-size="11" fill="#b45309">量程已从满分 ${xml(num(declared))} 自动扩到 ${xml(num(axisMax))}（有模型总分超出，未截断）</text>` : `<text x="${width - 26}" y="${height - 18}" text-anchor="end" font-size="11" fill="#64748b">满分 ${xml(num(declared))}；柱顶数字为真实得分，均可反算核对（共 ${dims.length} 个维度）</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="模型能力总分柱状图"><rect width="100%" height="100%" fill="#ffffff"/><text x="${width / 2}" y="24" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">模型能力总分（满分 ${xml(num(declared))}）</text>${grid}<line x1="${left}" x2="${width - 26}" y1="${top + chartHeight}" y2="${top + chartHeight}" stroke="#64748b"/>${bars}${note}</svg>`;
}

export function renderCapabilityRadarChart(summaries: CapabilityModelSummary[], dimensions?: DimensionInput): string {
  const dims = resolveDimensions(dimensions, summaries);
  const diagnostics = capabilityChartDiagnostics(summaries, dims);
  const width = 1_020;
  const rowHeight = 62;
  const height = Math.max(660, 230 + summaries.length * rowHeight);
  const cx = 315; const cy = 330; const radius = 205;
  const count = Math.max(1, dims.length);
  const point = (ratio: number, index: number, scale = radius): [number, number] => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
    return [cx + Math.cos(angle) * scale * ratio, cy + Math.sin(angle) * scale * ratio];
  };
  const polygon = (ratios: number[], scale = radius) => ratios.map((ratio, index) => point(ratio, index, scale).map((item) => item.toFixed(1)).join(',')).join(' ');
  const grid = [0.2, 0.4, 0.6, 0.8, 1].map((level) => `<polygon points="${polygon(dims.map(() => level))}" fill="none" stroke="#94a3b8" stroke-width="${level === 1 ? 2 : 1}"><title>${xml(`各维度自身量程的 ${level * 100}%`)}</title></polygon>`).join('');
  const labelFont = count > 14 ? 11 : count > 10 ? 12 : 15;
  const axes = dims.map((dimension, index) => {
    const [x, y] = point(1, index); const [lx, ly] = point(1.14, index);
    const axisMax = diagnostics[index]?.axisMax ?? dimension.maxScore;
    const offset = capabilityDimensionLabel(dimension.key, dimension.label);
    const label = offset.length > 8 ? `${offset.slice(0, 7)}…` : offset;
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#94a3b8" stroke-width="1.2"><title>${xml(`${offset}：0 → ${num(axisMax)}（${dimension.questionCount} 题，满分 ${num(dimension.maxScore)}）`)}</title></line>`
      + `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="${labelFont}" font-weight="600" fill="#1e293b">${xml(label)}<tspan font-size="${labelFont - 3}" font-weight="400" fill="#64748b"> ${xml(num(axisMax))}</tspan></text>`;
  }).join('');
  const showVertexValues = summaries.length > 0 && summaries.length <= 3;
  const data = summaries.map((summary, index) => {
    const color = COLORS[index % COLORS.length];
    // 半径 = 真实得分 / 该维度有效量程；有效量程保证 ≥ 实际最大值，因此永远不会被截断
    const ratios = dims.map((dimension, dimensionIndex) => {
      const value = score(summary, dimension.key);
      const axisMax = diagnostics[dimensionIndex]?.axisMax ?? dimension.maxScore;
      return axisMax > 0 ? value / axisMax : 0;
    });
    const points = ratios.map((ratio, valueIndex) => {
      const [x, y] = point(ratio, valueIndex);
      const dimension = dims[valueIndex];
      const axisMax = diagnostics[valueIndex]?.axisMax ?? dimension.maxScore;
      const value = score(summary, dimension.key);
      const title = `${summary.model} · ${capabilityDimensionLabel(dimension.key, dimension.label)}：${num(value)}/${num(axisMax)}（得分率 ${num(ratio * 100)}%）`;
      const label = showVertexValues ? `<text x="${x.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${color}">${xml(num(value))}</text>` : '';
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"><title>${xml(title)}</title></circle>${label}`;
    }).join('');
    return `<polygon points="${polygon(ratios)}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="${index < 6 ? 2.8 : 2}" stroke-linejoin="round" vector-effect="non-scaling-stroke"><title>${xml(summary.model)}</title></polygon>${points}`;
  }).join('');
  const legendX = 690;
  const legend = summaries.map((summary, index) => {
    const y = 76 + index * rowHeight; const raw = summary.model; const label = raw.length > 31 ? `${raw.slice(0, 30)}…` : raw;
    return `<circle cx="${legendX}" cy="${y}" r="6" fill="${COLORS[index % COLORS.length]}"/><text x="${legendX + 15}" y="${y + 5}" font-size="13" fill="#1e293b"><title>${xml(`${raw}：总分 ${num(summary.totalScore)}/${num(summary.maxScore)}`)}</title>${xml(label)}（${xml(num(summary.totalScore))}分）</text>`;
  }).join('');
  const subtitle = `${dims.length} 维；每根轴 0 → 该维度满分（灰字），半径 = 真实得分 ÷ 该维度量程，无截断。`;
  const noteLines = caption(diagnostics, summaries.length > 0).map((text, index) => `<text x="24" y="${(cy + radius + 62 + index * 18).toFixed(1)}" font-size="12" fill="${text.startsWith('⚠') ? '#b45309' : '#475569'}">${xml(text)}</text>`).join('');
  const empty = summaries.length ? '' : `<text x="${cx}" y="${cy}" text-anchor="middle" font-size="15" fill="#64748b">暂无可绘制的模型得分</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${dims.length}维模型能力雷达图"><rect width="100%" height="100%" fill="#ffffff"/><text x="${cx}" y="28" text-anchor="middle" font-size="19" font-weight="700" fill="#0f172a">${dims.length}维度能力雷达图</text><text x="${cx}" y="50" text-anchor="middle" font-size="11.5" fill="#64748b">${xml(subtitle)}</text>${grid}${axes}${empty}${data}${noteLines}<line x1="625" y1="35" x2="625" y2="${Math.min(height - 24, 76 + summaries.length * rowHeight)}" stroke="#cbd5e1" stroke-width="1"/>${legend}</svg>`;
}
