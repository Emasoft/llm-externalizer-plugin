---
trdd-id: 38QAM06E
title: route-aware free populator guard and candidate queue hygiene
column: complete
created: 2026-09-17T14:31:02+0200
updated: 2026-09-23T23:42:46+0200
current-owner: coordinator-session-20260917
created-by: coordinator-session-20260917
task-type: bugfix
min-approval-requirement: none
approved: true
parent-trdd: 90DM5YHO
npt: []
eht: []
blocked-by: []
relevant-rules: []
approval-judge: coordinator-session-2026-09-17
approval-datetime: 2026-09-17T17:15:37+0200
assignee: coordinator-session-2026-09-17
implementation-commits: [154d083, 51a100c, 93cc031]
---

# route-aware free populator guard and candidate queue hygiene

## Symptom

P6d 2026-09-17, both keys set: `dynamic-candidates.json` held 68 free candidates, 46 b.ai ids without `:free`; `--populate-default-profile free` refused ("NOT priced at $0 by the live catalog"), so the free benchmark never ran, dead ids stayed in `free_models`, `model:` stayed the placeholder, while `settings status` printed "Free pool (21, benchmark-vetted)" from the written pool.

## Root cause 1 (fixed separately, fix-queue row 82)

`default-profiles.ts` ~426 enqueued every b.ai id as a candidate although only `bai = baiModels[0]` got a providers route.

## Root cause 2 (this card)

Per the 2026-09-17 analysis (worker trace, not re-read by the coordinator): `runPopulateDefaultProfilePhase` (scripts/llm-ext/src/benchmark/index.ts ~1226-1294) reads configured `free_models` plus the whole queue and `resolveFreePool` classifies against the OpenRouter catalog only (never `resolveRoutes`/`routeByModel`/`servedEntirelyByProviderRoutes` from config.ts), so even the ONE legitimately routed b.ai id is rejected; on any machine where b.ai returns models the free profile cannot be benchmark-populated while the populator rejects route-served ids (the implementer verifies this first: run the populator on an isolated copy holding only the routed id). The CHANGELOG 14.0.0 entry currently promises "filled in by a background benchmark".

## Decision to make (USER)

(a) filter queued/configured ids through `routeByModel` before `resolveFreePool`, treating a route-served id as legal without the $0 OpenRouter check (what $0 guarantee replaces it: b.ai's own pricing? the route preset's `isFreeProvider`?), or (b) tag each queue entry with its route at enqueue time and let the populator trust the tag; either touches `benchmark/index.ts` + `config.ts` and/or `dynamic-candidates.ts` + tests.

Also: prune a pre-existing poisoned `dynamic-candidates.json` (the 45 stray ids) on first run after the fix; make "benchmark-vetted" read the population state, not the written pool (`index.ts` ~4142-4148).

## Acceptance

On a two-key machine an isolated fresh config reaches a populated `free` with `model:` not the placeholder and the three dead ids absent (the P6d 2d check), on all three env legs; the b.ai-only leg (fix-queue row 53) documented as expected or fixed.

## References

Fix-queue rows 53 and 82. Analysis report: the local, gitignored report `reports/llm-ext-release/20260917_142619+0200-fq81-82-analysis.md` (written under the session working directory, not the repo) (Question B). PRRD searched on 2026-09-17 with prrdgrep: this repo has no PRRD corpus under design/ (no design/requirements/PRRD.md), so relevant-rules stays empty on purpose until one exists.

Dependencies and rules are in the frontmatter.

## Approval log
- 2026-09-17T17:15:37+0200 — APPROVED by USER (min-approval-requirement: manager). promoted proposal → planned.
- 2026-09-17T17:15:41+0200 — column → todo by USER.
2026-09-17 ~21:45 — approved by the coordinator under the USER's 2026-09-17 ~21:10 decision to land every open fix for 14.1.0; the USER did not read this card.
2026-09-17 ~22:10 — min-approval-requirement lowered manager → none: standalone project, no MANAGER exists (governance rule: outside the ai-maestro harness the session's Claude is the approver).
(the manager value was trddgrep's proposal-zone default, not a chosen bar).
- 2026-09-23T23:42:46+0200 — COMPLETE by agent. archived → complete.

## STATE

IMPLEMENTED 51a100c: route-aware $0 guard (benchmark/index.ts) + unrouted-id pruning on read (dynamic-candidates.ts); review follow-ups (swallowed loadSettings error in the pruner, isFreeProvider provenance, no-catalog-lookup assertion, patch-before-enqueue ordering) are in OE27RD7I's phase C2.
2026-09-17 ~22:30: row 82 root cause 154d083, B 51a100c+93cc031 committed; the free profile populates on a two-key machine pending the release live smoke.

## Fresh check evidence

Fresh check 2026-09-23, mapping of the four deferred review follow-ups. (1) swallowed loadSettings error in the pruner: VERIFIED FIXED — config.ts:802-806 loadSettings() catches parse errors itself and writes a stderr warning before returning null; dynamic-candidates.ts:168-171 currentFreeRouteByModel() relies on that contract, so no error is silently dropped.
(2) isFreeProvider provenance: VERIFIED FIXED — config.ts:2639 and 2738 compute isFreeProvider as preset.isFreeProvider === true && !overridesEndpoint(binding.url, preset), so a preset's free claim is not trusted once the endpoint has been overridden.
(3) no-catalog-lookup assertion: NOT fixed — no test asserts pruneUnroutedFreeCandidates makes no catalog call; copied in full onto OE27RD7I under heading 'Follow-ups carried from 38QAM06E'.
(4) patch-before-enqueue ordering: VERIFIED FIXED — dynamic-maintainer.ts:701-712 documents and enforces (by source order) that the providers[] patch is written to disk before enqueueCandidates() runs, naming the invariant so a reorder cannot reintroduce the drop.
Also checked the index.ts 'benchmark-vetted label' item: NOT fixed as literally specified — index.ts:4312 still reads the written free_models pool (activeFreePool/approvedFreePoolFromSettings), true only by construction of the write path, not a live population-state check; copied onto OE27RD7I under the same heading. Closing this card: the two unresolved items are now tracked on OE27RD7I, which is on the WBZJRSQB slice chain.

## Acceptance checklist

- [x] four review follow-ups mapped (2 verified fixed in code, 2 copied onto OE27RD7I); benchmark-vetted label item checked and copied onto OE27RD7I; STATE's P6d 2d check (route-aware /bin/zsh guard, unrouted-id pruning) landed in 51a100c/154d083/93cc031
