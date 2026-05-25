---
trdd-id: 828238b5-42d7-478e-8fe7-44d74f812286
title: Auto-* model management suite + deep-audit findings backlog
status: in-progress
created: 2026-05-24T22:56:20+0200
updated: 2026-05-25T03:31:11+0200
---

# TRDD-828238b5 — Auto-* model management suite + deep-audit findings backlog

**Filename:** `design/tasks/TRDD-20260524_225620+0200-828238b5-auto-model-management-and-deep-audit-backlog.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

Durable, git-tracked record of the 2026-05-24 whole-plugin deep audit. The raw
agent reports live in `reports/deep-audit/` (gitignored, ephemeral); the
load-bearing findings + the auto-* roadmap are embedded here so they survive.

Design guardrail (applies to EVERYTHING below): the MCP server is **read-only by
design**. There is no `change_model`/`set_settings` tool. Any capability that
*changes* a configured model MUST stay CLI/cron-triggered and explicit (extend
the `--apply-profile` pattern) — never a silent MCP side-effect. Self-checks and
benchmarks remain advisory (emit a report, return a path), like the existing
`assess-model` and `security-triage-benchmark` surfaces.

---

## Part A — Auto-* model-management roadmap (7 capabilities)

Source: gap analysis grounded in `mcp-server/src`. Status tally: 1 EXISTS /
5 PARTIAL / 1 MISSING. Ordered by value-to-effort.

### A0 — What already EXISTS (capability 6: runtime auto issue-detection + mitigation)
Robust and complete — DO NOT rebuild; build ON it:
- Unsupported-param auto-drop, forward-compat + one-shot warning:
  `index.ts` `filterBodyForSupportedParams` (~1575), `getModelSupportedParams`
  (~1517, 1h TTL).
- AIMD adaptive rate limiter: `AdaptiveRateLimiter` (~3451), 429→halve, success→additive.
- Retry/backoff: `fetchWithRetry429` (~2400), `RETRYABLE_STATUS` (~2398).
- Reasoning-effort ladder + cache: `reasoningLadderForModel` (~1409).
- Per-model sampling overrides: `MODEL_REQUEST_OVERRIDES` (~1445, e.g. Nemotron).
- Truncated-response retry + JSON-healing (~3009/3072/3185).
GAP: all per-session/in-memory; nothing persisted → can't drive durable decisions.

### A1 — [S] Persist runtime mitigation/health events (foundation) — DONE (commit a307759)
Append model-health events (param drops, reasoning downgrades, 429 streaks,
schema heals, non-retryable failures) keyed by model id, reusing
`usage-history.ts`'s append-only sink (or a sibling `model-events.log`). Pure
add of structured event lines + a reader. Unlocks A2. Real tests on the
reader/aggregator (no LLM calls needed).

### A2 — [M] `check_model_health` self-check (capability 1, MISSING) — DONE (commit 5eb4998)
For the *configured* model(s) (main/second/third + every `tool_models` entry):
- **Presence:** id ∈ live catalog (`benchmark/discover.ts::fetchProgrammingModels`)?
  Absent ⇒ deprecated/removed finding.
- **Cost drift:** live `pricing` vs a seeded `getConfigDir()/model-baseline.json`
  (atomic tmp+rename, same pattern as `pick.ts`). First run seeds.
- **Requirements regression:** re-run `qualifyModelForTool` (registry.ts:172).
New module `model-qualification/drift.ts`; 3 surfaces (MCP tool + CLI
`--check-health` + slash command); report to `reports/model-health/`.
No LLM cost. Directly answers "is my model outdated / did the price change".

### A3 — [M] De-hardcode the catalog tables (capability 5, PARTIAL) — DONE
Replace the load-bearing hardcoded tables with live/cached catalog lookups
(fetch plumbing already exists; reuse the 1h-TTL cache pattern). See the
hardcoded inventory in Part C. Dedupe the two `DEFAULT_MODEL` literals.

**What shipped:**
1. `DEFAULT_MODEL` deduped — `mass_scouting/cli.ts` now imports the canonical
   `DEFAULT_MODEL` from `security_scan/types.ts` (already a pure leaf, already
   the source mass_scouting → security_scan dep direction at cli.ts:60) instead
   of redeclaring the literal. The real single-source-of-truth win from Part C.
2. Ensemble per-model limits extracted to a new pure, unit-tested module
   `ensemble-limits.ts` (`resolveEnsembleModelLimits` + 16 tests). `maxOutput`
   is now CATALOG-PREFERRED: `getEnsembleModels()` reads the warm 1h-TTL catalog
   cache (`openRouterModelCache`, sync-readable) for each model's live
   `top_provider.max_completion_tokens`, with a plausibility floor and fallback
   to the calibrated table when the cache is cold or the model is absent.

**Calibration boundary (verified, deliberate — do NOT "fix" further):**
The KNOWN_* tables MIX two kinds of value and only the catalog-authoritative
kind was de-hardcoded:
- `maxOutput` (ensemble) and `pricing.{prompt,completion}` (KNOWN_PRICING) ARE
  catalog-authoritative → catalog-preferred (maxOutput now; pricing already
  injectable by callers + drift-detected by A2's `check_model_health`).
- `maxInputLines` (ensemble) and `KNOWN_PRICING.context_window` (32_768) are
  EMPIRICAL calibration the catalog does NOT carry — deliberately far below the
  models' architectural limits (grok 20K lines; qwen provider endpoint cap
  32_768 < architectural 128K). Auto-deriving them from `context_length` would
  REGRESS quality / trigger HTTP-400s. They stay hand-calibrated, now documented
  inline in `ensemble-limits.ts` and `cost-estimate.ts` so a future maintainer
  does not naively "de-hardcode" them.
- `cost-estimate.ts` stays a PURE module (callers inject live `ModelPricing`);
  price drift is detected by A2, so no live-fetch was wired into the estimator.
- `INCUMBENT_FALLBACK_PRICING` (`benchmark/security-triage/index.ts:61`) keeps
  its `?? {…}` — it is a legitimate guard for a future `DEFAULT_MODEL` change,
  not dead under the project's index-access typing.

### A4 — [M] New-arrivals autodiscovery (capability 3, PARTIAL)
New `model-qualification/new-arrivals.ts`: persist a catalog snapshot
(`getConfigDir()/catalog-snapshot.json`, shared with A3), diff live vs snapshot
on `created` (field already parsed at `discover.ts:44`), feed new qualifying ids
into the existing benchmarks (`pickTopN` / `selectSecurityTriageModel`), report
winners. CLI `--new-arrivals` + opt-in cron; report-only by default.

### A5 — [M] Doc/help/config regeneration gate (capability 7, PARTIAL)
Single-source-of-truth generator: `registry.ts` (per-tool table) + `API_PRESETS`
(config.ts:120, presets table) + `generateDefaultSettings` (config.ts:303,
default model list) → splice into `<!-- BEGIN GENERATED: x -->…<!-- END -->`
markers (mirror the README-badge marker pattern in `publish.py:63`) across the
rule file + command docs. Add `_gate_docs` to `publish.py --check` (fail CI if
regeneration would change a tracked file). Ends the recurring doc-drift class
this audit kept fixing. NOTE: `publish.py` already regenerates README badges
(`update_readme_badges`) + CHANGELOG via git-cliff — extend that pattern.

### A6 — [L] Per-tool tailored benchmarks (capability 4, PARTIAL)
10 of 12 LLM tools have requirements (registry) but no benchmark dataset/scorer
(the registry header explicitly marks them incremental; `benchmark: null`).
Only `security_scan` (→ `benchmark/security-triage/`) and the generic keyword
task are real. Per tool, mirror the `security-triage/` package: `dataset.ts`
(golden cases+rubrics), `score.ts` (scorer+thresholds), `runner.ts` (reuse the
tool's REAL pipeline, not a re-impl), `select.ts` (extract the shared
same-or-cheaper gate from `security-triage/select.ts` once the 2nd dataset
lands — DRY), wire registry `benchmark` pointer. Prioritize `code_task` →
`scan_folder` → `search_existing_implementations`. Real golden datasets, no fakes.

### A7 — [L] Auto-replacement loop (capability 2 "replacement" half, PARTIAL)
Capstone. Wire durable health ledger (A1) → tool flagged degraded → run that
tool's benchmark (A6) → surface best same-or-cheaper passer → opt-in per-tool
`tool_models` write (extend `--apply-profile` to per-tool; CLI/cron only, never
silent MCP). Depends on A1 + A6.

**Recommended build order:** A1 → A2 → A3 → A4 → A5 → A6 (tool-by-tool) → A7.

---

## Part B — Architectural findings (from the code-audit swarm)

- **B1 [MAJOR] index.ts is 9599 lines** — single-file monolith holding server
  entry + buildTools() + the full dispatch switch + all runtime mitigation. Split
  along natural boundaries (rate-limiter, retry/backoff, model-param filtering,
  reasoning ladder, tool dispatch, OpenRouter client) into modules. Large, risky;
  do incrementally with the 801-test suite as the guard. Pre-req that makes A1–A7
  edits to index.ts safer.
- **B2 [HIGH] cluster resume is a half-wired stub** that silently overwrites
  outputs (`cluster/` — `resume_from` accepted but not honored end-to-end).
  Either implement real resume (checkpoint.sqlite exists) or remove the param +
  doc. Silent-overwrite is a data-loss footgun.
- **B3 [HIGH] cluster whole-corpus in-memory load** contradicts the documented
  10k–1M-item streaming contract (`cluster_synonyms_main.ts` / `phase1_batch.ts`).
  Stream from the JSONL + checkpoint instead of loading all items.
- **B4 [MEDIUM] cluster preflight benchmark never wired** into the entry path
  (`cluster/preflight_benchmark.ts` exists, unused). Wire it or remove.
- **B5 [MEDIUM] cluster `partition()` recomputed 3–4× at emit** — cache once.

---

## Part C — Hardcoded model/cost inventory (de-hardcode targets for A3)

| Item | File:line | Hardcodes | Live source |
|------|-----------|-----------|-------------|
| `DEFAULT_MODEL` | `security_scan/types.ts:215` | qwen/qwen-2.5-7b-instruct | dedupe + tool_models |
| `DEFAULT_MODEL` | `mass_scouting/cli.ts:117` | duplicate literal | import the one above |
| `KNOWN_PRICING` | `mass_scouting/cost-estimate.ts:164` | qwen pricing/ctx | catalog `pricing` |
| `KNOWN_MODEL_LIMITS` | `index.ts:4509` | 4 ensemble models' limits (comment already drifted "Free variant deprecated 2026-04") | catalog `context_length` + `top_provider.max_completion_tokens` |
| `DEFAULT_MODEL_LIMITS` | `index.ts:4521` | 32000/30000 fallback | derive from ctx fraction |
| `INCUMBENT_FALLBACK_PRICING` | `benchmark/security-triage/index.ts:60` | $0.04/$0.10 | catalog pricing (already fetched ~236) |
| default ensemble ids | `config.ts:320` & `:693` (SETTINGS_TEMPLATE) | gemini-2.5-flash/grok-4.1-fast/qwen3.6-plus | single source `generateDefaultSettings` |
| ensemble ids in docs | `commands/llm-externalizer-change-model.md`, `rules/use-llm-externalizer.md` | restated by hand | generated (A5) |

The two `DEFAULT_MODEL` literals are a real single-source-of-truth violation.
The `KNOWN_*` tables are highest-value (load-bearing in cost/budget AND drifting).

---

## Part D — Concrete bug backlog (live scripts; honor each function's OWN contract)

These are robustness/correctness defects in live Python helpers. Where a
function's docstring PROMISES "never raise / return error dict" (batch-loop
resilience), honoring that contract is correct and is NOT a fail-fast violation.
Where there is no such contract, prefer fail-fast.

- **D1 `scripts/setup/build-snippet.py` (LIVE — setup-agent uses it):**
  `_yaml_dquote` rejects `\n`/`\r` as control chars BEFORE the `.replace("\n","\\n")`
  runs, so the docstring's "newlines escaped as \\n" promise is false (fix the
  docstring to "control chars incl newlines are rejected", OR actually escape).
  `SystemExit(<msg>)` with no code exits 1, but docstring promises exit 2 for
  safety-guard violations. `_validate_profile_name` doesn't reject YAML-reserved
  tokens (null/true/yes/no/~) though the name is emitted as an UNQUOTED key.
  argparse errors exit 2 vs documented 1 (align docstring).
- **D2 `scripts/setup/_bench_helpers.py`:** `_avg_test_score` (`record["tests"]`),
  `rank_models` (`r["perf"]`), `render_markdown` (`r["tests"]`/`r["perf"]`) use
  direct indexing → KeyError crashes the whole rank/render despite `_is_viable`
  using `.get(...,{})`. Use `.get` defaults to honor batch resilience.
- **D3 `scripts/setup/benchmark-models.py`:** `measure_throughput` lets
  `call_chat` exceptions escape (docstring says return error dict);
  `benchmark_one_model` lacks the try/except guard around `measure_throughput`
  that it uses for reliability tests; `run_vmlx_bench` `float()/int()` can raise
  ValueError vs "never raise" contract; `"error" in resp` without `isinstance dict`.
- **D4 `scripts/setup/detect-runners.py`:** `_safe_model_names` does
  `(payload or {}).get(...)` → AttributeError if JSON is a list (non-dict);
  `_vllm_import_probe` misses some "installed but broken" import failures.
- **D5 `scripts/fix_found_bugs_helper.py` `_find_report_files` (~413):**
  `--skip-if-fixer-exists` only matches `.fixer.` siblings, not the canonical
  `-fixer-` pattern `_is_sidecar` recognizes → skip filter effectively disabled,
  already-fixed reports re-aggregated. (Confirm the real fixer-sidecar naming via
  `validate_fixer_summary.py` / `join_fixer_reports.py` before fixing.)
- **D6 statusline usage/budget fetchers (`scripts/statusline/`):**
  `fetch_usage_from_api` (~305) and `fetch_openrouter_budget` (~346) use bare
  `except Exception:` → silently swallow all errors (network, schema, bugs),
  masking diagnosis. Log the error (statusline may still fail-soft visually, but
  must not hide the cause).

---

## Part E — Dead code (REMOVAL PENDING USER APPROVAL — RULE 0)

These are git-tracked (committed before this session), so RULE 0 forbids deleting
them without explicit user approval. Verified orphaned (no caller in
commands/skills/hooks/ts/scripts; only CHANGELOG history + their own usage strings):
- `scripts/apply_ensemble_choice.py` (202 LOC) — superseded by user-only manual config.
- `scripts/read_ensemble_state.py` (152 LOC) — same era, unreferenced.
- `scripts/setup/vllm-cuda-autoconfig.py` (448 LOC) — orphaned FEATURE (CUDA
  auto-config for vLLM) never wired into the setup flow. Decision: wire it into
  the setup-agent (it has a real FP8-KV bug at ~375, F7) OR remove. It is an
  "unimplemented/never-wired" item, not just dead code.

Action: ask the user → `git rm` (recoverable via history) or move to a `_dev`
folder, per RULE 0.

---

## Part F — Test-coverage gaps (from scripts-tests audit)

10 TS source modules + 14 Python scripts lack a matching test. Full list is in
`reports/deep-audit/20260524_221551+0200-scripts-tests.md`. When implementing any
A1–A7 item, add real tests for the touched modules (no mocks of the unit under
test, per project rule). Prioritize tests for: the new drift/new-arrivals
modules, the de-hardcoded catalog lookups, and the build-snippet.py fixes (D1).

---

## Acceptance / done-criteria
- Each A-item ships with: implementation + real tests (green) + 3 surfaces where
  applicable (MCP + CLI + slash) + doc update + a passing `publish.py` run.
- Read-only guardrail upheld: no silent model writes from MCP tools.
- `npm run build` + `npm test` green; `tsc --noEmit` + eslint clean.
- This TRDD's status bumped per the trdd-design-tasks rule as items land.
