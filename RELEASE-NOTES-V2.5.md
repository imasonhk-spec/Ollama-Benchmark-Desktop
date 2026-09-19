# Ollama Benchmark 桌面端 — V2.5 发布说明

> 版本：`2.5.0`　|　产品名：`Ollama Benchmark_V2.5`　|　构建日期：2026-09-19
> 升级路径：V2.4 → V2.5（安装器会自动清理 V2.0 / V2.1 / V2.2 / V2.3 / V2.4 的旧 exe 与快捷方式）

---

## 1. 为什么要改：一个真实事故

2026-09-18 在一台 AMD Strix Halo 服务器（Ryzen AI MAX+ 395 + Radeon 8060S + 124 GB）上
连接时，界面显示后端为 **`ollama-rocm`**，但模型列表**只有一个 `qwen3.8:27b`**——
服务器上实际有 4 个 Ollama 实例、25 个模型。

根因不在服务器，在探测代码：

```ts
// 旧逻辑（V2.4）
if (/rocm/i.test(discovery)) return { backend: "ollama-rocm", ... };  // ← 首个命中即 return
```

`/rocm/i` 匹配到的是 **Docker 镜像名 `ollama/ollama:rocm`**，与「哪个端点可用」毫无关系。
一旦命中就 `return`，后面所有端点的探测被跳过。

这个 bug 暴露了三个设计错误，V2.5 逐个修掉：

| # | 设计错误 | V2.5 的做法 |
|---|----------|-------------|
| 1 | 后端选项里混了**加速实现**（rocm/cuda/vulkan） | 选项只表达**协议族**，加速改为**实测结果** |
| 2 | 探测**首个命中即返回** | 枚举**全部候选端点**，列表返回，用户选 |
| 3 | 失败原因被丢弃 | 每个端点的失败原因**无条件写入 `warnings`** |

---

## 2. 本次变更要点

| # | 变更 | 解决什么问题 |
|---|------|--------------|
| 1 | **推理后端 = 三个协议族** | `Ollama` / `llama.cpp·OpenAI 兼容` / `OpenAI 兼容·远程+Key`。不再让用户猜「服务器装的是哪个加速版 Ollama」 |
| 2 | **加速方式从选项变成实测** | 曾经选错下拉框就能让报告「看起来」跑在 ROCm 上；现在读 `/api/ps` 的 `size_vram/size` 与 `llama-server` 的 `--n-gpu-layers` 实测 |
| 3 | **端点全枚举，不再首个命中即返回** | 修掉上面那个 25 个模型只显示 1 个的事故 |
| 4 | **失败原因全部浮出** | 每个端点的拒绝/超时/状态码带端口号进警告，环境页可展开 |
| 5 | **llama.cpp 端口从进程+监听表反推** | 不再猜端口；默认候选补上 `8082`（llama-swap） |
| 6 | **恢复 `apiHost` / `apiKey`** | 支持带鉴权的远程 OpenAI 兼容端点（`Authorization: Bearer`） |
| 7 | **修复 `llamaAvailable` 子串误判** | `includes("llama")` 把 `ollama-host` 判成 llama.cpp |
| 8 | **修复 GPU 识别正则词序** | `amd.*vga\|amd.*display` 在 Strix Halo 上匹配不到，词序写反了 |
| 9 | **探测耗时 68s → 40s** | 16 条系统命令合并为 2 条批量命令，省下 14 次 SSH 通道建立 |

---

## 3. 后端选项：从「猜镜像」到「选协议」

### 3.1 新的三个选项

| 选项 | 对应服务 | 说明（界面提示原文） |
|------|----------|----------------------|
| `Ollama` | 原生 Ollama、`ollama-*` 加速镜像、Ollama Docker | 枚举服务器上全部 Ollama 实例（11434 以及容器映射到 11435/11437/11438 等端口），逐个实测可用性、模型清单与显存占用，再由你确认使用哪一个 |
| `llama.cpp · OpenAI 兼容` | `llama-server`、llama-swap | 探测 llama-server / llama-swap / llama.cpp 的 OpenAI 兼容端点，候选端口由进程启动参数与监听表反推（含 8082 llama-swap），不靠猜端口 |
| `OpenAI 兼容 · 远程服务` | vLLM、LM Studio、远程网关 | 连接任意 OpenAI 兼容服务：填写推理服务主机、端口与 API Key；留空主机则按默认端口在本机枚举 |

