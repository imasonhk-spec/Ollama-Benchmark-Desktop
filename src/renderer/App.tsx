import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BenchmarkConfigPage } from "./BenchmarkConfigPage";
import { CapabilityEvaluationPage } from "./CapabilityEvaluationPage";
import { AdvancedEvaluationPage } from "./AdvancedEvaluationPage";
import type { BenchmarkProgress } from "../shared/ipc";
import type {
  AccelerationInfo,
  BackendPreference,
  BenchmarkConfig,
  BenchmarkSample,
  BenchmarkSummary,
  OllamaEnvironment,
  ReportFormat,
  SshConfig,
} from "../shared/types";
import { BACKEND_HINTS, BACKEND_LABELS, BACKEND_OPTIONS, accelerationLabel, backendLabel } from "../shared/types";

type Page = "connect" | "config" | "execution";

type RunResult = {
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
  config: BenchmarkConfig;
  samples: BenchmarkSample[];
  summaries: BenchmarkSummary[];
};

type ConnectionForm = Pick<SshConfig, "host" | "port" | "username" | "password" | "apiPort" | "apiHost" | "apiKey" | "backendPreference">;

const defaultConnection: ConnectionForm = {
  host: "",
  port: 22,
  username: "",
  password: "",
  backendPreference: "ollama",
};

