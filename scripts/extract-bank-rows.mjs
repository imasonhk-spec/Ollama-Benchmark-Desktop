/* 把 samples/8维模型评测用例_办公类.xlsx 按 App 渲染层 capabilityQuestionsFromExcel 的读取逻辑
   （JSZip + sheet1.xml + 表头映射）抽成 samples/office-bank-rows.json，
   供 OfficeBankVerify.test.ts 在任意机器上复现「真实题库 → 导入 → 评分 → 图表 → 报告」链路。

   用法：node scripts/extract-bank-rows.mjs */
import JSZip from 'jszip';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'samples', '8维模型评测用例_办公类.xlsx');
const output = join(root, 'samples', 'office-bank-rows.json');

const unescape = (value) => value
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const zip = await JSZip.loadAsync(readFileSync(source));
const sheetFile = zip.file('xl/worksheets/sheet1.xml');
if (!sheetFile) throw new Error(`缺少 xl/worksheets/sheet1.xml：${source}`);
const sheetXml = await sheetFile.async('string');

const rows = [...sheetXml.matchAll(/<row r="(\d+)"[\s\S]*?<\/row>/g)].map((match) => {
  const values = [];
  for (const cell of match[0].matchAll(/<c r="([A-Z]+)\d+"[^>]*>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>|<v>([\s\S]*?)<\/v>)?<\/c>/g)) {
    let column = 0;
    for (const char of cell[1]) column = column * 26 + char.charCodeAt(0) - 64;
    values[column - 1] = unescape(cell[2] ?? cell[3] ?? '');
  }
  for (let index = 0; index < values.length; index += 1) values[index] ??= '';
  return values;
});

const headers = rows[0].map((value) => String(value).trim());
const records = rows.slice(1)
  .filter((row) => row.some((value) => String(value).trim()))
  .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));

writeFileSync(output, `${JSON.stringify({ sheet: '题库', header: headers, records }, null, 1)}\n`, 'utf8');
console.log(`headers = ${headers.join(',')}`);
console.log(`records = ${records.length} -> ${output}`);
