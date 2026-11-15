---
trdd-id: 7H5MGN34
title: Suspected - remote ensemble may never fan out because non-reserved members carry no route
column: complete
status: archived
created: 2026-10-28T21:08:06+0100
updated: 2026-10-31T21:04:20+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-28T21:08:06+0100
implementation-commits: [c7c8a532, 14ccd69f]
---

# Suspected - remote ensemble may never fan out because non-reserved members carry no route

Suspected bug found while researching the local ensemble (report reports/llama-cpp-profile/20261028_200508+0100-ensemble-scout-routes-facts.md, section 1, lines 18-19). Read from the code, not yet confirmed by a run.

ensembleStreaming in scripts/llm-ext/src/index.ts (about line 3434) takes the multi-model path only when every member has a route. getEnsembleModels (about lines 3986-4126) attaches a route only to reserved members (about 4012); model, second_model, third_model and free-pool members come back without one (about 4119). Read literally, any ensemble with a non-reserved member falls back to the single-model path, so a plain remote-ensemble profile would never fan out. No test drives a fan-out through ensembleStreaming.

First step: reproduce with a real run on a remote-ensemble profile and count the models that answered. If confirmed: give every member a route (or relax the guard), and add a test that drives a 3-member fan-out through a tool. Related: TRDD-1OOAH3LD and TRDD-ZGSGGHQG, whose local ensemble depends on the same path.

## Approval log

- 2026-10-28T21:08:06+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31 — confirmed and fixed in c7c8a532, src/remote-ensemble-fanout.test.ts
- 2026-10-31T21:04:20+0100 — COMPLETE by main-agent@llm-externalizer-plugin. fixed by c7c8a532 and 14ccd69f; every acceptance box proven, the failing-before box by reverting the guard in an exported tree (07ba007a); ships in 14.3.0.

## Review notes 2026-10-28

- The guard near index.ts:3434 may only choose WHERE requests go (per-member routes vs the profile default endpoint), not WHETHER they fan out. Read index.ts lines 3420-3540 in full before the run and write down both possible outcomes.
- Done when: a real run on a remote-ensemble profile with 3 members either shows 3 distinct model ids in the report (no bug: record the finding and close as cancelled) or shows 1 (bug confirmed), and in the confirmed case a test drives a 3-member fan-out through a tool and fails before the fix.
- Related: TRDD-YG72CYY7 (its increment 2 targets the 5-minute bound on the remote-ensemble path) and TRDD-WBZJRSQB (14.1.0 release); a confirmed fix changes shipped 14.1.0 behaviour and must be coordinated with both.

## Acceptance

- [x] the suspicion is confirmed or refuted by evidence (3 distinct model ids answer, or only 1) - evidence: Approval log 2026-10-31 confirmed and fixed in c7c8a532
- [x] if confirmed, every member carries a route or the guard is relaxed - evidence: c7c8a532, narrowed by 14ccd69f (only a USER-declared remote-ensemble profile fans out)
- [x] a test drives a 3-member fan-out through a tool - evidence: remote-ensemble-fanout.test.ts:57 (3 members reached), :134 (real chat entry), :155 (built-in paid with mode remote-ensemble stays single)
- [x] that test fails before the fix - MISSING: the verify report does not show a run of the test against the pre-fix tree
- 2026-10-31 proof pass 1, box 4 ticked: in an exported HEAD 6339f84f tree the pre-fix guard (the canFanOut expression reverted to ensembleModels.every route check, index.ts:3673) made vitest run src/remote-ensemble-fanout.test.ts exit 1 with 2 of 3 tests failing (one prompt reaches all three members; a user-declared remote-ensemble profile on OpenRouter reaches all three from a real chat command; expected 1 model id, not 3); with the fix restored the same file exits 0, 3 of 3 pass. The third test (built-in paid stays single) passes both ways by design. Mutex-run, exported tree under reports_dev/proof-pass/a.
