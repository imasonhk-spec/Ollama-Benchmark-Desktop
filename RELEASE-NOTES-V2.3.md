# Ollama Benchmark 桌面端 — V2.3 发布说明

> 版本：`2.3.0`　|　产品名：`Ollama Benchmark_V2.3`　|　构建日期：2026-08-22
> 升级路径：V2.2 → V2.3（安装器会自动清理 V2.0 / V2.1 / V2.2 的旧 exe 与快捷方式）

---

## 1. 本次变更要点

在原有 `ollama` / `ollama-rocm` / `llama.cpp` 三种推理后端的基础上，**新增两种 `llama.cpp` GPU 后端变体**，使工具现在支持 **5 种** 推理后端：

| # | 后端值（InferenceBackend） | 显示名（连接页下拉） | API 端点 | 加速方式 |
|---|---------------------------|----------------------|----------|----------|
| 1 | `ollama` | Ollama | `:11434` Ollama HTTP API | CPU / 通用 |
| 2 | `ollama-rocm` | Ollama (ROCm · AMD GPU 加速) | `:11434` Ollama HTTP API | AMD GPU (ROCm) |
| 3 | `llama.cpp` | llama.cpp | `:8080` OpenAI 兼容 `/v1/chat/completions` | CPU / 通用 |
| 4 | `llama.cpp-rocm` | llama.cpp (ROCm · AMD GPU) | `:8080` OpenAI 兼容 | AMD GPU (ROCm/HIP) |
| 5 | `llama.cpp-vulkan` | llama.cpp (Vulkan · 跨 GPU) | `:8080` OpenAI 兼容 | 任意 GPU (Vulkan) |

两种新后端均为 `llama.cpp`（`llama-server`）的 GPU 加速形态，**复用同一套 OpenAI 兼容接口与探测/压测/能力/高级场景逻辑**，仅在探测阶段根据 GPU 厂商与运行环境做差异化校验与告警。

---

## 2. 代码改动清单

| 文件 | 改动 |
|------|------|
| `src/shared/types.ts` | 扩展 `InferenceBackend` / `BackendPreference` 联合类型至 5 种；`BACKEND_LABELS` / `BACKEND_OPTIONS` 增加两项；新增 `isLlamaCppBackend()` 助手；`defaultModelsForBackend()` 对全部 3 种 llama.cpp 系列返回 `.gguf` 默认模型 |
| `src/shared/schemas.ts` | `sshConfigSchema.backendPreference` 枚举同步扩展至 5 种（连接配置校验） |
| `src/main/ssh/OllamaProbe.ts` | 探测候选生成、GPU 厂商过滤、候选循环统一用 `isLlamaCppBackend()`；新后端返回各自 `backend` 值；`llama.cpp-rocm` 无 AMD GPU / `llama.cpp-vulkan` 无 GPU 时给出针对性告警；`not-found` 与 `fallbackPort` 覆盖全部 5 种；清理历史死代码 |
| `src/main/benchmark/BenchmarkRunner.ts` | `backend === "llama.cpp"` 改为 `isLlamaCppBackend(backend)`，3 种 llama.cpp 后端统一走 `/v1/chat/completions` |
| `src/main/advanced/ScenarioClient.ts` | 同上，高级场景推理统一适配 llama.cpp 系列 |
| `src/main/capability/CapabilityRunner.ts` | 同上，能力评测统一适配 llama.cpp 系列 |
| `src/renderer/App.tsx` | 连接页「推理后端」下拉新增 `llama.cpp (ROCm · AMD GPU)` 与 `llama.cpp (Vulkan · 跨 GPU)` 两项，并补充说明文字 |
| `build/installer.nsh` | `customInstall` 宏新增 V2.1 / V2.2 旧 exe 与快捷方式清理，确保升级不留陈旧产物 |
| `scripts/sync-branding.mjs` | 版本号仍由该脚本从 `package.json` 自动同步至 `electron-builder.yml` / 窗口标题 / HTML 标题（V2.3 已同步） |

> **设计要点**：新增的 `llama.cpp-rocm` / `llama.cpp-vulkan` 与既有 `llama.cpp` 共享 OpenAI 兼容调用路径，因此压测、能力评测、高级场景三大引擎**无需为每个 GPU 后端重复实现**，而是通过 `isLlamaCppBackend()` 统一分支——既覆盖全部后端，又避免代码膨胀。

---

## 3. 测试方案（覆盖全部 5 种后端，逐后端验证）

测试在本地 CI 中执行：`npm run typecheck` + `npm test`（Vitest）。新增/扩展的测试**对每个后端分别断言**，而非只验证“能不能跑”。

