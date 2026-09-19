import { useEffect, useMemo, useRef, useState } from "react";
import type { AdvancedProgress } from "../shared/ipc";
import {
  ADVANCED_PLAN_VERSION,
  ADVANCED_SCENARIOS,
  ADVANCED_SCENARIO_DESCRIPTIONS,
  ADVANCED_SCENARIO_LABELS,
  JUDGE_DEFAULTS,
  createDefaultAdvancedConfig,
  type AdvancedRunConfig,
  type AdvancedRunResult,
  type AdvancedScenario,
} from "../shared/AdvancedScenarios";
import type { OllamaEnvironment, ReportFormat } from "../shared/types";

type Props = {
  environment: OllamaEnvironment;
  onOpenPerformance: () => void;
};

const SCENARIO_ORDER: AdvancedScenario[] = [...ADVANCED_SCENARIOS];

function formatMs(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "-" : `${(value / 1_000).toFixed(2)}s`;
}
function formatPct(value: number | undefined, digits = 1): string {
  return value === undefined || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(digits)}%`;
}
function formatNumber(value: number | undefined, digits = 1): string {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function VerdictBadge({ ok }: { ok: boolean }): React.JSX.Element {
  return <span className={`badge ${ok ? "ok" : "bad"}`}>{ok ? "通过" : "未过"}</span>;
}

function ResultSummary({ result }: { result: AdvancedRunResult }): React.JSX.Element {
  return (
    <div className="advanced-result">
      {result.degradation && result.degradation.flags.length > 0 && (
        <div className="notice warning">
          <strong>退化检测告警：</strong>
          {result.degradation.flags.join("；")}
        </div>
      )}

      {result.concurrency && (
        <section className="card">
          <h3>并发阶梯压测</h3>
          <p className="muted">判定门槛：成功率 ≥ {JUDGE_DEFAULTS.minSuccessRatePercent}% 且 P95-E2E ≤ 基线 × {JUDGE_DEFAULTS.p95LatencyMultiplier}。</p>
          <div className="facts">
            <div><span>基线 P95</span><strong>{formatMs(result.concurrency.baselineP95Ms)}</strong></div>
            <div><span>最大通过并发</span><strong>{result.concurrency.maxPassingConcurrency ?? "-"}</strong></div>
            <div><span>首失败并发</span><strong>{result.concurrency.firstFailingConcurrency ?? "-"}</strong></div>
            <div><span>推荐并发</span><strong>{result.concurrency.recommendedConcurrency ?? "-"}</strong></div>
          </div>
          {result.concurrency.autotune && (
            <p className="muted">自适应阶梯：{result.concurrency.autotune.laddered.join(" → ")}；二分收敛：{result.concurrency.autotune.refined.join(" → ")}</p>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>并发</th><th>阶段</th><th>成功率</th><th>P95 E2E</th><th>QPS</th><th>判定</th></tr></thead>
              <tbody>{result.concurrency.levels.map((level) => (
                <tr key={level.concurrency}>
                  <td>{level.concurrency}</td>
                  <td>{level.steady ? "稳态复测" : "探测"}</td>
                  <td>{formatPct(level.successRatePercent / 100)}</td>
                  <td>{formatMs(level.p95E2eMs)}</td>
                  <td>{formatNumber(level.qps, 2)}</td>
                  <td><VerdictBadge ok={level.verdict.passed} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {result.maxContext && (
        <section className="card">
          <h3>最大上下文探测</h3>
          <div className="facts">
            <div><span>可用上限</span><strong>{result.maxContext.limitTokens ? `${result.maxContext.limitTokens.toLocaleString()} tokens` : "-"}</strong></div>
            <div><span>首个失败档</span><strong>{result.maxContext.firstFailTokens ? `${result.maxContext.firstFailTokens.toLocaleString()} tokens` : "未触发"}</strong></div>
          </div>
        </section>
      )}

      {result.stability && (
        <section className="card">
          <h3>稳态漂移</h3>
          <div className="facts">
            <div><span>判定</span><strong>{result.stability.verdict === "stable" ? "稳态" : result.stability.verdict === "minor" ? "轻微漂移" : "明显退化"}</strong></div>
            <div><span>P95 漂移</span><strong>{formatNumber(result.stability.driftPercent, 1)}%</strong></div>
            <div><span>TPM</span><strong>{formatNumber(result.stability.tpm, 0)}</strong></div>
            <div><span>QPS</span><strong>{formatNumber(result.stability.qps, 2)}</strong></div>
          </div>
        </section>
      )}

      {result.fairness && (
        <section className="card">
          <h3>公平性分析</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>并发</th><th>样本</th><th>均值</th><th>中位</th><th>P95</th><th>CV</th><th>饿死</th><th>判定</th></tr></thead>
              <tbody>{result.fairness.stats.map((stat) => (
                <tr key={stat.concurrency}>
                  <td>{stat.concurrency}</td>
                  <td>{stat.samples}</td>
                  <td>{formatMs(stat.meanE2eMs)}</td>
                  <td>{formatMs(stat.medianE2eMs)}</td>
                  <td>{formatMs(stat.p95E2eMs)}</td>
                  <td>{formatNumber(stat.cv, 3)}</td>
                  <td>{stat.starved}</td>
                  <td>{stat.verdict === "fair" ? "公平" : stat.verdict === "warn" ? "需关注" : "不公平"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {result.needle && (
        <section className="card">
          <h3>长文本召回</h3>
          <div className="facts">
            <div><span>综合召回率</span><strong>{formatPct(result.needle.overallRecall)}</strong></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>长度 tokens</th><th>正确</th><th>总数</th><th>召回率</th></tr></thead>
              <tbody>{result.needle.recallByLength.map((recall) => (
                <tr key={recall.lengthTokens}>
                  <td>{recall.lengthTokens.toLocaleString()}</td>
                  <td>{recall.correct}</td>
                  <td>{recall.total}</td>
                  <td>{formatPct(recall.recall)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {result.latency && (
        <section className="card">
          <h3>Latency 基准</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>输入</th><th>输出</th><th>TTFT</th><th>E2E</th><th>P95</th><th>Decode(t/s)</th></tr></thead>
              <tbody>{result.latency.combos.map((combo) => (
                <tr key={`${combo.inputTokens}-${combo.outputTokens}`}>
                  <td>{combo.inputTokens.toLocaleString()}</td>
                  <td>{combo.outputTokens.toLocaleString()}</td>
                  <td>{formatMs(combo.avgTtftMs)}</td>
                  <td>{formatMs(combo.avgE2eMs)}</td>
                  <td>{formatMs(combo.p95E2eMs)}</td>
                  <td>{formatNumber(combo.decodeTps)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {result.errors.length > 0 && (
        <section className="card">
          <h3>运行错误</h3>
          <ul className="error-list">{result.errors.map((error) => <li key={error}>{error}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

export function AdvancedEvaluationPage({ environment, onOpenPerformance }: Props): React.JSX.Element {
  const installedModels = environment.installedModels;
  const [model, setModel] = useState<string>(installedModels[0] ?? environment.binary);
  const [scenarios, setScenarios] = useState<AdvancedScenario[]>(["latency", "concurrency", "fairness"]);
  const [autotune, setAutotune] = useState<boolean>(true);
  const [maxConcurrency, setMaxConcurrency] = useState<number>(256);
  const [stabilityMinutes, setStabilityMinutes] = useState<number>(10);
  const [stabilityConcurrency, setStabilityConcurrency] = useState<number>(8);
  const [needleRepeats, setNeedleRepeats] = useState<number>(2);
  const [requestTimeoutMs, setRequestTimeoutMs] = useState<number>(120_000);
  const [seed, setSeed] = useState<number>(42);

  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string>();
  const [progress, setProgress] = useState<AdvancedProgress>();
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<AdvancedRunResult>();
  const logRef = useRef<HTMLDivElement>(null);

  const baseConfig = useMemo<AdvancedRunConfig>(() => createDefaultAdvancedConfig(model), [model]);
  const config = useMemo<AdvancedRunConfig>(() => ({
    ...baseConfig,
    scenarios,
    seed,
    requestTimeoutMs,
    concurrency: { ...baseConfig.concurrency, autotune, maxConcurrency },
    stability: { ...baseConfig.stability, durationMinutes: stabilityMinutes, concurrency: stabilityConcurrency },
    needle: { ...baseConfig.needle, repeats: needleRepeats },
  }), [baseConfig, scenarios, seed, requestTimeoutMs, autotune, maxConcurrency, stabilityMinutes, stabilityConcurrency, needleRepeats]);

  useEffect(() => window.ollamaBenchmark.onAdvancedProgress((value: AdvancedProgress) => {
    setProgress(value);
    if (value.message) setLogs((current) => [...current, `[${value.label}] ${value.message}`].slice(-1_000));
  }), []);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const appendLog = (line: string) => setLogs((current) => [...current, line].slice(-1_000));

  const run = async () => {
    setBusy(true);
    setResult(undefined);
    setProgress(undefined);
    setMessage(undefined);
    setLogs([`高级评测已开始：${model}；启用场景 ${scenarios.map((scenario) => ADVANCED_SCENARIO_LABELS[scenario]).join("、")}`]);
    try {
      const completed = await window.ollamaBenchmark.runAdvanced(config);
      setResult(completed);
      appendLog(completed.cancelled ? "评测已暂停，已保留当前结果。" : "评测完成，已生成结果。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendLog(`评测未完成：${detail}`);
      setMessage(detail);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await window.ollamaBenchmark.cancelAdvanced();
    appendLog("正在请求取消；当前批次结束后会停止。");
  };

  const exportReports = async (formats: ReportFormat[]) => {
    if (!result) return;
    setExporting(true);
    setMessage(undefined);
    try {
      const paths = await window.ollamaBenchmark.exportAdvancedReports({ result, formats });
      setMessage(paths.length ? `报告已导出：${paths.join("；")}` : "已取消选择输出目录。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };

  const progressPercent = progress?.total && progress.index
    ? Math.round((progress.index / progress.total) * 100)
    : progress?.totalUnits && progress.current
      ? Math.min(100, Math.round((progress.current / progress.totalUnits) * 100))
      : busy ? 5 : result ? 100 : 0;

  const toggleScenario = (scenario: AdvancedScenario) => {
    setScenarios((current) => current.includes(scenario)
      ? current.filter((item) => item !== scenario)
      : [...current, scenario]);
  };

  const selectedCount = scenarios.length;

  return (
    <div className="advanced-shell">
      <header className="advanced-topbar">
        <div>
          <p className="eyebrow">ADVANCED</p>
          <h1>高级场景评测</h1>
        </div>
        <span className="status online">已连接</span>
      </header>

      <section className="card advanced-intro-card">
        <div className="advanced-intro-head">
          <div>
            <h2>测试方案与场景</h2>
            <p className="muted">测试方案版本 <span className="version-pill">{ADVANCED_PLAN_VERSION}</span>（原生移植自 Python llm-bench，无需 Python 运行时）。</p>
          </div>
          <div className="advanced-model-field">
            <label htmlFor="advanced-model">评测模型</label>
            <select id="advanced-model" value={model} onChange={(event) => setModel(event.target.value)}>
              {installedModels.map((installed) => <option key={installed} value={installed}>{installed}</option>)}
            </select>
          </div>
        </div>

        <div className="scenario-section">
          <div className="scenario-section-title">
            <span>选择评测场景</span>
            <span className="scenario-count">已选 {selectedCount} / {SCENARIO_ORDER.length}</span>
          </div>
          <div className="scenario-grid">
            {SCENARIO_ORDER.map((scenario) => {
              const selected = scenarios.includes(scenario);
              return (
                <button
                  key={scenario}
                  type="button"
                  className={`scenario-chip ${selected ? "selected" : ""}`}
                  onClick={() => toggleScenario(scenario)}
                  aria-pressed={selected}
                >
                  <span className="scenario-check" aria-hidden="true">
                    {selected && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </span>
                  <span className="scenario-text">
                    <strong>{ADVANCED_SCENARIO_LABELS[scenario]}</strong>
                    <small>{ADVANCED_SCENARIO_DESCRIPTIONS[scenario]}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="card advanced-params-card">
        <h2>关键参数</h2>
        <div className="params-cluster">
          <div className="params-cluster-title">并发与压测</div>
          <div className="knob-grid">
            <label className="knob-toggle">
              <span>并发自适应压测</span>
              <input type="checkbox" checked={autotune} onChange={(event) => setAutotune(event.target.checked)} />
            </label>
            <label>并发上限<input type="number" min="1" max="1024" value={maxConcurrency} onChange={(event) => setMaxConcurrency(Number(event.target.value) || 256)} /></label>
            <label>稳态并发<input type="number" min="1" max="256" value={stabilityConcurrency} onChange={(event) => setStabilityConcurrency(Number(event.target.value) || 8)} /></label>
          </div>
        </div>
        <div className="params-cluster">
          <div className="params-cluster-title">运行设置</div>
          <div className="knob-grid">
            <label>稳态时长（分钟）<input type="number" min="1" max="120" value={stabilityMinutes} onChange={(event) => setStabilityMinutes(Number(event.target.value) || 10)} /></label>
            <label>长文本重复次数<input type="number" min="1" max="10" value={needleRepeats} onChange={(event) => setNeedleRepeats(Number(event.target.value) || 2)} /></label>
            <label>请求超时（秒）<input type="number" min="1" max="600" value={Math.round(requestTimeoutMs / 1000)} onChange={(event) => setRequestTimeoutMs((Number(event.target.value) || 120) * 1_000)} /></label>
            <label>确定性种子<input type="number" min="0" max="9999" value={seed} onChange={(event) => setSeed(Number(event.target.value) || 42)} /></label>
          </div>
        </div>
        <div className="actions advanced-actions">
          <button type="button" disabled={busy || !scenarios.length} onClick={() => void run()}>{busy ? "评测中…" : "开始高级评测"}</button>
          {busy && <button type="button" className="secondary" onClick={() => void cancel()}>取消评测</button>}
          <span className="action-spacer" />
          <button type="button" className="secondary" onClick={onOpenPerformance}>返回性能测试</button>
        </div>
      </section>

      {message && <p className="message">{message}</p>}

      {busy && (
        <section className="card advanced-progress-card">
          <div className="progress-header">
            <h3>评测进度{progress ? `：${progress.label}` : ""}</h3>
            <span className="progress-percent">{progressPercent}%</span>
          </div>
          <div className="progress-track"><div className="progress-bar" style={{ width: `${progressPercent}%` }} /></div>
          <div className="execution-log" ref={logRef}>{logs.length ? logs.join("\n") : "正在准备评测请求……"}</div>
        </section>
      )}

      {result && (
        <section className="card advanced-result-card">
          <div className="result-toolbar">
            <h3>评测结果{result.cancelled ? "（未完成）" : ""}</h3>
            <div className="actions report-actions">
              <button type="button" disabled={exporting} onClick={() => void exportReports(["docx", "pdf", "markdown", "html"])}>导出全部报告</button>
              <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["docx"])}>仅 Word</button>
              <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["pdf"])}>仅 PDF</button>
              <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["markdown"])}>仅 Markdown</button>
              <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["html"])}>仅 HTML</button>
            </div>
          </div>
          <ResultSummary result={result} />
        </section>
      )}
    </div>
  );
}
