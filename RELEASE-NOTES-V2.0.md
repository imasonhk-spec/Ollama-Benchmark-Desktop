# Release Notes — Ollama Benchmark V2.0

**Release date:** 2026-08-10
**Test plan version:** `llm-bench-2026.08`
**Platform:** Windows x64 (NSIS installer)

## What's new

V2.0 integrates the `llm-bench` Python test plan into the desktop tool as a
**native TypeScript engine** — no Python runtime, no evalscope dependency. Every
scenario in the plan (A–F) now runs against the same SSH-tunneled Ollama /
llama.cpp endpoint the performance benchmarks already use.

### Advanced scenario evaluation

A new **高级场景评测** workspace tab exposes six scenarios:

| Scenario | What it measures |
| --- | --- |
| Latency 基准 | Single-request baseline across input×output combos (TTFT/E2E/P95/TPOT/ITL/Decode/Prefill/Overall TPS). |
| 并发阶梯压测 | Adaptive concurrency stress. Dual-threshold judge: **success rate ≥ 99% AND P95-E2E ≤ baseline × 1.5**. Ladder + binary search; recommends 50% of the confirmed max. |
| 最大上下文探测 | Input-length ladder; stops at the first context-overflow failure. |
| 稳态漂移 | Long steady run, minute-bucketed P95 drift. |
| 公平性分析 | Reuses concurrency samples; CV / max-over-median / P99-over-P50 / starved requests. |
| 长文本召回 | Needle-in-haystack recall across length/depth/needle grid. |

Every run also produces a **degradation report** (empty-response rate, duplicate
rate, finish-reason mix, context-overflow flags) and a multi-format report
(Markdown / HTML / Word / PDF).

### Quality benchmark bridge

The plan's standard 8-benchmark package (ceval, cmmlu, truthful_qa, simple_qa,
mmlu_pro, gpqa, gsm8k, humaneval, ifeval) is configured in-app and surfaced as a
ready-to-run `evalscope` command. The suites need external model datasets, so the
tool emits the command rather than executing it:

```bash
python -m llm_bench quality -b <baseUrl> -m <model> -k "<apiKey>" --suite standard
```

## Verification

- `npm run typecheck` — passes.
- `npm test` — **82 tests pass** (engine stats, filler, judge/autotune, diff,
  orchestrator integration, report exporters, plus the existing suites).
- `npm run build` — `electron-vite build` produces `out/main`, `out/preload`,
  `out/renderer`.

## Installer

- NSIS one-click-disabled installer, per-machine optional, desktop + start-menu
  shortcuts.
- Upgrades automatically remove legacy V1.1 / V1.2 / V1.3 / V1.4 artifacts.

## Migration

- Existing performance and capability evaluation flows are unchanged.
- Saved result files remain valid; no format changes.
