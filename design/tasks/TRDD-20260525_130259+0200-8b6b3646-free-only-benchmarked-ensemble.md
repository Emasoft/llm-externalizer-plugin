---
trdd-id: 8b6b3646-0152-4077-8d2a-e888f17e0fc7
title: Free-only switch — benchmark-filtered free ensemble (per-profile)
status: in-progress
created: 2026-05-25T13:02:59+0200
updated: 2026-05-25T13:02:59+0200
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
Phase 1 in progress.
