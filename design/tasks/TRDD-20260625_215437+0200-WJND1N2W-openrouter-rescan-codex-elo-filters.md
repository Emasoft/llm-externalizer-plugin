---
trdd-id: WJND1N2W
title: OpenRouter model rescan — codex/design-arena pre-filters, free-no-suffix inclusion, skills update
column: dev
created: 2026-06-25T21:54:37+0200
updated: 2026-06-25T22:02:32+0200
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
implementation-commits: [2ca844b]
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

**Current state (2026-06-25):** P1 (data layer) DONE + committed (2ca844b). The two indexes are
parsed from the catalog `benchmarks` object via defensive pure extractors and decorated onto
`QualifiedModel` (no behavior change yet); +9 unit tests, discover 19/19 green, typecheck + lint
clean. P2-P5 pending. No paid run will happen without explicit user OK ($20 budget).

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

**NEXT ACTION:** build P2 — pre-rank candidates by codex/ELO + top-N restrict ($0 pure ranking):
a `rankByQualityIndex(models)` in discover.ts (indexed-above-unindexed, higher index first,
cheapest tiebreak) + a `qualifyingTopN` cap applied to the candidate pool before the benchmark
roster. Then P3 (semantic-free owl-alpha — modifies the `free_only` chokepoint; MUST preserve
zero-spend via a runtime price re-check; document the safety reasoning), P4 (skills/docs +
dogfood + full suite), P5 (GATED paid rescan — user OK only).

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
