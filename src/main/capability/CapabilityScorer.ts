import type { CapabilityJsonValue, CapabilityQuestion, CapabilityResponseKey } from '../../shared/types';

export type ParsedCapabilityAnswer = {
  /** 供文本类规则使用的可读答案。 */
  answer: string;
  parserMode: 'json' | 'fallback' | 'invalid';
  /** JSON 应答的根对象，供 json_schema / tool_call 等结构化规则使用。 */
  root?: Record<string, unknown>;
  /** responseKey 对应的原始值，可能是字符串、对象或数组。 */
  value?: unknown;
};
export type CapabilityScore = { score: number; evidence: string[] };

function stripReasoning(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
}

function cleanCode(raw: string): string {
  return raw.replace(/^```(?:javascript|typescript|js|ts)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意应答值转成可读文本；空值返回 undefined，用于判断 responseKey 是否真的有内容。 */
function toAnswerText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : undefined;
  if (isRecordLike(value)) return Object.keys(value).length ? JSON.stringify(value) : undefined;
  return undefined;
}

/** 扫描出所有配平的 JSON 片段，能正确处理嵌套对象与字符串内的括号（正则做不到）。 */
function extractBalanced(text: string, open: string, close: string): string[] {
  const found: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== open) continue;
    let depth = 0; let inString = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) { escaped = false; continue; }
      if (inString) {
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) { found.push(text.slice(start, index + 1)); break; }
      }
    }
  }
  return found;
}

export function parseCapabilityAnswer(raw: string, responseKey: CapabilityResponseKey): ParsedCapabilityAnswer {
  const cleaned = stripReasoning(raw);
  const candidates = extractBalanced(cleaned, '{', '}');
  let lastRoot: Record<string, unknown> | undefined;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]) as Record<string, unknown>;
      lastRoot = parsed;
      const value = parsed[responseKey] ?? parsed.answer ?? (responseKey === 'code' ? parsed.code : undefined);
      const text = toAnswerText(value);
      if (text !== undefined) return { answer: responseKey === 'code' ? cleanCode(text) : text, parserMode: 'json', root: parsed, value };
    } catch { /* try the next candidate */ }
  }
  if (responseKey === 'code') {
    const functionIndex = cleaned.search(/function\s+solution\s*\(/i);
    if (functionIndex >= 0) return { answer: cleanCode(cleaned.slice(functionIndex)), parserMode: 'fallback' };
  }
  // 工具调用类题目：部分模型直接输出 tool_calls 数组而不套外层对象。
  if (responseKey === 'tool_calls') {
    const arrayText = extractBalanced(cleaned, '[', ']').at(-1);
    if (arrayText) {
      try {
        const parsedArray = JSON.parse(arrayText) as unknown;
        const text = toAnswerText(parsedArray);
        if (text !== undefined) return { answer: text, parserMode: 'fallback', value: parsedArray };
      } catch { /* ignore malformed array */ }
    }
  }
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // 模型若省掉 responseKey 外层包装，仍把解析出的根对象带出去，供 json_schema 等结构化规则考察。
  if (lines.length > 0) return { answer: cleanCode(lines[lines.length - 1]), parserMode: 'fallback', root: lastRoot };
  return { answer: '', parserMode: 'invalid' };
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。、“”‘’；：！？,.!?;:'"`_()（）【】\[\]{}]/g, '');
}

