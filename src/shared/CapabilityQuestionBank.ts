import { CAPABILITY_MAX_QUESTION_SCORE, CAPABILITY_RESPONSE_KEYS, CAPABILITY_RULE_KINDS, type CapabilityJsonValue, type CapabilityQuestion, type CapabilityResponseKey, type CapabilityRule } from './types';
import { capabilityDimensionLabel } from './CapabilityDimensions';

export { CAPABILITY_MAX_QUESTION_SCORE };

const MAX_DIMENSION_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`题库字段 ${field} 必须是非空字符串`);
  return value.trim();
}

function stringList(value: unknown, field: string, index: number): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`第 ${index + 1} 题的 ${field} 必须是非空字符串数组`);
  }
  return value.map((item) => String(item).trim());
}

function optionalStringList(value: unknown, field: string, index: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return stringList(value, field, index);
}

function expectedMap(value: unknown, field: string, index: number): Record<string, string> {
  if (!isRecord(value) || !Object.keys(value).length) throw new Error(`第 ${index + 1} 题的 ${field} 必须是非空对象`);
  const entries = Object.entries(value).map(([key, item]) => [key, String(item ?? '').trim()] as const);
  if (entries.some(([, item]) => !item)) throw new Error(`第 ${index + 1} 题的 ${field} 存在空值`);
  return Object.fromEntries(entries);
}

function optionalPositiveInteger(value: unknown, field: string, index: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`第 ${index + 1} 题的 ${field} 必须是正整数`);
  return value;
}

/** json_schema 的期望值：字符串为期望取值，null 表示「该字段应当缺失」，对象表示多层抽取。 */
function jsonValue(value: unknown, field: string, index: number): CapabilityJsonValue {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error(`第 ${index + 1} 题的 ${field} 存在空字符串（未知字段请写 null）`);
    return value.trim();
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length) throw new Error(`第 ${index + 1} 题的 ${field} 不能是空对象`);
    return Object.fromEntries(entries.map(([key, item]) => [key, jsonValue(item, `${field}.${key}`, index)]));
  }
  throw new Error(`第 ${index + 1} 题的 ${field} 只能是字符串、null 或嵌套对象`);
}

function parseRule(value: unknown, index: number): CapabilityRule {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error(`第 ${index + 1} 题的 rule 无效`);
  const lengthLimit = (field: 'minimumLength' | 'maximumLength') => (typeof value[field] === 'number' ? value[field] as number : undefined);
  switch (value.kind) {
    case 'keywords': {
      if (!Array.isArray(value.groups) || !value.groups.length || value.groups.some((group) => !Array.isArray(group) || !group.length || group.some((item) => typeof item !== 'string' || !item.trim()))) throw new Error(`第 ${index + 1} 题的 keywords.groups 无效`);
      return { kind: 'keywords', groups: value.groups.map((group) => group.map((item: string) => String(item).trim())), minimumLength: lengthLimit('minimumLength'), maximumLength: lengthLimit('maximumLength') };
    }
    case 'number':
      return { kind: 'number', answers: stringList(value.answers, 'number.answers', index), tolerance: typeof value.tolerance === 'number' ? value.tolerance : undefined };
    case 'exact':
      return { kind: 'exact', aliases: stringList(value.aliases, 'exact.aliases', index) };
    case 'code':
      return { kind: 'code', checks: stringList(value.checks, 'code.checks', index) };
    case 'contains_all':
      return { kind: 'contains_all', terms: stringList(value.terms, 'contains_all.terms', index) };
    case 'formula':
      return { kind: 'formula', checks: stringList(value.checks, 'formula.checks', index) };
    case 'sql_result':
      return { kind: 'sql_result', checks: stringList(value.checks, 'sql_result.checks', index) };
    case 'json_schema': {
      const required = optionalStringList(value.required, 'json_schema.required', index);
      let expected: CapabilityJsonValue | CapabilityJsonValue[] | undefined;
      if (Array.isArray(value.expected)) expected = value.expected.map((item, position) => jsonValue(item, `json_schema.expected[${position}]`, index));
      else if (value.expected !== undefined && value.expected !== null) expected = jsonValue(value.expected, 'json_schema.expected', index);
      const expectedCount = optionalPositiveInteger(value.expectedCount, 'json_schema.expectedCount', index);
      if (!required && !expected && !expectedCount) throw new Error(`第 ${index + 1} 题的 json_schema 至少需要 required / expected / expectedCount 之一`);
      return { kind: 'json_schema', required, expected, expectedCount };
    }
    case 'tool_call': {
      const expectedTools = optionalStringList(value.expectedTools, 'tool_call.expectedTools', index);
      const requiredArgs = optionalStringList(value.requiredArgs, 'tool_call.requiredArgs', index);
      const notContains = optionalStringList(value.notContains, 'tool_call.notContains', index);
      const expected = value.expected === undefined || value.expected === null ? undefined : expectedMap(value.expected, 'tool_call.expected', index);
      if (!expectedTools && !requiredArgs && !expected && !notContains) throw new Error(`第 ${index + 1} 题的 tool_call 至少需要一个检查项`);
      return { kind: 'tool_call', expectedTools, requiredArgs, expected, notContains };
    }
    default:
      throw new Error(`第 ${index + 1} 题的 rule.kind 不支持：${String(value.kind)}（支持：${CAPABILITY_RULE_KINDS.join('、')}）`);
  }
}

