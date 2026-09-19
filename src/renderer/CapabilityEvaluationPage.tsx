import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReportFormat } from '../shared/types';
import { CAPABILITY_DIMENSIONS, type CapabilityConfig, type CapabilityQuestion, type CapabilityRunResult, type OllamaEnvironment } from '../shared/types';
import { collectCapabilityDimensions, resolveCapabilityDimensionLabels, resolveCapabilityDimensions } from '../shared/CapabilityDimensions';
import { renderCapabilityBarChart, renderCapabilityRadarChart } from '../shared/CapabilityCharts';
import { getQuestionBankTemplate, parseCapabilityQuestionBank, parseCapabilityQuestionBankWithIssues, serializeCapabilityQuestionBank } from '../shared/CapabilityQuestionBank';
import { getCapabilityQuestions } from '../shared/CapabilityDefaultQuestions';
import { capabilityQuestionsFromExcel, capabilityQuestionsToExcel } from './CapabilityQuestionExcel';

function formatNumber(value: number | undefined, digits = 1): string { return value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits); }
function stamp(): string { return new Date().toLocaleTimeString(); }
async function downloadExcel(filename: string, questions: CapabilityQuestion[], includeTemplateNotes = false): Promise<void> { const blob = await capabilityQuestionsToExcel(questions, includeTemplateNotes); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }

