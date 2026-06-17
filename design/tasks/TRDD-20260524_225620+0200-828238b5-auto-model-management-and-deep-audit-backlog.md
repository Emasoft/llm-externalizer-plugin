---
trdd-id: 828238b5-42d7-478e-8fe7-44d74f812286
title: Auto-* model management suite + deep-audit findings backlog
status: in-progress
created: 2026-05-24T22:56:20+0200
updated: 2026-06-18T01:22:56+0200
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

### A4 — [M] New-arrivals autodiscovery (capability 3, PARTIAL) — DONE
New `model-qualification/new-arrivals.ts`: persist a catalog snapshot
(`getConfigDir()/catalog-snapshot.json`, shared with A3), diff live vs snapshot
on `created` (field already parsed at `discover.ts:44`), feed new qualifying ids
into the existing benchmarks (`pickTopN` / `selectSecurityTriageModel`), report
winners. CLI `--new-arrivals` + opt-in cron; report-only by default.

**What shipped:**
- `model-qualification/new-arrivals.ts` — pure core (`diffNewArrivals`,
  `createdToIso`) + IO (`discoverNewArrivals`, snapshot load/save atomic) + 3
  surfaces (`runDiscoverNewArrivals` orchestrator, markdown + text renderers).
  Each new id is assessed via `assessModelAcrossTools` (registry requirements);
  report shows qualified-tool count + which are benchmark-gated. First run seeds
  the snapshot and reports zero (mirrors A2's baseline seeding). `qualifyingOnly`
  filters to fits-≥1-tool.
- 3 surfaces: MCP tool `discover_new_models` (mass_scouting/mcp-tools.ts), CLI
  `--new-arrivals [--qualifying-only]` (benchmark/index.ts), slash command
  `llm-externalizer-discover-new-models`.
- 18 new-arrivals unit tests + 2 hermetic dispatch tests; roster (index.test.ts,
  mcp-tools.test.ts count 20→21) + docs (README 36→37 tools / 25→26 commands /
  16→17 base, model-qual tables, rule inventory, tool-use-cases) updated.
- Snapshot at `getConfigDir()/catalog-snapshot.json` (the A3-shared snapshot the
  original plan referenced; A3 itself used the in-memory 1h cache, so A4 owns
  this on-disk snapshot). Report-only — adoption stays user-only.
- DEFERRED to A7: auto-feeding qualifying arrivals into `pickTopN` /
  `selectSecurityTriageBenchmark` (that's the auto-replacement loop's job; A4
  reports candidates, A7 acts on them). Opt-in cron is a userland scheduling
  choice (the CLI `--new-arrivals` is the cron entry point), not shipped code.

### A5 — [M] Doc/help/config regeneration gate (capability 7, PARTIAL) — DONE
Single-source-of-truth generator: `registry.ts` (per-tool table) + `API_PRESETS`
(config.ts:120, presets table) + `generateDefaultSettings` (config.ts:303,
default model list) → splice into `<!-- BEGIN GENERATED: x -->…<!-- END -->`
markers (mirror the README-badge marker pattern in `publish.py:63`) across the
rule file + command docs. Add `_gate_docs` to `publish.py --check` (fail CI if
regeneration would change a tracked file). Ends the recurring doc-drift class
this audit kept fixing. NOTE: `publish.py` already regenerates README badges
(`update_readme_badges`) + CHANGELOG via git-cliff — extend that pattern.

**What shipped (CHECK gate, not a templating regenerator — see decision):**
- `doc-inventory.ts` — pure, side-effect-free EXTRACTORS that parse the
  authoritative declarations straight from source as text (no server import,
  because index.ts runs `main()` on import): core tool names (6-space-indent
  `name:` regex on index.ts), mass-scout/model-qual tool names (4-space regex
  on mcp-tools.ts), API-preset keys (config.ts), slash-command names
  (commands/*.md frontmatter), agent names (agents/*.md).
- `doc-consistency.test.ts` — asserts the README's hand-restated COUNTS
  (`N MCP tools` ×2, `N plugin commands` + base/mass-scout/security split,
  `N backend presets`, `N internal agents`, the core/utility + security/
  model-qualification sub-counts) AND NAME LISTS (every tool backtick-wrapped,
  every command present) match the extractors. 11 tests.

**Decision: CHECK over GENERATE (documented, deliberate).**
- The gate is a vitest test, so it runs inside `npm test`, which is ALREADY a
  mandatory publish gate (`publish.py::run_checks` → `npm test`, line 324). No
  `publish.py` edit, no new CI wiring — the "fail CI if docs drift" goal is met
  for free. Add a tool/command and forget a README count → this test fails with
  a clear message.
- A full marker-splicing REGENERATOR was rejected: (a) the core tool list lives
  inline in the 9.6k-line index.ts which runs `main()` on import (can't be
  imported into a generator without a risky refactor); (b) rendering the README
  PROSE lists exactly is brittle and a cosmetic mismatch would block publishes.
  A check with a precise failure message is equally drift-proof and far safer —
  same END (no drift ships) as the TRDD's gate, lower risk. Same judgment as A3.
- NOT a fake test: it enforces a real invariant (docs match code) by parsing the
  real source declarations, no mocks.

### A6 — [L] Per-tool tailored benchmarks (capability 4, PARTIAL) — PARTIALLY DONE (search-existing shipped 2026-06-10; free-form code_task/scan_folder deferred)
10 of 12 LLM tools have requirements (registry) but no benchmark dataset/scorer
(the registry header explicitly marks them incremental; `benchmark: null`).
Only `security_scan` (→ `benchmark/security-triage/`) and the generic keyword
task are real. Per tool, mirror the `security-triage/` package: `dataset.ts`
(golden cases+rubrics), `score.ts` (scorer+thresholds), `runner.ts` (reuse the
tool's REAL pipeline, not a re-impl), `select.ts` (extract the shared
same-or-cheaper gate from `security-triage/select.ts` once the 2nd dataset
lands — DRY), wire registry `benchmark` pointer. Prioritize `code_task` →
`scan_folder` → `search_existing_implementations`. Real golden datasets, no fakes.

**Findings from the A6 scoping pass (2026-05-25) — why this is a focused
follow-up, not a quick port:**
1. **Scoring substrate differs per tool.** `security_scan` was benchmarkable
   because its output is a STRUCTURED verdict (threat/not_threat/uncertain) →
   deterministic scoring. `code_task` / `scan_folder` emit FREE-FORM review
   prose → objective scoring needs an LLM-JUDGE calibration (a sub-project like
   security-triage's `judgeGroups`), not a mechanical port. The first
   deterministically-scorable target is **`search_existing_implementations`**
   (per-file YES/NO + symbol/lines — binary classification, like the triage
   verdict), so it should lead, ahead of the TRDD's original code_task-first
   order.
2. **The real pipeline is NOT importable.** `security-triage/runner.ts` could
   reuse `judgeGroups` because it was a standalone module. The
   `search_existing_implementations` pipeline lives INSIDE `index.ts`'s dispatch
   (`case "search_existing_implementations"`, ~7434) and `index.ts` runs
   `main()` on import — so a faithful in-process runner is blocked on extracting
   that core into an importable module (part of **B1**, the monolith split:
   "Large, risky; do incrementally"). The alternative — a runner that spawns the
   server over stdio (as `cli.ts::cmdSearchExisting` does) — works but is
   heavyweight + live-only.
3. **Real golden dataset = real curation.** A `search_existing` dataset is a
   small REAL fixture codebase whose feature locations are KNOWN (because we
   author the fixture) + `(feature_description → expected_yes files)` cases.
   That is genuine curation; rushing it produces a shallow/fake dataset, which
   violates the hard "Real golden datasets, no fakes" rule — worse than none.

**Recommended A6 plan (next session):** (a) extract the
`search_existing_implementations` core from `index.ts` into an importable module
(B1 increment, guarded by the 883-test suite); (b) build `benchmark/search-existing/`
(real fixture + dataset + deterministic precision/recall scorer + in-process
runner) mirroring `security-triage/`; (c) THEN extract the shared
same-or-cheaper gate into `benchmark/select-common.ts` (now justified by the 2nd
consumer — premature before that, per YAGNI); (d) wire registry
`benchmark: "search-existing"`; (e) only after a structured-output tool lands,
tackle the free-form tools (`code_task`/`scan_folder`) via an LLM-judge scorer.
DEFERRED deliberately rather than faked.

**What shipped (2026-06-10) — `search_existing_implementations` benchmark:**
- **Scan-pipeline + core extraction (B1 increment).** The
  `search_existing_implementations` core was extracted from `index.ts`'s dispatch
  into an importable module (`runSearchExistingImplementations`), guarded by the
  existing test suite — so the benchmark drives the REAL pipeline (same FFD
  bin-packed batching, same per-file-section prompt contract, same merged-report
  assembly), not a re-implementation.
- **Fixture corpus + golden dataset + deterministic scorer.** A real hand-authored
  mini-codebase under `mcp-server/benchmark-fixtures/search-existing/` (retry,
  LRU cache, memoization, slugify, debounce, HMAC tokens, leveled logger, plus an
  absent-feature case that measures hallucination resistance). Every case states
  the exact files a correct run must answer YES for; scoring is purely MECHANICAL
  (precision/recall/F1 over the known duplicate locations — NO LLM judge).
- **In-process runner via SeiDeps/FetchImpl.** The runner injects dependencies so
  the pipeline runs in-process against a controllable fetch, measuring the model
  the way the tool will actually use it.
- **`select-common` extraction with security-triage refactored onto it.** The
  shared same-or-cheaper selection gate was lifted into
  `benchmark/select-common.ts` (now justified by the 2nd consumer per YAGNI), and
  `security-triage/select.ts` was refactored onto it — DRY.
- **Registry benchmark pointer flipped** to `search-existing` for
  `search_existing_implementations`.
- **3 surfaces.** MCP tool `search_existing_benchmark`, CLI flag
  `llm-ext-benchmark --search-existing`, and slash command
  `/llm-externalizer:llm-externalizer-search-existing-benchmark` — same core logic.

Still deferred: the free-form tools (`code_task` / `scan_folder`) need an
LLM-judge scorer (a sub-project like security-triage's `judgeGroups`), not a
mechanical port — left for a follow-up rather than faked.

### A7 — [L] Auto-replacement loop (capability 2 "replacement" half) — DONE for security_scan + search_existing_implementations (2026-06-11); broader rollout follows each new per-tool benchmark
Capstone. Wire durable health ledger (A1) → tool flagged degraded → run that
tool's benchmark (A6) → surface best same-or-cheaper passer → opt-in per-tool
`tool_models` write (extend `--apply-profile` to per-tool; CLI/cron only, never
silent MCP). Depends on A1 + A6.

A7 is now UNBLOCKED for `search_existing_implementations`: the "run that tool's
benchmark" step has something real to run (the `search-existing` benchmark
shipped 2026-06-10), so the auto-replacement loop can be built for that tool
end-to-end. The BROADER rollout across the remaining tools still pends their
benchmarks (the free-form `code_task` / `scan_folder` LLM-judge scorers, A6's
deferred half). A1's foundation (durable health ledger) and A4's
candidate-surfacing (`discover_new_models`) are in place; A7 also subsumes A1's
deferred failure-signal emission (429/empty/non-retryable events threaded with
the model id at the index.ts error classifier) and A4's deferred "auto-feed
qualifying arrivals into the benchmark" step. Build the broader A7 only as each
remaining tool's benchmark lands.

**What shipped (2026-06-11) — A7 across its 3 build slices:**

- **A7-P1 — health-signal emission (the ledger's input).** The five mitigation
  failure kinds (`rate_limit_429`, `truncation_retry`, `schema_heal`,
  `empty_response`, `non_retryable_failure`) are now emitted with the model id at
  the hot-path sites (the index.ts error classifier / retry ladder), so A1's
  durable ledger actually accumulates the events A7 aggregates. Tests:
  `src/model-events-emission.test.ts`.
- **A7-P2 — the loop CORE (advisory planner + CLI-only writer), split for the
  read-only-MCP guardrail.**
  - `src/model-qualification/auto-replace.ts::planToolReplacements` — the
    ADVISORY orchestrator. For every benchmarked tool it resolves the incumbent,
    aggregates that incumbent's ledger window, and (only when degraded, or on an
    explicit `force` audit) runs that tool's benchmark to surface the best
    same-or-cheaper passer. Returns `{ findings, reportMarkdown }` and NEVER
    writes config. Healthy/empty ledger ⇒ zero benchmarks, zero false positives.
    IO seams injected (settingsReader / benchmarkRunner / eventsPath) so the
    whole planner is unit-tested without network. Tests:
    `src/model-qualification/auto-replace.test.ts`.
  - `src/benchmark/pick.ts::applyToolModelToSettings` — the CLI/cron-ONLY writer
    that atomically writes one `tool_models.<tool>` entry, behind a
    READ-ONLY-MCP GUARDRAIL banner. Tests:
    `src/benchmark/apply-tool-model.test.ts`.
- **A7-P3 — the 3 surfaces (this slice).**
  - **MCP — `check_tool_replacements` (READ-ONLY, the 21st model-mgmt tool /
    39th MCP tool overall).** Registered in `MASS_SCOUT_TOOLS`; dispatch calls
    ONLY `planToolReplacements`, writes the advisory report under
    `reports/auto-replace/`, returns the report path + a one-line summary. The
    handler deliberately does NOT import `applyToolModelToSettings` (inline
    guardrail comment) — the MCP surface can never rewrite settings.
  - **CLI — `llm-ext-benchmark --auto-replace [--apply]` (the SOLE writer
    path).** `--auto-replace` runs the planner + writes the report (advisory);
    `--apply` (gated: requires `--auto-replace`) adopts every `changed=true`
    finding via `applyToolModelToSettings`, printing `old → new` per tool and
    telling the user to run `reset`; exit 3 on write failure; honors `free_only`.
    Tests: `src/benchmark/auto-replace-cli.test.ts` (hermetic spawn of
    `dist/benchmark.js` on a healthy ledger — no network).
  - **Slash command — `commands/llm-externalizer-auto-replace.md`** (cloned from
    the search-existing-benchmark command) wraps the read-only MCP tool and
    documents that applying requires the CLI `--apply`.
  - Docs synced: README MCP-tool count 38→39 + model-qualification bucket 6→7 +
    plugin-commands 36→37 (base 19→20) + tool table row; `bin/llm-ext`
    TOOL_CATALOG entry; `docs/agent-usage-reference.md`,
    `docs/tool-use-cases.md`, `rules/use-llm-externalizer.md`. Roster tests
    bumped (`src/index.test.ts`, `src/mass_scouting/mcp-tools.test.ts` 22→23);
    `doc-consistency` gate green.

**The read-only-MCP guardrail is upheld:** the MCP `check_tool_replacements`
tool REPORTS (writes a markdown report, returns its path) and recommends — it
never mutates `settings.yaml`. The ONLY path that writes a `tool_models` entry is
the human-run CLI `llm-ext-benchmark --auto-replace --apply`. The split keeps the
server incapable of self-rewriting its own config (the standing invariant) while
a deliberate CLI / scheduled cron can adopt a recommendation.

**Status (2026-06-11):** A1–A5 SHIPPED (commits a307759, 5eb4998, 0eed8d2,
f2dde4c, 4f684af). A6 PARTIALLY DONE — the `search_existing_implementations`
benchmark shipped (real fixture corpus + deterministic P/R/F1 scorer + in-process
runner + `select-common` extraction + registry pointer + 3 surfaces); the
free-form `code_task` / `scan_folder` benchmarks (LLM-judge scorer) remain
deferred. A7 DONE (P1+P2+P3) for the two tools that have a per-tool benchmark —
`security_scan` and `search_existing_implementations`: the auto-replacement loop
runs end-to-end (ledger → degraded verdict → benchmark → recommend → CLI-only
adopt), surfaced on all 3 surfaces with the read-only-MCP guardrail upheld. The
BROADER rollout across the remaining tools follows automatically as each new
per-tool benchmark lands (the planner already iterates every registry tool whose
`.benchmark` the default runner can dispatch) — it pends only the free-form
`code_task` / `scan_folder` LLM-judge benchmarks (A6's deferred half). Verified:
build + lint green; 1067/1067 tests pass (4 live skipped); dogfood 100 PASS / 0
FAIL / 1 SKIP.

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
  doc. Silent-overwrite is a data-loss footgun. — **DONE** (implemented real
  resume; [[TRDD-66da2aa7]], commit 8bee08a).
- **B3 [HIGH→RE-SCOPED] cluster whole-corpus in-memory load** — original finding:
  "in-memory load contradicts the documented 10k–1M streaming contract; stream
  from the JSONL + checkpoint instead." **2026-06-18 source re-verification found
  the original fix MIS-TARGETED — do NOT implement "stream from the JSONL" as
  written, it would not unlock 1M-item runs.** Facts (all VERIFIED from source):
  - The corpus IS held in memory, multiple times: `runClusterSynonyms`
    (`cluster_synonyms_main.ts:302`) drains the JSONL into `items[]` via
    `readClusterJsonl` (`jsonl.ts:93-97`), then builds `itemsById` Map (`:309`),
    `uf.add` over all ids (`:347-348`), and `partition` over all ids (`:396`).
  - BUT the §3 design contract of [[TRDD-220ea89f]] (line 79) explicitly SANCTIONS
    the row accumulator: "no full-file load; 1M items at ~50 chars ≈ 50 MB on disk,
    ~50 MB in memory after row parsing — acceptable." The code already streams the
    FILE (no `readFileSync` blob; `streamJsonl` = `createReadStream`+`readline`).
    So "stream from the JSONL" targets the ONE part the design already accepted.
  - That §3 math is INCOMPLETE: it counts only parsed rows. The real high-N
    consumer is the **embeddings bundle** — `compute_embeddings:true` by default
    (`policy.ts:19`, model `all-MiniLM-L6-v2` 384-dim, `:18`), computed for ALL
    items at once (`:330-334`) and passed to phase1/phase2 (`:355`,`:376`). Est.
    1M × 384 × 4 B ≈ **1.5 GB** (arithmetic), plus uf+partition+itemsById (~300 MB)
    → ~2 GB on the default path, beyond a typical Node heap. The true default-path
    ceiling is embeddings-dominated, order-of-100k not 1M (UNMEASURED — needs a
    growth-curve run to pin the OOM point).
  - Net: streaming the JSONL saves the ~50 MB the contract already accepted and
    leaves the GB-scale embeddings/uf/partition materialized. Real 1M streaming
    needs out-of-core embeddings + disk-backed union-find/partition — a LARGE,
    multi-session rewrite with real clustering-correctness risk, NOT scoped by the
    §3 contract (which only addressed the file read).
  - **Re-scoped options (PRODUCT-DIRECTION DECISION — pending USER):**
    **(B)** near-term, low-risk: add a fail-fast guard that estimates the in-memory
    footprint (items + embeddings@dim + uf/partition) and EXITS with a clear,
    actionable error above a measured ceiling (honors the hard fail-fast rule;
    today a 1M run silently OOMs mid-flight AFTER spending phase-2/3 LLM budget),
    and correct the tool description's unbacked "10k–1M" (`index.ts:4840`) to the
    real tested ceiling. **(A)** full out-of-core/streaming rewrite to actually
    honor the 1M contract (embeddings mmap/disk-backed, disk-backed uf/partition).
    Recommendation: **B** unless real million-item runs are required — A is the
    speculative capability ("don't build for imaginary scenarios"); B fixes the
    silent-failure footgun now. The "stream from the JSONL" phrasing of the
    original finding is RETIRED (mis-diagnosed). Decision belongs to the user.
- **B4 [MEDIUM] cluster preflight benchmark never wired** into the entry path
  (`cluster/preflight_benchmark.ts` exists, unused). Wire it or remove.
  — **DONE (wired)** 2026-06-12. The MCP `cluster_synonyms` dispatch (the sole
  production hooks site — the CLI routes through the server) now supplies a
  `preflight` hook via the new `makePreflightHook` adapter, which wraps
  `runPreflightBenchmark` (daily per-model cache) and maps its `{pass,reason}`
  to the core's `{ok,reason}` gate. Preflight runs by default (policy default
  `skip_preflight_benchmark:false`); a model that can't cluster 3 sentences
  fails the gate before an expensive run, and an LLM-call failure fails closed.
  Opt out via the policy flag. 4 adapter tests added.
- **B5 [MEDIUM] cluster `partition()` recomputed 3–4× at emit** — cache once.
  — **DONE** (computed once after phase-2; [[TRDD-66da2aa7]], commit 8bee08a).

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
