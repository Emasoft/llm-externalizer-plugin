---
trdd-id: WJND1N2W
title: OpenRouter model rescan — codex/design-arena pre-filters, free-no-suffix inclusion, skills update
column: dev
created: 2026-06-25T21:54:37+0200
updated: 2026-07-02T06:25:00+0200
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
implementation-commits: [2ca844b, 582affc, 09c1f64, 59fb4b3, d133001, eb676fc, e96faba, a3cf340]
external-refs: ["https://openrouter.ai/api/v1/models"]
---

# OpenRouter model rescan — codex/design-arena pre-filters + free-no-suffix inclusion

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-06-25

### UPDATE 2026-07-02 (later) — P5 DONE: models updated (user approved "go on 2 directly")

Ran the actual rescan. Total spend ≈ **$0.06** (well under $20). Two runs, both via the one-shot CLI
(zero orchestrator per-model loops — the token fix held; each run was one backgrounded Bash call):
- **Paid sweep** (`--qualifying-top-n 15 --pick-top-n 3 --apply-profile <name>`): `category=programming`
  + `<$1/M` + caps yields only **3 paid candidates** (mimo-v2.5-pro, mimo-v2.5, deepseek-v4-pro).
  Run 1 deepseek scored 88.6% (FAIL) → only 2 passed → pick correctly REFUSED (need 3) → nothing applied.
- **Unified free-pool sweep** (`--bench-free-pool --pick-top-n 3`): 3 paid CAND + 13 `:free` BASE = 16
  models. **12/13 free models 429/timeout** (free tier heavily rate-limited right now); only
  `nvidia/nemotron-3-super-120b-a12b:free` passed (100%, $0). All 3 paid passed 100% this run.
- **Pick (F1 desc, cost asc):** deepseek-v4-pro ($0.0028) / mimo-v2.5 ($0.0041) / mimo-v2.5-pro ($0.0083),
  all 100%. Free models enter as BASELINES → NOT pickable into the paid ensemble (by design; also
  429-unreliable as live members). The $0 nemotron-super was excluded despite 100% for this reason.
- **APPLIED** (deterministic `--from-cache`, $0) to profile **`remote-ensemble-geminigrok`** (the remote
  ensemble; the assumed name `remote-ensemble` does NOT exist): second_model
  gemini-3.1-flash-lite-preview→**mimo-v2.5**, third gpt-5.4-nano→**mimo-v2.5-pro**; deepseek-v4-pro
  unchanged as primary. Verified in settings.yaml. Takes effect after `reset` MCP tool or Claude restart.
- **Caveats surfaced to user:** (1) deepseek-v4-pro is FLAKY (88.6% then 100%) but was already the old
  primary → no regression; (2) profile name `remote-ensemble-geminigrok` is now STALE (no gemini/grok);
  (3) nemotron-3-super-120b-a12b:free passed but stays in the FREE pool (free_only mode), not the paid
  ensemble, due to 429s.
- Reports (gitignored): `reports/benchmark/20260702_054749+0200-model-comparison.md` (paid),
  `…20260702_062059+0200-model-comparison.md` (unified).
- **Remaining:** push (~44 commits) still gated on user; optional `reset`/restart to load the ensemble.

### UPDATE 2026-07-02 — token-cost audit + procedure token-fix (P-A/P-B done)

**User escalation (verbatim, 2026-07-02):** "you need to update the models, but you also need to
make the procedure less token consuming. it should be pretty much all automatable via scripts.
yet it got 30-40 million tokens each time. audit the whole system and improve it." + standing:
"All the operations you do must have a token cap. you must be token aware."

**Root cause (audit → `reports/model-update-audit/audit.md`, gitignored):** the 30–40M burn is a
ROUTING gap, NOT a code gap. The `llm-ext-benchmark` CLI already does discover→filter→credit-free
pre-rank→cap→paid-benchmark→score→pick→atomic-settings-write→report-to-file entirely inside the
Node process (nothing touches Claude context). The burn came from the orchestrator hand-rolling a
per-model loop over `chat`/`code_task`/`or_model_info` (~50–150 candidates), re-sending the growing
transcript each turn = O(N²). Fix = route every rescan to the ONE CLI call; forbid the per-model loop.

