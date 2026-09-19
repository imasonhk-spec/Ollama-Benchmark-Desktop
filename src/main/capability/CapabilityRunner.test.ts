import { describe, expect, it, vi } from 'vitest';
import type { CapabilityConfig, OllamaEnvironment } from '../../shared/types';
import { CapabilityRunner } from './CapabilityRunner';

const environment: OllamaEnvironment = { deployment: 'native', binary: 'ollama', apiHost: '127.0.0.1', apiPort: 11434, gpuVendor: 'none', gpuModels: [], installedModels: ['demo'], warnings: [] };
const config: CapabilityConfig = { models: ['demo'], maxOutputTokens: 128, temperature: 0, timeoutMs: 10_000, thinkingMode: 'off', suiteVersion: 'CapabilitySuite-1.0' };

describe('CapabilityRunner', () => {
  it('runs the independent six-dimension suite and emits progress', async () => {
    const requestJson = vi.fn(async (request: { body: { prompt: string; stream: boolean; format: string } }) => {
      const prompt = request.body.prompt;
      const answer = prompt.includes('800') ? '540' : prompt.includes('4(2x') ? '4.8' : prompt.includes('3, 8') ? '48' : prompt.includes('《出师表》') ? '刘禅' : prompt.includes('《史记》') ? '司马迁' : prompt.includes('逆否') ? 'A 未过载' : '学习后经常复习会感到高兴，先天下之忧而忧，后天下之乐而乐。';
      return { response: JSON.stringify({ answer }), eval_count: 12, eval_duration: 1_000_000_000 };
    });
    const progress = vi.fn();
    const result = await new CapabilityRunner({ requestJson } as never, environment).run(config, progress);
    expect(result.questions).toHaveLength(14);
    expect(result.summaries[0].completedCount).toBe(14);
    expect(requestJson).toHaveBeenCalledTimes(14);
    expect(requestJson.mock.calls[0][0].body.stream).toBe(false);
    expect(requestJson.mock.calls[0][0].body.format).toBe('json');
    expect(progress).toHaveBeenCalledTimes(14);
    // 内置题库仍是 7 个维度，顺序与满分由题库推导
    expect(result.dimensions?.map((dimension) => dimension.key)).toEqual(['code', 'translation', 'classicalChinese', 'math', 'logic', 'chineseKnowledge', 'creativeWriting']);
    expect(result.dimensions?.every((dimension) => dimension.maxScore === 10 && dimension.questionCount === 2)).toBe(true);
  });

  it('returns a resumable partial result when cancelled before the next request', async () => {
    const controller = new AbortController(); controller.abort();
    const requestJson = vi.fn();
    const result = await new CapabilityRunner({ requestJson } as never, environment).run(config, undefined, controller.signal);
    expect(result.cancelled).toBe(true);
    expect(result.questions).toHaveLength(0);
    expect(requestJson).not.toHaveBeenCalled();
  });
  it('runs a supplied custom question bank instead of the built-in suite', async () => {
    const requestJson = vi.fn(async () => ({ response: JSON.stringify({ answer: '2' }), eval_count: 1, eval_duration: 1_000_000 }));
    const customQuestion = { id: 'custom.math', dimension: 'math' as const, title: '自定义题', prompt: '1+1?', responseKey: 'answer' as const, maxScore: 5, rule: { kind: 'number' as const, answers: ['2'], tolerance: 0 } };
    const result = await new CapabilityRunner({ requestJson } as never, environment).run({ ...config, questions: [customQuestion] });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].id).toBe('custom.math');
    expect(result.questions[0].score).toBe(5);
  });

  it('按题库里出现的任意维度聚合（办公类 8 维那样），满分 = 该维度题目之和', async () => {
    const requestJson = vi.fn(async () => ({ response: JSON.stringify({ answer: '2' }), eval_count: 1, eval_duration: 1_000_000 }));
    const bank = [
      { id: 'officeWriting.1', dimension: 'officeWriting', dimensionLabel: '办公写作', title: 'a', prompt: '1+1?', responseKey: 'answer' as const, maxScore: 5, rule: { kind: 'number' as const, answers: ['2'] } },
      { id: 'officeWriting.2', dimension: 'officeWriting', dimensionLabel: '办公写作', title: 'b', prompt: '1+1?', responseKey: 'answer' as const, maxScore: 5, rule: { kind: 'number' as const, answers: ['2'] } },
      { id: 'officeSheet.1', dimension: 'officeSheet', dimensionLabel: '表格分析', title: 'c', prompt: '1+1?', responseKey: 'answer' as const, maxScore: 10, rule: { kind: 'number' as const, answers: ['2'] } },
    ];
    const result = await new CapabilityRunner({ requestJson } as never, environment).run({ ...config, questions: bank });
    expect(result.dimensions).toEqual([
      { key: 'officeWriting', label: '办公写作', maxScore: 10, questionCount: 2 },
      { key: 'officeSheet', label: '表格分析', maxScore: 10, questionCount: 1 },
    ]);
    expect(result.summaries[0].dimensionScores).toEqual({ officeWriting: 10, officeSheet: 10 });
    expect(result.summaries[0].dimensionMaxScores).toEqual({ officeWriting: 10, officeSheet: 10 });
    expect(result.summaries[0].totalScore).toBe(20);
    expect(result.summaries[0].maxScore).toBe(20);
    // 内置 7 维不会凭空出现在结果里
    expect(Object.keys(result.summaries[0].dimensionScores)).toHaveLength(2);
  });});
