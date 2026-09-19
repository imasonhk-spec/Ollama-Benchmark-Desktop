import { describe, expect, it } from 'vitest';
import { capabilityChartDiagnostics, renderCapabilityBarChart, renderCapabilityRadarChart } from './CapabilityCharts';
import type { CapabilityDimensionMeta, CapabilityModelSummary } from './types';

/* 与图表实现约定一致的几何常量：任何改动都必须同步这里，否则测试会失败 */
const CX = 315; const CY = 330; const R = 205;

function summary(model: string, values: Record<string, number>, maxes: Record<string, number>, total?: number, maxScore?: number): CapabilityModelSummary {
  const totalScore = total ?? Object.values(values).reduce((sum, value) => sum + value, 0);
  return { model, rank: 1, totalScore, maxScore: maxScore ?? Object.values(maxes).reduce((sum, value) => sum + value, 0), dimensionScores: values, dimensionMaxScores: maxes, completedCount: 12, questionCount: 12 };
}

/** 取出数据多边形（fill-opacity="0.08" 的那些）的顶点坐标 */
function dataPolygonPoints(svg: string): [number, number][][] {
  return [...svg.matchAll(/<polygon points="([^"]+)" fill="#[0-9a-f]{6}" fill-opacity="0\.08"/g)].map((match) => match[1].split(' ').map((pair) => pair.split(',').map(Number) as [number, number]));
}

/** 第 index 根轴的极角（与图表实现一致：从正上方开始顺时针均分） */
function angleAt(index: number, count: number): number {
  return -Math.PI / 2 + (Math.PI * 2 * index) / count;
}

/** 给定"得分率"时，图上顶点应有的坐标 */
function expectedVertex(ratio: number, index: number, count: number): { x: number; y: number } {
  return { x: CX + Math.cos(angleAt(index, count)) * R * ratio, y: CY + Math.sin(angleAt(index, count)) * R * ratio };
}

