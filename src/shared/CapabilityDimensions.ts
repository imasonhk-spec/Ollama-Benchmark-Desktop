import {
  CAPABILITY_DIMENSION_LABELS,
  CAPABILITY_DIMENSIONS,
  type CapabilityDimension,
  type CapabilityDimensionMeta,
  type CapabilityModelSummary,
  type CapabilityQuestion,
  type CapabilityQuestionResult,
  type CapabilityRunResult,
} from './types';

/**
 * 维度解析：V2.4 起评测维度由题库决定，不再固定为内置 7 个。
 *
 * 优先级：
 *   1. 题库中的 dimensionLabel 列（导入的自定义题库自带中文名）
 *   2. 内置维度的中文标签
 *   3. 维度标识本身
 */
export function capabilityDimensionLabel(dimension: CapabilityDimension, ...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return CAPABILITY_DIMENSION_LABELS[dimension] ?? dimension;
}

/** 按题库中首次出现的顺序汇总维度，maxScore = 该维度所有题目满分之和。 */
export function collectCapabilityDimensions(questions: CapabilityQuestion[]): CapabilityDimensionMeta[] {
  const order: CapabilityDimension[] = [];
  const acc = new Map<CapabilityDimension, { label?: string; maxScore: number; questionCount: number }>();
  for (const question of questions) {
    const key = question.dimension;
    if (!acc.has(key)) {
      acc.set(key, { label: question.dimensionLabel, maxScore: 0, questionCount: 0 });
      order.push(key);
    }
    const entry = acc.get(key)!;
    entry.maxScore += Number.isFinite(question.maxScore) ? question.maxScore : 0;
    entry.questionCount += 1;
    if (!entry.label && question.dimensionLabel) entry.label = question.dimensionLabel;
  }
  return order.map((key) => {
    const entry = acc.get(key)!;
    return { key, label: capabilityDimensionLabel(key, entry.label), maxScore: entry.maxScore, questionCount: entry.questionCount };
  });
}

/**
 * 从"逐题结果"推导维度（V2.3 及更早的结果对象没有 dimensions 字段，用它兜底）。
 * 同一道题会在每个模型下出现一次，因此按题目 id 去重后再累加满分，避免满分被模型数量放大。
 */
function dimensionsFromResults(results: readonly CapabilityQuestionResult[]): CapabilityDimensionMeta[] {
  const order: CapabilityDimension[] = [];
  const acc = new Map<CapabilityDimension, { maxScore: number; questionCount: number }>();
  const seenQuestionIds = new Set<string>();
  for (const item of results) {
    if (!acc.has(item.dimension)) {
      acc.set(item.dimension, { maxScore: 0, questionCount: 0 });
      order.push(item.dimension);
    }
    const entry = acc.get(item.dimension)!;
    const uniqueId = `${item.dimension}::${item.id}`;
    if (seenQuestionIds.has(uniqueId)) continue;
    seenQuestionIds.add(uniqueId);
    entry.maxScore += Number.isFinite(item.maxScore) ? item.maxScore : 0;
    entry.questionCount += 1;
  }
  return order.map((key) => {
    const entry = acc.get(key)!;
    return { key, label: capabilityDimensionLabel(key), maxScore: entry.maxScore, questionCount: entry.questionCount };
  });
}

function dimensionsFromSummaries(summaries: CapabilityModelSummary[]): CapabilityDimensionMeta[] {
  const keys = new Set<CapabilityDimension>();
  for (const summary of summaries) {
    for (const key of Object.keys(summary.dimensionMaxScores ?? {})) keys.add(key);
    for (const key of Object.keys(summary.dimensionScores ?? {})) keys.add(key);
  }
  const builtIn = CAPABILITY_DIMENSIONS.filter((key) => keys.has(key));
  const extra = [...keys].filter((key) => !(CAPABILITY_DIMENSIONS as readonly string[]).includes(key)).sort();
  return [...builtIn, ...extra].map((key) => {
    const rawMax = summaries.reduce((max, summary) => Math.max(max, Number(summary.dimensionMaxScores?.[key] ?? 0)), 0);
    const observed = summaries.reduce((max, summary) => Math.max(max, Number(summary.dimensionScores?.[key] ?? 0)), 0);
    const maxScore = rawMax > 0 ? rawMax : observed;
    return { key, label: capabilityDimensionLabel(key), maxScore, questionCount: 0 };
  });
}

/**
 * 取出一轮评测实际使用的维度。
 * 优先用结果里记录的 dimensions；旧结果（无该字段）从题目推导；再兜底从汇总分数推导。
 */
export function resolveCapabilityDimensions(result: Pick<CapabilityRunResult, 'dimensions' | 'questions' | 'summaries'>): CapabilityDimensionMeta[] {
  const recorded = result.dimensions;
  if (recorded?.length) return recorded.map((item) => ({ ...item }));
  const questions = result.questions ?? [];
  if (questions.length) return dimensionsFromResults(questions);
  return dimensionsFromSummaries(result.summaries ?? []);
}

/** 维度标识 → 中文标签，用于逐题结果等按题取名的场景。 */
export function resolveCapabilityDimensionLabels(result: Pick<CapabilityRunResult, 'dimensions' | 'questions' | 'summaries'>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const dimension of resolveCapabilityDimensions(result)) labels[dimension.key] = dimension.label;
  for (const question of result.questions ?? []) {
    if (!labels[question.dimension]) labels[question.dimension] = capabilityDimensionLabel(question.dimension);
  }
  return labels;
}

/**
 * 雷达图每根轴的有效量程。
 *
 * 关键约束：**永不截断**。若某模型得分超过该维度声明的满分（题库与模型不匹配、或满分被误改小），
 * 轴量程就地放大到覆盖实际最大值，并记录一次扩展，保证"图上半径"与"实测分数"始终严格对应。
 */
export function resolveAxisMax(declaredMax: number, observedMax: number): { axisMax: number; expanded: boolean } {
  const declared = Number.isFinite(declaredMax) && declaredMax > 0 ? declaredMax : 0;
  const observed = Number.isFinite(observedMax) && observedMax > 0 ? observedMax : 0;
  if (declared <= 0) return { axisMax: observed > 0 ? observed : 1, expanded: false };
  if (observed > declared + 1e-9) return { axisMax: niceAxisCeil(observed), expanded: true };
  return { axisMax: declared, expanded: false };
}

/** 取整到"好看"的轴上限（1/1.2/1.5/2/2.5/3/4/5/6/8/10 × 10^n）。 */
export function niceAxisCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value) + 1e-12));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value - 1e-9) return Number(candidate.toFixed(6));
  }
  return Number((10 * magnitude).toFixed(6));
}

/** 坐标轴刻度：0 起步、等分，且**不超过**给定的最大值（避免刻度线画到绘图区之外）。 */
export function axisTicks(max: number, target = 4): number[] {
  const safe = Number.isFinite(max) && max > 0 ? max : 1;
  const rough = safe / Math.max(1, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough) + 1e-12));
  const step = [1, 1.2, 1.5, 2, 2.5, 5, 10].map((value) => value * magnitude).find((value) => value >= rough - 1e-9) ?? 10 * magnitude;
  const ticks: number[] = [0];
  for (let value = step; value <= safe + step * 1e-9 && ticks.length < 12; value += step) ticks.push(Number(value.toFixed(6)));
  if (ticks.length === 1) ticks.push(safe);
  return ticks;
}