function formatNumber(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function formatSeconds(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "-" : (value / 1_000).toFixed(3);
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || value < 0) return "未检测到";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function formatLogTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function withTimestamp(message: string): string {
  return "[" + formatLogTimestamp() + "] " + message;
}
function sampleLog(sample: BenchmarkSample): string {
  const prefix = `${sample.model} / ${sample.targetInputTokens.toLocaleString()} tokens / 并发 ${sample.concurrency} / 第 ${sample.round} 轮 / 请求 ${sample.workerIndex + 1}`;
  if (sample.status !== "success") return `失败：${prefix}；${sample.errorMessage ?? sample.status}`;
  return `完成：${prefix}；TTFT ${formatSeconds(sample.ttftMs)} s；Decode ${formatNumber(sample.decodeTokensPerSecond)} tok/s；输出 ${sample.generatedTokens ?? "-"} tokens；总耗时 ${formatSeconds(sample.totalMs)} s`;
}

function StepIndicator({
  page,
  canOpenConfig,
  canOpenExecution,
  onNavigate,
}: {
  page: Page;
  canOpenConfig: boolean;
  canOpenExecution: boolean;
  onNavigate: (page: Page) => void;
}): React.JSX.Element {
  const steps: Array<{ key: Page; title: string; subtitle: string }> = [
    { key: "connect", title: "连接与环境检查", subtitle: "登录并识别服务器环境" },
    { key: "config", title: "测试参数配置", subtitle: "选择模型与测试条件" },
    { key: "execution", title: "测试执行报告", subtitle: "查看日志、结果并导出报告" },
  ];

  return (
    <nav className="stepper" aria-label="测试流程">
      {steps.map((step, index) => {
        const unavailable = (step.key === "config" && !canOpenConfig)
          || (step.key === "execution" && !canOpenExecution);
        const completed = (step.key === "connect" && canOpenConfig)
          || (step.key === "config" && canOpenExecution);
        return (
          <button
            key={step.key}
            type="button"
            className={`step ${page === step.key ? "active" : ""} ${completed ? "completed" : ""}`}
            disabled={unavailable}
            onClick={() => onNavigate(step.key)}
            style={{ width: "100%", textAlign: "left", font: "inherit" }}
          >
            <span>{index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <small>{step.subtitle}</small>
            </div>
          </button>
        );
      })}
    </nav>
  );
}

function accelerationClass(info?: AccelerationInfo): string {
  if (!info) return "acc-unknown";
  return `acc-${info.mode}`;
}

function EnvironmentPanel({
  environment,
  busy,
  onSelectEndpoint,
}: {
  environment?: OllamaEnvironment;
  busy?: boolean;
  onSelectEndpoint?: (endpointId: string) => void;
}): React.JSX.Element {
  if (!environment) {
    return <section className="card environment-panel"><h2>环境检测结果</h2><div className="empty">连接服务器后，将自动检测 Ollama/llama.cpp、Docker 部署、GPU 与系统资源。</div></section>;
  }

  const system = environment.systemInfo;
  const chip = system?.chipPlatform || environment.gpuModels.join(", ") || environment.gpuVendor;
  const endpoints = environment.endpoints ?? [];
  const notFound = environment.deployment === "not-found";
  const selected = endpoints.find((endpoint) => endpoint.id === environment.endpointId);

  return (
    <section className="card environment-panel">
      <p className="eyebrow">ENVIRONMENT</p>
      <h2>环境检测结果</h2>
      {notFound && <p className="warning">未找到可用的推理端点，已阻止进入下一步。下方「候选端点」列出了全部试过的地址与失败原因，请据此修复服务器，或改用「推理 API 端口 / 推理服务主机 / API Key」手填。</p>}
      <div className="facts">
        <div><span>推理后端</span><strong>{backendLabel(environment.backend)}</strong></div>
        <div><span>命中端点</span><strong>{selected ? `${selected.host}:${selected.port}` : "未命中的候选：" + endpoints.length + " 个"}</strong></div>
        <div><span>端点来源</span><strong>{selected?.source ?? "—"}</strong></div>
        <div><span>部署方式</span><strong>{environment.deployment}</strong></div>
        <div><span>运行程序</span><strong>{environment.binary}</strong></div>
        <div><span>推理 API</span><strong>{environment.apiHost}:{environment.apiPort}</strong></div>
        <div><span>加速实测</span><strong className={accelerationClass(environment.acceleration)}>{accelerationLabel(environment.acceleration)}</strong></div>
        <div><span>芯片平台</span><strong>{chip || "未检测到"}</strong></div>
        <div><span>内存总量</span><strong>{formatBytes(system?.memoryBytes)}</strong></div>
        <div><span>存储总量</span><strong>{formatBytes(system?.storageTotalBytes)}</strong></div>
        <div><span>操作系统</span><strong>{system?.osName ?? "未检测到"}</strong></div>
        <div><span>CPU</span><strong>{system?.cpuModel ?? "未检测到"}</strong></div>
        <div><span>后端版本</span><strong>{environment.version ?? "未检测到"}</strong></div>
      </div>

      {endpoints.length > 0 && <>
        <h3>候选端点（逐个实测）</h3>
        <p className="muted">探测会枚举全部候选端点；同一台机器上往往同时躺着多个推理实例，模型清单可能并不一致，这里可以手动切换评测对象。</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>选用</th><th>端点</th><th>来源</th><th>模型</th><th>加速</th><th>结论 / 失败原因</th></tr></thead>
            <tbody>{endpoints.map((endpoint) => (
              <tr key={endpoint.id} className={endpoint.ok ? "" : "endpoint-failed"}>
                <td>{endpoint.ok
                  ? <button type="button" className="secondary" disabled={busy || endpoint.id === environment.endpointId} onClick={() => onSelectEndpoint?.(endpoint.id)}>{endpoint.id === environment.endpointId ? "使用中" : "选用"}</button>
                  : "—"}</td>
                <td>{endpoint.host}:{endpoint.port}</td>
                <td>{endpoint.source}</td>
                <td>{endpoint.ok ? endpoint.models.length : "—"}</td>
                <td className={endpoint.ok ? accelerationClass(endpoint.acceleration) : "acc-unknown"}>{endpoint.ok ? (endpoint.acceleration?.mode ?? "unknown") : "—"}</td>
                <td>{endpoint.detail}{endpoint.elapsedMs !== undefined ? `（${endpoint.elapsedMs} ms）` : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>}

      {environment.installedModels.length > 0 && <><h3>已安装模型（{environment.installedModels.length}）</h3><div className="model-list">{environment.installedModels.map((model) => <span key={model}>{model}</span>)}</div></>}
      {environment.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
    </section>
  );
}

function ResultTable({ result }: { result: RunResult }): React.JSX.Element {
  if (!result.summaries.length) return <div className="empty">本轮没有可汇总的测试结果。</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>模型</th><th>输入 tokens</th><th>并发</th><th>成功 / 样本</th><th>TTFT（秒）</th><th>P95 TTFT（秒）</th><th>Decode（tok/s）</th></tr></thead>
        <tbody>{result.summaries.map((item) => (
          <tr key={`${item.model}-${item.inputTokens}-${item.concurrency}`}>
            <td>{item.model}</td>
            <td>{item.inputTokens.toLocaleString()}</td>
            <td>{item.concurrency}</td>
            <td>{item.successCount} / {item.sampleCount}</td>
            <td>{formatSeconds(item.ttftMeanMs)}</td>
            <td>{formatSeconds(item.ttftP95Ms)}</td>
            <td>{formatNumber(item.decodeMeanTokensPerSecond)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<"performance" | "capability" | "advanced">("performance");
  const [page, setPage] = useState<Page>("connect");
  const [connection, setConnection] = useState<ConnectionForm>(defaultConnection);
  const [environment, setEnvironment] = useState<OllamaEnvironment>();
  const [result, setResult] = useState<RunResult>();
  const [savedConfig, setSavedConfig] = useState<BenchmarkConfig>();
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string>();
  const logElementRef = useRef<HTMLDivElement>(null);
  const shouldFollowLogsRef = useRef(true);
  const autoScrollInProgressRef = useRef(false);

  const appendExecutionLog = (message: string) => {
    setExecutionLogs((current) => [...current, withTimestamp(message)].slice(-1_000));
  };

  useEffect(() => {
    if (!busy) return;
    const confirmClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "测试仍在执行，关闭将中止本轮测试并断开连接。";
    };
    window.addEventListener("beforeunload", confirmClose);
    return () => window.removeEventListener("beforeunload", confirmClose);
  }, [busy]);
  useEffect(() => window.ollamaBenchmark.onBenchmarkProgress((value: BenchmarkProgress) => {
    setProgress({ completed: value.completed, total: value.total });
    appendExecutionLog(value.sample ? sampleLog(value.sample) : `进度：${value.completed} / ${value.total}`);
  }), []);

  useLayoutEffect(() => {
    if (!shouldFollowLogsRef.current) return;
    const element = logElementRef.current;
    if (!element) return;
    autoScrollInProgressRef.current = true;
    element.scrollTop = element.scrollHeight;
    requestAnimationFrame(() => { autoScrollInProgressRef.current = false; });
  }, [executionLogs]);

  useEffect(() => {
    const disconnectOnUnload = () => { void window.ollamaBenchmark.disconnect(); };
    window.addEventListener("unload", disconnectOnUnload);
    return () => window.removeEventListener("unload", disconnectOnUnload);
  }, []);

  const connect = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const apiHost = connection.apiHost?.trim();
      const apiKey = connection.apiKey?.trim();
      const detected = await window.ollamaBenchmark.connect({
        host: connection.host.trim(),
        port: Number(connection.port),
        username: connection.username.trim(),
        password: connection.password,
        backendPreference: connection.backendPreference,
        connectTimeoutMs: 20_000,
        ...(connection.apiPort ? { apiPort: Number(connection.apiPort) } : {}),
        ...(apiHost ? { apiHost } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setEnvironment(detected);
      setPage("connect");
      setMessage(detected.deployment === "not-found"
        ? "已连接服务器，但没有找到可用的推理端点；请查看下方「候选端点」里的失败原因。"
        : `已连接并完成环境检测：命中 ${detected.apiHost}:${detected.apiPort}，${detected.installedModels.length} 个模型，加速状态 ${detected.acceleration?.mode ?? "未判定"}。`);
    } catch (error) {
      setEnvironment(undefined);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectEndpoint = async (endpointId: string) => {
    setBusy(true);
    try {
      const next = await window.ollamaBenchmark.useEndpoint(endpointId);
      setEnvironment(next);
      setMessage(`已切换评测端点：${next.apiHost}:${next.apiPort}（${next.installedModels.length} 个模型）。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await window.ollamaBenchmark.disconnect();
      setEnvironment(undefined);
      setPage("connect");
      setMessage("已断开服务器连接；上一轮测试结果仍可在第 3 步查看。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const startBenchmark = async (config: BenchmarkConfig, previousSamples: BenchmarkSample[] = []) => {
    setBusy(true);
    if (!previousSamples.length) setResult(undefined);
    setSavedConfig(config);
    shouldFollowLogsRef.current = true;
    const total = config.models.length * config.inputLengths.length * config.concurrencies.reduce((sum, value) => sum + value * config.rounds, 0);
    const completed = previousSamples.filter((sample) => sample.status === "success").length;
    setProgress({ completed, total });
    setExecutionLogs([withTimestamp("测试已开始，正在等待首个请求完成……")]);
    setMessage(undefined);
    setPage("execution");
    try {
      const completedResult = await window.ollamaBenchmark.runBenchmark(config, previousSamples) as RunResult;
      setResult(completedResult);
      appendExecutionLog(completedResult.cancelled ? "测试已暂停，已保留当前结果，可继续测试。" : "测试完成，已生成汇总结果。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendExecutionLog(`测试未完成：${detail}`);
      setMessage(detail);
    } finally {
      setBusy(false);
    }
  };

  const cancelBenchmark = async () => {
    await window.ollamaBenchmark.cancelBenchmark();
    appendExecutionLog("正在请求取消；当前并发批次结束后会停止测试。");
  };

  const resumeBenchmark = () => {
    if (!result || !result.cancelled || busy) return;
    void startBenchmark(result.config, result.samples);
  };

  const exportReports = async (formats: ReportFormat[]) => {
    if (!result) return;
    setExporting(true);
    setMessage(undefined);
    try {
      const paths = await window.ollamaBenchmark.exportReports({ result, formats });
      setMessage(paths.length ? `报告已导出：${paths.join("；")}` : "已取消选择输出目录。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };

  const handleLogScroll = () => {
    if (autoScrollInProgressRef.current) return;
    const element = logElementRef.current;
    if (!element) return;
    shouldFollowLogsRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
  };

  const canOpenConfig = Boolean(environment) && environment?.deployment !== "not-found";
  const canOpenExecution = Boolean(result) || busy || page === "execution";
  const progressPercent = progress.total > 0
    ? Math.min(100, Math.max(progress.completed > 0 ? 1 : 0, Math.round(progress.completed / progress.total * 100)))
    : busy ? 1 : result ? 100 : 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow"></p><h1>服务器模型推理性能测试</h1></div>
        <span className={`status ${environment ? "online" : "offline"}`}>{environment ? "已连接" : "未连接"}</span>
      </header>

      <div className="workspace-switcher"><button type="button" className={workspace === "performance" ? "active" : ""} onClick={() => setWorkspace("performance")}>性能测试</button><button type="button" className={workspace === "capability" ? "active" : ""} onClick={() => setWorkspace("capability")}>模型能力横评</button><button type="button" className={workspace === "advanced" ? "active" : ""} onClick={() => setWorkspace("advanced")}>高级场景评测</button></div>

      <div className={`workspace-page ${workspace === "performance" ? "active" : "hidden"}`}>
        <StepIndicator page={page} canOpenConfig={canOpenConfig} canOpenExecution={canOpenExecution} onNavigate={setPage} />
        {message && <p className="message">{message}</p>}

        {page === "connect" && <section className="connect-stack">
          <section className="card connection-card">
            <p className="eyebrow">STEP 1</p>
            <h2>连接与环境检查</h2>
            <p className="muted">通过 SSH 登录测试服务器；检测过程只读取现有信息，不会修改服务器配置。探测会逐个枚举候选端点，服务器较慢时约需 30–60 秒。</p>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px 150px", gap: 12 }}>
              <label>服务器 IP 或主机名<input value={connection.host} onChange={(event) => setConnection((current) => ({ ...current, host: event.target.value }))} placeholder="例如 192.168.1.10" /></label>
              <label>SSH 端口<input type="number" min="1" max="65535" value={connection.port} onChange={(event) => setConnection((current) => ({ ...current, port: Number(event.target.value) || 22 }))} /></label><label>推理 API 端口<input type="number" min="1" max="65535" placeholder="自动枚举" value={connection.apiPort ?? ""} onChange={(event) => setConnection((current) => ({ ...current, apiPort: event.target.value ? Number(event.target.value) : undefined }))} /></label>
            </div>
            <label>用户名<input value={connection.username} onChange={(event) => setConnection((current) => ({ ...current, username: event.target.value }))} autoComplete="username" /></label>
            <label>密码<input type="password" value={connection.password} onChange={(event) => setConnection((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" /></label>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
              <label>推理服务主机（可选）<input value={connection.apiHost ?? ""} onChange={(event) => setConnection((current) => ({ ...current, apiHost: event.target.value }))} placeholder="留空 = SSH 服务器本机" /></label>
              <label>API Key（可选）<input type="password" value={connection.apiKey ?? ""} onChange={(event) => setConnection((current) => ({ ...current, apiKey: event.target.value }))} placeholder="带鉴权的 OpenAI 兼容端点" autoComplete="off" /></label>
            </div>
            <label>推理后端
              <select value={connection.backendPreference ?? "ollama"} onChange={(event) => setConnection((current) => ({ ...current, backendPreference: event.target.value as BackendPreference }))}>
                {BACKEND_OPTIONS.map((backend) => <option key={backend} value={backend}>{BACKEND_LABELS[backend]}</option>)}
              </select>
            </label>
            <small className="muted">
              {BACKEND_HINTS[connection.backendPreference ?? "ollama"]}
              {" "}加速方式（ROCm / Vulkan / CPU）不再需要选择：探测会实测每个端点是否真的把模型放进了显存。
            </small>
            <div className="actions connection-actions">
              <button type="button" disabled={busy} onClick={() => void connect()}>{busy ? "正在枚举端点…" : "连接并检查环境"}</button>
              <span className="action-spacer" />
              <button type="button" className="secondary" disabled={!canOpenConfig || busy} onClick={() => setPage("config")}>下一步：配置测试参数</button>
              <button type="button" className="secondary" disabled={!environment || busy} onClick={() => void disconnect()}>断开连接</button>
            </div>
          </section>
          <EnvironmentPanel environment={environment} busy={busy} onSelectEndpoint={(endpointId) => void selectEndpoint(endpointId)} />
        </section>}

        {page === "config" && (environment
          ? <BenchmarkConfigPage installedModels={environment.installedModels} backend={environment.backend} initialConfig={savedConfig} onConfigChange={setSavedConfig} onStart={(config) => void startBenchmark(config)} onCancel={() => setPage("connect")} />
          : <section className="card"><div className="empty">请先完成服务器连接与环境检查。</div></section>)}

        {page === "execution" && <section className="card execution-panel">
          <div className="results-heading"><div><p className="eyebrow">STEP 3</p><h2>测试执行报告</h2></div>{busy && <button type="button" className="secondary" onClick={() => void cancelBenchmark()}>取消测试</button>}</div>
          <div className="progress-track"><div className="progress-bar" style={{ width: `${progressPercent}%` }} /></div>
          <p className="progress-label">测试进度：{progressPercent}%{progress.total ? `（已完成 ${progress.completed} / ${progress.total} 个独立请求）` : busy ? "（正在准备测试请求…）" : ""}</p>
          <h3>测试日志</h3>
          <div className="execution-log" ref={logElementRef} onScroll={handleLogScroll}>{executionLogs.length ? executionLogs.join("\n") : "暂无测试日志。"}</div>
          {result && <>
            <div className="result-toolbar">
              <h3>测试结果{result.cancelled ? "（未完成，可继续测试）" : ""}</h3>
              <div className="actions report-actions">
                {result.cancelled && !busy && <button type="button" disabled={exporting} onClick={() => resumeBenchmark()}>继续测试</button>}
                <button type="button" disabled={exporting} onClick={() => void exportReports(["docx", "pdf", "markdown", "html"])}>导出全部报告</button>
                <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["docx"])}>仅导出 Word</button>
                <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["pdf"])}>仅导出 PDF</button>
                <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["markdown"])}>仅导出 Markdown</button>
                <button type="button" className="secondary" disabled={exporting} onClick={() => void exportReports(["html"])}>仅导出 HTML</button>
              </div>
            </div>
            <ResultTable result={result} />
          </>}
        </section>}
      </div>

      <div className={`workspace-page ${workspace === "capability" ? "active" : "hidden"}`}>
        {environment ? <CapabilityEvaluationPage environment={environment} onOpenPerformance={() => setWorkspace("performance")} /> : <section className="card"><div className="empty">请先完成服务器连接与环境检查，再进入模型能力横评。</div></section>}
      </div>

      <div className={`workspace-page ${workspace === "advanced" ? "active" : "hidden"}`}>
        {environment ? <AdvancedEvaluationPage environment={environment} onOpenPerformance={() => setWorkspace("performance")} /> : <section className="card"><div className="empty">请先完成服务器连接与环境检查，再进入高级场景评测。</div></section>}
      </div>
    </main>
  );
}