describe('CapabilityCharts 雷达图：图 = 数据', () => {
  const dimensions: CapabilityDimensionMeta[] = [
    { key: 'code', label: '写代码', maxScore: 10, questionCount: 2 },
    { key: 'translation', label: '翻译', maxScore: 10, questionCount: 2 },
    { key: 'classicalChinese', label: '文言文', maxScore: 10, questionCount: 2 },
    { key: 'math', label: '数学', maxScore: 10, questionCount: 2 },
    { key: 'logic', label: '逻辑', maxScore: 10, questionCount: 2 },
    { key: 'chineseKnowledge', label: '中文常识', maxScore: 10, questionCount: 2 },
    { key: 'creativeWriting', label: '创意写作', maxScore: 10, questionCount: 2 },
  ];
  const maxes = Object.fromEntries(dimensions.map((dimension) => [dimension.key, dimension.maxScore]));

  it('每个顶点的半径严格等于 值 ÷ 该维度量程，可反算核对', () => {
    const values = { code: 6, translation: 7, classicalChinese: 8, math: 9, logic: 5, chineseKnowledge: 5, creativeWriting: 0 };
    const svg = renderCapabilityRadarChart([summary('model-a', values, maxes)], dimensions);
    const [points] = dataPolygonPoints(svg);
    expect(points).toHaveLength(7);
    dimensions.forEach((dimension, index) => {
      const raw = values[dimension.key as keyof typeof values];
      const ratio = raw / dimension.maxScore;
      const wanted = expectedVertex(ratio, index, 7);
      // SVG 坐标保留 1 位小数 → 容差取 0.06（=舍入量）+ 浮点余量
      expect(Math.abs(points[index][0] - wanted.x)).toBeLessThan(0.06);
      expect(Math.abs(points[index][1] - wanted.y)).toBeLessThan(0.06);
      // 逐点反算：图上半径比例 → 数值，必须等于原始分数
      const radius = Math.hypot(points[index][0] - CX, points[index][1] - CY);
      expect(Number(((radius / R) * dimension.maxScore).toFixed(1))).toBeCloseTo(raw, 1);
    });
  });

  it('各维度满分不同时按各自量程映射，不再统一除以固定值', () => {
    const dims: CapabilityDimensionMeta[] = [
      { key: 'officeWriting', label: '办公写作', maxScore: 30, questionCount: 6 },
      { key: 'officeSheet', label: '表格分析', maxScore: 30, questionCount: 6 },
      { key: 'officeExtract', label: '信息抽取', maxScore: 15, questionCount: 3 },
      { key: 'officeLatency', label: '响应速度', maxScore: 6, questionCount: 2 },
    ];
    const values = { officeWriting: 24, officeSheet: 18, officeExtract: 9, officeLatency: 3 };
    const maxes4 = { officeWriting: 30, officeSheet: 30, officeExtract: 15, officeLatency: 6 };
    const svg = renderCapabilityRadarChart([summary('office-model', values, maxes4)], dims);
    const [points] = dataPolygonPoints(svg);
    // 得分率分别是 80% / 60% / 60% / 50%；若按"统一除以 30"实现，后两个维度会画错
    [0.8, 0.6, 0.6, 0.5].forEach((ratio, index) => {
      const wanted = expectedVertex(ratio, index, 4);
      expect(Math.abs(points[index][0] - wanted.x)).toBeLessThan(0.06);
      expect(Math.abs(points[index][1] - wanted.y)).toBeLessThan(0.06);
    });
    expect(svg).toContain('办公写作');
    expect(svg).toContain('30');
  });

  it('得分超过声明满分时自动扩量程，绝不截断（旧实现会压到外圈）', () => {
    const dims: CapabilityDimensionMeta[] = [{ key: 'accuracy', label: '准确率', maxScore: 30, questionCount: 6 }, { key: 'speed', label: '速度', maxScore: 10, questionCount: 2 }];
    const svg = renderCapabilityRadarChart([summary('over', { accuracy: 45, speed: 5 }, { accuracy: 30, speed: 10 })], dims);
    const [points] = dataPolygonPoints(svg);
    const radius = Math.hypot(points[0][0] - CX, points[0][1] - CY);
    const diagnostics = capabilityChartDiagnostics([summary('over', { accuracy: 45, speed: 5 }, { accuracy: 30, speed: 10 })], dims);
    expect(diagnostics[0].expanded).toBe(true);
    expect(diagnostics[0].axisMax).toBeGreaterThanOrEqual(45);
    // 半径 = 45 / 扩后的量程，且仍然落在最外圈之内
    expect(radius / R).toBeCloseTo(45 / diagnostics[0].axisMax, 2);
    expect(radius).toBeLessThanOrEqual(R + 0.1);
    expect(svg).toContain('已自动扩量程');
  });

  it('满分缺失时按实际最大值出图，不使用写死的 10', () => {
    const dims: CapabilityDimensionMeta[] = [{ key: 'unknown', label: '未知维度', maxScore: 0, questionCount: 3 }];
    const summaries = [summary('m1', { unknown: 17 }, { unknown: 0 }), summary('m2', { unknown: 9 }, { unknown: 0 })];
    const svg = renderCapabilityRadarChart(summaries, dims);
    const [best] = dataPolygonPoints(svg);
    const radius = Math.hypot(best[0][0] - CX, best[0][1] - CY);
    expect(radius / R).toBeCloseTo(1, 2); // 17 就是最大值 → 顶到外圈
    expect(svg).toContain('未知维度');
  });

  it('模型数量少时标注真实得分，并把区分度低的维度写在图上', () => {
    const dims: CapabilityDimensionMeta[] = [{ key: 'officeWriting', label: '办公写作', maxScore: 30, questionCount: 6 }, { key: 'officeSheet', label: '表格分析', maxScore: 30, questionCount: 6 }];
    const officePair = [summary('m1', { officeWriting: 29, officeSheet: 12 }, { officeWriting: 30, officeSheet: 30 }), summary('m2', { officeWriting: 28, officeSheet: 24 }, { officeWriting: 30, officeSheet: 30 })];
    const svg = renderCapabilityRadarChart(officePair, dims);
    expect(svg).toContain('>29<');
    expect(svg).toContain('区分度偏低');
    const diagnostics = capabilityChartDiagnostics(officePair, dims);
    expect(diagnostics[0].spreadPoints).toBeCloseTo(((29 - 28) / 30) * 100, 5);
    expect(diagnostics[0].spreadPoints).toBeLessThan(5);
    expect(diagnostics[1].spreadPoints).toBeCloseTo(((24 - 12) / 30) * 100, 5);
  });

  it('不限制维度数量：8 个自定义维度也能画出来，标题与图注同步', () => {
    const dims: CapabilityDimensionMeta[] = Array.from({ length: 8 }, (_, index) => ({ key: `office-${index}`, label: `办公维度${index + 1}`, maxScore: 30, questionCount: 6 }));
    const values = Object.fromEntries(dims.map((dimension, index) => [dimension.key, 6 + index * 3]));
    const maxes8 = Object.fromEntries(dims.map((dimension) => [dimension.key, 30]));
    const svg = renderCapabilityRadarChart([summary('m', values, maxes8)], dims);
    expect(svg).toContain('8维度能力雷达图');
    expect(dataPolygonPoints(svg)[0]).toHaveLength(8);
    expect(svg).toContain('办公维度8');
  });

  it('无模型时不产生 NaN 坐标，给出空态提示', () => {
    const svg = renderCapabilityRadarChart([], dimensions);
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('暂无可绘制的模型得分');
  });

  it('缺维度的旧结果按 0 处理，不产出 NaN', () => {
    const svg = renderCapabilityRadarChart([summary('legacy', { code: 5 }, maxes, 5)], dimensions);
    expect(svg).not.toContain('NaN');
  });
});

describe('CapabilityCharts 柱状图：刻度随量程变化', () => {
  it('满分 30 时不再写死 0/15/30/45/60 刻度', () => {
    const summaries = [
      summary('a', {}, {}, 24, 30), summary('b', {}, {}, 12, 30),
    ];
    const svg = renderCapabilityBarChart(summaries, []);
    expect(svg).toContain('模型能力总分（满分 30）');
    expect(svg).not.toContain('>60<');
    const barHeights = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)" rx="5"/g)].map((match) => Number(match[1]));
    expect(barHeights).toHaveLength(2);
    // 24/30 = 0.8，12/30 = 0.4；柱高比严格等于得分比
    expect(barHeights[0] / barHeights[1]).toBeCloseTo(2, 2);
    expect(barHeights[0]).toBeCloseTo(0.8 * (420 - 42 - 92), 0);
  });

  it('总分超出满分时扩量程并注明未截断', () => {
    const svg = renderCapabilityBarChart([summary('over', {}, {}, 70, 60)]);
    expect(svg).toContain('自动扩到');
    expect(svg).toContain('未截断');
  });
});
