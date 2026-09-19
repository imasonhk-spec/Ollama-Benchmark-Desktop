import { describe, expect, it } from 'vitest';
import { capabilityQuestionsToRows, getQuestionBankTemplate, missingCapabilityBankColumns, parseCapabilityQuestionBank, parseCapabilityQuestionBankWithIssues, parseCapabilityQuestionRows, parseCapabilityQuestionRowsWithIssues, serializeCapabilityQuestionBank } from './CapabilityQuestionBank';

describe('CapabilityQuestionBank', () => {
  it('accepts the template shape and rejects malformed questions', () => {
    const template = JSON.parse(getQuestionBankTemplate());
    const parsed = parseCapabilityQuestionBank(template);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].dimension).toBe('code');
    expect(() => parseCapabilityQuestionBank({ questions: [{ id: 'bad' }] })).toThrow();
  });

  it('round-trips a custom bank as UTF-8 JSON', () => {
    const template = JSON.parse(getQuestionBankTemplate());
    const parsed = parseCapabilityQuestionBank(template);
    expect(parseCapabilityQuestionBank(JSON.parse(serializeCapabilityQuestionBank(parsed)))).toEqual(parsed);
  });
});

it('round-trips Excel-shaped rows including ruleData', () => {
  const questions = parseCapabilityQuestionBank(JSON.parse(getQuestionBankTemplate()));
  const once = parseCapabilityQuestionRows(capabilityQuestionsToRows(questions));
  const twice = parseCapabilityQuestionRows(capabilityQuestionsToRows(once));
  expect(twice).toEqual(once);
  // 导出时 dimensionLabel 会被补全成中文名，方便在 Excel 里对着改
  expect(once[0].dimensionLabel).toBe('写代码');
});

describe('自定义维度题库（V2.4：维度不再限定内置 7 个）', () => {
  const OFFICE_ROWS = [
    { id: 'officeWriting.1', dimension: 'officeWriting', dimensionLabel: '办公写作', title: '纪要改写', prompt: 'p', responseKey: 'answer', maxScore: 5, ruleKind: 'keywords', ruleData: JSON.stringify({ kind: 'keywords', groups: [['摘要']] }) },
    { id: 'officeWriting.2', dimension: 'officeWriting', dimensionLabel: '办公写作', title: '公文润色', prompt: 'p', responseKey: 'answer', maxScore: 5, ruleKind: 'keywords', ruleData: JSON.stringify({ kind: 'keywords', groups: [['通知']] }) },
    { id: 'officeSheet.1', dimension: 'officeSheet', dimensionLabel: '表格分析', title: '数据透视', prompt: 'p', responseKey: 'answer', maxScore: 5, ruleKind: 'number', ruleData: JSON.stringify({ kind: 'number', answers: ['12'] }) },
  ];

  it('接受题库里出现的任意维度（旧版会直接抛「dimension 不支持」）', () => {
    const questions = parseCapabilityQuestionRows(OFFICE_ROWS);
    expect(questions.map((question) => question.dimension)).toEqual(['officeWriting', 'officeWriting', 'officeSheet']);
    expect(questions[0].dimensionLabel).toBe('办公写作');
  });

  it('JSON 题库同样接受自定义维度与 dimensionLabel', () => {
    const questions = parseCapabilityQuestionBank({ questions: [{ id: 'a.1', dimension: 'officeMeeting', dimensionLabel: '会议管理', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5, rule: { kind: 'exact', aliases: ['ok'] } }] });
    expect(questions[0]).toMatchObject({ dimension: 'officeMeeting', dimensionLabel: '会议管理' });
  });

  it('允许百分制单题满分（0–100）', () => {
    const questions = parseCapabilityQuestionBank({ questions: [{ id: 'b.1', dimension: 'officeWriting', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 100, rule: { kind: 'exact', aliases: ['ok'] } }] });
    expect(questions[0].maxScore).toBe(100);
    expect(() => parseCapabilityQuestionBank({ questions: [{ id: 'b.2', dimension: 'officeWriting', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 1000, rule: { kind: 'exact', aliases: ['ok'] } }] })).toThrow();
  });

  it('仍会拦截非法维度标识', () => {
    expect(() => parseCapabilityQuestionBank({ questions: [{ id: 'c.1', dimension: '   ', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5, rule: { kind: 'exact', aliases: ['ok'] } }] })).toThrow();
    expect(() => parseCapabilityQuestionBank({ questions: [{ id: 'c.2', dimension: 'x'.repeat(80), title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5, rule: { kind: 'exact', aliases: ['ok'] } }] })).toThrow();
  });
});

