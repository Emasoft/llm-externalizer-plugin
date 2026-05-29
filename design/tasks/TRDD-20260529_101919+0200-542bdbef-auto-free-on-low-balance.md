---
trdd-id: 542bdbef-bd20-4775-8708-c4feafbbf7be
title: Auto-engage free mode when OpenRouter balance drops below $1 — fix agents-refuse bug
status: in-progress
created: 2026-05-29T10:19:19+0200
updated: 2026-05-29T11:12:00+0200
---

# TRDD-542bdbef-bd20-4775-8708-c4feafbbf7be — Auto-engage free mode when OpenRouter balance drops below $1

**Filename:** `design/tasks/TRDD-20260529_101919+0200-542bdbef-auto-free-on-low-balance.md`
**Tracked in:** `Emasoft/llm-externalizer-plugin` (this repo)

## User directive (verbatim)

> "re-evaluate the free models with the benchmarks, make the process to
> switch to free models automatic in case of openrouter credits <$1. Also
> check the llm-externalizer is in forced free mode right now, many agents
> refuse to use it even if the free mode is available."
>
> "put the threshold at $1"

## Live diagnosis (2026-05-29)

- **Active profile: `remote-ensemble-geminigrok`** — a PAID ensemble
  (`deepseek/deepseek-v4-pro` + `google/gemini-3.1-flash-lite-preview` +
  `openai/gpt-5.4-nano`). **No `free_only`, no `free_models`.** The plugin
  is NOT in free mode.
- **OpenRouter balance: `$0.10` remaining** ($419 limit, $418.90 used).
- Result: every agent tool call hits the paid ensemble → OpenRouter 403
  "Budget limit exceeded" → the MCP tool errors → the agent gives up and
  does the work itself. **This is the "agents refuse to use it" bug, and it
  is live right now.**

### Three compounding root causes (all confirmed by reading the code)

1. **Threshold too low.** `MIN_BALANCE_FOR_PAID_USD = 0.05` (index.ts ~2124).
   Balance is `$0.10` — ABOVE the floor — so the existing pre-flight
   fallback in `resolveModelOverride()` never fires. The paid ensemble is
   used and 403s.
2. **Dead fallback model.** `FREE_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b:free"`
   (index.ts:4670). Our free-pool benchmark (TRDD-f1510055) showed this
   exact model returns **"response had no content"** — it is broken. So even
   when the fallback DOES fire (pre-flight or the 402 mid-flight retry at
   index.ts:4056), it routes to a dead model → error → refuse.
3. **Single-model, not a pool.** The fallback is one hardcoded model, no
   rotation. Free models rate-limit constantly (the benchmark showed ~12/15
   429 on any given run), so a single free model is inherently fragile.

## Decision

Auto-engage free mode when the OpenRouter balance drops below a
**configurable threshold (default `$1.00`)**, routing the **main dispatch
ensemble** (chat / code_task / scan_folder / compare_files / check_* /
check_against_specs / search_existing_implementations / cluster) through the
**validated free pool with the existing rate-limit rotation** (TRDD-8b6b3646
Phase 3) — instead of a single dead model.

### Threshold

- New env `LLM_EXT_FREE_BELOW_USD`, default `1.00` (replaces the hardcoded
  `0.05`). Parse: non-finite / ≤ 0 → fall back to `1.00`. A balance strictly
  below the threshold engages auto-free.

### `FREE_MODEL_ID` (single-model paths)

- Replace the dead `nvidia/...` constant with a **configurable** resolver:
  env `LLM_EXT_FREE_MODEL_ID`, default `z-ai/glm-4.5-air:free` — the
  benchmark winner (100% keyword F1, security-triage PASS at 0.906).
- Validate the override ends with `:free` (cost-safety); else use the
  default. Used by the `free: true` per-call flag and the 402 single-retry.

### Auto-free engagement (Phase 1 — main dispatch)

- New process-global `autoFreeEngaged: boolean` + `autoFreePool: string[]`.
- `engageAutoFree(reason)`: set `autoFreeEngaged = true`; `autoFreePool =
  activeResolved.freeModels.length ? activeResolved.freeModels :
  FREE_POOL_SEED`; log once. (Does NOT flip the global `setActiveFreeOnly`
  in Phase 1 — see "Why phased" below.)
- Engagement points (all pre-existing, augmented):
  - `resolveModelOverride()` pre-flight: balance < threshold → engageAutoFree;
    for `remote-ensemble` mode return `undefined` (let the now-free ensemble
    run with rotation); for `remote` single mode return the validated
    `FREE_MODEL_ID`.
  - 402 mid-flight retry (index.ts ~4043 and ~3536): engageAutoFree + retry
    the immediate call with the validated `FREE_MODEL_ID`; subsequent
    ensemble calls use the pool.
- Consumption: `getEnsembleModels()` (index.ts:4824) — the single chokepoint
  that picks the ensemble — treats `activeResolved.freeOnly || autoFreeEngaged`
  as free, with `pool = activeResolved.freeOnly ? activeResolved.freeModels :
  autoFreePool`, fed through `selectFreeEnsembleModels` (requirements +
  benchmark filters + top-3) with the full pool as rotation fallbacks.
- **Cost-safety guard:** under auto-free, assert every model `getEnsembleModels`
  returns ends with `:free` (fail-fast); FREE_POOL_SEED and validated
  `free_models` are all `:free`, so this only catches a future regression.

### Why phased (Phase 1 vs Phase 2)