### 3.2 旧配置仍可读

`LEGACY_BACKEND_ALIASES` 把 V2.4 及更早的选项值归一化，旧配置文件与历史结果不会读不出来：

```ts
export const LEGACY_BACKEND_ALIASES: Record<string, BackendPreference> = {
  "ollama-rocm": "ollama",
  "llama.cpp-rocm": "llama.cpp",
  "llama.cpp-vulkan": "llama.cpp",
};
```

若旧值是「自动检测」或未知值，回退到 `ollama`。

### 3.3 协议族与能力的对应

```ts
isLlamaCppBackend(b)       // 仅当 b === "llama.cpp"
isOpenAiCompatibleBackend(b)  // b === "llama.cpp" || b === "openai-compatible"
```

区别很重要：**llama.cpp 和远程兼容服务走的是同一套 HTTP 协议**（`/v1/models`、
`/v1/chat/completions`），所以运行时（BenchmarkRunner / CapabilityRunner /
ScenarioClient）统一用 `isOpenAiCompatibleBackend` 判断，而「是不是本地 llama.cpp」
只在**探测阶段**（端口反推、二进制识别）才关心。

---

## 4. 加速实测：让结论无法被人为选错

### 4.1 四级判定

```ts
export type AccelerationMode = "gpu" | "partial" | "cpu" | "unknown";
```

| mode | 界面/报告措辞 |
|------|---------------|
| `gpu` | GPU 加速 |
| `partial` | 部分卸载（GPU + 内存混合） |
| `cpu` | CPU 推理 |
| `unknown` | 未判定 |

### 4.2 两条实测路径

**路径 A — Ollama 端点，直接量显存占比**（优先级最高）

读 `/api/ps` 里已加载模型的 `size_vram / size`：

- 比值 ≥ 0.9 → `gpu`
- 0.1 ~ 0.9 → `partial`
- < 0.1 → `cpu`
- `size` 为 0（无模型驻留或数据不可信）→ `unknown`

`detail` 字段原文回显测量值，便于复核：

```text
/api/ps：size_vram 25.7 GB / 25.7 GB（100%）
```

**路径 B — llama.cpp 端点，读启动参数**

解析 `llama-server` 进程命令行的 `--n-gpu-layers` / `-ngl`：

- 层数 ≥ 极大值（全部卸载）→ `gpu`
- 层数 > 0 → `partial`
- 层数为 0 或无参数 → `cpu`

报告里以**「加速实测」**一行呈现，与「模型」「端点」并列。这一行不可由用户设置——
这是刻意的：一份基准报告不应该因为下拉框选错而失真。

---

## 5. 端点枚举：不再首个命中即返回

### 5.1 候选端口

```ts
export const DEFAULT_OLLAMA_PORTS   = [11434, 11435, 11437, 11438];
export const DEFAULT_LLAMACPP_PORTS = [8082, 8080, 8000, 10000, 8081, 1234];
```

`8082` 是 llama-swap 的常见端口，之前不在列表里，导致用 llama-swap 的部署完全探不到。

### 5.2 端口反推，不是猜

```ts
inferOllamaPorts(processes, listening)  // 从进程名 + 监听表求交集
inferLlamaPorts(processes, listening)   // 同上，但显式排除 "ollama" 进程
```

`inferLlamaPorts` 里有一处关键排除：**进程名含 `ollama` 的不算 llama.cpp 端点**。
这正是第 7 条 bug 的同类问题——`ollama-host` 之类的名字会污染 llama.cpp 的候选集。

### 5.3 探测流程

```text
connect()
  ├─ 1 条 SYSTEM_PROBE_COMMAND  → 监听表 / 进程表 / 二进制 / GPU / OS / 内存
  ├─ 1 条 DOCKER_PROBE_COMMAND  → 容器清单（含 __EXIT__<code> 区分无权限与无 docker）
  ├─ 批量 dockerInspectCommand() → 一次拿回全部容器 IP
  ├─ 逐端点探测（全部候选，不短路）
  │    ├─ Ollama：/api/tags（模型清单）+ /api/ps（显存占用）
  │    └─ OpenAI 兼容：/v1/models
  └─ 返回 endpoints[]：成功的 + 失败的全部保留
```

