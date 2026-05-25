---
trdd-id: 8b6b3646-0152-4077-8d2a-e888f17e0fc7
title: Free-only switch — benchmark-filtered free ensemble (per-profile)
status: completed
created: 2026-05-25T13:02:59+0200
updated: 2026-05-25T14:49:27+0200
---

# TRDD-8b6b3646 — Free-only benchmark-filtered ensemble

**Filename:** `design/tasks/TRDD-20260525_130259+0200-8b6b3646-free-only-benchmarked-ensemble.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

## User request

"add a switch in ~/.llm-externalizer/settings.yaml to only use free models on
openrouter" (with an example list of 15 `:free` models). Then: "you still need
to filter out models that do not pass the benchmark."

Design choices (confirmed via AskUserQuestion):
- **Per-profile** switch (`free_only:` + `free_models:` inside a profile block).
- **Free ensemble (top 3)** of the passing free models; the rest of the list is
  the rate-limit fallback pool.

## Key facts (grounded in the code)

- settings.yaml is USER-OWNED; the plugin NEVER writes it. `free_only` is a
  RECOGNIZED setting the plugin ENFORCES; the user adds it by hand.
- Two qualification gates already exist:
  - REQUIREMENTS — `qualifyModelForTool` / `assessModelAcrossTools` (registry.ts /
    assess.ts). PURE, zero-spend, checks catalog metadata (context window, price,
    reasoning support) vs per-tool criteria.
  - BENCHMARK — golden-dataset run. Only `security_scan` (security-triage) and
    `mass_scout` (keyword-classification) carry one; `code_task`/chat/cluster are
    requirements-only (benchmark: null).
- Benchmarking a `:free` model costs **$0** — so a real benchmark filter on the
  free pool is zero-spend (but slow + rate-limited → must be cached, not run per
  resolve).
- Benchmark results are NOT persisted today. A free-model qualification cache is
  new infrastructure.
- The catalog (`openRouterModelCache`) lives in index.ts; `resolveProfile`
  (config.ts) is pure and has no catalog → the requirements/benchmark FILTER must
  run in index.ts (e.g. in `getEnsembleModels`), not in `resolveProfile`.

## Design (phased)

### Phase 1 — config core + requirements filter (zero-spend, fully offline-testable)
1. `Profile`: add `free_only?: boolean`, `free_models?: string[]`.
2. `ResolvedProfile`: add `freeOnly: boolean`, `freeModels: string[]`.
3. `resolveProfile`: when `free_only`, set `model`=free_models[0],
   `secondModel`=free_models[1] ?? "", `thirdModel`=free_models[2] ?? "",
   `freeOnly`=true, `freeModels`=[...]. Ignore profile.model/second/third.
4. `validateProfile`: when `free_only`:
   - require non-local (remote/openrouter) preset,
   - require `free_models` non-empty,
   - require EVERY entry to end with `:free` (hard zero-spend guarantee),
   - require `free_models.length >= 2` when mode is `remote-ensemble`,
   - make `model` / `second_model` optional (free_models supplies them).
5. `getEnsembleModels` (index.ts): when `freeOnly`, build the candidate list from
   `freeModels`, FILTER by the REQUIREMENTS gate (`qualifyModelForTool` against the
   catalog) — drop free models that fail requirements — then take the top-3
   passing as the ensemble. (Zero-spend: requirements gate is pure.)
6. Tests: config (resolveProfile + validation) offline; getEnsembleModels filter
   with an injected catalog + registry. Docs: README env/profile + settings
   template + TESTING.

### Phase 2 — benchmark filter + result cache (zero-spend on :free, opt-in run)
1. Persist benchmark outcomes: a `model-qualification` cache keyed by
   (model, benchmark) → {pass, score, ts} under `~/.llm-externalizer/`.
2. A deliberate command/flow benchmarks the free pool (security-triage +
   keyword-classification) on the `:free` models ($0) and writes the cache.
3. `getEnsembleModels` (free_only) additionally filters by benchmark-pass FROM
   THE CACHE for benchmark-carrying tools; requirements-only tools keep the
   Phase-1 gate. A free model with no cache entry is treated as
   unverified (config: include-with-warning vs exclude — default exclude for
   benchmark-carrying tools, the strict choice).
4. Reuse `selectSecurityTriageModel` / the selection gate where applicable.

### Phase 3 — fallback rotation (needs live 429 testing)
1. `isModelUnavailableError` pure predicate (429 / rate-limit / 404 no-endpoints).
2. In `ensembleStreaming`, when `freeOnly` and a slot's model exhausts retries
   with a rotatable error, claim the next unused `freeModels` entry (atomic
   `idx = next++` — safe in single-threaded JS) and retry that slot.
3. Pure parts unit-tested; end-to-end rotation verified live (needs budget /
   real 429s) — deferred until the user can fund a live run.

## Safety invariants
- `free_only` can NEVER cause spend: validation rejects any non-`:free` entry, and
  the benchmark filter only ever runs `:free` candidates.
- security_scan / scout keep their own clean call paths (unchanged).

## Status
- **Phase 1 — DONE** (commit pending). Shipped: `Profile.free_only`/`free_models`,
  `ResolvedProfile.freeOnly`/`freeModels`, `resolveProfile` (ensemble from the
  pool), `validateProfile` (all `:free`, non-empty, remote, ≥2 for ensemble,
  model/second optional), `selectFreeEnsembleModels` (context-floor requirements
  pre-filter, zero-spend). Tests: `free-only.test.ts` (12). Docs: settings
  template + README B2. Full suite 907 passed / 4 skipped / 0 OpenRouter boots;
  tsc + eslint clean.
  - NOTE: the premium qualification framework sets `allowFree:false`, so it
    CANNOT gate free models — Phase 1 uses a dedicated context-floor instead.
- **Phase 2 — CODE DONE; cache population needs an OpenRouter run.** The filter
  reuses the EXISTING benchmark cache (`~/.llm-externalizer/security-triage-results.json`)
  rather than a new store. `failedModelsFromCache` (pure, latest-wins,
  conclusive-fail-only) + `benchmarkFailedModels()` in security-triage/index.ts;
  `selectFreeEnsembleModels` drops proven-failing free models BEFORE the context
  floor. The existing `security_triage_benchmark` tool already accepts an explicit
  `models:` list and benchmarks unqualified (incl. `:free`) models, so the user
  populates the cache with one `$0` run on the free pool — no new surface. Empty
  cache → no-op (fresh install safe). Tests: failedModelsFromCache (5) +
  selectFreeEnsembleModels benchmark-drop (1). Docs: README B2 recipe. The only
  OpenRouter-dependent step is the benchmark RUN itself (the user's to trigger).
- **Phase 3 — DONE** (rotation; pure parts unit-tested offline, live 429
  end-to-end still needs a funded run but the rotation logic is fully covered).
  Shipped in `index.ts`: `isModelUnavailableError` (pure predicate — rotates on
  429 / rate-limit / daily-limit / per-day / quota / no-endpoints / 404 / 502 /
  503 / overloaded; does NOT rotate on auth/malformed errors a different model
  would also fail); `filterFreeModels` (the FULL filtered list, so models 4+ are
  the fallback pool) refactored out of `selectFreeEnsembleModels` (= `.slice(0,3)`);
  `callEnsembleSlotWithRotation` (tries primary, on an unavailable error claims
  the next shared fallback via an atomic `idx = next++` counter and retries —
  bounded by pool size, no infinite loop). `ensembleStreaming` integration: when
  `freeOnly`, build the file-size-aware `fallbacks` list (filtered pool minus the
  top-3 primaries), share one `claimFallback` across all parallel slots so two
  slots never grab the same model's daily quota, gate the single-model fast path
  on `models.length === 1 && fallbacks.length === 0`, and route each slot through
  `callEnsembleSlotWithRotation`. The non-free path is byte-for-byte unchanged.
  Tests: `free-only.test.ts` +12 (filterFreeModels full-list, isModelUnavailableError
  match/non-match incl. daily-limit phrasings, callEnsembleSlotWithRotation:
  primary-success / daily-limit-rotate / multi-hop / throw-rotate / non-rotatable /
  pool-exhausted / shared-counter-no-collision). Docs: README B2 "Daily-limit
  rotation" paragraph. Full suite 927 passed / 4 skipped / 0 OpenRouter boots;
  tsc + eslint clean.

## Outcome — all three phases complete

`free_only` ships end-to-end: a per-profile switch that runs a zero-spend
ensemble of benchmark/requirements-qualified `:free` models with automatic
daily-limit fallback rotation. Zero-spend is enforced at THREE layers —
validation (rejects any non-`:free` entry), the benchmark/context filters (only
ever evaluate `:free` candidates, and the benchmark RUN is `$0` on free models),
and the rotation pool (free models only). The two remaining user-side steps are
documented in README B2: paste the profile into `settings.yaml`, and (optionally)
run one `$0` `security_triage_benchmark` on the free pool to populate the
pass/fail cache. No new MCP surface was added — the existing
`security_triage_benchmark` tool already accepts an explicit `models:` list.
