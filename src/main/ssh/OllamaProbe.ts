import type {
  AccelerationInfo,
  BackendPreference,
  GpuVendor,
  InferenceBackend,
  OllamaBinary,
  OllamaEnvironment,
  ProbeEndpoint,
  ServerSystemInfo,
} from "../../shared/types";
import { isOpenAiCompatibleBackend, normalizeBackendPreference } from "../../shared/types";
import { SshSession } from "./SshSession";

export type DockerContainer = { id: string; name: string; image: string; ports: string };
export type ApiCandidate = { backend: InferenceBackend; host: string; port: number; deployment: "native" | "docker"; image?: string };

type ApiModel = { name?: string; id?: string; model?: string };
type OllamaPsModel = { name?: string; size?: number; size_vram?: number };

/**
 * Ollama 端点候选端口。
 *
 * V2.4 只探测 11434（或用户手填端口），因此同一台机器上映射到其它端口的第二个
 * Ollama 实例永远看不见。这里把常见的多实例端口一并纳入候选，再由用户确认。
 */
export const DEFAULT_OLLAMA_PORTS = [11434, 11435, 11437, 11438];

/**
 * OpenAI 兼容端点候选端口。
 *
 * 8082 = llama-swap（V2.4 完全没覆盖，只有手填端口才能连上），
 * 8080 = llama-server 默认值，其余为常见自定义端口。
 */
export const DEFAULT_LLAMACPP_PORTS = [8082, 8080, 8000, 10000, 8081, 1234];

/**
 * 一次只读探测取回全部**非特权**信息，避免为每条命令各开一个 SSH 通道。
 *
 * 实测（一台跨 Tailscale 的远端服务器）：每开一个通道约 2.4s、每个隧道 HTTP 请求约 2.0s。
 * V2.4 的 16 次串行 exec 光通道开销就要 40s，所以这里合并成 1 条带标记的命令。
 * awk 把两张表的列名差异抹平：$4 = 本地地址:端口，$NF = 占用者
 * （ss: users:(...)，netstat: pid/prog）。
 */
export const SYSTEM_PROBE_COMMAND = [
  "echo __LISTEN__",
  "(ss -tlnpH 2>/dev/null || ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true) | awk '{print $4 \"\\t\" $NF}'",
  "echo __PROC__",
  "ps -eo pid=,args= 2>/dev/null || true",
  "echo __BIN_OLLAMA__",
  "command -v ollama 2>/dev/null || true",
  "echo __BIN_LLAMA__",
  "command -v llama-server 2>/dev/null || command -v llama.cpp 2>/dev/null || true",
  "echo __GPU_ROCM__",
  "timeout 10s rocm-smi --showproductname 2>/dev/null || true",
  "echo __GPU_LSPCI__",
  "timeout 10s lspci 2>/dev/null | grep -iE 'vga|display|3d' || true",
  "echo __GPU_NVIDIA__",
  "timeout 10s nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || true",
  "echo __OS__",
  "if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s\\n' \"$PRETTY_NAME\"; fi",
  "echo __UNAME__",
  "uname -srmo 2>/dev/null",
  "echo __ARCH__",
  "uname -m 2>/dev/null",
  "echo __CPU__",
  "lscpu 2>/dev/null | awk -F: '/Model name/ {sub(/^[[:space:]]+/, \"\", $2); print $2; exit}'",
  "echo __CORES__",
  "nproc 2>/dev/null",
  "echo __MEM__",
  "awk '/MemTotal/ {print $2 * 1024; exit}' /proc/meminfo 2>/dev/null",
  "echo __DISK__",
  "df -B1 / 2>/dev/null | awk 'NR==2 {print $2 \" \" $4; exit}'",
].join("; ");

/**
 * Docker 需要 sudo，单独一条命令：即使账号没有 sudo，上面的非特权探测结果也不会丢。
 * `__EXIT__<code>` 与 `__DOCKER_IP__` 是给解析器用的标记。
 */
export const DOCKER_PROBE_COMMAND = [
  "echo __DOCKER__",
  "docker ps --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Ports}}' 2>&1",
  "echo \"__EXIT__$?\"",
].join("; ");

/** 一条命令批量取回多个容器的 IP，避免每个容器各开一个通道。 */
export function dockerInspectCommand(containerIds: string[]): string {
  const ids = containerIds.filter((id) => /^[a-f0-9]+$/i.test(id)).join(" ");
  return [
    "echo __DOCKER_IP__",
    `docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${ids} 2>&1`,
  ].join("; ");
}

