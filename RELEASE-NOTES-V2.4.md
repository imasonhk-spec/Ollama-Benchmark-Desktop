# Ollama Benchmark 桌面端 — V2.4 发布说明

> 版本：`2.4.0`　|　产品名：`Ollama Benchmark_V2.4`　|　构建日期：2026-09-18
> 升级路径：V2.3 → V2.4（安装器会自动清理 V2.0 / V2.1 / V2.2 / V2.3 的旧 exe 与快捷方式）

---

## 1. 本次变更要点

「模型能力横评」从**内置 7 维固定题库**升级为**按场景自定义维度的通用横评引擎**：题库里出现哪些维度，评测、图表、报告就用哪些维度。同时修好了雷达图与实测数据对不上的问题，并补齐了业务场景（办公类）题库实际需要的规则类型。

| # | 变更 | 解决什么问题 |
|---|------|--------------|
| 1 | **维度不再限定内置 7 个** | 导入办公类 8 维题库（沟通协作、合规安全、表格分析…）不再被 `dimension 不支持` 拦住 |
| 2 | **雷达图按各维度自身量程映射** | 之前统一用固定量程导致「图上看不出差异/与实测对不上」；现在顶点半径 = 得分 ÷ 该维度满分，可逐点反算核对 |
| 3 | **规则类型由 4 种扩展到 9 种** | 业务题库用到的 `contains_all`、`formula`、`sql_result`、`json_schema`、`tool_call` 之前完全不被支持，48 道题里有 23 道无法评分 |
| 4 | **`keywords` 支持 `maximumLength`** | 之前只认 `minimumLength`，办公题库里 15 道「不得超过 N 字」的约束被静默忽略 |
| 5 | **导入逐行容错** | 单个坏单元格（如手改 Excel 时 JSON 写坏）之前会让整份题库导入失败；现在只跳过该行并提示 Excel 行号 |
| 6 | **修复样例题库损坏单元格** | `8维模型评测用例_办公类.xlsx` 第 36 行 `ruleData` 含乱码字符且被截断，导致导入中断 |

### 1.1 雷达图保真：图 = 数据

`CapabilityCharts.ts` 重写后，每根轴的量程取该维度自己的满分（如办公类每维 30 分），而不是所有维度共用一个固定分母：

- 顶点半径严格等于 `得分 ÷ 该维度满分 × 半径`，测试用 SVG 坐标反算半径比例来核对原始分数；
- 顶点直接标注真实分数，量程自动向上取整并给出「已扩大量程」诊断提示；
- 各维度满分不同（5 分制 / 百分制混用）时按各自量程映射，不会相互压扁。

### 1.2 规则类型词表（ruleKind）

| ruleKind | responseKey | ruleData 示例 | 评分方式 |
|----------|-------------|---------------|----------|
| `keywords` | `answer` | `{"kind":"keywords","groups":[["拒绝","不能"]],"minimumLength":20,"maximumLength":180}` | 每个 groups 子数组命中即得分，按比例给分；长度越界折半 |
| `number` | `answer` | `{"kind":"number","answers":["42"],"tolerance":0.01}` | 数值匹配，允许误差 |
| `exact` | `answer` | `{"kind":"exact","aliases":["标准答案"]}` | 完全匹配或包含别名 |
| `code` | `code` | `{"kind":"code","checks":["function solution","return"]}` | 正则检查代码结构，按比例给分 |
| `contains_all` | `answer` | `{"kind":"contains_all","terms":["手机号","身份证号"]}` | 必含项全部出现，按比例给分 |
| `formula` | `answer` | `{"kind":"formula","checks":["COUNTIFS","技术部","已审批"]}` | 表格公式要素检查（忽略大小写与多余空白） |
| `sql_result` | `answer` | `{"kind":"sql_result","checks":["JOIN","GROUP BY","ORDER BY"]}` | SQL 要素检查 |
| `json_schema` | `answer` | `{"kind":"json_schema","required":["name"],"expected":{"name":"陈明","owner":null,"payment":{"amount":"30000"}}}` | 结构化抽取：必填字段 + 逐路径取值比对；支持嵌套对象与 `null`（表示该字段本就无从确认，模型必须显式输出 null） |
| `tool_call` | `tool_calls` | `{"kind":"tool_call","expectedTools":["email.send"],"requiredArgs":["to","subject"],"expected":{"to":"内部销售负责人"},"notContains":["外部供应商群"]}` | 工具名、必填参数、参数取值、禁出现内容逐项检查 |

---

## 2. 代码改动清单

