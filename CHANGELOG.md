# Changelog

All notable changes to the Ollama Benchmark Desktop tool are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [2.5.0] - 2026-09-19

### Changed

- **推理后端改为「协议族」三选一** — 原来的「自动检测 / Ollama(ollama-rocm) / llama.cpp」
  无法表达真实部署。现在只问一个协议问题：**Ollama** / **llama.cpp·OpenAI 兼容** /
  **OpenAI 兼容·远程+Key**。每个选项带一行说明，写清它对应什么服务、默认端口是什么。
  这是不兼容变更：服务端检测逻辑完全相同，但选项语义变了，请按界面提示重选一次。
- **加速方式不再是用户选项，而是实测结果** — ROCm / CUDA / Vulkan / CPU 曾经是一个下拉框，
  用户选了软件也不会因此变快。现在应用自己测：优先读 `/api/ps` 的
  `size_vram / size` 比值，读不到再解析 `llama-server` 的启动参数
  （`--n-gpu-layers` / `-ngl`）。环境页显示「加速实测」：GPU / 部分卸载 / CPU / 未知。
- **端点由「首个命中即返回」改为「全部枚举后由你选」** — 这是 V2.4 那个
  「选了 ollama-rocm 却只看到 1 个模型」的根因：探测用 `/rocm/i` 匹配到
  `ollama/ollama:rocm` 镜像就立刻 return，后面所有端点被跳过。现在逐个探测
  **全部候选端口**，列出各自模型数、加速状态与端口，任何时刻都能在环境页切换。
- 默认候选端口补充 `8082`（llama-swap 常见端口），llama.cpp 端口改为**从进程命令行与
  监听表反推**，而不是猜一个端口再试。
- 连接页恢复 `apiHost` / `apiKey` 两个字段，用于「OpenAI 兼容·远程」场景
  （自动带上 `Authorization: Bearer <key>`）。

### Fixed

- **`llamaAvailable` 子串误判** — `includes("llama")` 会把 `ollama-host` 这类进程名
  判成 llama.cpp，导致环境页同时显示两个后端。改为按 token 边界匹配。
- **GPU 识别正则词序写反** — `amd.*vga|amd.*display` 在 Strix Halo 上匹配不到
  （lspci 输出是 `VGA compatible controller: AMD ...`，厂商名在后面）。
  已修正词序并过滤 `Card` 行与十六进制噪声。

### Added

- **`warnings` 无条件记录每个端点的失败原因** — 以前只在整体找不到后端时报错，
  现在每个端点的连接失败/超时/状态码都会带端口号进 `warnings`，环境页可展开查看。
- 环境页新增「命中端点」与「候选端点」表格，含手动切换按钮（`connection:use-endpoint`）。
- `/api/version` 改为**按需懒查**：只在选定端点上查一次，不再对每个候选端口各发一次。
- 新增实时集成测试 `OllamaProbe.live.test.ts`（`OLLAMA_LIVE=1` 门控），
  对真实服务器做端到端探测，跑不到服务器时自动 skip。

### Performance

- **探测耗时 68s → 40s** — 实测该服务器链路下每开一个 SSH 通道约 2.4s、
  每个隧道 HTTP 请求约 2.0s。原实现把 16 条系统命令逐条 exec，光建通道就 40s。
  现已合并为 **2 条批量命令**（`__MARKER__` 分段解析）：系统探测 1 条 + Docker 探测 1 条，
  容器 IP 也批量 inspect 一次拿回。

## [2.4.0] - 2026-09-18

### Added

- **自定义维度能力横评** — the capability evaluation is no longer limited to the
  built-in 7 dimensions. Whichever `dimension` values appear in the imported bank
  (e.g. `officeCommunication`, `officeSheet`) become the dimensions used by the
  scoring, the charts and the report. `dimensionLabel` supplies the display name.