const LLAMA_PROCESS_PATTERN = /llama-server|llama-swap|llama\.cpp|llama-cpp|rpc-server/i;
const OLLAMA_PROCESS_PATTERN = /(^|[\s/])ollama(\s|$)|ollama-serve|ollama_llama_server/i;

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
function firstPositiveNumber(value: string): number | undefined {
  const parsed = Number(firstLine(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}
function lines(value?: string): string[] {
  return (value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) { amount /= 1_024; unit += 1; }
  return `${amount.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}
function storageInfo(value: string): Pick<ServerSystemInfo, "storageTotalBytes" | "storageAvailableBytes"> {
  const [total, available] = value.trim().split(/\s+/).map(Number);
  return { storageTotalBytes: Number.isFinite(total) && total > 0 ? total : undefined, storageAvailableBytes: Number.isFinite(available) && available >= 0 ? available : undefined };
}

export function parseDockerContainers(output: string): DockerContainer[] {
  return output.split(/\r?\n/).map((line) => {
    const [id, name, image, ...ports] = line.split("\t");
    if (!id || !name || !image) return undefined;
    return { id: id.trim(), name: name.trim(), image: image.trim(), ports: ports.join("\t").trim() };
  }).filter((value): value is DockerContainer => value !== undefined);
}

export function mappedPort(ports: string, targetPort?: number): number | undefined {
  const pattern = targetPort ? new RegExp(`(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]|::|:::)?:(\\d+)->${targetPort}\\/tcp`) : /(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::|:::)?:([0-9]+)->11434\/tcp/;
  const match = ports.match(pattern);
  return match ? Number(match[1]) : undefined;
}

function anyMappedPort(ports: string): number | undefined {
  const match = ports.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::|:::)?:([0-9]+)->[0-9]+\/tcp/);
  return match ? Number(match[1]) : undefined;
}

function uniqueCandidates(candidates: ApiCandidate[]): ApiCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    // 按端点 id 去重：llama.cpp 与 openai-compatible 归一到同一协议族前缀，
    // 否则同一 host:port 会以两个 backend 值重复出现，UI 上无法区分。
    const key = endpointId(candidate.backend, candidate.host, candidate.port);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 把监听地址归一成可用于 SSH 隧道转发的目标主机。 */
export function normalizeBindHost(bind?: string): string {
  const value = (bind ?? "").trim();
  if (!value || /^(\*|::|\[::\]|0\.0\.0\.0|127\.|localhost)/.test(value)) return "127.0.0.1";
  return value;
}

function modelNames(models: ApiModel[] | undefined): string[] {
  return (models ?? []).map((model) => model.name ?? model.id ?? model.model).filter((name): name is string => Boolean(name));
}

/** 所有探测过的端点用同一个 id 规则，UI 与 IPC 都靠它切换。 */
export function endpointId(backend: InferenceBackend, host: string, port: number): string {
  return `${isOpenAiCompatibleBackend(backend) ? "openai" : "ollama"}:${host}:${port}`;
}

/** 协议族 → 运行程序标识（加速实现不再参与判断）。 */
export function backendBinary(backend: InferenceBackend): OllamaBinary {
  return isOpenAiCompatibleBackend(backend) ? "llama-server" : "ollama";
}

/* -------------------------------------------------------------------------- */
/* Discovery parsers (pure, unit-tested)                                       */
/* -------------------------------------------------------------------------- */

export type ListeningPort = { port: number; bind: string; pid?: number; process?: string };
export type RemoteProcess = { pid: number; args: string };

/**
 * 去掉 sshd 会话带来的 shell 噪音。
 *
 * 目标服务器的 `LC_ALL=zh_CN.UTF-8` 在本机不存在，于是每个 `bash -c` 都会往 stderr
 * 打一行 setlocale 警告；不清理的话它会冒充「docker inspect 失败原因」之类的诊断。
 */
export function stripShellNoise(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/setlocale|LC_(ALL|CTYPE).*cannot change locale|cannot change locale/i.test(line))
    .join("\n");
}

/** 按 `__MARKER__` 行切分合并命令的输出；标记行本身不进入内容。 */
export function parseMarkedSections(output: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections[current] = buffer.join("\n");
    buffer = [];
  };
  for (const line of output.split(/\r?\n/)) {
    const marker = line.trim().match(/^__([A-Z_]+)__$/);
    if (marker) {
      flush();
      current = marker[1];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return sections;
}

/** 取回 docker ps 的输出与退出码（退出码由命令尾部的 `__EXIT__<code>` 回传）。 */
export function parseDockerSection(section: string): { code: number | null; output: string } {
  const lines = section.split(/\r?\n/);
  const index = lines.findIndex((line) => /^__EXIT__-?\d+$/.test(line.trim()));
  if (index < 0) return { code: null, output: section.trim() };
  const code = Number(lines[index].trim().slice("__EXIT__".length));
  lines.splice(index, 1);
  return { code, output: lines.join("\n").trim() };
}

/** `docker inspect -f '{{.Name}} {{...IPAddress}}'` 的输出 → 容器名/IP 映射。 */
export function parseContainerIps(section: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of lines(section)) {
    const [name, ...addresses] = line.split(/\s+/);
    if (!name) continue;
    const ip = addresses.find((address) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address));
    if (ip) result.set(name.replace(/^\//, ""), ip);
  }
  return result;
}

export function parseListeningPorts(output: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const raw of lines(output)) {
    const [addressRaw, ownerRaw = ""] = raw.split("\t");
    const address = (addressRaw ?? "").trim();
    const match = address.match(/:(\d{1,5})$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
    const owner = ownerRaw.trim();
    const pid = owner.match(/pid=(\d+)/)?.[1] ?? owner.match(/^(\d+)\//)?.[1] ?? owner.match(/\s(\d+)\//)?.[1];
    const process = owner.match(/\("([^"]+)",pid=/)?.[1] ?? owner.match(/\d+\/(\S+)/)?.[1];
    ports.push({
      port,
      bind: address.slice(0, address.length - match[0].length) || address,
      pid: pid ? Number(pid) : undefined,
      process: process || undefined,
    });
  }
  return ports;
}

export function parseProcesses(output: string): RemoteProcess[] {
  const processes: RemoteProcess[] = [];
  for (const raw of lines(output)) {
    const match = raw.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), args: match[2].trim() });
  }
  return processes;
}

function portFromHostSpec(value: string | undefined): number | undefined {
  const match = value?.match(/:(\d{1,5})$/);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * 从进程启动参数与监听表反推 Ollama 真实端口，而不是死猜 11434。
 * 覆盖 `OLLAMA_HOST=0.0.0.0:11436`、`ollama serve --host :11436`，
 * 以及监听表里进程名/命令行含 ollama 的端口（例如包装脚本、shim、容器内的 ollama）。
 */
export function inferOllamaPorts(processes: RemoteProcess[], listening: ListeningPort[]): number[] {
  const ports = new Set<number>();
  for (const process of processes) {
    if (!OLLAMA_PROCESS_PATTERN.test(process.args) || /\bgrep\b/.test(process.args)) continue;
    for (const spec of [process.args.match(/OLLAMA_HOST=(\S+)/)?.[1], process.args.match(/--host[=\s](\S+)/)?.[1]]) {
      const port = portFromHostSpec(spec);
      if (port) ports.add(port);
    }
    if (/ollama\s+serve/.test(process.args)) ports.add(11434);
    for (const item of listening) if (item.pid === process.pid) ports.add(item.port);
  }
  for (const item of listening) {
    if (item.pid === undefined) continue;
    const argv = processes.find((process) => process.pid === item.pid)?.args ?? "";
    const hint = `${item.process ?? ""} ${argv}`;
    if (/\bgrep\b/.test(hint)) continue;
    if (/ollama/i.test(hint)) ports.add(item.port);
  }
  return [...ports];
}

/** 从 `llama-server --port 8082` / `-p 8082` 及监听表 pid 关联反推 llama.cpp 端口。 */
export function inferLlamaPorts(processes: RemoteProcess[], listening: ListeningPort[]): number[] {
  const ports = new Set<number>();
  for (const process of processes) {
    if (!LLAMA_PROCESS_PATTERN.test(process.args)) continue;
    const explicit = process.args.match(/--port[=\s](\d{1,5})/)?.[1] ?? process.args.match(/(?:^|\s)-p[=\s]?(\d{1,5})(?:\s|$)/)?.[1];
    if (explicit) ports.add(Number(explicit));
    for (const item of listening) if (item.pid === process.pid) ports.add(item.port);
  }
  for (const item of listening) {
    if (item.pid === undefined) continue;
    const argv = processes.find((process) => process.pid === item.pid)?.args ?? "";
    const hint = `${item.process ?? ""} ${argv}`;
    // 注意 "ollama" 里也含 "llama"，必须先排除 Ollama，否则会把 Ollama 端口误判成 llama.cpp。
    if (/llama/i.test(hint) && !/ollama/i.test(hint)) ports.add(item.port);
  }
  return [...ports];
}

/**
 * GPU 识别。
 *
 * V2.4 的兜底正则 `amd.*vga|amd.*display` 在 Strix Halo 上实测 NO MATCH ——
 * `lspci` 实际输出是 `Display controller: ... [AMD/ATI] ...`，词序正好相反。
 * 这里改成「先按设备类型行过滤，再按厂商名判断」，不再依赖词序。
 */
export function classifyGpu(sources: { rocm?: string; lspci?: string; nvidia?: string }): { vendor: GpuVendor; models: string[] } {
  const lspciLines = lines(sources.lspci);
  const nvidiaLines = lines(sources.nvidia);
  const rocmLines = lines(sources.rocm).filter((line) => /amd|radeon|instinct|gfx[0-9]|marketing name|card series|card model|device name|gpu\[\d/i.test(line));

  const displayLines = lspciLines.filter((line) => /(vga|display|3d)/i.test(line));
  const amdHit = rocmLines.length > 0 || displayLines.some((line) => /(amd|ati|radeon)/i.test(line));
  const nvidiaHit = nvidiaLines.length > 0 || displayLines.some((line) => /nvidia/i.test(line));
  const vendor: GpuVendor = amdHit ? "amd" : nvidiaHit ? "nvidia" : displayLines.length ? "unknown" : "none";

  const models = new Set<string>();
  for (const line of rocmLines) {
    // `Card vendor: Advanced Micro Devices, Inc. [AMD/ATI]` 不是型号，剔掉。
    if (/card vendor/i.test(line)) continue;
    const cleaned = line
      .replace(/^gpu\[\d+\]\s*:\s*/i, "")
      .replace(/^(card series|card model|card vendor|marketing name|device name|graphics chip)\s*:\s*/i, "")
      .trim();
    if (!cleaned || /^n\/?a$/i.test(cleaned) || /^0x[0-9a-f]+$/i.test(cleaned)) continue;
    models.add(cleaned);
  }
  for (const line of displayLines) {
    // lspci 的型号在**末尾**方括号里：`... [AMD/ATI] Strix [Radeon 8060S] (rev c1)`。
    const trailing = line.match(/\[([^[\]]+)\]\s*(?:\(rev|\(R\)|$)/i)?.[1];
    const vendorTagged = line.match(/\[(?:AMD\/ATI|AMD|NVIDIA|Intel)\]\s*([^[]+)$/i)?.[1];
    const fallback = line.replace(/^[0-9a-f]{2,4}:[0-9a-f]{2}\.[0-9a-f]\s+/i, "").replace(/^[^:]*:\s*/, "");
    const cleaned = (trailing ?? vendorTagged ?? fallback).trim();
    if (cleaned) models.add(cleaned.replace(/\s+/g, " "));
  }
  return { vendor, models: [...models].slice(0, 4) };
}

/** 用 `/api/ps` 的 size_vram/size 实测 Ollama 是否真的把模型放进了显存。 */
export function accelerationFromOllamaPs(loaded: OllamaPsModel[] | undefined, imageHint?: string): AccelerationInfo {
  const models = loaded ?? [];
  const names = models.map((model) => model.name).filter((name): name is string => Boolean(name));
  if (!models.length) {
    const hint = imageHint ? ` 端点镜像/标签含 “${imageHint}”，是加速构建的弱信号，但不代表已生效。` : "";
    return {
      mode: "unknown",
      detail: `端点当前空闲（无可读取的 /api/ps 记录），无法实测显存占用；先发一次推理再重新探测即可判定。${hint}`,
      loadedModels: [],
    };
  }
  const size = models.reduce((sum, model) => sum + (Number(model.size) || 0), 0);
  const vram = models.reduce((sum, model) => sum + (Number(model.size_vram) || 0), 0);
  const ratio = size > 0 ? vram / size : undefined;
  const basis = ratio === undefined
    ? `/api/ps：${names.join(", ")}（未上报 size_vram）`
    : `/api/ps：size_vram ${formatBytes(vram)} / size ${formatBytes(size)}（${Math.round(ratio * 100)}%）`;
  const mode = ratio === undefined ? "unknown" : ratio >= 0.95 ? "gpu" : ratio <= 0.02 ? "cpu" : "partial";
  return { mode, detail: basis, vramRatio: ratio, loadedModels: names };
}

/** llama.cpp 无法从 HTTP 层判断加速，只能看启动参数（-ngl / --device / --no-kv-offload）。 */
export function accelerationFromArgv(argv: string | undefined, gpuVendor: GpuVendor): AccelerationInfo {
  const args = argv ?? "";
  if (/--n-gpu-layers[=\s]+0\b/.test(args) || /(?:^|\s)-ngl[=\s]+0\b/.test(args)) {
    return { mode: "cpu", detail: "启动参数 -ngl 0：llama-server 未把任何层卸载到 GPU，推理在 CPU 上运行。" };
  }
  const device = args.match(/--device[=\s]+(\S+)/i)?.[1];
  if (device) return { mode: "gpu", detail: `启动参数 --device ${device}（由 llama-server 日志/参数确认的加速后端）。` };
  const layers = args.match(/(?:--n-gpu-layers|-ngl)[=\s]+(\d+)/)?.[1];
  if (layers && Number(layers) > 0) return { mode: "gpu", detail: `启动参数 -ngl ${layers}：已把 ${layers} 层卸载到 GPU。` };
  if (/--no-kv-offload/.test(args)) return { mode: "partial", detail: "启动参数含 --no-kv-offload：模型层在 GPU、KV cache 留在内存。" };
  if (gpuVendor === "amd" || gpuVendor === "nvidia") {
    return { mode: "unknown", detail: `未能从进程启动参数确认加速状态；服务器存在 ${gpuVendor} GPU，实际是否生效取决于 llama-server 的编译与启动参数。` };
  }
  return { mode: "unknown", detail: "未检测到 GPU，且无法从启动参数确认加速状态。" };
}

/** 选定默认端点：先比模型数（评测对象越完整越好），再看加速是否已实测为 GPU，最后取端口小的。 */
export function selectDefaultEndpoint(endpoints: ProbeEndpoint[]): ProbeEndpoint | undefined {
  const ok = endpoints.filter((endpoint) => endpoint.ok);
  const weight = (endpoint: ProbeEndpoint): number => (endpoint.acceleration?.mode === "gpu" ? 2 : endpoint.acceleration?.mode === "unknown" ? 1 : 0);
  return [...ok].sort((a, b) =>
    b.models.length - a.models.length
    || weight(b) - weight(a)
    || a.port - b.port)[0];
}

/** 把选中的端点套到环境对象上（不重新探测，避免多开 SSH 通道）。 */
export function applyEndpoint(environment: OllamaEnvironment, id: string): OllamaEnvironment {
  const endpoint = environment.endpoints?.find((item) => item.id === id && item.ok);
  if (!endpoint) return environment;
  return {
    ...environment,
    backend: endpoint.backend,
    endpointId: endpoint.id,
    deployment: endpoint.deployment,
    binary: backendBinary(endpoint.backend),
    apiHost: endpoint.host,
    apiPort: endpoint.port,
    version: endpoint.version,
    installedModels: endpoint.models,
    acceleration: endpoint.acceleration,
  };
}

/* -------------------------------------------------------------------------- */
/* Probe                                                                       */
/* -------------------------------------------------------------------------- */

type CandidateSeed = ApiCandidate & { source: string; id: string; argv?: string };

export class OllamaProbe {
  public constructor(private readonly ssh: SshSession) {}

  public async detect(preference: BackendPreference | string = "ollama"): Promise<OllamaEnvironment> {
    // Probes are deliberately serial: hardened SSH servers often limit channels.
    const session = this.ssh as SshSession & { requestedApiPort?: number; requestedApiHost?: string };
    const requested = normalizeBackendPreference(typeof preference === "string" ? preference : undefined);
    const requestedPort = session.requestedApiPort;
    const requestedHost = session.requestedApiHost?.trim() || undefined;
    // openai-compatible + 明确指定了主机 = 远程服务，此时不做本机端口枚举。
    const remote = requested === "openai-compatible" && Boolean(requestedHost);

    // 只开 2 个 SSH 通道取回全部环境信息（实测每通道约 2.4s，逐条命令开通道会白等 40s）。
    const probe = await this.ssh.exec(SYSTEM_PROBE_COMMAND, 60_000);
    const dockerProbe = await this.execPrivileged(DOCKER_PROBE_COMMAND, 60_000);
    const sections = parseMarkedSections(stripShellNoise(probe.stdout));
    const dockerSection = parseDockerSection(stripShellNoise(dockerProbe.stdout));

    const ollamaBinary = firstLine(sections.BIN_OLLAMA ?? "");
    const llamaBinary = firstLine(sections.BIN_LLAMA ?? "");
    const gpu = classifyGpu({ rocm: sections.GPU_ROCM, lspci: sections.GPU_LSPCI, nvidia: sections.GPU_NVIDIA });
    const gpuVendor = gpu.vendor;
    const gpuModels = gpu.models.length ? gpu.models : lines(sections.GPU_NVIDIA);
    const cpu = firstLine(sections.CPU ?? "");
    const architecture = firstLine(sections.ARCH ?? "");
    const systemInfo: ServerSystemInfo = {
      osName: firstLine(sections.OS ?? ""), kernel: firstLine(sections.UNAME ?? ""), architecture, cpuModel: cpu,
      cpuCores: firstPositiveNumber(sections.CORES ?? ""), memoryBytes: firstPositiveNumber(sections.MEM ?? ""), ...storageInfo(sections.DISK ?? ""),
      chipPlatform: [gpuModels[0], cpu, architecture].filter(Boolean).join(" / ") || undefined,
    };

    const warnings: string[] = [];
    const dockerOutput = dockerSection.output;
    const dockerContainers = parseDockerContainers(dockerOutput).filter((container) => /ollama|llama|llama\.cpp|gguf/i.test(`${container.name} ${container.image}`));
    const listening = parseListeningPorts(sections.LISTEN ?? "");
    const processes = parseProcesses(sections.PROC ?? "");
    const processByPid = new Map(processes.map((process) => [process.pid, process.args]));

    if (dockerSection.code !== 0) {
      // 命令内已做 2>&1，这里再并上 exec 级 stderr：sudo 本身失败时错误只出现在这一侧。
      const detail = stripShellNoise(`${dockerSection.output}\n${dockerProbe.stderr}`).trim();
      const safeDetail = (detail || "未知错误").slice(0, 300);
      warnings.push(`Docker 探测失败：${safeDetail}`);
      if (/docker\.sock|permission denied|sudo/i.test(safeDetail)) warnings.push("Docker 仅使用 SSH 用户现有权限读取，未修改服务器任何配置。");
    } else if (!dockerOutput.trim() && !ollamaBinary && !llamaBinary) {
      warnings.push("Docker 没有运行中的容器，也没有找到宿主上的 Ollama / llama-server 可执行文件。");
    }
    if (!probe.stdout.trim()) {
      warnings.push(`服务器环境探测没有返回任何输出（退出码 ${probe.code ?? "未知"}）；${probe.stderr.trim().slice(0, 200) || "请确认 SSH 账号可以执行只读命令"}`);
    }

    /* ---- 候选端点 ---------------------------------------------------------- */
    const candidates: CandidateSeed[] = [];
    const pushCandidate = (seed: Omit<CandidateSeed, "id">) => {
      candidates.push({ ...seed, id: endpointId(seed.backend, seed.host, seed.port) });
    };

    // 1) Docker 容器：优先用宿主映射端口（等价且免穿透）；只有容器完全没有端口映射时
    //    才退回容器 IP，避免为每个容器再产生一组无谓的探测请求。
    const needIpLookup: DockerContainer[] = [];
    for (const container of dockerContainers) {
      const text = `${container.name} ${container.image}`;
      const isLlama = /llama/i.test(text) && !/ollama/i.test(text);
      // 只探测属于所选协议族的容器：用户选 Ollama 时不该拿 404 去猜 llama.cpp 端点。
      if (isLlama !== isOpenAiCompatibleBackend(requested)) continue;
      const backend: InferenceBackend = isLlama ? requested : "ollama";
      const source = `容器 ${container.name} · ${container.image}${container.id ? ` (${container.id.slice(0, 8)})` : ""}`;
      const mapped = isLlama ? anyMappedPort(container.ports) : mappedPort(container.ports, 11434) ?? anyMappedPort(container.ports);
      if (mapped) {
        pushCandidate({ backend, host: requestedHost ?? "127.0.0.1", port: mapped, deployment: "docker", image: container.image, source: `${source} · 映射端口 ${mapped}` });
        continue;
      }
      if (!/^[a-f0-9]+$/i.test(container.id)) continue;
      needIpLookup.push(container);
    }
    // 所有需要 IP 的容器用一条 docker inspect 批量取回（每个容器一条命令会白等 2.4s）。
    if (needIpLookup.length) {
      const inspect = await this.execDocker(dockerInspectCommand(needIpLookup.map((container) => container.id)), 60_000);
      const inspected = parseMarkedSections(stripShellNoise(inspect.stdout));
      const ipByName = parseContainerIps(inspected.DOCKER_IP ?? "");
      const inspectNoise = stripShellNoise(inspected.DOCKER_IP ?? "").split(/\r?\n/).filter((line) => /error|denied|cannot|no such/i.test(line));
      if (inspectNoise.length) warnings.push(`容器 IP 查询失败：${inspectNoise[0].trim().slice(0, 200)}`);
      for (const container of needIpLookup) {
        const text = `${container.name} ${container.image}`;
        const isLlama = /llama/i.test(text) && !/ollama/i.test(text);
        const backend: InferenceBackend = isLlama ? requested : "ollama";
        const ip = ipByName.get(container.name) ?? ipByName.get(container.id);
        if (!ip) continue;
        const source = `容器 ${container.name} · ${container.image}${container.id ? ` (${container.id.slice(0, 8)})` : ""}`;
        // 容器内的 Ollama 默认监听 11434；llama.cpp 容器端口不可知，只能按容器 IP + 默认表试。
        const ports = isLlama ? DEFAULT_LLAMACPP_PORTS.slice(0, 3) : [11434];
        for (const port of ports) pushCandidate({ backend, host: ip, port, deployment: "docker", image: container.image, source: `${source} · 容器 IP ${ip}` });
      }
    }

    // 2) 进程/监听表反推的端口（不猜端口的关键一步）。
    if (!remote) {
      const discoveredOllama = inferOllamaPorts(processes, listening);
      const discoveredLlama = inferLlamaPorts(processes, listening);
      for (const port of inferredPortsFor(requested, discoveredOllama, discoveredLlama)) {
        const owner = listening.find((item) => item.port === port);
        const argv = owner?.pid !== undefined ? processByPid.get(owner.pid) : undefined;
        pushCandidate({
          backend: requested,
          host: requestedHost ?? normalizeBindHost(owner?.bind),
          port,
          deployment: "native",
          source: owner?.pid !== undefined ? `监听端口 · 进程 ${owner.process ?? "未知"} (pid ${owner.pid})` : "监听端口",
          argv,
        });
      }
    }

    // 3) 用户手填的端口/主机。
    if (requestedPort) {
      pushCandidate({ backend: requested, host: requestedHost ?? "127.0.0.1", port: requestedPort, deployment: "native", source: "连接表单手动指定", argv: undefined });
    }

    // 4) 默认候选端口。指定了远程主机时（openai-compatible），不再做本机枚举。
    if (!remote) {
      const defaults = isOpenAiCompatibleBackend(requested) ? DEFAULT_LLAMACPP_PORTS : DEFAULT_OLLAMA_PORTS;
      for (const port of defaults) {
        const owner = listening.find((item) => item.port === port);
        const argv = owner?.pid !== undefined ? processByPid.get(owner.pid) : undefined;
        pushCandidate({ backend: requested, host: requestedHost ?? "127.0.0.1", port, deployment: "native", source: owner ? `默认候选端口 · 已被 ${owner.process ?? "进程"} 占用` : "默认候选端口", argv });
      }
    }

    const unique = uniqueCandidates(candidates);
    // 同 id 的候选保留**第一条**：docker / 监听表反推的来源描述比「默认候选端口」更有信息量。
    const seedById = new Map<string, CandidateSeed>();
    for (const seed of candidates) if (!seedById.has(seed.id)) seedById.set(seed.id, seed);

    /* ---- 逐个探测：全部保留结果，不再 first-match-return -------------------- */
    const endpoints: ProbeEndpoint[] = [];
    for (const candidate of unique) {
      const id = endpointId(candidate.backend, candidate.host, candidate.port);
      const seed = seedById.get(id);
      const startedAt = Date.now();
      const base = {
        id,
        backend: candidate.backend,
        host: candidate.host,
        port: candidate.port,
        deployment: candidate.deployment,
        source: seed?.source ?? (candidate.deployment === "docker" ? "Docker 容器" : "候选端口"),
      };
      try {
        const endpoint = isOpenAiCompatibleBackend(candidate.backend)
          ? await this.probeOpenAi(base, seed?.argv, gpuVendor)
          : await this.probeOllama(base, candidate.image);
        endpoints.push({ ...endpoint, elapsedMs: Date.now() - startedAt });
      } catch (error) {
        endpoints.push({ ...base, ok: false, detail: errorMessage(error), models: [], elapsedMs: Date.now() - startedAt });
      }
    }

    /* ---- 失败原因无条件并入 warnings（V2.4 里被 return 绕过，用户什么都看不到） -- */
    const failed = endpoints.filter((endpoint) => !endpoint.ok);
    const succeeded = endpoints.filter((endpoint) => endpoint.ok);
    for (const endpoint of failed) {
      warnings.push(`${endpoint.id}（${endpoint.source}）不可达：${endpoint.detail}`);
    }

    const selected = selectDefaultEndpoint(endpoints);
    if (selected) await this.fillVersion(selected);
    if (!selected) {
      const family = isOpenAiCompatibleBackend(requested) ? (requested === "openai-compatible" ? "OpenAI 兼容（远程）" : "llama.cpp（OpenAI 兼容）") : "Ollama";
      const availability = llamaBinary || dockerContainers.some((container) => /llama/i.test(`${container.name} ${container.image}`) && !/ollama/i.test(`${container.name} ${container.image}`))
        ? "已找到 llama.cpp 相关程序/容器"
        : "未找到 llama-server 程序或相关容器";
      warnings.push(
        requested === "ollama"
          ? `未检测到可访问的 Ollama API 端点（已试 ${endpoints.length} 个候选：${endpoints.map((endpoint) => endpoint.port).join(", ")}）。请确认 Ollama 正在运行、监听地址可被本机访问，或在「推理 API 端口」里显式指定端口。`
          : `未检测到可访问的 ${family} 端点（已试 ${endpoints.length} 个候选：${endpoints.map((endpoint) => endpoint.port).join(", ")}）。${availability}；如服务使用 API Key，请填写「API Key」后重试，或在「推理 API 端口」里显式指定。`,
      );
      return {
        backend: undefined, deployment: "not-found", binary: "unknown", apiHost: requestedHost ?? "127.0.0.1",
        apiPort: requestedPort ?? (isOpenAiCompatibleBackend(requested) ? DEFAULT_LLAMACPP_PORTS[0] : DEFAULT_OLLAMA_PORTS[0]),
        gpuVendor, gpuModels, installedModels: [], warnings, systemInfo,
        preference: requested, endpoints, acceleration: undefined,
      };
    }

    /* ---- 多端点冲突提示：模型清单不一致时明确告知选中了哪个 ------------------ */
    if (succeeded.length > 1) {
      const counts = new Set(succeeded.map((endpoint) => endpoint.models.length));
      if (counts.size > 1) {
        warnings.push(
          `检测到 ${succeeded.length} 个可用端点且模型清单不一致（${succeeded.map((endpoint) => `${endpoint.port}→${endpoint.models.length} 个`).join("，")}）；已默认选用 ${selected.id}（模型最多），可在下方「候选端点」里手动切换。`,
        );
      } else {
        warnings.push(`检测到 ${succeeded.length} 个可用端点，模型清单一致；已默认选用 ${selected.id}，可在下方「候选端点」里手动切换。`);
      }
    }
    // 有模型在跑却落在 CPU 上：这是「选了 rocm 其实没加速」的真实信号。
    if (selected.acceleration?.mode === "cpu" && (gpuVendor === "amd" || gpuVendor === "nvidia")) {
      warnings.push(`端点 ${selected.id} 上已加载的模型没有进入显存（${selected.acceleration.detail}），当前推理实际跑在 CPU 上；请检查该容器的 --device /dev/dri 与 /dev/kfd 挂载或服务启动参数。`);
    }

    return {
      backend: selected.backend,
      deployment: selected.deployment,
      binary: backendBinary(selected.backend),
      apiHost: selected.host,
      apiPort: selected.port,
      version: selected.version,
      gpuVendor,
      gpuModels,
      installedModels: selected.models,
      warnings,
      systemInfo,
      preference: requested,
      endpointId: selected.id,
      endpoints,
      acceleration: selected.acceleration,
    };
  }

  private async probeOllama(base: Omit<ProbeEndpoint, "ok" | "detail" | "models">, image?: string): Promise<ProbeEndpoint> {
    // 每个端点只发 2 个请求（/api/tags + /api/ps）；版本等信息合并到选中端点后再补取，
    // 因为实测每个隧道请求约 2s，端点越多越要省。
    const tags = await this.ssh.requestJson<{ models?: ApiModel[] }>({ host: base.host, port: base.port, path: "/api/tags", timeoutMs: 10_000 });
    const models = modelNames(tags.models);
    const hint = image?.match(/rocm|cuda|vulkan/i)?.[0].toLowerCase();
    let acceleration: AccelerationInfo;
    try {
      const ps = await this.ssh.requestJson<{ models?: OllamaPsModel[] }>({ host: base.host, port: base.port, path: "/api/ps", timeoutMs: 8_000 });
      acceleration = accelerationFromOllamaPs(ps.models, hint);
    } catch (error) {
      acceleration = { mode: "unknown", detail: `无法读取 /api/ps 判定显存占用：${errorMessage(error)}` };
    }
    return {
      ...base,
      ok: true,
      models,
      acceleration,
      detail: `${models.length} 个模型 · ${acceleration.mode === "gpu" ? "显存已占满" : acceleration.mode === "cpu" ? "未使用显存" : "加速未判定"}`,
    };
  }

  /** 只为最终选中的端点补取版本号（多一个请求换一条关键信息，不值得给每个端点都发）。 */
  private async fillVersion(endpoint: ProbeEndpoint): Promise<void> {
    if (endpoint.backend !== "ollama" || endpoint.version) return;
    try {
      const version = await this.ssh.requestJson<{ version?: string }>({ host: endpoint.host, port: endpoint.port, path: "/api/version", timeoutMs: 5_000 });
      if (version.version) {
        endpoint.version = version.version;
        endpoint.detail = `${endpoint.models.length} 个模型 · 版本 ${version.version}`;
      }
    } catch {
      // 版本号只是展示信息，取不到不影响评测。
    }
  }

  private async probeOpenAi(base: Omit<ProbeEndpoint, "ok" | "detail" | "models">, argv: string | undefined, gpuVendor: GpuVendor): Promise<ProbeEndpoint> {
    const response = await this.ssh.requestJson<{ data?: ApiModel[] }>({ host: base.host, port: base.port, path: "/v1/models", timeoutMs: 10_000 });
    const models = modelNames(response.data);
    const acceleration = accelerationFromArgv(argv, gpuVendor);
    return {
      ...base,
      ok: true,
      models,
      acceleration,
      detail: `${models.length} 个模型 · OpenAI 兼容 /v1/models`,
    };
  }

  private async execPrivileged(command: string, timeoutMs = 30_000) {
    const session = this.ssh as SshSession & { execPrivileged?: SshSession["execPrivileged"] };
    if (typeof session.execPrivileged === "function") return session.execPrivileged.call(this.ssh, command, timeoutMs);
    return this.ssh.exec(command, timeoutMs);
  }

  private async execDocker(command: string, timeoutMs = 30_000) {
    // Docker 通常需要 sudo；沿用宿主环境的只读提权，不修改任何配置。
    return this.execPrivileged(command, timeoutMs);
  }
}

/** 把反推出来的端口按当前协议族筛选：llama 进程的端口给 OpenAI 家族用，反之亦然。 */
function inferredPortsFor(preference: BackendPreference, ollamaPorts: number[], llamaPorts: number[]): number[] {
  return isOpenAiCompatibleBackend(preference) ? llamaPorts : ollamaPorts;
}