function optionalLabel(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`题库字段 ${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_DIMENSION_LENGTH) throw new Error(`题库字段 ${field} 过长（最多 ${MAX_DIMENSION_LENGTH} 字）`);
  return trimmed;
}

export function parseCapabilityQuestionBank(raw: unknown): CapabilityQuestion[] {
  const questions = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : undefined;
  if (!questions || !questions.length) throw new Error('题库必须包含至少 1 道题目');
  const ids = new Set<string>();
  return questions.map((value, index) => {
    if (!isRecord(value)) throw new Error(`第 ${index + 1} 题格式无效`);
    const id = nonEmptyString(value.id, 'id');
    if (ids.has(id)) throw new Error(`题目 ID 重复：${id}`);
    ids.add(id);
    // 维度不再限定在内置 7 个之内：题库里写什么维度，评测与报告就用什么维度。
    const dimension = nonEmptyString(value.dimension, 'dimension');
    if (dimension.length > MAX_DIMENSION_LENGTH) throw new Error(`第 ${index + 1} 题 dimension 过长（最多 ${MAX_DIMENSION_LENGTH} 字）：${dimension}`);
    const dimensionLabel = optionalLabel(value.dimensionLabel, 'dimensionLabel');
    const responseKey = (CAPABILITY_RESPONSE_KEYS as readonly unknown[]).includes(value.responseKey) ? value.responseKey as CapabilityResponseKey : undefined;
    if (!responseKey) throw new Error(`第 ${index + 1} 题 responseKey 必须是 ${CAPABILITY_RESPONSE_KEYS.join(' / ')}`);
    if (typeof value.maxScore !== 'number' || value.maxScore <= 0 || value.maxScore > CAPABILITY_MAX_QUESTION_SCORE) throw new Error(`第 ${index + 1} 题 maxScore 必须在 0 到 ${CAPABILITY_MAX_QUESTION_SCORE} 之间`);
    return { id, dimension, dimensionLabel, title: nonEmptyString(value.title, 'title'), prompt: nonEmptyString(value.prompt, 'prompt'), responseKey, maxScore: value.maxScore, rule: parseRule(value.rule, index) };
  });
}

export function serializeCapabilityQuestionBank(questions: CapabilityQuestion[]): string {
  return `${JSON.stringify({ formatVersion: 1, questions }, null, 2)}\n`;
}

export function getQuestionBankTemplate(): string {
  return serializeCapabilityQuestionBank([{
    id: 'custom.example', dimension: 'code', title: '自定义示例题',
    prompt: '只返回一个 JSON 对象，格式为 {"answer":"最终答案"}。请回答：1+1 等于多少？', responseKey: 'answer', maxScore: 5,
    rule: { kind: 'number', answers: ['2'], tolerance: 0 },
  }]);
}

export const CAPABILITY_QUESTION_BANK_COLUMNS = ['id', 'dimension', 'dimensionLabel', 'title', 'prompt', 'responseKey', 'maxScore', 'ruleKind', 'ruleData'] as const;
export type CapabilityQuestionBankRow = Record<string, unknown>;

export function capabilityQuestionToRow(question: CapabilityQuestion): CapabilityQuestionBankRow {
  return {
    id: question.id,
    dimension: question.dimension,
    dimensionLabel: capabilityDimensionLabel(question.dimension, question.dimensionLabel),
    title: question.title,
    prompt: question.prompt,
    responseKey: question.responseKey,
    maxScore: question.maxScore,
    ruleKind: question.rule.kind,
    ruleData: JSON.stringify(question.rule),
  };
}

export function capabilityQuestionsToRows(questions: CapabilityQuestion[]): CapabilityQuestionBankRow[] {
  return questions.map(capabilityQuestionToRow);
}

export function parseCapabilityQuestionRows(rows: CapabilityQuestionBankRow[]): CapabilityQuestion[] {
  const raw = rows.map((row, index) => {
    const ruleData = typeof row.ruleData === 'string' ? row.ruleData.trim() : '';
    let rule: unknown;
    try { rule = ruleData ? JSON.parse(ruleData) : { kind: row.ruleKind }; }
    catch { throw new Error(`第 ${index + 2} 行 ruleData 不是有效 JSON`); }
    return { id: row.id, dimension: row.dimension, dimensionLabel: row.dimensionLabel, title: row.title, prompt: row.prompt, responseKey: row.responseKey, maxScore: typeof row.maxScore === 'number' ? row.maxScore : Number(row.maxScore), rule };
  });
  return parseCapabilityQuestionBank(raw);
}

/** 一行导入失败的原因。row 为 Excel 行号（含表头，从 1 开始）。 */
export type CapabilityRowIssue = { row: number; id: string; message: string };
export type CapabilityRowParseResult = { questions: CapabilityQuestion[]; issues: CapabilityRowIssue[] };

/**
 * 逐行容错解析：单行数据有问题（比如手改 Excel 时 JSON 写坏）只跳过该行并记录原因，
 * 不影响其余题目导入。
 */
export function parseCapabilityQuestionRowsWithIssues(rows: CapabilityQuestionBankRow[]): CapabilityRowParseResult {
  const questions: CapabilityQuestion[] = [];
  const issues: CapabilityRowIssue[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : '(无 id)';
    try {
      const parsed = parseCapabilityQuestionRows([row])[0];
      if (seen.has(parsed.id)) throw new Error(`题目 ID 重复：${parsed.id}`);
      seen.add(parsed.id);
      questions.push(parsed);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^第 \d+ [题行]的?\s*/, '');
      issues.push({ row: index + 2, id, message });
    }
  });
  return { questions, issues };
}

/** 题库工作表必须包含的列；缺列时直接给出可读提示，而不是逐行报错。 */
export function missingCapabilityBankColumns(headers: string[]): string[] {
  const normalized = headers.map((header) => header.trim());
  return CAPABILITY_QUESTION_BANK_COLUMNS.filter((column) => !normalized.includes(column));
}

/** JSON 题库里一条题目的问题。index 为题目在题库中的序号（从 1 开始）。 */
export type CapabilityBankIssue = { index: number; id: string; message: string };

/** JSON 题库的逐题容错解析：坏题目只跳过并记录，不影响其余题目。 */
export function parseCapabilityQuestionBankWithIssues(raw: unknown): { questions: CapabilityQuestion[]; issues: CapabilityBankIssue[] } {
  const items = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : undefined;
  if (!items || !items.length) throw new Error('题库必须包含至少 1 道题目');
  const questions: CapabilityQuestion[] = [];
  const issues: CapabilityBankIssue[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = isRecord(item) && typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '(无 id)';
    try {
      const parsed = parseCapabilityQuestionBank([item])[0];
      if (seen.has(parsed.id)) throw new Error(`题目 ID 重复：${parsed.id}`);
      seen.add(parsed.id);
      questions.push(parsed);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^第 \d+ [题行]的?\s*/, '');
      issues.push({ index: index + 1, id, message });
    }
  });
  return { questions, issues };
}