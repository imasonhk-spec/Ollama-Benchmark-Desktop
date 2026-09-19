export const DEFAULT_MODELS = [
  "qwen3.5:2b",
  "qwen3.5:35b",
  "qwen3.5:122b",
  "qwen3.6:35b",
] as const;

/**
 * Default model suggestions shown when the detected backend is llama.cpp.
 * llama.cpp serves local `.gguf` files (not Ollama's `name:tag` registry), so the
 * suggestions use `.gguf` file names and never the Ollama-style defaults above.
 */
export const DEFAULT_LLAMACPP_MODELS = [
  "llama-3.1-8b-instruct-q4_k_m.gguf",
  "qwen2.5-7b-instruct-q4_k_m.gguf",
  "mistral-7b-instruct-v0.3-q4_k_m.gguf",
  "gemma-2-9b-it-q4_k_m.gguf",
] as const;

/**
 * Returns the default model suggestions appropriate for the detected backend.
 * This keeps the selectable model list scoped to one backend: Ollama-style
 * `name:tag` defaults are never mixed into a llama.cpp session and vice versa.
 */
export function defaultModelsForBackend(backend?: InferenceBackend): readonly string[] {
  return isOpenAiCompatibleBackend(backend) ? DEFAULT_LLAMACPP_MODELS : DEFAULT_MODELS;
}

export const DEFAULT_INPUT_LENGTHS = [
  10, 100, 1_000, 2_000, 4_000, 6_000, 8_000, 16_000, 32_000, 64_000,
] as const;

export const DEFAULT_CONCURRENCIES = [1, 2, 4, 6, 8, 10] as const;

export type GpuVendor = "amd" | "nvidia" | "none" | "unknown";
export type Deployment = "native" | "docker" | "not-found";
/**
 * 运行程序的标识。
 *
 * `ollama-rocm` 仅用于读取 V2.4 及更早版本保存的结果；V2.5 起探测不再推断构建变体，
 * 因为「是否走 GPU」是端点的运行时属性，由 `AccelerationInfo` 实测得出。
 */
export type OllamaBinary = "ollama" | "ollama-rocm" | "llama-server" | "unknown";

/**
 * 推理后端的**协议族**。
 *
 * V2.5 起不再把「加速实现」（ROCm / Vulkan）当成用户选项：同一个 `ollama` 端点可能
 * 由 ROCm 容器或 CPU 构建提供，同一个 `llama.cpp` 端点也可能跑在 ROCm / Vulkan / CPU 上，
 * 从 HTTP API 完全无法区分（V2.4 的源码注释自己也承认三者 detection 完全相同）。
 * 因此选项只保留「用什么协议说话」，加速状态改为探测时**实测**并回显。
 *
 * - `ollama`            — Ollama 原生 API（`/api/tags`、`/api/generate`、`/api/ps`）
 * - `llama.cpp`         — llama-server / llama-swap 等本地 OpenAI 兼容端点（`/v1/chat/completions`）
 * - `openai-compatible` — 任意远程 OpenAI 兼容服务（自定义主机/端口/API Key）
 */
export type InferenceBackend = "ollama" | "llama.cpp" | "openai-compatible";
/** 连接表单里的后端选择；与 `InferenceBackend` 同值，便于 UI 直接绑定。 */
export type BackendPreference = InferenceBackend;

/** V2.4 及更早版本的选项值 → V2.5 协议族，保证旧配置/旧结果仍可读取。 */
export const LEGACY_BACKEND_ALIASES: Record<string, BackendPreference> = {
  "ollama-rocm": "ollama",
  "llama.cpp-rocm": "llama.cpp",
  "llama.cpp-vulkan": "llama.cpp",
};

/** 把任意历史选项值归一化为 V2.5 的协议族（未知值回退到 `ollama`）。 */
export function normalizeBackendPreference(value?: string): BackendPreference {
  if (value === "ollama" || value === "llama.cpp" || value === "openai-compatible") return value;
  return (value && LEGACY_BACKEND_ALIASES[value]) || "ollama";
}

/** True 仅当后端是本地 llama.cpp 家族（llama-server / llama-swap）。 */
export function isLlamaCppBackend(backend?: InferenceBackend): boolean {
  return backend === "llama.cpp";
}

