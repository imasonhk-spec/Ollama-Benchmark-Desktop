/* 回归验证：用真实业务题库 samples/8维模型评测用例_办公类.xlsx 跑通
   「导入 → 解析 → 评分 → 图表 → 报告」全链路，确认 8 个自定义维度与 6 种规则类型都可用。
   行数据由 scripts/extract-bank-rows.mjs 从同一份 xlsx 抽出，改题库后请重新生成。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilityQuestionsToRows, parseCapabilityQuestionRowsWithIssues, parseCapabilityQuestionRows as reparse } from './CapabilityQuestionBank';
import { collectCapabilityDimensions } from './CapabilityDimensions';
import { renderCapabilityBarChart, renderCapabilityRadarChart } from './CapabilityCharts';
import { parseCapabilityAnswer, scoreCapabilityAnswer } from '../main/capability/CapabilityScorer';
import { renderCapabilityHtml, renderCapabilityMarkdown } from '../main/reports/CapabilityReportExporter';
import type { CapabilityModelSummary, CapabilityQuestion, CapabilityRunResult } from './types';

const ROWS_PATH = fileURLToPath(new URL('../../samples/office-bank-rows.json', import.meta.url));
const raw = JSON.parse(readFileSync(ROWS_PATH, 'utf8')) as { records: Record<string, unknown>[] };

describe('真实办公类 8 维题库（导入 → 评分 → 图表 → 报告）', () => {
  const { questions, issues } = parseCapabilityQuestionRowsWithIssues(raw.records);
  const dimensions = collectCapabilityDimensions(questions);
  const questionOf = (id: string) => questions.find((item) => item.id === id) as CapabilityQuestion;
  /** 与 CapabilityRunner 完全一致的评分入口。 */
  const score = (id: string, response: string) => {
    const question = questionOf(id);
    const parsed = parseCapabilityAnswer(response, question.responseKey);
    return { parsed, scored: scoreCapabilityAnswer(question, parsed.answer, { rawResponse: response, root: parsed.root, value: parsed.value }) };
  };

  it('48 道题全部导入无坏行 / 8 个维度 / 每维满分 30，中文标签无乱码', () => {
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(48);
    expect(dimensions).toHaveLength(8);
    expect(dimensions.map((item) => item.key)).toEqual(['officeCommunication', 'officeCompliance', 'officeDataAnalysis', 'officeExtraction', 'officePresentation', 'officeSummarization', 'officeToolUse', 'officeWriting']);
    expect(dimensions.map((item) => item.label)).toEqual(['沟通协作', '合规安全', '表格分析', '信息抽取', '演示汇报', '摘要纪要', '工具自动化', '办公写作']);
    expect(dimensions.every((item) => item.maxScore === 30 && item.questionCount === 6)).toBe(true);
    expect(questions.reduce((sum, question) => sum + question.maxScore, 0)).toBe(240);
  });

  it('题库实际使用的 6 种规则类型都能解析（旧版只认 keywords 一种）', () => {
    const kinds = questions.reduce<Record<string, number>>((accumulator, question) => ({ ...accumulator, [question.rule.kind]: (accumulator[question.rule.kind] ?? 0) + 1 }), {});
    expect(kinds).toEqual({ keywords: 25, tool_call: 10, contains_all: 5, json_schema: 5, formula: 2, sql_result: 1 });
    expect(questions.filter((question) => question.responseKey === 'tool_calls')).toHaveLength(10);
    expect(questions.filter((question) => question.rule.kind === 'keywords' && question.rule.maximumLength).length).toBe(15);
  });

  it('tool_call：合规的邮件调用满分，泄露外部信息只拿一半', () => {
    const good = '{"tool_calls":[{"name":"email.send","arguments":{"to":"内部销售负责人","subject":"客户会议协调","body":"会议安排已同步"}}]}';
    expect(score('officeCommunication.comboCustomerList', good).scored.score).toBe(5);
    const leak = '{"tool_calls":[{"name":"email.send","arguments":{"to":"外部供应商群","subject":"客户名单","body":"附上电话与完整名单"}}]}';
    expect(score('officeCommunication.comboCustomerList', leak).scored.score).toBe(2.5);
    expect(score('officeCommunication.comboCustomerList', leak).scored.evidence.join(' ')).toContain('未出现');
  });

  it('tool_call：模型直接输出数组（不套 tool_calls）也能评分', () => {
    const bare = '[{"name":"task.create","arguments":{"title":"更新需求文档","assignee":"李娜","due":"2026-09-25"}}]';
    expect(score('officeToolUse.createTask', bare).scored.score).toBe(5);
  });

  it('contains_all：脱敏正确满分，未脱敏 0 分', () => {
    expect(score('officeCompliance.maskFormat', '{"answer":{"phone":"138****8000","email":"z***@corp.com"}}').scored.score).toBe(5);
    expect(score('officeCompliance.maskFormat', '{"answer":{"phone":"13800138000","email":"zhang@corp.com"}}').scored.score).toBe(0);
  });

  it('formula / sql_result：要素齐全满分，缺要素按比例给分', () => {
    expect(score('officeDataAnalysis.countif', '{"answer":"=COUNTIFS(A:A,\\"技术部\\",B:B,\\"已审批\\")"}').scored.score).toBe(5);
    expect(score('officeDataAnalysis.countif', '{"answer":"=SUM(A:A)"}').scored.score).toBe(0);
    const sql = '{"answer":"SELECT c.name, SUM(o.amount) AS total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = \'paid\' AND o.created_at >= \'2026-08-01\' GROUP BY c.name ORDER BY total DESC"}';
    expect(score('officeDataAnalysis.sqlJoin', sql).scored.score).toBe(5);
    expect(score('officeDataAnalysis.sqlJoin', '{"answer":"SELECT * FROM orders"}').scored.score).toBe(0.5);
  });

  it('json_schema：对象抽取与数组抽取都能逐字段核对', () => {
    expect(score('officeExtraction.businessCard', '{"answer":{"name":"陈明","company":"示例科技有限公司","phone":"13912345678","email":"chenming@example.com"}}').scored.score).toBe(5);
    // 只抽出 name：必填 4 项中 1 项存在，期望 4 项中 1 项取值正确 → 2/8
    expect(score('officeExtraction.businessCard', '{"answer":{"name":"陈明"}}').scored.score).toBe(1.5);
    const tasks = '{"answer":[{"task":"把报价单发给客户","owner":"小李"},{"task":"更新合同模板","owner":"小王"},{"task":"组织培训","owner":"小张"}]}';
    expect(score('officeExtraction.chatTasks', tasks).scored.score).toBe(5);
    expect(score('officeExtraction.chatTasks', '{"answer":[{"task":"把报价单发给客户","owner":"小李"}]}').scored.score).toBe(1.5);
  });

  it('json_schema：null 期望值代表「字段本就无从确认」，瞎填要扣分', () => {
    // owner / amount 在原文里缺失，模型应输出 null
    expect(score('officeExtraction.edgeMissing', '{"answer":{"project":"星河项目","owner":null,"amount":null}}').scored.score).toBe(5);
    expect(score('officeExtraction.edgeMissing', '{"answer":{"project":"星河项目","owner":"待定","amount":null}}').scored.score).toBe(4);
    // 嵌套抽取：payment.amount / penalty.rate 等叶子字段逐项核对
    const nested = '{"answer":{"payment":{"amount":"30,000","deadline":"签约后 10 日内"},"penalty":{"rate":"5%","trigger":"逾期交付超过 15 日"}}}';
    expect(score('officeExtraction.contractNested', nested).scored.score).toBe(5);
    expect(score('officeExtraction.contractNested', '{"answer":{"payment":{"amount":"30,000","deadline":"签约后 10 日内"},"penalty":{"rate":"5%"}}}').scored.score).toBe(4);
  });

  it('keywords + maximumLength：超长回答折半（旧版会忽略该上限）', () => {
    const brief = '{"answer":"无法确定对方是否参加，对方未回复，建议跟进确认。"}';
    expect(score('officeCommunication.edgeNoReply', brief).scored.score).toBe(5);
    const wordy = '{"answer":"无法确定对方是否参加，对方未回复，建议跟进确认。补充说明：需要依次核对会议时间、参会人、议程、会议室以及相关附件，并在得到回复后同步给全体参会者。补充说明：需要依次核对会议时间、参会人、议程、会议室以及相关附件，并在得到回复后同步给全体参会人。"}';
    expect(score('officeCommunication.edgeNoReply', wordy).scored.score).toBe(2.5);
  });

  it('导回 Excel 行后仍能解析（含自定义维度的 dimensionLabel）', () => {
    const roundTrip = reparse(capabilityQuestionsToRows(questions));
    expect(roundTrip).toHaveLength(48);
    expect(roundTrip[0].dimension).toBe('officeCommunication');
    expect(roundTrip[0].dimensionLabel).toBe('沟通协作');
    expect(collectCapabilityDimensions(roundTrip)).toEqual(dimensions);
  });

  it('雷达图 8 根轴按各自满分（30）映射，顶点可反算', () => {
    const scores = Object.fromEntries(dimensions.map((dimension, index) => [dimension.key, 12 + index * 2]));
    const maxes = Object.fromEntries(dimensions.map((dimension) => [dimension.key, 30]));
    const summaries: CapabilityModelSummary[] = [{ model: 'qwen3:32b', rank: 1, totalScore: Object.values(scores).reduce((sum, value) => sum + value, 0), maxScore: 240, dimensionScores: scores, dimensionMaxScores: maxes, completedCount: 48, questionCount: 48 }];
    const svg = renderCapabilityRadarChart(summaries, dimensions);
    expect(svg).toContain('8维度能力雷达图');
    expect(svg).toContain('沟通协作');
    expect(svg).toContain('办公写作');
    const points = [...svg.matchAll(/<polygon points="([^"]+)" fill="#[0-9a-f]{6}" fill-opacity="0\.08"/g)][0][1].split(' ').map((pair) => pair.split(',').map(Number));
    expect(points).toHaveLength(8);
    points.forEach((point, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 8;
      const ratio = scores[dimensions[index].key] / 30;
      expect(Math.abs(point[0] - (315 + Math.cos(angle) * 205 * ratio))).toBeLessThan(0.06);
      expect(Math.abs(point[1] - (330 + Math.sin(angle) * 205 * ratio))).toBeLessThan(0.06);
    });
    expect(renderCapabilityBarChart(summaries, dimensions)).toContain('满分 240');
  });

  it('报告里出现 8 个自定义维度的中文名与满分，不再写死 7 维', () => {
    const make = (model: string, rank: number, base: number): CapabilityModelSummary => {
      const scores = Object.fromEntries(dimensions.map((dimension, index) => [dimension.key, Math.min(30, base + index)]));
      return { model, rank, totalScore: Object.values(scores).reduce((sum, value) => sum + value, 0), maxScore: 240, dimensionScores: scores, dimensionMaxScores: Object.fromEntries(dimensions.map((dimension) => [dimension.key, 30])), completedCount: 48, questionCount: 48 };
    };
    const summaries = [make('qwen3:32b', 1, 22), make('deepseek-r1:32b', 2, 18)];
    const result: CapabilityRunResult = {
      startedAt: '2026-09-18T00:00:00.000Z', finishedAt: '2026-09-18T01:00:00.000Z', cancelled: false, suiteVersion: 'CapabilitySuite-1.1',
      config: { models: ['qwen3:32b', 'deepseek-r1:32b'], maxOutputTokens: 512, temperature: 0, timeoutMs: 120000, thinkingMode: 'off', suiteVersion: 'CapabilitySuite-1.1' },
      environment: { deployment: 'native', binary: 'ollama', apiHost: '127.0.0.1', apiPort: 11434, gpuVendor: 'amd', gpuModels: ['gfx1100'], installedModels: ['qwen3:32b', 'deepseek-r1:32b'], warnings: [] },
      questions: questions.slice(0, 8).map((question) => ({ model: 'qwen3:32b', id: question.id, dimension: question.dimension, title: question.title, prompt: question.prompt, response: 'r', score: 5, maxScore: question.maxScore, status: 'success' as const, parserMode: 'json' as const, reasoningDetected: false, evidence: [] })),
      dimensions, summaries,
    };
    const markdown = renderCapabilityMarkdown({ result });
    const html = renderCapabilityHtml({ result });
    for (const dimension of dimensions) {
      expect(markdown).toContain(dimension.label);
      expect(html).toContain(dimension.label);
      expect(markdown).toContain(dimension.key);
    }
    expect(markdown).toContain('沟通协作（满分 30）');
    expect(markdown).toContain('8维能力雷达图');
    expect(markdown).toContain('| 维度 | dimension | 满分 | 题数 |');
    expect(markdown).not.toContain('写代码');
    expect(html).not.toContain('写代码');
  });
});
