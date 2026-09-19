# Ollama Benchmark Desktop

Windows desktop tool for measuring LLM inference performance on a remote server over SSH —
plus model capability and end-to-end scenario evaluation.

All probing is **read-only**: the app never installs, starts, stops or reconfigures anything
on the target machine. It reaches the inference API through an SSH tunnel, so no port has to
be exposed to the public internet.

## Inference backends (V2.5)

The backend selector asks one protocol question, not which acceleration build you installed:

| Option | Target service | Protocol used |
| --- | --- | --- |
| `Ollama` | native Ollama, `ollama-*` images, Ollama in Docker | `/api/tags`, `/api/ps`, `/api/generate` |
| `llama.cpp · OpenAI-compatible` | `llama-server`, llama-swap | `/v1/models`, `/v1/chat/completions` |
| `OpenAI-compatible · remote` | vLLM, LM Studio, remote gateways | same, plus `Authorization: Bearer <key>` |

Everything reachable is **enumerated**, not short-circuited: every candidate port is probed and
reported with its model count, acceleration state and per-endpoint failure reason, and you can
switch endpoints at any time from the environment page.

**Acceleration is measured, not selected.** The app reads the `size_vram / size` ratio from
`/api/ps` (Ollama) or `--n-gpu-layers` from the `llama-server` command line, and classifies the
endpoint as GPU / partial offload / CPU / unknown. This is deliberate — a benchmark report
should not be able to claim GPU execution because a dropdown was set that way.

`llama.cpp` ports are derived from the process table and listening sockets rather than guessed,
so llama-swap on an unusual port is still found.

## Capabilities

- **Performance benchmark** — streaming TTFT and Decode (tok/s) measurement over SSH-forwarded
  requests; configurable models, input lengths, concurrency and rounds; progress, cancellation
  and Markdown / HTML / Word / PDF report export.
- **Capability evaluation** — dimension-driven horizontal comparison. Whichever `dimension`
  values appear in the imported bank become the dimensions used for scoring, charts and reports.
  Nine rule kinds are supported (`keywords`, `number`, `exact`, `code`, `contains_all`,
  `formula`, `sql_result`, `json_schema`, `tool_call`), with Excel question-bank import/export,
  row-tolerant import, and bar/radar charts whose vertices reconcile with the imported data.
- **Advanced scenario evaluation** — native TypeScript port of an internal `llm-bench` test plan:
  latency baseline, adaptive concurrency stress (dual-threshold judge with ladder + binary
  search), max-context probing, steady-state drift, fairness analysis, and needle-in-haystack
  long-context recall, each with degradation detection.
- **Quality benchmark bridge** — the standard benchmark package (ceval / cmmlu / truthful_qa /
  simple_qa / mmlu_pro / gpqa / gsm8k / humaneval / ifeval) is configured in-app and surfaced as
  a ready-to-run `evalscope` bridge command. Dataset benchmarks run outside the desktop app.

## Requirements

- Windows 10/11
- Node.js 20 or newer, npm
- Target server reachable over SSH, with one of the services listed above running

## Quick start

```powershell
npm install
npm run dev
```

## Verification

```powershell
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 171 passed, 2 skipped
npm run build       # electron-vite build
npm run package     # electron-builder --win nsis
```

The two skipped tests are a live end-to-end probe gated behind an environment variable, so they
are skipped unless you point them at a real server:

```powershell
$env:OLLAMA_LIVE        = "1"
$env:OLLAMA_LIVE_HOST   = "<server-host>"
$env:OLLAMA_LIVE_USER   = "<ssh-user>"
$env:OLLAMA_LIVE_PASSWORD = "<ssh-password>"
npx vitest run src/main/ssh/OllamaProbe.live.test.ts
```

It only runs read-only commands (`docker ps`, `ss`, `ps`, `lspci`) and also reports the measured
per-channel and per-request overhead of the link.

## Repository layout

```
src/
  main/       Electron main process — SSH session, probing, benchmark runners, report exporters
  preload/    contextBridge API surface
  renderer/   React UI
  shared/     types, zod schemas, question banks, scoring rules, chart geometry
scripts/      branding sync, package verification, fixture extraction
samples/      question-bank fixtures used by the regression tests
build/        NSIS installer include
```

## Notes on the sample fixture

`samples/office-bank-rows.json` is the committed fixture and is what the regression tests read.
`samples/8维模型评测用例_办公类.xlsx` is the source workbook for that fixture. The binary
workbook is not tracked in this repository; regenerate the JSON from your own workbook with:

```powershell
node scripts/extract-bank-rows.mjs
```

The scenario data in the fixture is synthetic (placeholder phone numbers, reserved
`example.com` addresses, a non-existent company name).

## License

No license is currently declared, which means all rights are reserved by the author.