`selectDefaultEndpoint()` 的挑选顺序：**模型数最多 → 加速状态最优 → 端口号最小**。
`applyEndpoint()` 供用户在环境页手动切换，`/api/version` 只在**选定端点上懒查一次**，
不再对每个候选端口各发一次（这是 40s 里的可观一笔）。

### 5.4 失败原因全部保留

```ts
export type ProbeEndpoint = {
  id: string;          // `family:host:port`，UI 用它切换端点
  // ... reachable / port / models / acceleration ...
};
```

成功与失败的端点都在 `endpoints[]` 里。失败行在环境页标出原因，同时写入 `warnings`：

- 连接被拒 → 端口没起
- 超时 → 被防火墙拦
- 返回 HTML 而非 JSON → **端口被别的服务占用**（`describeHttpFailure()` 会识别并给出这句提示）
- 401 / 403 → Key 缺失或错误
- 404 → 路径不对（可能是别的 HTTP 服务）

---

## 6. 代码改动清单

### 6.1 类型与协议（`src/shared/`）

| 文件 | 改动 |
|------|------|
| `types.ts` | `InferenceBackend` 改为三协议族；新增 `LEGACY_BACKEND_ALIASES`、`normalizeBackendPreference()`、`isOpenAiCompatibleBackend()`；`BACKEND_LABELS` / `BACKEND_HINTS` / `BACKEND_OPTIONS`；新增 `AccelerationMode` / `AccelerationInfo` / `accelerationLabel()` / `ProbeEndpoint`；`SshConfig` 增加 `apiHost` / `apiKey`；`OllamaEnvironment` 增加 `preference` / `endpointId` / `endpoints` / `acceleration` |
| `schemas.ts` | `backendPreferenceSchema` 接受 V2.4 旧值 + 新值；`sshConfigSchema` 增加 `apiHost` / `apiKey` |
| `ipc.ts` | `BenchmarkApi` 增加 `useEndpoint` |

### 6.2 探测（`src/main/ssh/`）

| 文件 | 改动 |
|------|------|
| `OllamaProbe.ts` | `detect()` 重写：2 条批量命令 + 分段解析；纯函数拆分（`parseMarkedSections` / `parseDockerSection` / `parseContainerIps` / `parseListeningPorts` / `parseProcesses` / `inferOllamaPorts` / `inferLlamaPorts` / `classifyGpu` / `accelerationFromOllamaPs` / `accelerationFromArgv` / `selectDefaultEndpoint` / `applyEndpoint`） |
| `SshSession.ts` | `requestedApiHost` / `requestedApiKey`；`authHeaders()` 注入 `Authorization: Bearer`；非 JSON 响应累积样本并走 `describeHttpFailure()`；导出 `describeHttpFailure()` |

### 6.3 运行时与报告（`src/main/`）

| 文件 | 改动 |
|------|------|
| `ipc/connection.ipc.ts` | `connect` 先归一化再探测；不再因「未找到」抛错，改为返回带 `endpoints` 的环境；新增 `connection:use-endpoint` |
| `benchmark/BenchmarkRunner.ts`、`capability/CapabilityRunner.ts`、`advanced/ScenarioClient.ts` | `isLlamaCppBackend` → `isOpenAiCompatibleBackend` |
| `reports/ReportExporter.ts`、`CapabilityReportExporter.ts`、`AdvancedReportExporter.ts` | 报告增加「加速实测」行（`accelerationLabel(env.acceleration)`） |

### 6.4 界面（`src/renderer/`）

| 文件 | 改动 |
|------|------|
| `App.tsx` | 连接表单增加 `apiHost` / `apiKey`；后端下拉改为 `BACKEND_OPTIONS` + 提示文案；`EnvironmentPanel` 重写：命中端点 / 加速实测 / 候选端点表格 + 手动切换；`deployment === "not-found"` 时禁止进入配置页；探测中显示「正在枚举端点…」与「约需 30–60 秒」提示 |
| `styles.css` | 新增 `.acc-gpu` / `.acc-partial` / `.acc-cpu` / `.acc-unknown`、`.endpoint-failed` |
| `preload/index.ts` | 暴露 `useEndpoint` |

### 6.5 测试