describe('业务场景规则类型与容错导入（V2.4）', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'x.1', dimension: 'officeWriting', dimensionLabel: '办公写作', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5,
    ruleKind: 'keywords', ruleData: JSON.stringify({ kind: 'keywords', groups: [['a']] }), ...over,
  });

  it('接受 contains_all / formula / sql_result / json_schema / tool_call 五种业务规则', () => {
    const questions = parseCapabilityQuestionRows([
      row({ id: 'a', ruleKind: 'contains_all', ruleData: JSON.stringify({ kind: 'contains_all', terms: ['手机号', '身份证号'] }) }),
      row({ id: 'b', ruleKind: 'formula', ruleData: JSON.stringify({ kind: 'formula', checks: ['COUNTIFS', '技术部'] }) }),
      row({ id: 'c', ruleKind: 'sql_result', ruleData: JSON.stringify({ kind: 'sql_result', checks: ['JOIN', 'GROUP BY'] }) }),
      row({ id: 'd', ruleKind: 'json_schema', ruleData: JSON.stringify({ kind: 'json_schema', required: ['project'], expected: { owner: null, payment: { amount: '30000' } } }) }),
      row({ id: 'e', ruleKind: 'tool_call', responseKey: 'tool_calls', ruleData: JSON.stringify({ kind: 'tool_call', expectedTools: ['email.send'], notContains: ['外部'] }) }),
    ]);
    expect(questions.map((question) => question.rule.kind)).toEqual(['contains_all', 'formula', 'sql_result', 'json_schema', 'tool_call']);
    // null 期望值（字段本就无从确认）与嵌套对象都要原样保留
    expect(questions[3].rule).toMatchObject({ expected: { owner: null, payment: { amount: '30000' } } });
    expect(questions[4].responseKey).toBe('tool_calls');
  });

  it('keywords 保留 maximumLength（旧版会静默丢弃该上限）', () => {
    const [question] = parseCapabilityQuestionRows([row({ ruleData: JSON.stringify({ kind: 'keywords', groups: [['摘要']], minimumLength: 10, maximumLength: 120 }) })]);
    expect(question.rule).toMatchObject({ minimumLength: 10, maximumLength: 120 });
  });

  it('拒绝写法有问题的规则，并列出受支持的 ruleKind', () => {
    expect(() => parseCapabilityQuestionRows([row({ ruleData: JSON.stringify({ kind: 'sql', checks: ['x'] }) })])).toThrow(/rule\.kind 不支持：sql（支持：keywords、number、exact、code、contains_all、formula、sql_result、json_schema、tool_call）/);
    expect(() => parseCapabilityQuestionRows([row({ ruleData: JSON.stringify({ kind: 'json_schema', expected: { owner: 42 } }) })])).toThrow(/json_schema\.expected\.owner 只能是字符串、null 或嵌套对象/);
    expect(() => parseCapabilityQuestionRows([row({ ruleData: JSON.stringify({ kind: 'contains_all', terms: [] }) })])).toThrow(/contains_all\.terms 必须是非空字符串数组/);
  });

  it('逐行容错：坏行只跳过并给出 Excel 行号，不影响其余题目', () => {
    const { questions, issues } = parseCapabilityQuestionRowsWithIssues([
      row({ id: 'good.1' }),
      row({ id: 'broken', ruleData: '{"kind":"keywords"' }),
      row({ id: 'good.2', maxScore: 5 }),
      row({ id: 'bad-response', responseKey: 'text' }),
    ]);
    expect(questions.map((question) => question.id)).toEqual(['good.1', 'good.2']);
    expect(issues).toEqual([
      { row: 3, id: 'broken', message: 'ruleData 不是有效 JSON' },
      { row: 5, id: 'bad-response', message: 'responseKey 必须是 answer / code / tool_calls' },
    ]);
  });

  it('JSON 题库同样逐题容错，重复 ID 会被拦下', () => {
    const { questions, issues } = parseCapabilityQuestionBankWithIssues({ questions: [
      { id: 'ok.1', dimension: 'officeWriting', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5, rule: { kind: 'exact', aliases: ['ok'] } },
      { id: 'ok.1', dimension: 'officeWriting', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5, rule: { kind: 'exact', aliases: ['ok'] } },
      { id: 'no.1', dimension: 'officeWriting', title: 't', prompt: 'p', responseKey: 'answer', maxScore: 5 },
    ] });
    expect(questions.map((question) => question.id)).toEqual(['ok.1']);
    expect(issues.map((issue) => issue.index)).toEqual([2, 3]);
    expect(issues[0].message).toContain('题目 ID 重复');
  });

  it('缺列时给出可读提示而不是逐行报错', () => {
    expect(missingCapabilityBankColumns(['id', 'dimension', 'title', 'prompt', 'responseKey', 'maxScore', 'ruleKind', 'ruleData'])).toEqual(['dimensionLabel']);
    expect(missingCapabilityBankColumns(['id']).length).toBe(8);
  });
});
