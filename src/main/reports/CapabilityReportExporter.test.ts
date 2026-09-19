import { describe, expect, it } from 'vitest';
import type { CapabilityRunResult } from '../../shared/types';
import { renderCapabilityDocx, renderCapabilityHtml, renderCapabilityMarkdown } from './CapabilityReportExporter';

const result: CapabilityRunResult = {
  startedAt: '2026-08-02T00:00:00.000Z', finishedAt: '2026-08-02T00:01:00.000Z', cancelled: false, suiteVersion: 'CapabilitySuite-1.0',
  config: { models: ['demo'], maxOutputTokens: 128, temperature: 0, timeoutMs: 10000, thinkingMode: 'off', suiteVersion: 'CapabilitySuite-1.0' },
  environment: { deployment: 'native', binary: 'ollama', apiHost: '127.0.0.1', apiPort: 11434, gpuVendor: 'none', gpuModels: [], installedModels: ['demo'], warnings: [] },
  questions: [], summaries: [{ model: 'demo', rank: 1, totalScore: 60, maxScore: 70, dimensionScores: { code: 10, translation: 10, classicalChinese: 10, math: 10, logic: 10, chineseKnowledge: 10, creativeWriting: 0 }, dimensionMaxScores: { code: 10, translation: 10, classicalChinese: 10, math: 10, logic: 10, chineseKnowledge: 10, creativeWriting: 10 }, completedCount: 14, questionCount: 14 }],
};

describe('CapabilityReportExporter', () => {
  it('renders charts and seven-dimension summary in HTML and Markdown', async () => {
    const html = renderCapabilityHtml({ result });
    const markdown = renderCapabilityMarkdown({ result });
    expect(html).toContain('<svg');
    expect(html).toContain('写代码');
    expect(markdown).toContain('capability-score-bar.svg');
    expect(markdown).toContain('中文常识');
    expect((await renderCapabilityDocx({ result })).length).toBeGreaterThan(1000);
  });

  it('用自定义 8 维题库跑出来的结果，报告里的维度与满分都跟着变（不再写死 7 维）', async () => {
    const custom: CapabilityRunResult = {
      startedAt: '2026-09-18T00:00:00.000Z', finishedAt: '2026-09-18T00:10:00.000Z', cancelled: false, suiteVersion: 'CapabilitySuite-1.1',
      config: { models: ['office-a', 'office-b'], maxOutputTokens: 512, temperature: 0, timeoutMs: 120000, thinkingMode: 'off', suiteVersion: 'CapabilitySuite-1.1' },
      environment: { deployment: 'native', binary: 'ollama', apiHost: '127.0.0.1', apiPort: 11434, gpuVendor: 'none', gpuModels: [], installedModels: ['office-a', 'office-b'], warnings: [] },
      questions: [
        { model: 'office-a', id: 'officeWriting.1', dimension: 'officeWriting', title: '纪要改写', prompt: 'p', response: 'r', score: 5, maxScore: 5, status: 'success', parserMode: 'json', reasoningDetected: false, evidence: [] },
        { model: 'office-a', id: 'officeSheet.1', dimension: 'officeSheet', title: '数据透视', prompt: 'p', response: 'r', score: 4, maxScore: 5, status: 'success', parserMode: 'json', reasoningDetected: false, evidence: [] },
      ],
      dimensions: [
        { key: 'officeWriting', label: '办公写作', maxScore: 30, questionCount: 6 },
        { key: 'officeSheet', label: '表格分析', maxScore: 30, questionCount: 6 },
      ],
      summaries: [
        { model: 'office-a', rank: 1, totalScore: 45, maxScore: 60, dimensionScores: { officeWriting: 24, officeSheet: 21 }, dimensionMaxScores: { officeWriting: 30, officeSheet: 30 }, completedCount: 12, questionCount: 12 },
        { model: 'office-b', rank: 2, totalScore: 40, maxScore: 60, dimensionScores: { officeWriting: 24, officeSheet: 16 }, dimensionMaxScores: { officeWriting: 30, officeSheet: 30 }, completedCount: 12, questionCount: 12 },
      ],
    };
    const html = renderCapabilityHtml({ result: custom });
    const markdown = renderCapabilityMarkdown({ result: custom });
    expect(html).toContain('办公写作');
    expect(html).toContain('表格分析');
    expect(html).toContain('2维度能力雷达图');
    expect(html).not.toContain('写代码');
    expect(markdown).toContain('| 维度 | dimension | 满分 | 题数 |');
    expect(markdown).toContain('办公写作（满分 30）');
    expect(markdown).toContain('2维能力雷达图');
    // 优势维度按得分率取：办公写作 24/30 高于表格分析 21/30
    expect(markdown).toContain('其当前优势维度为办公写作（24/30）');
    expect((await renderCapabilityDocx({ result: custom })).length).toBeGreaterThan(1000);
  });
});