/** 宽松匹配用的归一化：忽略大小写、压掉多余空白，但保留标点（邮箱、公式里有意义）。 */
function loose(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function parseNumber(value: string): number | undefined {
  const fraction = value.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator === 0 ? undefined : Number(fraction[1]) / denominator;
  }
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

const roundHalf = (value: number) => Math.round(value * 2) / 2;

export type CapabilityAnswerContext = { rawResponse?: string; root?: Record<string, unknown>; value?: unknown };

/** 结构化规则要考察的值：优先 responseKey 的值；模型若省掉外层包装则退回整个根对象。 */
function resolveStructuredValue(context: CapabilityAnswerContext | undefined): unknown {
  if (context?.value !== undefined) return context.value;
  if (context?.root !== undefined) return context.root;
  return undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try { return JSON.parse(text) as unknown; } catch { return value; }
}

type ToolCallEntry = { name: string; args: Record<string, unknown> };

/** 把 tool_calls 数组归一化成 { name, args }，兼容 arguments / parameters / args 三种写法。 */
function toolCallEntries(value: unknown): ToolCallEntry[] {
  const parsed = parseMaybeJson(value);
  const list = Array.isArray(parsed) ? parsed : isRecordLike(parsed) && Array.isArray(parsed.tool_calls) ? parsed.tool_calls as unknown[] : [];
  return list.flatMap((item) => {
    const fn = isRecordLike(item) && isRecordLike(item.function) ? item.function : item;
    if (!isRecordLike(fn)) return [];
    const rawName = fn.name ?? fn.tool ?? fn.tool_name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const rawArgs = parseMaybeJson(fn.arguments ?? fn.parameters ?? fn.args);
    return [{ name, args: isRecordLike(rawArgs) ? rawArgs : {} }];
  });
}

/** 命中即得分（按命中比例给分），用于 contains_all / formula / sql_result。 */
function scoreTermHits(terms: string[], haystack: string, maxScore: number, evidence: string[], label: string): CapabilityScore {
  const text = loose(haystack);
  const missing = terms.filter((term) => !text.includes(loose(term)));
  const hitCount = terms.length - missing.length;
  evidence.push(`${label}命中 ${hitCount}/${terms.length}`);
  if (missing.length) evidence.push(`未命中：${missing.join('、')}`);
  return { score: roundHalf((maxScore * hitCount) / terms.length), evidence };
}

type ExpectedLeaf = { path: string[]; value: string | null };

/** 把嵌套的期望值摊平成「路径 → 期望值」列表，便于逐字段核对。 */
function flattenExpected(value: CapabilityJsonValue, path: string[]): ExpectedLeaf[] {
  if (value === null || typeof value === 'string') return [{ path, value }];
  return Object.entries(value).flatMap(([key, child]) => flattenExpected(child, [...path, key]));
}

function pickPath(actual: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecordLike(current) ? current[key] : undefined), actual);
}

/** 字段取值比较：忽略大小写、空白与千分位逗号（"30,000" 与 "30000" 视为一致）。 */
const normalizeValue = (value: string) => value.toLocaleLowerCase().replace(/[\s,]/g, '');

function leafMatches(actual: unknown, expected: string | null): boolean {
  // expected 为 null 表示该字段本就无从确认，模型必须显式输出 null 或空串；
  // 直接不写这个字段不算「答对」，缺失交给 required 去管。
  if (expected === null) return actual === null || (typeof actual === 'string' && !actual.trim());
  const text = toAnswerText(actual);
  return text !== undefined && normalizeValue(text).includes(normalizeValue(expected));
}