/** True 当端点使用 OpenAI 兼容协议（`/v1/chat/completions`）——llama.cpp 与远程兼容服务都算。 */
export function isOpenAiCompatibleBackend(backend?: InferenceBackend): boolean {
  return backend === "llama.cpp" || backend === "openai-compatible";
}

/** Human-readable labels for each backend, used in the UI and reports. */
export const BACKEND_LABELS: Record<InferenceBackend, string> = {
  ollama: "Ollama",
  "llama.cpp": "llama.cpp · OpenAI 兼容",
  "openai-compatible": "OpenAI 兼容 · 远程服务",
};

/** 每个选项在连接表单里的说明文字。 */
export const BACKEND_HINTS: Record<BackendPreference, string> = {
  ollama: "枚举服务器上全部 Ollama 实例（11434 以及容器映射到 11435/11437/11438 等端口），逐个实测可用性、模型清单与显存占用，再由你确认使用哪一个。",
  "llama.cpp": "探测 llama-server / llama-swap / llama.cpp 的 OpenAI 兼容端点，候选端口由进程启动参数与监听表反推（含 8082 llama-swap），不靠猜端口。",
  "openai-compatible": "连接任意 OpenAI 兼容服务：填写推理服务主机、端口与 API Key（例如带鉴权的反向代理或远程 GPU 机器）；留空主机则按默认端口在本机枚举。",
};

/** The backends offered in the connection form, in display order. */
export const BACKEND_OPTIONS: BackendPreference[] = ["ollama", "llama.cpp", "openai-compatible"];

/** Map a detected backend to its display label (defaults to Ollama when unknown). */
export function backendLabel(backend?: InferenceBackend): string {
  return backend ? BACKEND_LABELS[backend] : "Ollama";
}

/** 端点的加速状态，来自运行时实测而非用户选择。 */
export type AccelerationMode = "gpu" | "partial" | "cpu" | "unknown";

export type AccelerationInfo = {
  mode: AccelerationMode;
  /** 实测依据（原文回显，便于复核），例如 `/api/ps：size_vram 25.7 GB / 25.7 GB（100%）`。 */
  detail: string;
  /** 已加载模型落在显存的比例（0–1）；只有 Ollama 端点能直接实测。 */
  vramRatio?: number;
  /** 探测时正在加载/驻留的模型清单。 */
  loadedModels?: string[];
};

/** 加速状态的一行式说明，界面与报告共用同一套措辞。 */
export function accelerationLabel(info?: AccelerationInfo): string {
  if (!info) return "未检测";
  const mode = info.mode === "gpu" ? "GPU 加速"
    : info.mode === "partial" ? "部分卸载（GPU + 内存混合）"
      : info.mode === "cpu" ? "CPU 推理" : "未判定";
  return `${mode} · ${info.detail}`;
}

/** 探测过程中试过的单个端点（成功的与失败的都保留，便于用户判断与手动切换）。 */
export type ProbeEndpoint = {
  /** `family:host:port`，UI 用它切换端点。 */
  id: string;
  backend: InferenceBackend;
  host: string;
  port: number;
  deployment: "native" | "docker";
  /** 端点来源说明，例如「容器 ollama-host · ollama/ollama:rocm」或「进程 llama-server (pid 991)」。 */
  source: string;
  ok: boolean;
  /** ok 时为结论摘要，失败时为具体原因。 */
  detail: string;
  version?: string;
  models: string[];
  acceleration?: AccelerationInfo;
  /** 连通性探测耗时（毫秒）。 */
  elapsedMs?: number;
};

export type SshConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  /** Optional remote inference API port; common ports are probed when omitted. */
  apiPort?: number;
  /**
   * 推理服务所在主机（相对 SSH 服务器）。
   * 留空 = SSH 服务器的回环地址；填写远程地址时请求经 SSH 隧道转发到该主机。
   */
  apiHost?: string;
  /**
   * OpenAI 兼容 / 反向代理端点的 Bearer Token。
   * 填了之后所有探测与推理请求都会带上 `Authorization: Bearer <apiKey>`；
   * 出现 401/403 时结果面板会明确提示需要该字段，而不是笼统地说「不可达」。
   */
  apiKey?: string;
  backendPreference?: BackendPreference;
  connectTimeoutMs: number;
};

