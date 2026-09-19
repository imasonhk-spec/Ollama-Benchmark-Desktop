import { describe, expect, it } from 'vitest';
import { axisTicks, capabilityDimensionLabel, collectCapabilityDimensions, niceAxisCeil, resolveAxisMax, resolveCapabilityDimensionLabels, resolveCapabilityDimensions } from './CapabilityDimensions';
import type { CapabilityModelSummary, CapabilityQuestion, CapabilityQuestionResult } from './types';

function question(dimension: string, maxScore: number, dimensionLabel?: string): CapabilityQuestion {
  return { id: `${dimension}.${maxScore}.${Math.random()}`, dimension, dimensionLabel, title: 't', prompt: 'p', responseKey: 'answer', maxScore, rule: { kind: 'number', answers: ['1'] } };
}

function questionResult(dimension: string, id: string, maxScore: number, model: string): CapabilityQuestionResult {
  return { model, id, dimension, title: id, prompt: 'p', response: 'r', score: maxScore, maxScore, status: 'success', parserMode: 'json', reasoningDetected: false, evidence: [] };
}

describe('collectCapabilityDimensions', () => {
  it('按题库首次出现顺序汇总维度，满分 = 该维度所有题目之和', () => {
    const dimensions = collectCapabilityDimensions([
      question('officeWriting', 5, '办公写作'), question('officeSheet', 5, '表格分析'),
      question('officeWriting', 5), question('officeWriting', 5),
    ]);
    expect(dimensions.map((item) => item.key)).toEqual(['officeWriting', 'officeSheet']);
    expect(dimensions[0]).toMatchObject({ label: '办公写作', maxScore: 15, questionCount: 3 });
    expect(dimensions[1]).toMatchObject({ label: '表格分析', maxScore: 5, questionCount: 1 });
  });

  it('自定义维度不会被内置 7 个限制，标签缺失时回退到维度标识', () => {
    const dimensions = collectCapabilityDimensions([question('myCustomDim', 10)]);
    expect(dimensions[0].label).toBe('myCustomDim');
    expect(capabilityDimensionLabel('code')).toBe('写代码');
    expect(capabilityDimensionLabel('code', '代码能力')).toBe('代码能力');
  });
});

describe('resolveCapabilityDimensions', () => {
  const summaries: CapabilityModelSummary[] = [{ model: 'm', rank: 1, totalScore: 45, maxScore: 60, dimensionScores: { officeWriting: 20, officeSheet: 25 }, dimensionMaxScores: { officeWriting: 30, officeSheet: 30 }, completedCount: 12, questionCount: 12 }];

  it('优先使用结果里记录的维度，支持每维不同满分', () => {
    const dimensions = resolveCapabilityDimensions({ dimensions: [{ key: 'a', label: 'A 能力', maxScore: 12, questionCount: 2 }], questions: [], summaries: [] });
    expect(dimensions).toEqual([{ key: 'a', label: 'A 能力', maxScore: 12, questionCount: 2 }]);
  });

  it('旧结果（无 dimensions 字段）从逐题结果推导，满分按题目去重累加', () => {
    const results = [
      questionResult('officeSheet', 's1', 5, 'm1'), questionResult('officeSheet', 's1', 5, 'm2'),
      questionResult('officeSheet', 's2', 5, 'm1'), questionResult('officeSheet', 's2', 5, 'm2'),
      questionResult('officeWriting', 'w1', 10, 'm1'), questionResult('officeWriting', 'w1', 10, 'm2'),
    ];
    expect(resolveCapabilityDimensions({ dimensions: undefined, questions: results, summaries })).toEqual([
      { key: 'officeSheet', label: 'officeSheet', maxScore: 10, questionCount: 2 },
      { key: 'officeWriting', label: 'officeWriting', maxScore: 10, questionCount: 1 },
    ]);
  });

  it('既没有 dimensions 也没有题目时，回退到汇总分数（自定义维度排在内置维度之后）', () => {
    expect(resolveCapabilityDimensions({ dimensions: undefined, questions: [], summaries }).map((item) => item.key)).toEqual(['officeSheet', 'officeWriting']);
  });

  it('逐题标签：内置维度取中文名，自定义维度退回维度标识', () => {
    const labels = resolveCapabilityDimensionLabels({ dimensions: undefined, questions: [questionResult('code', 'c1', 5, 'm1'), questionResult('officeSheet', 's1', 5, 'm1')], summaries });
    expect(labels).toEqual({ code: '写代码', officeSheet: 'officeSheet' });
  });
});

describe('量程与刻度（数值忠实性的基础）', () => {
  it('不越界时用声明满分', () => {
    expect(resolveAxisMax(30, 24)).toEqual({ axisMax: 30, expanded: false });
    expect(resolveAxisMax(100, 100)).toEqual({ axisMax: 100, expanded: false });
  });

  it('越界时扩量程而不是截断', () => {
    const expanded = resolveAxisMax(30, 45);
    expect(expanded.expanded).toBe(true);
    expect(expanded.axisMax).toBeGreaterThanOrEqual(45);
    expect(45 / expanded.axisMax).toBeLessThanOrEqual(1);
  });

  it('满分缺失（0）时退化为实际最大值，绝不用写死的 10 兜底', () => {
    expect(resolveAxisMax(0, 17).axisMax).toBe(17);
    expect(resolveAxisMax(0, 0).axisMax).toBe(1);
  });

  it('取整函数对小数与负数量程都成立', () => {
    expect(niceAxisCeil(45)).toBe(50);
    expect(niceAxisCeil(118)).toBe(120);
    expect(niceAxisCeil(7)).toBe(8);
    expect(niceAxisCeil(0.42)).toBeCloseTo(0.5, 6);
    expect(niceAxisCeil(-5)).toBe(1);
  });

  it('刻度从 0 起步且不超过量程', () => {
    expect(axisTicks(240)).toEqual([0, 100, 200]);
    expect(axisTicks(70)).toEqual([0, 20, 40, 60]);
    expect(axisTicks(60)).toEqual([0, 15, 30, 45, 60]);
    for (const max of [5, 12, 30, 60, 70, 100, 240, 1000, 2.5]) {
      const ticks = axisTicks(max);
      expect(ticks[0]).toBe(0);
      expect(Math.max(...ticks)).toBeLessThanOrEqual(max + 1e-9);
    }
  });
});