export function scoreCapabilityAnswer(question: CapabilityQuestion, answer: string, context?: CapabilityAnswerContext): CapabilityScore {
  const evidence: string[] = [];
  const normalizedAnswer = normalize(answer);
  const rawResponse = context?.rawResponse ?? answer;
  switch (question.rule.kind) {
    case 'keywords': {
      const hitCount = question.rule.groups.reduce((count, group, index) => {
        const hit = group.some((keyword) => new RegExp(keyword, 'iu').test(answer));
        if (hit) evidence.push(`关键词组 ${index + 1} 命中`);
        return count + (hit ? 1 : 0);
      }, 0);
      let score = question.maxScore * (hitCount / question.rule.groups.length);
      if (question.rule.minimumLength && answer.trim().length < question.rule.minimumLength) {
        score = Math.min(score, question.maxScore * 0.5);
        evidence.push(`回答长度不足 ${question.rule.minimumLength} 字`);
      }
      if (question.rule.maximumLength && answer.trim().length > question.rule.maximumLength) {
        score = Math.min(score, question.maxScore * 0.5);
        evidence.push(`回答长度超出 ${question.rule.maximumLength} 字上限（实际 ${answer.trim().length} 字）`);
      }
      return { score: roundHalf(score), evidence };
    }
    case 'number': {
      const value = parseNumber(answer);
      const expected = question.rule.answers.map(parseNumber).find((item): item is number => item !== undefined);
      const tolerance = question.rule.tolerance ?? 0;
      if (value !== undefined && expected !== undefined && Math.abs(value - expected) <= tolerance) {
        evidence.push(`数值正确：${value}`);
        return { score: question.maxScore, evidence };
      }
      evidence.push(value === undefined ? '未解析到有效数字' : `数值不匹配：${value}`);
      return { score: 0, evidence };
    }
    case 'exact': {
      const matched = question.rule.aliases.some((alias) => {
        const aliasNormalized = normalize(alias);
        if (/^[a-z]+$/i.test(alias)) return new RegExp(`\\b${alias}\\b`, 'i').test(answer);
        return normalizedAnswer.includes(aliasNormalized);
      });
      evidence.push(matched ? '标准答案命中' : '未命中标准答案');
      return { score: matched ? question.maxScore : 0, evidence };
    }
    case 'code': {
      const hitCount = question.rule.checks.reduce((count, pattern) => {
        const hit = new RegExp(pattern, 'iu').test(answer);
        if (hit) evidence.push(`代码检查通过：${pattern}`);
        return count + (hit ? 1 : 0);
      }, 0);
      return { score: roundHalf((question.maxScore * hitCount) / question.rule.checks.length), evidence };
    }
    case 'contains_all':
      return scoreTermHits(question.rule.terms, rawResponse, question.maxScore, evidence, '必含项');
    case 'formula':
      return scoreTermHits(question.rule.checks, rawResponse, question.maxScore, evidence, '公式要素');
    case 'sql_result':
      return scoreTermHits(question.rule.checks, rawResponse, question.maxScore, evidence, 'SQL 要素');
    case 'json_schema': {
      const value = parseMaybeJson(resolveStructuredValue(context));
      const { expected, required, expectedCount } = question.rule;
      let passed = 0;
      let total = 0;
      const record = (ok: boolean, detail: string) => { total += 1; if (ok) passed += 1; evidence.push(`${detail}：${ok ? '通过' : '未通过'}`); };
      if (Array.isArray(expected)) {
        const items = Array.isArray(value) ? value : [];
        if (expectedCount !== undefined) record(items.length === expectedCount, `条目数 ${items.length}/${expectedCount}`);
        expected.forEach((want, index) => {
          const leaves = flattenExpected(want, []);
          const ok = items.some((actual) => isRecordLike(actual) && leaves.every((leaf) => leafMatches(pickPath(actual, leaf.path), leaf.value)));
          record(ok, `第 ${index + 1} 条抽取`);
        });
      } else {
        const fields = isRecordLike(value) ? value : {};
        for (const key of required ?? []) record(Object.prototype.hasOwnProperty.call(fields, key), `字段 ${key} 存在`);
        if (expected !== undefined) {
          for (const leaf of flattenExpected(expected, [])) record(leafMatches(pickPath(fields, leaf.path), leaf.value), `字段 ${leaf.path.join('.')} 取值`);
        }
      }
      if (!total) return { score: 0, evidence: ['json_schema 规则没有可检查项'] };
      return { score: roundHalf((question.maxScore * passed) / total), evidence };
    }
    case 'tool_call': {
      const calls = toolCallEntries(resolveStructuredValue(context));
      const names = calls.map((call) => loose(call.name)).join(' ');
      const argsText = calls.map((call) => JSON.stringify(call.args ?? {})).join(' ');
      const whole = loose(rawResponse);
      let passed = 0;
      let total = 0;
      const record = (ok: boolean, detail: string) => { total += 1; if (ok) passed += 1; evidence.push(`${detail}：${ok ? '通过' : '未通过'}`); };
      if (!calls.length) evidence.push('未解析到任何工具调用');
      for (const tool of question.rule.expectedTools ?? []) record(names.includes(loose(tool)), `调用工具 ${tool}`);
      for (const arg of question.rule.requiredArgs ?? []) record(calls.some((call) => Object.prototype.hasOwnProperty.call(call.args, arg)), `参数 ${arg}`);
      for (const [arg, expectedValue] of Object.entries(question.rule.expected ?? {})) record(loose(argsText).includes(loose(expectedValue)), `参数 ${arg} 取值`);
      for (const term of question.rule.notContains ?? []) record(!whole.includes(loose(term)), `未出现「${term}」`);
      if (!total) return { score: 0, evidence: ['tool_call 规则没有可检查项'] };
      return { score: roundHalf((question.maxScore * passed) / total), evidence };
    }
  }
}
