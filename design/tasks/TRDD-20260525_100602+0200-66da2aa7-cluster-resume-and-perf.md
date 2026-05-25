---
trdd-id: 66da2aa7-82b0-4c6f-8d77-53f62bb39405
title: cluster_synonyms — honor resume_from (data-loss fix) + cache partition + stale-comment cleanup
status: in-progress
created: 2026-05-25T10:06:02+0200
updated: 2026-05-25T10:06:02+0200
---

# TRDD-66da2aa7 — cluster_synonyms resume + perf

**Filename:** `design/tasks/TRDD-20260525_100602+0200-66da2aa7-cluster-resume-and-perf.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)
**Source spec:** [[TRDD-828238b5]] Part B (B2 + B5; B1/B3/B4 deferred below).

## Why now

`/go-on-yourself` (2026-05-25), after Part-D ([[TRDD-6e859d3c]]) landed. Verified
the cluster B-series on real ground; B2 is a HIGH-severity data-loss footgun with
a small, well-understood fix, and B5 is a safe perf win. B3/B4/B1 are larger
design/refactor items, deferred with verified facts.

## Verified facts (read the code, not the audit)

- **B2 (data-loss):** `runClusterSynonyms` (cluster_synonyms_main.ts) sets the
  checkpoint path to `join(output_dir, "checkpoint.sqlite")` (line 331),
  IGNORING `invocation.resume_from`'s value. `resume_from` is used ONLY to flip
  `resuming` (line 289), which bypasses the output-dir non-empty guard
  (`gateOutputDir(..., resuming)`, line 304). Net: passing `resume_from`
  suppresses the overwrite safety-guard but loads the wrong/empty checkpoint →
  the run re-clusters and OVERWRITES the output dir. The resume MACHINERY exists
  and works (`CheckpointDB.open/loadUnionFind/saveUnionFind`; `uf` is rehydrated
  at line 333; phase-1 is checkpoint-aware) — only the path wiring is broken.
  Existing "resume" test (`wiring.test.ts:70`) checks only that the arg PARSES,
  not that resume behaves. The line-7 module comment ("Phase 2 / Phase 3 /
  resume are placeholders") is STALE — Phase 2 (line 358) and Phase 3 (line 385)
  are fully implemented.
- **B5 (perf):** `uf.partition()` (an O(n) Map rebuild) is recomputed at emit by
  `writeClustersJsonl` (line 221) AND `buildSummary` (line 243) over the
  identical final union-find, plus a third time in the phase-3-LLM branch (line
  386). `uf` is final after the phase-2 merge loop (line 374) and is not mutated
  before emit.

## Changes (this TRDD)

1. **B2 — honor `resume_from`:** `checkpointPath = invocation.resume_from ??
   join(output_dir, OUTPUT_NAMES.checkpoint)`. When `resume_from` is provided,
   VALIDATE it exists (fail-fast `buildEarlyAbort` with a clear error) so a
   typo'd path can't silently fall through to a from-scratch overwrite — closing
   the footgun for the missing-file case too. Load/save then use that path; the
   existing rehydrate + phase-1 skip do the real resume. Fix the stale line-7
   comment.
2. **B5 — compute `partition` once:** build `const partition = uf.partition()`
   right after the phase-2 merge loop; pass it to the phase-3 branch,
   `writeClustersJsonl`, and `buildSummary` (change those two internal helpers to
   take a `partition: Map<string,string[]>` instead of `uf`). Eliminates 2-3
   redundant O(n) recomputes per run; output is byte-identical.

## TDD

- New behavioral resume test (the gap `wiring.test.ts` leaves): pre-populate a
  checkpoint with a union edge, run with `resume_from` pointing at it, assert the
  emitted clusters reflect the rehydrated edge (merged) — i.e. resume actually
  continues prior work rather than re-clustering from scratch. Plus a missing
  `resume_from` path → clean error (no overwrite).
- B5 is a refactor with byte-identical output: the existing end-to-end cluster
  tests (`cluster_synonyms_main.test.ts`) guard it; add an assertion only if a
  gap appears.
- `npm run build` + full `npm test` (TS change → the 883-test suite must stay
  green); `tsc --noEmit` + eslint clean.

## Deferred (verified, NOT rushed — focused follow-up)

- **B1 [MAJOR]** index.ts monolith split (9.6k lines; runs `main()` on import —
  also blocks an in-process A6 benchmark runner). Large, incremental, suite-guarded.
- **B3 [HIGH]** cluster loads the whole corpus into memory, contradicting the
  documented 10k–1M streaming contract. A streaming refactor (read JSONL +
  checkpoint incrementally) — large; needs a memory-bound test.
- **B4 [MEDIUM]** preflight benchmark is never wired into the production entry
  (`csHooks` in index.ts:9443 omits `preflight`; only tests inject it). "Wire or
  remove" is a DESIGN+COST decision: wiring it runs an LLM benchmark on every
  cluster call unless `skip_preflight_benchmark=true` (policy default false → it
  WOULD run). Decide opt-in-vs-opt-out + confirm `runPreflightBenchmark`'s
  contract before wiring. Prefer integrating (per directive) but not on a
  session tail.
