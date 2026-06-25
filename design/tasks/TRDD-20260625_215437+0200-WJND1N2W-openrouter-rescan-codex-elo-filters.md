---
trdd-id: WJND1N2W
title: OpenRouter model rescan — codex/design-arena pre-filters, free-no-suffix inclusion, skills update
column: dev
created: 2026-06-25T21:54:37+0200
updated: 2026-06-25T22:54:33+0200
current-owner: claude-llm-externalizer
assignee: claude-llm-externalizer
priority: 3
severity: MEDIUM
effort: L
labels: [openrouter, benchmark, discovery, free-pool, credit-safety, skills]
task-type: feature
parent-trdd: null
npt: []
eht: []
blocked-by: []
relevant-rules: []
release-via: publish
delivery: direct-push
target-branch: main
test-requirements: [unit, typecheck, lint]
audit-requirements: []
review-requirements: [human-review]
runtime-targets: [macos, linux]
impacts: [config-schema, public-api]
attempts: 0
test-failures: 0
last-test-result: pass
implementation-commits: [2ca844b, 582affc, 09c1f64, 59fb4b3]
external-refs: ["https://openrouter.ai/api/v1/models"]
---

# OpenRouter model rescan — codex/design-arena pre-filters + free-no-suffix inclusion

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-06-25