### 3.1 后端注册表与校验（新增 `src/shared/backends.test.ts`）
- `BACKEND_OPTIONS` 恰好为 5 项，且与类型联合一致；
- `BACKEND_LABELS` 覆盖全部 5 种后端；
- `isLlamaCppBackend()` 对 `llama.cpp` / `llama.cpp-rocm` / `llama.cpp-vulkan` 返回 `true`，对 `ollama` / `ollama-rocm` 返回 `false`；
- `defaultModelsForBackend()`：3 种 llama.cpp 后端均返回 `.gguf` 默认模型，Ollama 系列返回 Ollama 风格默认模型；
- `sshConfigSchema` 接受全部 5 种 `backendPreference`，拒绝非法值。

### 3.2 探测逻辑逐后端验证（扩展 `src/main/ssh/OllamaProbe.test.ts`）
对 **5 种 `preference` 各写独立用例**，断言探测返回正确的 `backend` 值、API 族（Ollama HTTP vs OpenAI 兼容）、二进制与端口：

| 测试用例 | 注入环境 | 期望 `backend` | 期望端口/接口 |
|----------|----------|----------------|---------------|
| `ollama` | `command -v ollama` 命中，`:11434` 存活 | `ollama` | 11434 / Ollama API |
| `ollama-rocm` | `command -v ollama-rocm` 命中，`:11434` 存活 | `ollama-rocm` | 11434 / Ollama API |
| `llama.cpp` | `command -v llama-server` 命中，`:8080/v1/models` 存活 | `llama.cpp` | 8080 / OpenAI 兼容 |
| `llama.cpp-rocm` | 同上（ROCm 环境） | `llama.cpp-rocm` | 8080 / OpenAI 兼容 |
| `llama.cpp-vulkan` | 同上（Vulkan 环境） | `llama.cpp-vulkan` | 8080 / OpenAI 兼容 |

并新增 GPU 告警分支用例：
- `llama.cpp-rocm` 在 **无 AMD GPU** 的服务器上探测 → 返回 `warnings` 含“未检测到 AMD GPU”；
- `llama.cpp-vulkan` 在 **无任何 GPU** 的服务器上探测 → 返回 `warnings` 含“未检测到可用 GPU”。

### 3.3 压测引擎逐后端验证（扩展 `src/main/benchmark/BenchmarkRunner.test.ts`）
- `ollama` / `ollama-rocm` → 断言走 `/api/generate`；
- `llama.cpp` / `llama.cpp-rocm` / `llama.cpp-vulkan` → 断言三者**均**走 `/v1/chat/completions`（OpenAI 兼容），token 统计与吞吐计算一致。

### 3.4 默认模型建议（扩展 `src/renderer/BenchmarkConfigPage.selection.test.ts`）
- 5 种后端各自的 `defaultModelsForBackend()` 结果符合预期（llama.cpp 系列返回 `.gguf`，Ollama 系列返回 Ollama 风格）。

### 3.5 目标校验（`scripts/verify-package-target.mjs`）
- 构建产物 `win-unpacked\Ollama Benchmark_V2.3.exe` 存在；
- 无 `Ollama Benchmark_V2.2.exe` 等旧版本残留；
- 主进程资源标题为 `Ollama Benchmark_V2.3-明松Mason`；
- 无嵌套 `out/out` 目录（避免混入旧资源）。

### 3.6 执行结果
- `npm run typecheck`：**通过**（0 错误）
- `npm test`：**104 个用例全部通过**（含上述新增/扩展用例）
- `npm run verify:package-target`：**通过**

---

## 4. 交付物

| 产物 | 路径 / 说明 |
|------|------------|
| 安装包（可执行 exe 安装文件） | `Ollama Benchmark_V2.3-Setup.exe`（NSIS 安装器，安装后生成 `Ollama Benchmark_V2.3.exe`） |
| 完整源码包 | `Ollama-Benchmark-Source-V2.3.zip`（含 `src/`、`scripts/`、`build/`、`electron-builder.yml`、`package.json` 等，已排除 `node_modules`/`out`/`dist`/日志） |
| 本发布说明 | `RELEASE-NOTES-V2.3.md` |

> 源码包即为「完整源码」，拿到后按 `npm install && npm run prebuild && npm run build && npm run dist` 即可在本地复现安装包（需 Node 与 Electron 43 构建环境）。

---

## 5. 升级与安装注意

1. 直接运行 `Ollama Benchmark_V2.3-Setup.exe`，安装器会自动清理 V2.0 / V2.1 / V2.2 的旧 exe 与开始菜单/桌面快捷方式。
2. 连接页「推理后端」下拉现在含 5 项；选择 `llama.cpp (ROCm)` 或 `llama.cpp (Vulkan)` 前，请确认服务器已启动对应 GPU 加速的 `llama-server`（默认监听 `:8080`）。
3. 若服务器仅安装普通 `llama.cpp` 而无 GPU 加速，仍可选 `llama.cpp`；工具会在无 GPU 时给出告警但不阻断。