| 文件 | 改动 |
|------|------|
| `src/shared/types.ts` | `CapabilityDimension` 由字面量联合放宽为 `string`；新增 `CapabilityDimensionMeta`、`CapabilityJsonValue`、`CAPABILITY_RULE_KINDS`、`CAPABILITY_RESPONSE_KEYS`、`isCapabilityRuleKind()`；`CapabilityRule` 扩展至 9 种；`responseKey` 增加 `tool_calls`；`CapabilityRunResult` 增加 `dimensions` 字段 |
| `src/shared/CapabilityDimensions.ts` | **新增**：`collectCapabilityDimensions()` / `resolveCapabilityDimensions()` / `resolveCapabilityDimensionLabels()` / `axisTicks()` / `niceAxisCeil()`，统一「题库 → 维度元信息」的推导，并兼容旧结果文件 |
| `src/shared/CapabilityQuestionBank.ts` | 移除内置维度白名单校验；`maxScore` 上限放宽到 100；`parseRule()` 支持 9 种规则并给出可读错误；新增 `parseCapabilityQuestionRowsWithIssues()`、`parseCapabilityQuestionBankWithIssues()`、`missingCapabilityBankColumns()` |
| `src/shared/schemas.ts` | `capabilityQuestionSchema.dimension` 改为 `z.string()`；`responseKey` 枚举扩至 3 种；`capabilityRuleSchema` 扩展至 9 种（含递归的 `jsonValueSchema` 支持嵌套与 null） |
| `src/main/capability/CapabilityScorer.ts` | 重写：新增配平括号扫描（修复嵌套 JSON 被截断）；`keywords.maximumLength`；`contains_all` / `formula` / `sql_result` / `json_schema` / `tool_call` 评分；结构化答案与工具调用参数归一化 |
| `src/main/capability/CapabilityRunner.ts` | 聚合按题库实际维度动态计算；向评分器传递原始响应上下文 |
| `src/shared/CapabilityCharts.ts` | 重写雷达图与柱状图：按维度量程映射、顶点标注真实值、量程自适应与诊断 |
| `src/main/reports/CapabilityReportExporter.ts` | HTML / Markdown / DOCX 报告全部改用动态维度与标签 |
| `src/renderer/CapabilityEvaluationPage.tsx` | 维度列表动态化；导入后展示跳过的坏行与原因；帮助文案覆盖新规则类型 |
| `src/renderer/CapabilityQuestionExcel.ts` | 导入改为逐行容错并汇报；缺列时给出可读提示；「规则说明」页覆盖全部 9 种 ruleKind |
| `samples/` | **新增**：`8维模型评测用例_办公类.xlsx` 与 `office-bank-rows.json`（回归验证用真实题库） |
| `scripts/extract-bank-rows.mjs` | **新增**：按 App 的读取逻辑把样例 xlsx 抽成行数据，便于题库更新后重新生成 |

---

## 3. 测试方案与结果

### 3.1 真实业务题库全链路回归（新增 `src/shared/OfficeBankVerify.test.ts`）

以 `samples/8维模型评测用例_办公类.xlsx`（48 题 / 8 维 / 每维满分 30）跑通「导入 → 解析 → 评分 → 图表 → 报告」：

- **导入**：48 行全部解析成功、0 坏行，8 个维度与中文标签无乱码；
- **规则类型**：断言题库实际使用的 6 种类型分布（keywords 25 / tool_call 10 / contains_all 5 / json_schema 5 / formula 2 / sql_result 1）；
- **评分**：对每类规则各给一组「正确应答」与「错误应答」，断言得分差异——例如工具调用泄露外部信息只得 3/5、脱敏错误 0 分、`GROUP BY` 缺失按比例扣分、`owner=null` 的字段被瞎填要扣分；
- **图表**：断言 8 根轴按各自满分映射，并用 SVG 顶点坐标反算半径比例核对原始分数；
- **报告**：断言 Markdown/HTML 出现 8 个自定义维度的中文名与满分，且不再出现内置 7 维的「写代码」。

### 3.2 规则与解析单元测试

- `src/shared/CapabilityDimensions.test.ts`：维度推导、回退与标签解析（11 例）；
- `src/shared/CapabilityCharts.test.ts`：雷达图顶点可反算、各维度量程不同时分别映射、柱状图刻度随量程变化、空态与旧结果不产生 NaN（10 例）；
- `src/shared/CapabilityQuestionBank.test.ts`：9 种规则解析、`maximumLength` 保留、非法规则报错文案、逐行/逐题容错与重复 ID 拦截（13 例）；
- `src/main/capability/CapabilityScorer.test.ts`：嵌套 JSON 不被截断、`contains_all` 比例给分、`formula`/`sql_result` 大小写与空白容忍、`json_schema` 的 null 与数组抽取、`tool_call` 的工具/参数/禁含项与 `parameters`/`args` 兼容（10 例）。

### 3.3 执行结果

| 检查项 | 结果 |
|--------|------|
| `npm run typecheck` | **通过**（0 错误） |
| `npm test` | **156 个用例全部通过**（25 个测试文件；V2.3 为 104 例） |
| `npm run verify:package-target` | **通过** |

---

## 4. 交付物

| 产物 | 路径 / 说明 |
|------|------------|
| 安装包 | `Ollama Benchmark_V2.4-Setup.exe`（NSIS 安装器，安装后生成 `Ollama Benchmark_V2.4.exe`） |
| 完整源码包 | `Ollama-Benchmark-Source-V2.4.zip`（含 `src/`、`scripts/`、`samples/`、`build/`、`electron-builder.yml`、`package.json` 等，已排除 `node_modules`/`out`/`dist`） |
| 回归样例题库 | `8维模型评测用例_办公类.xlsx`（已修复损坏单元格） |
| 本发布说明 | `RELEASE-NOTES-V2.4.md` |

> 源码包即为完整源码，按 `npm install && npm run build && npm run package` 可在本地复现安装包（需 Node 20+ 与 Electron 43 构建环境）。

---

## 5. 升级与使用注意

1. 直接运行 `Ollama Benchmark_V2.4-Setup.exe`，安装器会清理 V2.0–V2.3 的旧 exe 与快捷方式。
2. 自定义题库仍通过「模型能力横评 → 导入 Excel 题库」导入，表头须包含 `id, dimension, dimensionLabel, title, prompt, responseKey, maxScore, ruleKind, ruleData`（可从「下载 Excel 格式模板」取得，模板第二页「规则说明」列出全部 9 种规则格式）。
3. 单题满分支持 5 分制或百分制（上限 100），同一维度的满分 = 该维度所有题目 `maxScore` 之和。
4. 导入时若个别行写坏，界面会提示「已跳过 N 行」并列出 Excel 行号与原因，其余题目照常导入。
5. 旧版本导出的能力评测 JSON 结果仍可读取；缺少 `dimensions` 字段的历史结果会按题库自动推导维度。
