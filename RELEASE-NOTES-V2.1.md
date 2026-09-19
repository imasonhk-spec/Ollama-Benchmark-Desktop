# Release Notes — Ollama Benchmark V2.1

**Release date:** 2026-08-11
**Test plan version:** `llm-bench-2026.08`
**Platform:** Windows x64 (NSIS installer)

## What's new

V2.1 is a UI and stability refinement of the V2.0 advanced-scenario evaluation
engine. No engine logic changed — the improvements target the desktop
experience and multi-workspace workflow.

### Advanced scenario evaluation — UI refresh

The **高级场景评测** workspace tab was visually reworked:

- **Scenario cards** — whole-card clickable buttons with a custom checkbox on
  the left and a title/description stack on the right; clearer selected/hover
  states (primary-color border + soft tint + focus glow).
- **Grouped parameter knobs** — parameters are now split into *并发与压测*
  (concurrency & stress) and *运行设置* (run settings) sections, each with its
  own container and heading.
- **Consistent spacing & alignment** — unified grid rhythm, aligned numeric
  inputs and boolean toggles, compact progress/result cards.

### Workspace state persistence

Switching to **性能测试** (performance) or **模型能力横评** (capability) no
longer unmounts the advanced-scenario page. As a result:

- The advanced scenario configuration, progress, live log and results are
  preserved exactly as left.
- A running evaluation keeps executing in the background and is not interrupted
  by the tab switch.
- Returning to the **高级场景评测** tab restores the full view — config,
  progress, log and results — with no data loss.

## Verification

- `npm run typecheck` — passes.
- `npm test` — **82 tests pass** (engine stats, filler, judge/autotune, diff,
  orchestrator integration, report exporters, plus the existing suites).
- `npm run build` — `electron-vite build` produces `out/main`, `out/preload`,
  `out/renderer`.

## Installer

- NSIS installer with installation-directory picker, desktop + start-menu
  shortcuts.
- Upgrades automatically remove legacy V1.1 / V1.2 / V1.3 / V1.4 and the prior
  V2.0 artifacts, so an upgrade never leaves a stale executable behind.

## Migration

- Existing performance and capability evaluation flows are unchanged.
- Saved result files remain valid; no format changes.