**Goal (user's verbatim intent, 2026-06-25):** "launch the skill to rescan openrouter for
compatible models, both normals and free. Identify the 3 best cheap models for the ensemble
mode, as usual, but if you find free models passing the ensemble mode benchmark, include them
in the ranking. for example there is a free model called `openrouter/owl-alpha` (note the
missing `:free` suffix) that it is a big model under open beta, free for a while. Include it
in the ensemble as well as in the free models benchmarks and if it pass, use it. do this
automatically for all models when benchmarking. But beware: the benchmarking of paid models
consumes credits! i only have recharged $20 in openrouter. try to use other filters to
restrict the candidates before running the benchmarks. And add all these instructions to the
skills used to update the remote models. openrouter has 2 benchmark indexes reported for each
model that can be used: `codex index score`, and `design arena code categories ELO`. see if
you can find them, and use them to restrict the candidates before running the actual benchmark
and consuming tokens."

**Current state (2026-06-25):** P1 + P2 DONE + committed (2ca844b, 582affc).
- P1 (data layer): both indexes parsed from the catalog `benchmarks` object via defensive pure
  extractors + decorated onto `QualifiedModel`; +9 tests.
- P2 (quality pre-filter): pure `rankByQualityIndex` (scored>unscored; composite of min-max-
  normalised codex + design-arena code ELO over PRESENT axes; cheapest tiebreak). Wired into all
  3 candidate paths — keyword/ensemble ranks best-first + honours a NEW `--qualifying-top-n N`
  pre-benchmark cap (vs `--pick-top-n` = post-run result cap; `--include` baselines never capped);
  search-existing + security-triage swap cheapest-sort → quality-rank before their top-16 cap.
  +5 tests; 178 benchmark tests green, typecheck/lint/build clean. **owl-alpha already competes in
  the ENSEMBLE via P1+P2** (it qualifies at $0 and gets ranked by its indexes).
- P3a (semantic chokepoint, 09c1f64): the runtime free_only guard is now `:free OR catalog-price-0`
  (pure `isZeroCostPriced` + `isFreeModeEligible`); +5 tests incl. priced-no-suffix→REJECTED and
  NaN/Infinity→REJECTED; 183 benchmark tests green. **owl-alpha now passes the free-mode chokepoint**,
  so it is benchmarked in free_only ENSEMBLE runs — the core "use it if it passes" path is covered.
- P3b (free-pool verify + auto-discovery, 59fb4b3): pure `resolveFreePool` resolves `--bench-free-pool`
  against the LIVE catalog — a configured non-`:free` id is admitted only when the catalog prices it $0
  (else fail-fast BEFORE any run, since --bench-free-pool can run without a free_only profile, so the
  chokepoint is not the only guard), and auto-discovery adds every structurally-qualified zero-cost
  catalog model (incl. no-suffix owl-alpha), ranked by the P2 indexes, capped at `--qualifying-top-n`.
  +3 tests; **full suite 1247 green**. **owl-alpha is now in BOTH the ensemble AND the dedicated free
  benchmark, automatically — the user's full intent.**
P4/P5 pending. No paid run without explicit user OK ($20 budget).

**P3 DESIGN (P3 COMPLETE — chokepoint 09c1f64 + free-pool resolve/auto-discover 59fb4b3):** The free
pool is "zero-spend by construction" (TRDD-97ef8b63) via the `:free` SUFFIX at three sites — the
runtime chokepoint `runner.ts:166`, and the load-time validators `benchmark/index.ts:426` +
`config.ts:584`. To admit owl-alpha (price-0, no `:free`) into the FREE-pool benchmark WITHOUT
weakening zero-spend, make the guarantee SEMANTIC, not syntactic:
- **Chokepoint (the airtight guard, `runner.ts:166`):** allow in free mode iff `id.endsWith(":free")
  OR (inputDollarsPerMillion === 0 && outputDollarsPerMillion === 0)`. The `QualifiedModel` already
  carries the parsed catalog prices, so this needs NO new fetch. Sound because OpenRouter BILLS per
  the same catalog price → price-0 = $0 for the call; if a beta model flips to paid the re-read
  price is non-zero → rejected (fail-safe). This is the single source of zero-spend truth.
- **Validators (`index.ts:426`, `config.ts:584`):** relax the `:free`-only string check to accept a
  non-`:free` id, deferring the zero-cost verification to catalog-resolution + the chokepoint
  (config-load is synchronous and has no catalog). They were belt-and-suspenders on top of the
  chokepoint; with a price-aware chokepoint they relax to match without losing the guarantee.
- Tests MUST include: `:free` admitted, price-0-no-suffix admitted, **price>0-no-suffix REJECTED**
  (the critical safety case), flip-to-paid rejected.

**FEASIBILITY — VERIFIED (the load-bearing research win):** Both indexes are exposed as
structured JSON on the UNAUTHENTICATED, $0 `GET https://openrouter.ai/api/v1/models`:
- **codex index** = `benchmarks.artificial_analysis.coding_index` (number; present on ~60/339
  models; live but lightly-documented).
- **design-arena code ELO** = an entry in `benchmarks.design_arena[]` where `arena == "models"`
  and `category == "codecategories"`, its `.elo` field (~94/339 models).
- So a credit-FREE quality pre-rank is genuinely viable. Evidence + sample JSON in the durable
  artifact below.

**VERIFIED code facts (read discover.ts whole + the free-pool validators):**
- `mcp-server/src/benchmark/discover.ts` is the discovery+filter core. SSOT predicate:
  `disqualifyReason(m, criteria)` (128-167). Types: `OpenRouterModel` (31-45, NO `benchmarks`
  field yet), `ModelCriteria` (47-56), `DEFAULT_CRITERIA` (58-71), `QualifiedModel` (73-83).
  `fetchProgrammingModels` (92-102) hits the public catalog. `filterModels`→`qualify`→
  `disqualifyReason`. `buildBenchmarkRoster` (215-259) = candidates(filtered)+baselines(includeIds).
- The `:free` exclusion is ONE line: `disqualifyReason` 129 (`!allowFree && id.endsWith(":free")`).
- **owl-alpha (price-0, no `:free` suffix) ALREADY passes the PAID candidate filter** (0 < $1/M).
  Its real exclusion is the FREE pool: `benchmark/index.ts:423-431` (`--bench-free-pool` THROWS
  on any non-`:free` id) and `config.ts:584-589` (free_only profile validation throws likewise).
- **WHY the `:free` suffix is load-bearing:** `benchmark/index.ts:420-422` documents the free
  pool is "genuinely zero-spend BY CONSTRUCTION" — the runner's free_only chokepoint
  (runner.ts:166, TRDD-97ef8b63) rejects any non-`:free` id, so a `:free`-only pool cannot bill.
  A price-0-no-suffix open-beta model (owl-alpha) breaks that structural guarantee: it could flip
  to paid when the beta ends and silently spend credits.

**DESIGN DECISIONS:**
1. **Indexes are a credit-free PRE-RANK + TOP-N restrictor, NOT a hard disqualifier.** Only
   18-28% of models carry an index; hard-failing index-less models would gut the pool. So: after
   the existing hard caps (`disqualifyReason`), RANK survivors by a composite quality score
   (codex coding_index + design-arena code ELO, normalized; index-less models rank below
   indexed ones, cheapest-first as the final tiebreak), then benchmark only the TOP-N
   (`qualifying_top_n`, default SMALL — e.g. 8 — to protect the $20 budget). This is the
   "restrict candidates before the paid benchmark" the user asked for. `--include` still bypasses.
2. **owl-alpha / free-no-suffix inclusion WITHOUT breaking zero-spend** — change the free-pool
   membership test from SYNTACTIC (`endsWith(":free")`) to SEMANTIC + RUNTIME-GUARDED: a non-
   `:free` id is free-eligible IFF the live catalog shows `pricing.prompt == 0 && completion == 0`,
   AND a runtime price re-check before each free call aborts (fail-fast) if it ever reads non-zero.
   This keeps the zero-spend GUARANTEE (now semantic + runtime-verified, not just syntactic) while
   admitting owl-alpha. → **This is the one design fork to confirm with the user (budget owner)
   before building Phase 3.**
3. **Skills updates** — fold the codex/ELO pre-filter rule + the free-no-suffix rule into the
   model-update commands/skills (discover-new-models, bench-free-pool, benchmark,
   search-existing-benchmark, ensemble-autoselect).

**NEXT ACTION (resume here — all $0 until P5):** P4 — fold the two new rules into the model-update docs
(commands: bench-free-pool, benchmark, discover-new-models, search-existing-benchmark,
security-triage-benchmark; skill: ensemble-autoselect): (1) the credit-FREE codex / design-arena code-ELO
pre-rank + `--qualifying-top-n` cap that restricts candidates BEFORE the paid benchmark; (2) zero-cost
no-suffix models (e.g. owl-alpha) are auto-included in the ensemble ($0 candidate) and the free benchmark
(catalog-price-verified + auto-discovered). Then README/docs, dogfood, full suite. P5 = GATED paid rescan
(user OK only; the pre-filter lands first so it spends minimally on the $20 budget).
Note: `config.ts:584` (manual `free_models`) kept `:free`-only by design — conservative; FREE_POOL_SEED +
auto-discovery are the price-0 inclusion paths, so no user-facing config relaxation was needed.

**PHASES:**
- **P1 — data layer (no behavior change, fully unit-testable, $0):** extend `OpenRouterModel`
  with an optional `benchmarks` shape; add pure helpers `extractCodexIndex(m)` / `extractDesignArenaCodeElo(m)`
  → number|undefined; decorate `QualifiedModel` with optional `codexIndex`/`designArenaElo`. Unit
  tests over fixture JSON (real shapes from the research report).
- **P2 — pre-rank + top-N restrict ($0 pure ranking):** add `rankByQualityIndex(models)` + wire a
  `qualifyingTopN` cap into the candidate-pool path before the benchmark roster. Tests assert the
  ordering (indexed>non-indexed, higher index first, cheapest tiebreak) + the cap.
- **P3 — semantic free-detection + runtime price guard (the owl-alpha path):** `isEffectivelyFree(model, catalog)`;
  relax the two free-pool validators to accept verified-price-0 ids; add the runtime pre-call price
  re-check (fail-fast). Tests cover :free, price-0-no-suffix (accept), and price-flips-to-paid (abort).
- **P4 — skills/docs:** update the 5 model-update commands/skills + README/docs; dogfood; full suite.
- **P5 (gated):** run the actual rescan (`llm-ext-benchmark` discover→pre-rank→top-N→benchmark) —
  ONLY after user OK; report the recommended 3-best-cheap ensemble + any qualifying free models.

**Durable artifacts to read before acting:**
- `reports/llm-ext-model-rescan/20260625_214644+0200-openrouter-indexes-research.md` — the
  OpenRouter API research: exact field paths, model counts, sample JSON, feasibility verdict.

## Background

This task hardens the model-rescan/benchmark pipeline so it spends the least credit possible
(the user has $20 in OpenRouter) by ranking candidates on TWO free, catalog-provided quality
indexes BEFORE any paid benchmark, and by admitting open-beta "free for now" models (price 0,
no `:free` suffix) into both the ensemble and the free benchmark without surrendering the
free pool's structural zero-spend guarantee.

The decisions and verified facts above are the plan; the phases are sized so every non-paid
phase (P1-P4) lands with tests and zero credit spend, and the only credit-spending step (P5)
is explicitly user-gated.