`security_scan` (judge.ts) and `mass_scout` (scout.ts) gate on
`getActiveFreeOnly()` (the global flag set by `setActiveFreeOnly`) and
**assert** the model passed to them is `:free` (judge.ts:185 —
`assertFreeOnlyModel`). They do NOT pick a free model themselves — the
caller does. So flipping the global `setActiveFreeOnly(true)` on low balance
without ALSO routing those subsystems' model selection to the free pool would
turn a 402 into a hard `assertFreeOnlyModel` throw — a regression.

- **Phase 1 (this commit):** fix the main dispatch via the local
  `autoFreeEngaged` flag consulted by `getEnsembleModels` — no global flag,
  no subsystem regression. Covers chat / code_task / scan_folder /
  compare_files / check_references / check_imports / check_against_specs /
  search_existing_implementations / cluster — the tools agents actually call.
  Strict improvement; nothing regresses.
- **Phase 2 (follow-up):** route `security_scan` + `mass_scout` model
  selection to the auto-free pool, THEN safely engage the global
  `setActiveFreeOnly(true)` so the airtight chokepoint (TRDD-97ef8b63) covers
  every spend site under auto-free.

## Acceptance criteria (Phase 1 — all met)

- [x] `LLM_EXT_FREE_BELOW_USD` default `1.00`; balance `$0.10 < $1` engages
      auto-free. (Live: "Auto-free engaged (balance $0.1021 < $1.00)".)
- [x] `FREE_MODEL_ID` default is a benchmark-validated working `:free` model;
      configurable via `LLM_EXT_FREE_MODEL_ID`; non-`:free` override rejected.
      Default tuned to `poolside/laguna-m.1:free` (most available across 4
      runs + top triage 0.966) after the v4 benchmark.
- [x] On low balance, the main-dispatch ensemble runs the free pool with
      rotation. **Verified live** (commit d0639bc binary): a `chat`/`code_task`
      call on the dead wallet ($0.10, paid profile) auto-engaged free mode,
      rotated past a 429'd `deepseek-v4-flash:free`, and returned a correct
      report from `poolside/laguna-m.1:free + gemma-4-26b:free` — exit 0,
      report written, $0 spent. The paid ensemble + dead nvidia model were
      never used.
- [x] `getEnsembleModels` asserts `:free`-only under auto-free.
- [x] Unit tests (15) for threshold parse, FREE_MODEL_ID resolution/validation,
      auto-free pool selection, and the cold-catalog ensemble selection.
- [x] `npm run build` + full suite (964/968, 4 live-skips) + lint clean.
- [x] Fresh free-pool benchmark re-run recorded (user ask #1):
      `reports/free-bench/keyword-v4.{md,json}`. Valid this run:
      gemma-4-31b 98.2%, poolside 87.2%; z-ai timed out on 429 contention
      (100%/98.2% in prior runs); nvidia models still empty/wrong-schema.

## Related TRDDs

- `TRDD-8b6b3646` — free_only Phases 1-3 (config, golden-dataset filter,
  rate-limit rotation). This TRDD reuses `selectFreeEnsembleModels` +
  `callEnsembleSlotWithRotation`.
- `TRDD-97ef8b63` — airtight free_only chokepoint (`assertFreeOnlyModel`,
  `setActiveFreeOnly`). Phase 2 here engages it on low balance.
- `TRDD-f1510055` — `--bench-free-pool` + auto-bench; produced the benchmark
  data that picks the validated `FREE_MODEL_ID` default.

## Status log

- 2026-05-29 10:19 — TRDD authored; UUID 542bdbef. Live diagnosis recorded
  (balance $0.10, paid profile, dead FREE_MODEL_ID, $0.05 threshold). Fresh
  benchmark re-running (background). Phase 1 implementation starting.
- 2026-05-29 10:35 — Phase 1 shipped (commit d0639bc): threshold→$1
  (LLM_EXT_FREE_BELOW_USD), dead FREE_MODEL_ID→validated, autoFreeEngaged +
  engageAutoFree wired into resolveModelOverride + both 402 sites,
  getEnsembleModels routes the free pool under auto-free, :free cost-safety
  assert, 3 pure helpers + 15 tests. Build/lint/suite green.
- 2026-05-29 10:52 — Benchmark v4 finished; FREE_MODEL_ID default tuned
  z-ai/glm-4.5-air:free → poolside/laguna-m.1:free (most-available 4/4 +
  best triage). **Live smoke PASSED** on the dead wallet — auto-free engaged,
  free-pool rotation past a 429, correct $0 answer. Phase 1 COMPLETE.
- 2026-05-29 11:12 — **Phase 2 COMPLETE.** Auto-free now covers EVERY tool:
  engageAutoFree flips the global setActiveFreeOnly(true) (TRDD-97ef8b63
  chokepoint), the balance decision is extracted to a shared
  ensureAutoFreeDecided() called by both the main dispatch and the
  security_scan / mass_scout short-circuit, and that short-circuit substitutes
  a ':free' model (resolveSubsystemFreeModel — pure, 6 new tests) so the
  chokepoint assertion is satisfied rather than thrown. Also fixes a LATENT
  bug: security_scan defaulted to a PAID model (qwen-2.5-7b-instruct) and would
  throw under an explicit free_only profile too — now it self-selects a free
  model under any free mode. Reload-preserve: a settings reload keeps a live
  auto-free engagement (empty wallet stays free). Full suite 970/974, lint
  clean. Live security_scan smoke deferred (single-model subsystem + free-tier
  429 contention from the benchmark; Phase 1 already proved the engagement
  path end-to-end and the inject-':free' / assert-accepts-':free' composition
  is unit-covered).
