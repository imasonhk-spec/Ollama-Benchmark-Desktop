import { describe, expect, it } from 'vitest';
import { getCapabilityQuestions } from './QuestionBank';
import { parseCapabilityAnswer, scoreCapabilityAnswer } from './CapabilityScorer';
import type { CapabilityQuestion, CapabilityResponseKey, CapabilityRule } from '../../shared/types';

describe('CapabilityScorer', () => {
  it('parses JSON answers after thinking blocks and scores numbers', () => {
    const question = getCapabilityQuestions().find((item) => item.id === 'math.discount')!;
    const parsed = parseCapabilityAnswer('<think>先计算</think>{"answer":"540"}', question.responseKey);
    expect(parsed.parserMode).toBe('json');
    expect(scoreCapabilityAnswer(question, parsed.answer).score).toBe(5);
  });

  it('scores keyword groups proportionally and accepts code fallback', () => {
    const translation = getCapabilityQuestions().find((item) => item.id === 'translation.enZh.config')!;
    expect(scoreCapabilityAnswer(translation, '请保存配置，完成后导出报告。').score).toBeGreaterThan(0);
    const code = getCapabilityQuestions().find((item) => item.id === 'code.brackets')!;
    const parsed = parseCapabilityAnswer('function solution(text) { const stack=[]; stack.push(text); stack.pop(); return true; }', 'code');
    expect(parsed.parserMode).toBe('fallback');
    expect(scoreCapabilityAnswer(code, parsed.answer).score).toBeGreaterThan(3);
  });

  it('checks exact knowledge aliases', () => {
    const question = getCapabilityQuestions().find((item) => item.id === 'knowledge.chushibiao')!;
    expect(scoreCapabilityAnswer(question, '刘禅').score).toBe(5);
    expect(scoreCapabilityAnswer(question, '刘备').score).toBe(0);
  });
});

describe('CapabilityScorer 业务规则（V2.4）', () => {
  const build = (rule: CapabilityRule, over: Partial<CapabilityQuestion> = {}): CapabilityQuestion => ({ id: 't', dimension: 'officeWriting', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5, rule, ...over });
  /** 与 CapabilityRunner 相同的调用链：解析 → 评分。 */
  const run = (rule: CapabilityRule, raw: string, responseKey: CapabilityResponseKey = 'answer') => {
    const parsed = parseCapabilityAnswer(raw, responseKey);
    return scoreCapabilityAnswer(build(rule, { responseKey }), parsed.answer, { rawResponse: raw, root: parsed.root, value: parsed.value });
  };

  it('嵌套 JSON 应答不会被截断（旧正则只取到第一个右括号）', () => {
    const parsed = parseCapabilityAnswer('{"answer":{"payment":{"amount":"30000"}}}', 'answer');
    expect(parsed.parserMode).toBe('json');
    expect(JSON.parse(parsed.answer)).toEqual({ payment: { amount: '30000' } });
  });

  it('keywords 支持 maximumLength：超出上限折半', () => {
    const rule: CapabilityRule = { kind: 'keywords', groups: [['摘要']], maximumLength: 10 };
    expect(run(rule, '{"answer":"摘要：今天开会"}').score).toBe(5);
    const long = run(rule, `{"answer":"摘要：${'会'.repeat(40)}"}`);
    expect(long.score).toBe(2.5);
    expect(long.evidence.join(' ')).toContain('上限');
  });

  it('contains_all 按必含项命中比例给分', () => {
    const rule: CapabilityRule = { kind: 'contains_all', terms: ['手机号', '身份证号', '银行卡号'] };
    expect(run(rule, '{"answer":["手机号","身份证号","银行卡号"]}').score).toBe(5);
    expect(run(rule, '{"answer":["手机号"]}').score).toBe(1.5);
  });

  it('formula 与 sql_result 忽略大小写与多余空白', () => {
    expect(run({ kind: 'formula', checks: ['SUM', 'A2:A10'] }, '{"answer":"=sum(a2:a10)"}').score).toBe(5);
    expect(run({ kind: 'sql_result', checks: ['GROUP BY', 'ORDER BY'] }, '{"answer":"select 1 group   by a order   by b"}').score).toBe(5);
  });

  it('json_schema：null 期望值要求模型显式输出 null，不能乱猜也不能漏字段', () => {
    const rule: CapabilityRule = { kind: 'json_schema', required: ['owner'], expected: { owner: null } };
    expect(run(rule, '{"answer":{"owner":null}}').score).toBe(5);
    // 字段在、但瞎填了一个值：必填项通过、null 期望不通过
    expect(run(rule, '{"answer":{"owner":"待定"}}').score).toBe(2.5);
    // 字段整个缺失：必填与 null 期望都不通过 → 0
    expect(run(rule, '{"answer":{}}').score).toBe(0);
  });

  it('json_schema：数组抽取校验条数与逐条内容', () => {
    const rule: CapabilityRule = { kind: 'json_schema', expected: [{ task: '发报价' }, { task: '改合同' }], expectedCount: 2 };
    expect(run(rule, '{"answer":[{"task":"明天发报价"},{"task":"改合同模板"}]}').score).toBe(5);
    // 条数不符 + 少一条 → 3 项检查里只过 1 项
    expect(run(rule, '{"answer":[{"task":"明天发报价"}]}').score).toBe(1.5);
  });

  it('tool_call：校验工具、必填参数、参数取值与禁出现内容', () => {
    const rule: CapabilityRule = { kind: 'tool_call', expectedTools: ['email.send'], requiredArgs: ['to', 'body'], expected: { to: '内部销售' }, notContains: ['外部'] };
    expect(run(rule, '{"tool_calls":[{"name":"email.send","arguments":{"to":"内部销售负责人","body":"同步"}}]}', 'tool_calls').score).toBe(5);
    // 共 5 项检查：工具 + 2 个必填参数 + 取值 + 禁含项；泄露外部信息时只有取值与禁含项不过
    const leak = run(rule, '{"tool_calls":[{"name":"email.send","arguments":{"to":"外部群","body":"名单"}}]}', 'tool_calls');
    expect(leak.score).toBe(3);
    expect(leak.evidence.join(' ')).toContain('未出现');
    // 参数缺失：requiredArgs 中 body 不存在
    expect(run(rule, '{"tool_calls":[{"name":"email.send","arguments":{"to":"内部销售负责人"}}]}', 'tool_calls').score).toBe(4);
  });

  it('tool_call：兼容 parameters / args 两种参数写法', () => {
    const rule: CapabilityRule = { kind: 'tool_call', expectedTools: ['task.create'], requiredArgs: ['title'] };
    expect(run(rule, '{"tool_calls":[{"function":{"name":"task.create","parameters":{"title":"更新文档"}}}]}', 'tool_calls').score).toBe(5);
    expect(run(rule, '{"tool_calls":[{"name":"task.create","args":"{\\"title\\":\\"更新文档\\"}"}]}', 'tool_calls').score).toBe(5);
  });
});
