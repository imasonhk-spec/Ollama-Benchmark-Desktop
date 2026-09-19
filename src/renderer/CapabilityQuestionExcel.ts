import JSZip from 'jszip';
import { CAPABILITY_QUESTION_BANK_COLUMNS, capabilityQuestionsToRows, missingCapabilityBankColumns, parseCapabilityQuestionRowsWithIssues, type CapabilityQuestionBankRow, type CapabilityRowIssue } from '../shared/CapabilityQuestionBank';
import type { CapabilityQuestion } from '../shared/types';

const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const colName = (index: number) => { let n = index + 1; let out = ''; while (n) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); } return out; };
const cellXml = (row: number, column: number, value: unknown) => { const ref = `${colName(column)}${row}`; if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`; return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value ?? ''))}</t></is></c>`; };
const sheetXml = (rows: unknown[][]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, ri) => `<row r="${ri + 1}">${row.map((value, ci) => cellXml(ri + 1, ci, value)).join('')}</row>`).join('')}</sheetData></worksheet>`;
const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="题库" sheetId="1" r:id="rId1"/><sheet name="规则说明" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;

/** 「规则说明」工作表内容，覆盖全部受支持的 ruleKind，方便按场景自建题库。 */
const RULE_NOTES: unknown[][] = [
  ['ruleKind', 'responseKey', 'ruleData 格式', '说明'],
  ['keywords', 'answer', '{"kind":"keywords","groups":[["关键词1","同义词"]],"minimumLength":20,"maximumLength":180}', '每个 groups 子数组至少命中一个关键词，按命中比例给分；超出 maximumLength 或不足 minimumLength 会折半'],
  ['number', 'answer', '{"kind":"number","answers":["42"],"tolerance":0.01}', '数值答案，允许误差'],
  ['exact', 'answer', '{"kind":"exact","aliases":["标准答案"]}', '完全匹配或包含别名'],
  ['code', 'code', '{"kind":"code","checks":["function solution","return"]}', '正则检查代码关键结构，按命中比例给分'],
  ['contains_all', 'answer', '{"kind":"contains_all","terms":["手机号","身份证号"]}', '必含项：全部出现在模型原始输出中才满分，按比例给分'],
  ['formula', 'answer', '{"kind":"formula","checks":["COUNTIFS","技术部","已审批"]}', '表格公式要素检查（忽略大小写与多余空白），按比例给分'],
  ['sql_result', 'answer', '{"kind":"sql_result","checks":["JOIN","GROUP BY","ORDER BY"]}', 'SQL 要素检查，语义同 formula'],
  ['json_schema', 'answer', '{"kind":"json_schema","required":["name","company"],"expected":{"name":"陈明","company":"示例科技有限公司"}}', '结构化抽取：校验必填字段与取值；expected 也可写成数组并配 expectedCount 校验条数与逐条内容'],
  ['tool_call', 'tool_calls', '{"kind":"tool_call","expectedTools":["email.send"],"requiredArgs":["to","subject","body"],"expected":{"to":"内部销售负责人"},"notContains":["外部供应商群"]}', '工具调用：校验调用的工具、必填参数、参数取值，以及不得出现的敏感内容'],
];

export async function capabilityQuestionsToExcel(questions: CapabilityQuestion[], includeTemplateNotes = false): Promise<Blob> {
  const zip = new JSZip();
  const rows = [Array.from(CAPABILITY_QUESTION_BANK_COLUMNS), ...capabilityQuestionsToRows(questions).map((row) => CAPABILITY_QUESTION_BANK_COLUMNS.map((column) => row[column]))];
  zip.file('[Content_Types].xml', contentTypes).file('_rels/.rels', rootRels).file('xl/workbook.xml', workbookXml).file('xl/_rels/workbook.xml.rels', workbookRels).file('xl/worksheets/sheet1.xml', sheetXml(rows)).file('xl/worksheets/sheet2.xml', sheetXml(includeTemplateNotes ? RULE_NOTES : [['请在题库工作表中逐行填写题目；ruleData 必须是 JSON。'], ['完整规则类型见下载的 Excel 格式模板。']]));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function cellValue(cell: Element): string { const inline = cell.querySelector('is t'); if (inline) return inline.textContent ?? ''; return cell.querySelector('v')?.textContent ?? ''; }
function readSheetRows(xml: string): string[][] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.querySelectorAll('sheetData > row')).map((row) => {
    const values: string[] = [];
    for (const cell of Array.from(row.children).filter((child) => child.localName === 'c')) {
      const match = cell.getAttribute('r')?.match(/^([A-Z]+)/); let column = 0;
      for (const char of match?.[1] ?? 'A') column = column * 26 + char.charCodeAt(0) - 64;
      while (values.length < column) values.push(''); values[column - 1] = cellValue(cell);
    }
    return values;
  });
}

export type CapabilityExcelImport = { questions: CapabilityQuestion[]; issues: CapabilityRowIssue[] };

/**
 * 解析 Excel 题库。单行数据有问题（例如手改后 ruleData 不再是合法 JSON）只跳过该行并记录原因，
 * 其余题目照常导入；仅当没有任何可用行时才整体报错。
 */
export async function capabilityQuestionsFromExcel(data: ArrayBuffer): Promise<CapabilityExcelImport> {
  const zip = await JSZip.loadAsync(data); const file = zip.file('xl/worksheets/sheet1.xml');
  if (!file) throw new Error('Excel 文件缺少“题库”工作表');
  const rows = readSheetRows(await file.async('string')); if (rows.length < 2) throw new Error('Excel 题库没有可导入的题目行');
  const headers = rows[0].map((value) => value.trim());
  const missing = missingCapabilityBankColumns(headers);
  if (missing.length) throw new Error(`Excel 题库缺少必需列：${missing.join('、')}（可从“下载 Excel 格式模板”获取表头）`);
  const records: CapabilityQuestionBankRow[] = rows.slice(1).filter((row) => row.some((value) => value.trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  if (!records.length) throw new Error('Excel 题库没有可导入的题目行');
  const { questions, issues } = parseCapabilityQuestionRowsWithIssues(records);
  if (!questions.length) throw new Error(`Excel 题库没有可用的题目行：${issues.slice(0, 5).map((issue) => `第 ${issue.row} 行「${issue.id}」${issue.message}`).join('；')}${issues.length > 5 ? ` 等 ${issues.length} 行` : ''}`);
  return { questions, issues };
}