- **Five business-scenario rule kinds** — `contains_all`, `formula`, `sql_result`,
  `json_schema` and `tool_call` (with `responseKey: tool_calls`), so scenario banks
  such as the office 8-dimension suite can be imported and scored as-is.
  `json_schema` supports nested expected objects and `null` values (meaning "this
  field genuinely cannot be confirmed — the model must output null").
- **Import is now row-tolerant** — a malformed row is skipped and reported with its
  Excel row number and reason; the rest of the bank still imports. Missing columns
  produce a single readable message instead of one error per row.
- `samples/` fixture + `scripts/extract-bank-rows.mjs` for reproducing the real
  office-bank regression test on any machine.

### Changed

- **Radar chart fidelity** — each axis is scaled by that dimension's own maximum
  score, so vertex radius equals `score ÷ dimension max`, vertices are labelled with
  their real values, and the range expands (with a diagnostic note) instead of
  silently clipping. Values on the chart now reconcile with the imported data.
- `keywords` rule now honours `maximumLength` (answers over the limit are capped at
  half score); previously only `minimumLength` was read.
- Capability reports (HTML / Markdown / DOCX) render the dynamic dimension set and
  labels instead of the hardcoded 7 dimensions.
- `maxScore` per question accepts either a 5-point or a 100-point scale (max 100).

### Fixed

- Nested JSON answers were truncated by a greedy-brace regex, breaking structured
  rules; replaced with a balanced-bracket scanner.
- A corrupted `ruleData` cell in `8维模型评测用例_办公类.xlsx` (row 36, containing
  U+FFFD and truncated) aborted the whole import; the sample file is repaired.
- `verify:package-target` now also guards against a stale previous-version
  executable; the NSIS installer removes the V2.3 build on upgrade.

## [2.3.0] - 2026-08-22

### Added

- **Two more `llama.cpp` GPU backends** — `llama.cpp-rocm` and
  `llama.cpp-vulkan`, bringing the supported inference backends to five
  (`ollama`, `ollama-rocm`, `llama.cpp`, `llama.cpp-rocm`, `llama.cpp-vulkan`).
  All three llama.cpp variants share the OpenAI-compatible `/v1/chat/completions`
  path via `isLlamaCppBackend()`, so the benchmark, capability and advanced
  scenario engines needed no per-backend duplication.

## [2.2.0] - 2026-08-15

### Changed

- **推理后端改为显式三选一** — 连接页「推理后端」下拉由「自动检测 / Ollama(ollama-rocm) / llama.cpp」改为明确的 **Ollama / Ollama (ROCm · AMD GPU 加速) / llama.cpp** 三个选项，移除「自动检测」；探测仅连接所选后端对应的候选。
- **ollama-rocm 真正驱动模型** — 选择 ollama-rocm 时，环境探测要求服务二进制确认为 `ollama-rocm`（通过 `command -v ollama-rocm` 或 rocm 标签容器镜像识别）；若仅发现普通 ollama 则明确拒绝并给出诊断，确保模型运行于 AMD/ROCm 路径以获得 GPU 加速。检测结果与报告统一记录 `backend/binary = "ollama-rocm"`，UI 与报告显示「Ollama (ROCm · AMD GPU 加速)」。
- Branding synchronized to V2.2 (product name, executable, window title, shortcuts).
- NSIS installer now also removes the previous V2.1 executable and shortcuts on upgrade.

## [2.1.0] - 2026-08-11

### Changed

- **高级场景评测页面改版** — 重排场景卡片（自定义勾选框 + 标题/描述分层）、按「并发与压测」「运行设置」分组参数区、统一间距与对齐、整体视觉协调度提升。
- **工作区状态保持** — 切换到性能测试 / 模型能力横评时，高级场景评测的配置参数、测试进度、日志与结果保持不变，后台评测任务持续运行；返回页面后完整恢复显示。
- Branding synchronized to V2.1 (product name, executable, window title, shortcuts).
- NSIS installer now also removes the previous V2.0 executable and shortcuts on upgrade.

## [2.0.0] - 2026-08-10

### Added

- **Advanced scenario evaluation** — a native TypeScript port of the `llm-bench`
  test plan (`llm-bench-2026.08`), integrated into the desktop tool's main flow
  with no Python runtime required:
  - **Latency baseline** — fixed concurrency 1, scans input×output combos and
    records TTFT / E2E / P95 / TPOT / ITL / Decode / Prefill / Overall TPS.
  - **Adaptive concurrency stress** — stepped ladder (1→2→4→…) plus binary
    refinement; each level judged by the dual threshold *success rate ≥ 99% AND
    P95-E2E ≤ baseline(P=1) × 1.5*. Recommends 50% of the confirmed maximum for
    downstream scenarios and re-measures the confirmed level over a steady window.
  - **Max-context probing** — input length ladder, first failure stops the scan.
  - **Steady-state drift** — minute-bucketed P95 drift against early buckets.
  - **Fairness analysis** — reuses concurrency samples; reports CV, max/median,
    P99/P50 and starved-request counts.
  - **Needle-in-haystack** — long-context recall across length/depth/needle grid.
  - **Degradation detection** — empty-response rate, duplicate rate, finish-reason
    mix and context-overflow flags across all captured outcomes.
  - **Report export** — Markdown / HTML / Word / PDF, with environment, per-scenario
    tables and an executive summary.
- **Quality benchmark bridge** — the plan's standard 8-benchmark package
  (ceval, cmmlu, truthful_qa, simple_qa, mmlu_pro, gpqa, gsm8k, humaneval,
  ifeval) is configured in-app and exposed as a ready-to-run `evalscope` command
  (`buildQualityBridgeCommand`), since the dataset-driven suites need external
  model datasets that are not bundled with the desktop app.
- **UI** — third workspace tab "高级场景评测" (Advanced scenario evaluation)
  alongside performance testing and capability evaluation, with scenario picker,
  key-parameter knobs, live progress/logs and report export.
- **IPC** — `advanced:run`, `advanced:cancel`, `advanced:progress` and
  `advanced-report:export` channels, plus `runAdvanced` / `cancelAdvanced` /
  `onAdvancedProgress` / `exportAdvancedReports` on the renderer API.

### Changed

- Branding synchronized to V2.0 (product name, executable, window title, shortcuts).
- NSIS installer now also removes the legacy V1.4 executable and shortcuts on upgrade.

### Migration

- No data-format breaking changes. Saved performance/capability results remain valid.
- The advanced scenarios are opt-in via the new workspace tab; the existing
  performance and capability flows are unchanged.

## [1.4.0]

- Seven-dimension capability evaluation with charts and multi-format reports.
- AMD GPU / ROCm detection improvements.