export function CapabilityEvaluationPage({ environment, onOpenPerformance }: { environment: OllamaEnvironment; onOpenPerformance: () => void }): React.JSX.Element {
  const models = environment.installedModels;
  const [selectedModels, setSelectedModels] = useState<string[]>(models.slice(0, Math.min(4, models.length)));
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([...CAPABILITY_DIMENSIONS]);
  const [customQuestions, setCustomQuestions] = useState<CapabilityQuestion[]>(() => { try { const saved = localStorage.getItem('ollama-benchmark-capability-questions'); return saved ? parseCapabilityQuestionBank(JSON.parse(saved)) : []; } catch { return []; } });
  // 维度由题库决定：内置 7 个 + 导入题库里出现的任意维度，都会在这里出现。
  const availableDimensions = useMemo(() => collectCapabilityDimensions([...getCapabilityQuestions(), ...customQuestions]), [customQuestions]);
  const dimensionLabels = useMemo(() => Object.fromEntries(availableDimensions.map((dimension) => [dimension.key, dimension.label])), [availableDimensions]);
  const allQuestions = useMemo(() => { const enabled = new Set(selectedDimensions); return [...getCapabilityQuestions(), ...customQuestions].filter((question) => enabled.has(question.dimension)); }, [customQuestions, selectedDimensions]);
  const [config, setConfig] = useState<CapabilityConfig>({ models: selectedModels, maxOutputTokens: 512, temperature: 0, timeoutMs: 120_000, thinkingMode: 'off', suiteVersion: 'CapabilitySuite-1.1', questions: [] });
  const [questionEditorOpen, setQuestionEditorOpen] = useState(false);
  const [questionDraft, setQuestionDraft] = useState(() => getQuestionBankTemplate());
  const [result, setResult] = useState<CapabilityRunResult>();
  const resultDimensions = useMemo(() => result ? resolveCapabilityDimensions(result) : [], [result]);
  const resultLabels = useMemo(() => result ? resolveCapabilityDimensionLabels(result) : {}, [result]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [logs, setLogs] = useState<string[]>([]);
  const [message, setMessage] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  // 进度回调只订阅一次，用 ref 拿最新的维度标签映射，避免导入新维度后日志里显示成英文代码
  const labelRef = useRef<Record<string, string>>(dimensionLabels);
  labelRef.current = dimensionLabels;

  useEffect(() => { setSelectedModels((current) => current.filter((model) => models.includes(model))); }, [models]);
  useEffect(() => { localStorage.setItem('ollama-benchmark-capability-questions', serializeCapabilityQuestionBank(customQuestions)); }, [customQuestions]);
  useEffect(() => window.ollamaBenchmark.onCapabilityProgress((value) => { setProgress({ completed: value.completed, total: value.total }); const item = value.question; const text = item ? `${item.model} / ${labelRef.current[item.dimension] ?? item.dimension} / ${item.title}：${formatNumber(item.score)}/${item.maxScore}${item.decodeTokensPerSecond ? `；Decode ${formatNumber(item.decodeTokensPerSecond)} tok/s` : ''}` : `能力评测进度：${value.completed}/${value.total}`; setLogs((current) => [...current, `[${stamp()}] ${text}`].slice(-500)); }), []);
  useEffect(() => { if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const start = async () => {
    if (!selectedModels.length) { setMessage('请至少选择一个已安装模型。'); return; }
    if (!selectedDimensions.length) { setMessage('请至少选择一个能力维度。'); return; }
    const nextConfig = { ...config, models: selectedModels, questions: allQuestions }; setConfig(nextConfig); setBusy(true); setResult(undefined); setMessage(undefined); setLogs([`[${stamp()}] 能力横评开始：${selectedModels.join(', ')}`]); setProgress({ completed: 0, total: selectedModels.length * allQuestions.length });
    try { const completed = await window.ollamaBenchmark.runCapability(nextConfig); setResult(completed); setLogs((current) => [...current, `[${stamp()}] 能力横评${completed.cancelled ? '已中断，已保留部分结果' : '完成'}`]); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setLogs((current) => [...current, `[${stamp()}] 评测失败：${error instanceof Error ? error.message : String(error)}`]); } finally { setBusy(false); }
  };
  const addQuestions = () => { try { const imported = parseCapabilityQuestionBank(JSON.parse(questionDraft)); const builtInIds = new Set(getCapabilityQuestions().map((question) => question.id)); setCustomQuestions((current) => [...current, ...imported.filter((question) => !builtInIds.has(question.id) && !current.some((item) => item.id === question.id))]); setQuestionEditorOpen(false); setMessage(`已新增 ${imported.length} 道自定义题目。`); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } };
  const importQuestions = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try {
      // 逐题/逐行容错：个别题目写坏只跳过并汇报，不阻塞整份题库导入。
      let imported: CapabilityQuestion[]; let issueHint = '';
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = parseCapabilityQuestionBankWithIssues(JSON.parse(await file.text()));
        imported = parsed.questions;
        if (parsed.issues.length) issueHint = `；已跳过 ${parsed.issues.length} 道问题题目（${parsed.issues.slice(0, 3).map((issue) => `第 ${issue.index} 道「${issue.id}」${issue.message}`).join('；')}${parsed.issues.length > 3 ? ' 等' : ''}）`;
      } else {
        const parsed = await capabilityQuestionsFromExcel(await file.arrayBuffer());
        imported = parsed.questions;
        if (parsed.issues.length) issueHint = `；已跳过 ${parsed.issues.length} 行问题数据（${parsed.issues.slice(0, 3).map((issue) => `第 ${issue.row} 行「${issue.id}」${issue.message}`).join('；')}${parsed.issues.length > 3 ? ' 等' : ''}）`;
      }
      const builtInIds = new Set(getCapabilityQuestions().map((question) => question.id)); setCustomQuestions(imported.filter((question) => !builtInIds.has(question.id))); // 题库里出现的维度自动进入选中列表，导入后可直接开测
    const importedDimensions = [...new Set(imported.map((question) => question.dimension))]; const known = new Set(availableDimensions.map((dimension) => dimension.key)); const fresh = importedDimensions.filter((dimension) => !known.has(dimension)); setSelectedDimensions((current) => [...new Set([...current, ...importedDimensions])]); setMessage(`已导入 ${imported.length} 道题目，覆盖 ${importedDimensions.length} 个维度（${fresh.length ? `其中新增维度 ${fresh.length} 个：${fresh.join('、')}` : '无新增维度'}）；内置题目仍会保留。${issueHint}`); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } };
  const exportQuestions = () => void downloadExcel(`ollama-capability-question-bank-${new Date().toISOString().slice(0, 10)}.xlsx`, [...getCapabilityQuestions(), ...customQuestions]);
  const removeQuestion = (id: string) => setCustomQuestions((current) => current.filter((question) => question.id !== id));
  const cancel = async () => { await window.ollamaBenchmark.cancelCapability(); setLogs((current) => [...current, `[${stamp()}] 已请求停止能力横评`]); };
  const exportReport = async (formats: ReportFormat[]) => { if (!result) return; setExporting(true); try { const paths = await window.ollamaBenchmark.exportCapabilityReports({ result, formats }); setMessage(paths.length ? `能力报告已导出：${paths.join('；')}` : '已取消选择输出目录。'); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setExporting(false); } };
  const bar = useMemo(() => result ? renderCapabilityBarChart(result.summaries) : '', [result]);
  const radar = useMemo(() => result ? renderCapabilityRadarChart(result.summaries) : '', [result]);

  return <section className="capability-page">
    <div className="capability-heading"><div><p className="eyebrow">MODEL CAPABILITY</p><h2>模型能力横评</h2><p className="muted">评测维度由题库决定：内置 7 个维度，导入自定义题库后会自动带上题库里的任意维度（例如办公类 8 维）；维度可多选、满分与题数按题库实时计算，不改变原有性能测试。</p></div><button type="button" className="secondary" onClick={onOpenPerformance}>返回性能测试</button></div>
    <section className="card capability-bank">
      <div className="capability-bank-heading"><div><h3>题库管理</h3><p className="muted">内置题目 {getCapabilityQuestions().length} 道；自定义题目 {customQuestions.length} 道；当前选中维度共 {allQuestions.length} 道/模型。</p></div><div className="actions"><button type="button" className="secondary" onClick={() => void downloadExcel('ollama-capability-question-template.xlsx', [getCapabilityQuestions()[0]], true)}>下载 Excel 格式模板</button><button type="button" className="secondary" onClick={exportQuestions}>导出 Excel 题库</button><label className="button secondary">导入 Excel 题库<input type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,.json" hidden onChange={(event) => void importQuestions(event)} /></label><button type="button" onClick={() => { setQuestionDraft(getQuestionBankTemplate()); setQuestionEditorOpen(true); }}>新增题目</button></div></div>
      <p className="muted capability-bank-help">Excel 模板包含“题库”和“规则说明”工作表；题库列包括 id、dimension、dimensionLabel、title、prompt、responseKey、maxScore、ruleKind、ruleData。<b>dimension 不再限定内置 7 个</b>：写成 officeWriting、officeSheet 之类的新维度即可，dimensionLabel 是它在界面与报告里的中文名，同一维度的满分 = 该维度所有题目 maxScore 之和。<b>ruleKind 支持 keywords、number、exact、code、contains_all、formula、sql_result、json_schema、tool_call</b>，各自格式见下载模板的“规则说明”页；单行写坏只会跳过该行并提示行号，不影响整份题库导入。导入会替换当前自定义题目，内置题目始终保留；旧 JSON 文件仍可导入。</p>
      {customQuestions.length > 0 && <div className="custom-question-list">{customQuestions.map((question) => <div className="custom-question-row" key={question.id}><span><strong>{question.title}</strong><small>{question.id} · {dimensionLabels[question.dimension] ?? question.dimensionLabel ?? question.dimension} · {question.rule.kind}</small></span><button type="button" className="secondary" onClick={() => removeQuestion(question.id)}>删除</button></div>)}</div>}
      {questionEditorOpen && <div className="question-editor"><label>题目 JSON（适合快速新增；批量编辑请使用 Excel）<textarea rows={14} value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} /></label><div className="actions"><button type="button" onClick={addQuestions}>保存新增题目</button><button type="button" className="secondary" onClick={() => setQuestionEditorOpen(false)}>取消</button></div></div>}
    </section>
    <section className="card capability-config"><h3>评测参数</h3><div className="capability-dimensions"><span className="field-title">评测维度（可多选，来自题库）</span><div className="chips">{availableDimensions.map((dimension) => <button type="button" className={`chip ${selectedDimensions.includes(dimension.key) ? 'selected' : ''}`} key={dimension.key} title={`${dimension.key}：${dimension.questionCount} 题，满分 ${dimension.maxScore}`} onClick={() => setSelectedDimensions((current) => current.includes(dimension.key) ? current.filter((item) => item !== dimension.key) : [...current, dimension.key])}>{dimension.label}<small style={{ opacity: 0.65, marginLeft: 4 }}>{dimension.questionCount}</small></button>)}</div><p className="muted">已选 {selectedDimensions.length} / {availableDimensions.length} 个维度（题库共 {availableDimensions.length} 维、{availableDimensions.reduce((sum, dimension) => sum + dimension.questionCount, 0)} 题），本次每个模型 {allQuestions.length} 道题、满分 {allQuestions.reduce((sum, question) => sum + question.maxScore, 0)}。</p></div><div className="capability-model-selector">
  <div className="selector-heading"><span className="field-title">评测模型（可多选）</span><span className="muted">已选 {selectedModels.length} / {models.length}</span></div>
  {models.length ? <div className="model-select-grid">{models.map((model) => <label key={model} className={`model-select-card ${selectedModels.includes(model) ? 'selected' : ''}`}>
    <input type="checkbox" checked={selectedModels.includes(model)} onChange={(event) => setSelectedModels((current) => event.target.checked ? [...current, model] : current.filter((item) => item !== model))} />
    <span className="model-select-check" aria-hidden="true">{selectedModels.includes(model) ? '✓' : ''}</span><span className="model-select-name" title={model}>{model}</span>
  </label>)}</div> : <span className="muted">未检测到已安装模型</span>}
  {models.length > 0 && <div className="selection-actions"><button type="button" className="secondary" onClick={() => setSelectedModels(models)}>全选</button><button type="button" className="secondary" onClick={() => setSelectedModels([])}>清空</button></div>}
</div><div className="capability-options"><label>每题最大输出<input type="number" min="64" max="4096" value={config.maxOutputTokens} onChange={(event) => setConfig((current) => ({ ...current, maxOutputTokens: Number(event.target.value) || 512 }))} /></label><label>温度<input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={(event) => setConfig((current) => ({ ...current, temperature: Number(event.target.value) || 0 }))} /></label><label>超时（秒）<input type="number" min="10" max="3600" value={Math.round(config.timeoutMs / 1000)} onChange={(event) => setConfig((current) => ({ ...current, timeoutMs: (Number(event.target.value) || 120) * 1000 }))} /></label><label>思考模式<select value={config.thinkingMode} onChange={(event) => setConfig((current) => ({ ...current, thinkingMode: event.target.value as CapabilityConfig['thinkingMode'] }))}><option value="off">关闭（可比性更好）</option><option value="on">开启</option></select></label></div><div className="actions"><button type="button" disabled={busy || !selectedModels.length || !selectedDimensions.length} onClick={() => void start()}>{busy ? '评测进行中…' : result ? '重新开始横评' : '开始能力横评'}</button>{busy && <button type="button" className="secondary" onClick={() => void cancel()}>停止评测</button>}</div></section>
    <section className="card"><div className="capability-progress"><div className="progress-track"><div className="progress-bar" style={{ width: `${progress.total ? Math.max(progress.completed ? 1 : 0, Math.round(progress.completed / progress.total * 100)) : 0}%` }} /></div><span>{progress.total ? `${Math.round(progress.completed / progress.total * 100)}%（${progress.completed}/${progress.total} 题）` : '尚未开始'}</span></div><h3>评测日志</h3><div className="capability-log" ref={logRef} onScroll={(event) => { const element = event.currentTarget; followRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 8; }}>{logs.length ? logs.join('\n') : '暂无能力评测日志。'}</div></section>
    {message && <p className="message">{message}</p>}
    {result && <section className="card capability-results"><div className="results-heading"><div><p className="eyebrow">CAPABILITY REPORT</p><h3>能力评测结果{result.cancelled ? '（部分完成）' : ''}</h3></div><div className="actions report-actions"><button type="button" disabled={exporting} onClick={() => void exportReport(['docx', 'pdf', 'markdown', 'html'])}>导出全部</button><button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport(['docx'])}>Word</button><button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport(['pdf'])}>PDF</button><button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport(['markdown'])}>Markdown</button><button type="button" className="secondary" disabled={exporting} onClick={() => void exportReport(['html'])}>HTML</button></div></div><div className="table-wrap"><table><thead><tr><th>排名</th><th>模型</th><th>总分</th>{resultDimensions.map((dimension) => <th key={dimension.key} title={`${dimension.key}：满分 ${dimension.maxScore}`}>{dimension.label}</th>)}<th>完成度</th><th>Decode(tok/s)</th></tr></thead><tbody>{result.summaries.map((summary) => <tr key={summary.model}><td>{summary.rank}</td><td>{summary.model}</td><td>{formatNumber(summary.totalScore)}/{summary.maxScore}</td>{resultDimensions.map((dimension) => <td key={dimension.key}>{formatNumber(summary.dimensionScores[dimension.key])}</td>)}<td>{summary.completedCount}/{summary.questionCount}</td><td>{formatNumber(summary.averageDecodeTokensPerSecond)}</td></tr>)}</tbody></table></div><div className="capability-charts"><div className="capability-chart" dangerouslySetInnerHTML={{ __html: bar }} /><div className="capability-chart" dangerouslySetInnerHTML={{ __html: radar }} /></div><h4>逐题结果</h4><div className="table-wrap"><table><thead><tr><th>模型</th><th>维度</th><th>题目</th><th>得分</th><th>状态</th><th>回答摘要</th></tr></thead><tbody>{result.questions.map((item, index) => <tr key={`${item.model}-${item.id}-${index}`}><td>{item.model}</td><td>{resultLabels[item.dimension] ?? item.dimension}</td><td>{item.title}</td><td>{formatNumber(item.score)}/{item.maxScore}</td><td>{item.status === 'success' ? '成功' : item.status === 'cancelled' ? '取消' : '失败'}</td><td title={item.response}>{item.response.slice(0, 180) || item.errorMessage || '-'}</td></tr>)}</tbody></table></div></section>}
  </section>;
}