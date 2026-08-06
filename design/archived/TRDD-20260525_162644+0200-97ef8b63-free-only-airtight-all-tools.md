---
trdd-id: 97ef8b63-a9c2-48eb-8163-d6f29defe6a8
title: free_only must override every tool — airtight zero-spend enforcement
column: complete
created: 2026-05-25T16:26:44+0200
updated: 2026-08-06T17:35:00+0200
---

# TRDD-97ef8b63 — free_only airtight: free models override EVERY tool

**Filename:** `design/tasks/TRDD-20260525_162644+0200-97ef8b63-free-only-airtight-all-tools.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

## User request (verbatim)

1. "when the free mode is set in the settings.yaml, the free models OVERRIDE
   every customized choice of the tools"
2. "fix immediately the issues remaining, and push the new version so i can
   update the plugin in claude code at user scope. we must prevent other claude
   code sessions from using the llm-externalizer without the free models mode
   enabled and working for all tools. update the rules too."

## The gap (grounded in code)

`free_only` (TRDD-8b6b3646) routes the ENSEMBLE through the free pool
(`getEnsembleModels`), but TWO other model-resolution paths could still reach a
PAID model under a free_only profile:

1. **`resolveModelForTool` (config.ts)** — resolution order is
   `toolModels[tool]` → caller `fallback` → `resolved.model`. A per-tool
   override (`tool_models:`) OR a caller-supplied fallback would be returned
   BEFORE the free `resolved.model`. So a paid `tool_models` entry, or any
   caller passing a paid default, bypasses free_only. (Single runtime caller
   today: `mass_scouting/cli.ts:1813`.)
2. **No hard floor at the wire.** Every request's model is `conn.model`, set by
   `resolveConnection` (`options?.model || backend.model`). Nothing asserts that
   model is `:free` under free_only — so any present/future code path that
   forgets to apply free_only would silently BILL.

## Design — defence in depth (fail-fast)

### Primary: airtight chokepoint guard
`resolveConnection` is the SINGLE point every request's model flows through
(verified: both OpenRouter fetch sites set `baseBody.model = conn.model`;
`chatCompletionNative` uses `conn.model`; all callers go through
`chatCompletionSimple` → `resolveConnection`). Add a pure guard
`assertFreeOnlyModel(freeOnly, backendType, model)` called right after the model
is resolved: under `freeOnly` + `backendType === "openrouter"`, a model id NOT
ending in `:free` THROWS before the fetch. Local backends and non-free profiles
are no-ops. This makes free_only impossible to bypass — any leak fails fast
(no spend) instead of billing.

### Secondary: resolveModelForTool honours free_only
`if (resolved.freeOnly) return resolved.model;` at the TOP — free models override
`tool_models` AND any caller `fallback`. Matches request (1) exactly.

### Tertiary: resolved profile reflects the override
`resolveProfile`: under free_only, `toolModels = {}` (runtime resolved only —
the user's settings.yaml is untouched). Keeps `get_settings`/drift diagnostics
consistent ("no per-tool overrides active under free_only").

### Rule update
`rules/use-llm-externalizer.md` (auto-installed to ~/.claude/rules/): add a
cost-safety section instructing every session to keep a `free_only` profile
active when spend must be zero, and that under free_only EVERY tool uses only
`:free` models (the guard enforces it). README B2: state the all-tools override
explicitly.

## Safety invariants

- Under free_only, NO tool (chat, code_task, scan_folder, security_scan,
  cluster_synonyms, mass_scout, check_*, compare_files, the 402 fallback, the
  rotation fallback, modelOverride) can send a non-`:free` model to OpenRouter —
  the chokepoint throws first.
- Non-free profiles are completely unaffected (guard no-ops when freeOnly=false).
- Local backends unaffected (guard no-ops when type !== openrouter; $0 anyway).
- `FREE_MODEL_ID` (the 402 fallback target) is already `:free`
  (`nvidia/nemotron-3-super-120b-a12b:free`) — consistent with the guard.

## Files

- `mcp-server/src/index.ts` — `assertFreeOnlyModel` + call in `resolveConnection`.
- `mcp-server/src/config.ts` — `resolveModelForTool` short-circuit;
  `resolveProfile` toolModels clear under free_only.
- `mcp-server/src/free-only.test.ts` — guard tests + resolveModelForTool/profile tests.
- `rules/use-llm-externalizer.md` — cost-safety / free-mode section.
- `README.md` — B2 all-tools override note.

## Ship

Part of the free-only feature (TRDD-8b6b3646, unpublished). Version bump
9.13.1 → 9.14.0 (minor: new feature surface), publish via publish.py (all 9
gates), push + tag + GitHub release. User updates the plugin at user scope so
every session gets the airtight free mode.

## Implementation note — coverage EXPANDED during build

The audit found that the main chat/scan path is NOT the only place a model
reaches OpenRouter. There are **5 independent spend sites** across 3 subsystems,
each fetching OpenRouter directly:

| # | Spend site | Subsystem | Guard |
|---|------------|-----------|-------|
| 1 | `index.ts` `resolveConnection` (chat / code_task / scan_folder / cluster_synonyms / check_* / compare_files / search_existing_implementations) | core | `assertFreeOnlyModel(activeResolved?.freeOnly, backend.type, model)` |
| 2 | `security_scan/judge.ts` `judgeGroups` (security_scan runtime + security-triage benchmark) | security_scan | `assertFreeOnlyModel(getActiveFreeOnly(), "openrouter", opts.model)` |
| 3 | `mass_scouting/scout.ts` `runScoutJob` (mass_scout fan-out) | mass_scouting | `assertFreeOnlyModel(getActiveFreeOnly(), "openrouter", opts.model)` |
| 4 | `mass_scouting/cli.ts` `runProposeFieldset` (propose-fieldset LLM call) | mass_scouting | `assertFreeOnlyModel(getActiveFreeOnly(), "openrouter", model)` |
| 5 | `benchmark/runner.ts` `runBenchmarkOnModelInner` (keyword benchmark) | benchmark | `getActiveFreeOnly()` → RunError (honours the never-throw contract) |

Because the pure subsystem modules (judge/scout/runner) cannot import index.ts's
`activeResolved` (cycle + they are intentionally pure), the free_only state is
published to a single process-global in config.ts:
`setActiveFreeOnly()` / `getActiveFreeOnly()`. The owner of the active profile
sets it at the single resolution point in EACH entry process:
- `index.ts` (MCP server) — at both `activeResolved` assignments (load + reload).
  Covers every in-process MCP tool (this is what other Claude Code sessions use).
- `cli.ts` `main()` and `benchmark/index.ts` `main()` — at startup, for the
  standalone CLI processes (dist/cli.js, dist/benchmark.js).

`assertFreeOnlyModel` itself stays a PURE explicit-param function (callers pass
`getActiveFreeOnly()`), so it is fully offline-testable.

mass_scout is also made free_only-AWARE (not just guarded): `resolveCliModel()`
returns the active free model under free_only, so mass_scout RUNS on a free model
instead of failing the guard. Non-free profiles keep the exact prior behaviour.

Files changed: `config.ts` (flag + assertFreeOnlyModel + resolveModelForTool
short-circuit + toolModels clear), `index.ts` (resolveConnection guard + 2 flag
sets + imports), `security_scan/judge.ts`, `mass_scouting/scout.ts`,
`mass_scouting/cli.ts` (guard + resolveCliModel + main flag), `cli.ts` (main
flag), `benchmark/index.ts` (main flag), `benchmark/runner.ts` (skip),
`free-only.test.ts` (+10 tests), `README.md`, `rules/use-llm-externalizer.md`.

Verification: tsc + eslint clean; full suite 936 passed / 4 skipped / 0
OpenRouter boots; grep confirms 1:1 spend-site→guard coverage.

## Status
- completed. Ships in 9.14.0 with the rest of the free-only feature (TRDD-8b6b3646).