**P-A DONE + committed** (the actual token fix):
- `commands/llm-externalizer-benchmark.md` (e96faba): added proactive-rescan trigger phrases
  ("rescan models"/"update the models"/…); Step 2 mandates ONE Bash call, forbids the per-model
  loop (names it as the 30–40M failure mode), adds default `--qualifying-top-n 15` when uncapped,
  `run_in_background: true`, `--dry-run` FIRST when uncapped; examples reordered dry-run→bounded→exhaustive.
- `skills/llm-externalizer-ensemble-autoselect/SKILL.md` (a3cf340): trigger list extended from
  reactive-only (404/breakage) to ALSO proactive rescans; both resolve to the SAME single CLI call.

**P-B DONE** (credit-safety hardening, this session, uncommitted at time of writing):
- `mcp-server/src/benchmark/runner.ts`: guard-comment on `RunResult.rawResponse` documenting the
  non-serialization INVARIANT (must never reach report.ts/pick.ts/benchmark-results.json — it is
  tens-of-KB/model and would re-inflate an orchestrator's per-turn context, the exact blow-up the
  routing fix prevents). Comment-only ⇒ provably compile-safe (no tsc needed).

**Deliberate NO-GO (recorded so it is not re-litigated):** a DEFAULT `--qualifying-top-n` cap (or
forced-confirmation) INSIDE the CLI was considered and REJECTED. Rationale: (1) CLI runs cost
OpenRouter *credit*, not Claude *tokens* — they never touch context, so a CLI cap does nothing for
the token burn; (2) the user wants the procedure scriptable — a silent default cap/refusal breaks
scriptability and the fail-fast principle (a script author wanting exhaustive would be surprised);
(3) the credit gate the user asked for ("pre-filter + estimate + ASK before large paid runs") is
already enforced at the ORCHESTRATION layer by P-A's mandated dry-run-first ($0 candidate count)
+ cap-15 default. The cap belongs where the burn occurred (orchestrator), not in the CLI.

**NEXT = P5 (the actual model update) — GATED on explicit user $-OK ($20 OpenRouter budget):**
1. `llm-ext-benchmark --dry-run` → surface the qualifying candidate count ($0, no API calls).
2. On OK: PAID ensemble `llm-ext-benchmark --qualifying-top-n 15 --pick-top-n 3 --apply-profile
   remote-ensemble` (backgrounded) + FREE ensemble `--bench-free-pool` (admits owl-alpha-style $0).
3. Show the $ estimate BEFORE spending; WAIT for approval. No push (publish-only; ~44 commits unpushed).


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
- P4 (docs, d133001 + eb676fc): the codex/ELO pre-filter + zero-cost-no-suffix rules folded into all 6
  model-update docs (ensemble-autoselect skill + benchmark / bench-free-pool / discover-new-models /
  search-existing-benchmark / security-triage-benchmark commands) + README. The discover-new-models draft
  was CORRECTED — it overclaimed that the --new-arrivals phase ranks by the indexes; verified
  rankByQualityIndex lives ONLY in the benchmark candidate paths (index.ts:598, search-existing:330,
  security-triage:338), so the doc now attributes the pre-rank to the benchmark commands. Dogfood
  103 PASS/0 FAIL; doc-consistency + full suite green.
**Feature work P1–P4 COMPLETE** (built, tested 1247-green, documented, dogfooded). Only P5 remains, and
P5 (the paid rescan) + the push are BOTH gated on the user. No paid run without explicit OK ($20 budget).

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

**NEXT ACTION — P5 is GATED on the user (paid; the $20 OpenRouter budget):** run the actual rescan via
`llm-ext-benchmark` (discover → codex/ELO pre-rank → `--qualifying-top-n` cap → benchmark), then report the
recommended 3-best-cheap ensemble + any qualifying free models (incl. owl-alpha if it passes). The pre-filter
now bounds spend — pick a small `--qualifying-top-n` (e.g. 5–8) to cap paid runs. DO NOT run without explicit
user OK. The 39 local commits also remain gated ("Do not push. Wait for my approval first.").
Note: `config.ts:584` (manual `free_models`) kept `:free`-only by design — conservative; FREE_POOL_SEED +
P3b auto-discovery are the price-0 inclusion paths, so no user-facing config relaxation was needed.

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
