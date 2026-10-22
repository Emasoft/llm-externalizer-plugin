---
trdd-id: F1I95989
title: reconcile adopts free models unfit for text work
column: complete
created: 2026-09-16T15:30:02+0200
updated: 2026-09-23T23:40:56+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-16T15:30:02+0200
---

# reconcile adopts free models unfit for text work

## WHY

reconcile adopts :free models into the pool that are unfit for general text work -- a safety
classifier and a tiny 2.6B model -- because its adoption gate only checks the context-window
floor plus the benchmark-failed list, not model kind/purpose.

## Evidence

- reports/llm-ext-diagnosis/20260916_151012+0200-free-pool-dead-models.md
- Verified: the adopted pool includes nvidia/nemotron-3.5-content-safety:free (a safety
  classifier, not a chat model) and liquid/lfm-2.5-2.6b:free (2.6B, likely too weak for
  general text work).
- Reconcile's adoption gate (model-reconcile.ts) is only the context-window floor plus
  benchmarkFailedModels() -- no filter on model kind/purpose.

## Acceptance criteria

1. Adoption excludes non-chat or classifier models by a catalog field -- verify which
   OpenRouter catalog field (if any) reliably distinguishes classifier/safety models from
   general chat models before relying on it.
2. And/or: adoption requires a passing $0 probe (a real minimal chat completion) before a
   model enters free_models.
3. Real tests (no mocks of the code under test) covering both the exclusion-by-field path and
   the probe-gate path. Suite and tsc green.

## Approval log

- 2026-09-16T15:30:02+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-23T23:40:56+0200 — COMPLETE by agent. archived → complete.

## Implementation route (2026-09-16)

Now implemented as part of the dynamic free/paid profile maintainer (TRDD-90DM5YHO): the unfit-model adoption filter (exported looksLikeClassifier at adoption time) and the candidate pipeline (new free models are benchmarked at $0 before they enter the free profile; failures go to the shared failure store). See reports/llm-ext-release/*-dynamic-profiles-design.md phases P4 and P5.

## STATE

P4 (2026-09-16): decideDynamicProfile (default-profiles.ts) excludes any classifier-named id (looksLikeClassifier, exported by P2) from free-profile arrivals, so an unfit model like nvidia/nemotron-*-content-safety:free is never queued or adopted by the new dynamic maintainer path. Test: 'never adopts a classifier-named arrival' in default-profiles.test.ts.

## Fresh check evidence

Fresh check 2026-09-23. AC1 (classifier exclusion): default-profiles.ts:634 filters freeArrivals with !looksLikeClassifier(id); test 'never adopts a classifier-named arrival' in default-profiles.test.ts. Verified.
AC2 (/bin/zsh probe gate before adoption): dynamic-candidates.ts:1-9 docstring: 'The maintainer never writes a newly-discovered model id straight into settings.yaml... It queues the id here instead; the next population sweep benchmarks configured union queued and only THEN writes survivors through pick.ts writers.' benchmark/index.ts:1691,1784,1852 call readCandidates()/clearCandidates() around the sweep-and-judge cycle. Verified.
AC3 (real tests, both paths): benchmark/populate-default-profile.test.ts:432 'candidateIds is configured-union-queued...' exercises the probe-gate path; default-profiles.test.ts covers the classifier-exclusion path. All three ACs hold — closing.

## Acceptance checklist

- [x] AC1: adoption excludes classifier models via looksLikeClassifier (default-profiles.ts:634)
- [x] AC2: candidate queue + benchmark-before-write gate (dynamic-candidates.ts:1-9, benchmark/index.ts:1691-1852)
- [x] AC3: real tests for both paths (default-profiles.test.ts, benchmark/populate-default-profile.test.ts:432)