export type ServerSystemInfo = {
  osName?: string;
  kernel?: string;
  architecture?: string;
  chipPlatform?: string;
  cpuModel?: string;
  cpuCores?: number;
  memoryBytes?: number;
  storageTotalBytes?: number;
  storageAvailableBytes?: number;
};

export type OllamaEnvironment = {
  /** Detected inference backend; optional for backwards-compatible saved fixtures. */
  backend?: InferenceBackend;
  deployment: Deployment;
  binary: OllamaBinary;
  apiHost: string;
  apiPort: number;
  version?: string;
  gpuVendor: GpuVendor;
  gpuModels: string[];
  installedModels: string[];
  warnings: string[];
  systemInfo?: ServerSystemInfo;
  /** 本轮使用的协议族（= 连接表单里的选择，已做别名归一）。 */
  preference?: BackendPreference;
  /** 当前实际命中的端点 id（对应 `endpoints[].id`），用户手动切换后同步更新。 */
  endpointId?: string;
  /** 所有探测过的端点（含失败原因），UI 据此展示候选列表并允许手动切换。 */
  endpoints?: ProbeEndpoint[];
  /** 当前端点的加速实测结果。 */
  acceleration?: AccelerationInfo;
};

export type BenchmarkConfig = {
  models: string[];
  inputLengths: number[];
  concurrencies: number[];
  rounds: number;
  maxOutputTokens: number;
  temperature: number;
  warmupEnabled: boolean;
  timeoutMs: number;
  contextWindow: "auto-fixed" | "server-default";
};

export type ReportFormat = "markdown" | "html" | "docx" | "pdf";

export type BenchmarkSample = {
  model: string;
  targetInputTokens: number;
  actualInputTokens?: number;
  concurrency: number;
  round: number;
  workerIndex: number;
  ttftMs?: number;
  serverPrefillMs?: number;
  decodeTokensPerSecond?: number;
  generatedTokens?: number;
  loadMs?: number;
  totalMs?: number;
  status: "success" | "timeout" | "error" | "cancelled";
  errorMessage?: string;
};

export type BenchmarkSummary = {
  model: string;
  inputTokens: number;
  concurrency: number;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  ttftMeanMs?: number;
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  decodeMeanTokensPerSecond?: number;
  decodeP50TokensPerSecond?: number;
  aggregateDecodeTokensPerSecond?: number;
  serverPrefillMeanMs?: number;
};

export type OllamaGenerateDone = {
  done?: boolean;
  response?: string;
  thinking?: string;
  message?: {
    content?: string;
    thinking?: string;
  };
  error?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    message?: { content?: string; reasoning_content?: string };
    text?: string;
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  timings?: { predicted_n?: number; predicted_ms?: number; prompt_n?: number; prompt_ms?: number };
};

/** 内置题库使用的 7 个维度；仅作为默认值，评测维度不再被限定在这一组里。 */
export const CAPABILITY_DIMENSIONS = [
  "code",
  "translation",
  "classicalChinese",
  "math",
  "logic",
  "chineseKnowledge",
  "creativeWriting",
] as const;

/**
 * 维度标识（dimension）。
 *
 * V2.4 起维度由题库决定：导入的题库里出现哪些 dimension，评测、图表与报告就使用哪些维度，
 * 因此这里是开放的字符串，而不是固定的字面量联合类型。
 */
export type CapabilityDimension = string;

/** 一个维度的元信息，顺序即题库中首次出现的顺序。 */
export type CapabilityDimensionMeta = {
  key: CapabilityDimension;
  label: string;
  /** 该维度所有题目满分之和；为 0 表示题库里没有这个维度的题目。 */
  maxScore: number;
  questionCount: number;
};

/**
 * 评分规则（ruleKind 列 + ruleData JSON）。
 *
 * V2.4 起除了内置的 keywords / number / exact / code，还支持业务场景题库常用的
 * contains_all、formula、sql_result、json_schema、tool_call，
 * 这样办公类、合规类等自定义用例库可以直接导入，不必改写规则。
 */
