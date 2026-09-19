# Release Notes — Ollama Benchmark V2.2

**Release date:** 2026-08-15
**Test plan version:** `llm-bench-2026.08`
**Platform:** Windows x64 (NSIS installer)

## What's new

V2.2 refines the connection flow by making the inference backend an explicit,
first-class choice instead of an auto-detected one.

### Inference backend is now an explicit three-way choice

The **推理后端（inference backend）** selector on the connection page now
offers exactly three options:

- **Ollama** — standard Ollama server (`ollama serve`) on port `11434`.
- **Ollama (ROCm · AMD GPU 加速)** — `ollama-rocm`, the ROCm build that
  offloads inference onto AMD GPUs for higher throughput.
- **llama.cpp** — `llama-server` exposing the OpenAI-compatible
  `/v1/chat/completions` endpoint.

The previous **自动检测（auto-detect）** option has been removed: the user now
decides which backend drives the run, and the probe filters candidates to that
backend only.

### `ollama-rocm` runs the model through the ROCm build

When **ollama-rocm** is selected, the environment probe now *requires* the
ROCm build:

- It only considers Ollama-API candidates (port `11434`) whose serving binary
  is confirmed to be `ollama-rocm` (detected via `command -v ollama-rocm` or a
  `rocm`-tagged container image).
- If a plain `ollama` is found where `ollama-rocm` was requested, the candidate
  is rejected with a clear diagnostic instead of silently falling back — so the
  model is guaranteed to execute on the AMD/ROCm path and benefit from GPU
  acceleration.
- The detected environment records `backend = "ollama-rocm"` and
  `binary = "ollama-rocm"`; the UI environment panel and all exported reports
  show the readable label **"Ollama (ROCm · AMD GPU 加速)"**.

`ollama` and `ollama-rocm` share the same Ollama HTTP protocol, so no request
format changes — only *which build serves the model* differs.

## Verification

- `npm run typecheck` — passes.
- `npm test` — passes (engine probe, runner and report exporter suites updated
  for the three-way backend model).
- `npm run build` — `electron-vite build` produces `out/main`, `out/preload`,
  `out/renderer`.

## Installer

- NSIS installer with installation-directory picker, desktop + start-menu
  shortcuts.
- Upgrades automatically remove legacy V1.x / V2.0 / V2.1 artifacts, so an
  upgrade never leaves a stale executable behind.

## Migration

- Saved performance and capability results remain valid; no data-format changes.
- Connection presets that previously relied on `auto` detection now default to
  **Ollama**.