| 文件 | 说明 |
|------|------|
| `src/shared/backends.test.ts` | 重写：协议族归一化、旧值别名、`isOpenAiCompatibleBackend` |
| `src/main/ssh/OllamaProbe.test.ts` | 重写：用 `probeOutput()` / `dockerOutput()` 桩模拟 2 条批量命令的输出 |
| `src/main/ssh/OllamaProbe.permissions.test.ts` | 权限分支（无 sudo / 无 docker） |
| `src/main/ssh/OllamaProbe.live.test.ts` | **新增**，`OLLAMA_LIVE=1` 门控，对真实服务器端到端探测；拿不到服务器时 skip |
| `BenchmarkConfigPage.selection.test.ts`、`BenchmarkRunner.test.ts` | 适配新后端枚举 |

**测试结果：171 passed / 2 skipped（25 个测试文件通过，1 个 live 文件按门控跳过）。**

---

## 7. 性能：68s → 40s

在一台跨 Tailscale 的远端服务器上实测出两个常数：

| 操作 | 实测耗时 |
|------|----------|
| 开一个 SSH 通道（`exec`） | **≈ 2.4 s** |
| 每个隧道 HTTP 请求 | **≈ 2.0 s** |

原实现把 16 条系统命令**逐条 exec**——光建通道就 40 s，加上 12 次隧道请求，总计 68 s。

优化后：

- 16 条系统命令 → **1 条** `SYSTEM_PROBE_COMMAND`，用 `__MARKER__` 分段，回本地再切
- Docker 相关 → **1 条** `DOCKER_PROBE_COMMAND`（用 `__EXIT__<code>` 区分真失败与「没装 docker」）
- 容器 IP → **1 次** 批量 `docker inspect`
- 每端点的 API 调用 → `/api/tags` + `/api/ps` 两次；`/api/version` 改为选定端点后懒查

**结果：40 s**（通道开销从 16 次降到 2 次，占总耗时的大头被消掉）。

`OllamaProbe.live.test.ts` 会对这条耗时做端到端验证，因此这个数字不是估算。

---

## 8. 升级与验证

### 8.1 安装

安装器包含 V2.4 → V2.5 的清理块（`build/installer.nsh`），会删除旧 exe 与快捷方式：

```nsis
; Remove the previous V2.4 build (V2.4 -> V2.5 upgrade).
Delete "$INSTDIR\Ollama Benchmark_V2.4.exe"
Delete "$DESKTOP\Ollama Benchmark_V2.4.lnk"
Delete "$SMPROGRAMS\Ollama Benchmark_V2.4.lnk"
RMDir /r "$SMPROGRAMS\Ollama Benchmark_V2.4"
```

### 8.2 建议的首次验证

1. 用 `Ollama` 协议连目标服务器，确认列出 **4 个端点**（11434 / 11435 / 11437 / 11438）；
2. 看默认选中的是不是**模型数最多**的那个（11434，25 个模型）；
3. 确认「加速实测」显示 **GPU 加速**，`detail` 里显存占比接近 100%；
4. 展开警告区，确认 11435 / 11437 / 11438 的失败/差异原因都有端口号说明；
5. 手动切到另一个端点，确认模型列表与版本重新读取；
6. 用 `llama.cpp · OpenAI 兼容` 再连一次，确认候选端口里包含 8082。

### 8.3 回归命令

```powershell
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # electron-vite build（prebuild 会同步品牌到 V2.5）
npm run package     # electron-builder --win nsis
npm run verify:package-target
```

> 打包时若已存在旧 `win-unpacked`，`verify:package-target` 会因残留的
> `Ollama Benchmark_V2.4.exe` 报错——这是**预期行为**，说明用了非干净输出目录。
> 请指定全新的输出目录（如 `--config.directories.output=D:/ob-out-v25`）重新打包。

---

## 9. 已知限制

- **`partial` 判定的阈值是经验值**。显存占比的分档（0.9 / 0.1）在 Strix Halo 的统一内存
  架构上可能偏保守——iGPU 与内存共享物理颗粒，`size_vram` 的语义在部分驱动版本下
  不完全可靠。若你在此类机器上看到 `partial` 但实际是全量卸载，请把 `/api/ps` 的原始
  输出反馈给我，据此调阈值。
- **非 Ollama、非 llama-server 的服务拿不到精确显存占比**。远程 OpenAI 兼容端点只能
  从 `/v1/models` 拿到模型清单，加速状态一般是 `unknown`。
- **探测是只读的**。应用不会安装、启动、停止或修改服务器上的任何服务；Docker 相关探测
  需要 SSH 用户有 docker 权限，没有则跳过并记入警告，不影响其余端点枚举。