/**
 * json_schema 规则的期望值：字符串为期望取值，null 表示「该字段应当缺失/为 null」，
 * 嵌套对象表示多层抽取（例如 payment.amount）。
 */
export type CapabilityJsonValue = string | null | { [key: string]: CapabilityJsonValue };

export type CapabilityRule =
  | { kind: "keywords"; groups: string[][]; minimumLength?: number; maximumLength?: number }
  | { kind: "number"; answers: string[]; tolerance?: number }
  | { kind: "exact"; aliases: string[] }
  | { kind: "code"; checks: string[] }
  | { kind: "contains_all"; terms: string[] }
  | { kind: "formula"; checks: string[] }
  | { kind: "sql_result"; checks: string[] }
  | { kind: "json_schema"; required?: string[]; expected?: CapabilityJsonValue | CapabilityJsonValue[]; expectedCount?: number }
  | { kind: "tool_call"; expectedTools?: string[]; requiredArgs?: string[]; expected?: Record<string, string>; notContains?: string[] };

export const CAPABILITY_RULE_KINDS = ["keywords", "number", "exact", "code", "contains_all", "formula", "sql_result", "json_schema", "tool_call"] as const;
export type CapabilityRuleKind = (typeof CAPABILITY_RULE_KINDS)[number];

/** 从模型回答里取哪个字段作为答案；tool_calls 用于工具调用类题目。 */
export const CAPABILITY_RESPONSE_KEYS = ["answer", "code", "tool_calls"] as const;
export type CapabilityResponseKey = (typeof CAPABILITY_RESPONSE_KEYS)[number];

export function isCapabilityRuleKind(value: unknown): value is CapabilityRuleKind {
  return typeof value === "string" && (CAPABILITY_RULE_KINDS as readonly string[]).includes(value);
}

export type CapabilityQuestion = {
  id: string;
  dimension: CapabilityDimension;
  /** 维度的中文显示名，来自题库的 dimensionLabel 列；缺省时回退到内置标签或维度标识本身。 */
  dimensionLabel?: string;
  title: string;
  prompt: string;
  responseKey: CapabilityResponseKey;
  maxScore: number;
  rule: CapabilityRule;
};

/** 单题满分上限：内置题库每题 5 分，自定义用例库可用 5 分制或百分制。 */
export const CAPABILITY_MAX_QUESTION_SCORE = 100;

export const CAPABILITY_DIMENSION_LABELS: Record<string, string> = {
  code: "写代码",
  translation: "翻译",
  classicalChinese: "文言文",
  math: "数学",
  logic: "逻辑",
  chineseKnowledge: "中文常识",
  creativeWriting: "创意写作",
};

export type CapabilityThinkingMode = "off" | "on";

export type CapabilityConfig = {
  models: string[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  thinkingMode: CapabilityThinkingMode;
  suiteVersion: string;
  questions?: CapabilityQuestion[];
};

export type CapabilityQuestionResult = {
  model: string;
  id: string;
  dimension: CapabilityDimension;
  title: string;
  prompt: string;
  response: string;
  score: number;
  maxScore: number;
  status: "success" | "error" | "cancelled";
  elapsedMs?: number;
  generatedTokens?: number;
  decodeTokensPerSecond?: number;
  parserMode: "json" | "fallback" | "invalid";
  reasoningDetected: boolean;
  evidence: string[];
  errorMessage?: string;
};

export type CapabilityModelSummary = {
  model: string;
  rank: number;
  totalScore: number;
  maxScore: number;
  dimensionScores: Record<CapabilityDimension, number>;
  dimensionMaxScores: Record<CapabilityDimension, number>;
  completedCount: number;
  questionCount: number;
  averageResponseMs?: number;
  averageDecodeTokensPerSecond?: number;
};

export type CapabilityRunResult = {
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
  config: CapabilityConfig;
  suiteVersion: string;
  environment: OllamaEnvironment;
  questions: CapabilityQuestionResult[];
  summaries: CapabilityModelSummary[];
  /** 本轮实际使用的维度（顺序 = 题库首次出现顺序）。旧结果可能没有该字段，由 resolveCapabilityDimensions 兼容推导。 */
  dimensions?: CapabilityDimensionMeta[];
};