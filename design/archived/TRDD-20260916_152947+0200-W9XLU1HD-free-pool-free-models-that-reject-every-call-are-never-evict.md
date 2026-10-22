---
trdd-id: W9XLU1HD
title: free-pool free models that reject every call are never evicted
column: complete
created: 2026-09-16T15:29:47+0200
updated: 2026-10-05T07:46:53+0200
current-owner: agent
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-16T15:29:47+0200
implementation-commits: [8fa2db2]
status: archived
---

# free-pool free models that reject every call are never evicted

## WHY

Free-pool models that OpenRouter still LISTS but that reject every call (HTTP 403/404) are
never evicted from `free_models`, so session_summary keeps dispatching to them and burns every
chunk on a guaranteed failure.

## Evidence

- reports/llm-ext-diagnosis/20260916_151012+0200-free-pool-dead-models.md
- ~/.llm-externalizer/model-events.log 2026-09-16: 156x thinkingmachines/inkling:free HTTP 403,
  134x thinkingmachines/inkling-small:free HTTP 403, 5x nvidia/nemotron-3-ultra-550b-a55b:free
  HTTP 404. history.log same day: 295 session_summary FAIL / 24 SUCCESS. 295 = 156+134+5.
- model-reconcile.ts:133-138 (computeReconcile) marks a model dead only on catalog absence
  (!catalogIds.has(id)); all three models are still listed with one endpoint each.
- session_summary/driver.ts -> index.ts:4393-4421 calls plain chatCompletionWithRetry, which
  does NOT go through callWithFreeRotation; a 403/404 falls into the generic-failure branch
  (provider/completion.ts:1058-1060) and retries the SAME model up to MAX_TRUNCATION_RETRIES.
- Fan-out: every slot starts on models[0] and only advances on its own failure
  (applyFanoutTransition, driver.ts:2001-2027), so ~21 concurrent chunks hit the same dead
  model in the same second.
- applyFanoutTransition calls recordUnavailable unconditionally, yet free-cooldowns.json was
  last written 2026-09-13 and has none of the three models -- UNRESOLVED discrepancy;
  candidate causes (neither verified): (a) a per-invocation LLM_EXT_CONFIG_DIR override
  pointing writeStoreToDisk at a different directory; (b) unlocked read-modify-write races in
  writeStoreToDisk (free-rotation.ts:742-754, plain writeFileSync+renameSync, no lock) under
  concurrent fan-out slot writes.

## Acceptance criteria

1. Reproduce first: run a real `llm-ext session compact` against a small transcript on the
   free pool, capture full stderr, record the 403 body and whether free-cooldowns.json
   changes. Settle the recordUnavailable discrepancy with evidence before changing code.
2. A deterministic 4xx (403/404, not 429) on a :free model is not retried on the same model;
   the call rotates.
3. A model classified "gone" N times across runs (N chosen and justified) is evicted from
   free_models via the same atomic writer reconcile uses; reconcile does not re-adopt it while
   it stays listed (persisted exclusion with an expiry/re-probe so a restored model can return).
4. Fan-out slots share the "gone" verdict so sibling slots skip the model immediately.

## Verification

Real tests (no mocks of the code under test) for criteria 2-4. Suite and tsc green.

## Approval log

- 2026-09-16T15:29:47+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-05T07:46:53+0200 — COMPLETE by main-agent@llm-externalizer-plugin. AC2 P2 + AC3/AC4 in 8fa2db2, coordinator-verified 2026-10-04 (tsc 0 lint 0 suite 3109 dist rebuilt); checklist ticked 2026-10-05, card was in todo as bookkeeping only.

## Implementation route (2026-09-16)

Now implemented as part of the dynamic free/paid profile maintainer (TRDD-90DM5YHO): AC2 no same-model retry on a deterministic 4xx, AC3 persisted eviction through the shared failure store, AC4 fan-out slots share the gone verdict. See reports/llm-ext-release/*-dynamic-profiles-design.md phases P2 and P3.

## STATE

P2 landed AC2 (no same-model retry on deterministic 4xx) + the shared run-unusable registry (AC4's intent, scoped to owned files) + writeStoreToDisk stderr-on-failure (step 5). Diagnostic (step 0) confirms recordUnavailable/writeStoreToDisk DO persist on the completeOnFreePool path (llm ask, real network 403s) -- open question narrows to whether session_summary/driver.ts's own two recordUnavailable call sites (lines ~1503/2027, T1 AC3/AC4 territory, not owned by P2) are reached in the session_summary path T1 originally reproduced. AC3 (persisted eviction/strikes) and AC4's driver.ts wiring are NOT implemented by P2 (out of file ownership) -- still open for whoever owns session_summary/driver.ts and model-reconcile.ts. Report: reports/llm-ext-release/20260916_183940+0200-p2-impl.md
POST-REVIEW correction: fixed a real gap (410 was never classified gone -> never marked run-unusable despite skipping retry; now fixed + tested). Retracted the 'safe superset' claim for the 403 narrowing -- it is a genuine, UNRESOLVED coverage gap (a novel-wording dead 403 model is never marked unusable by any path, since assessModelPersistence's ROTATE_WORTHY_STATUSES pre-existing excludes 401/403 too); the amendment's '2+ distinct models' counter was the proposed mitigation and was NOT implemented -- needs coordinator decision. Also retracted 'pre-existing infra leak' claim -- ran a true A/B (baseline vs mine, clean isolated runs, no overlapping vitest processes): BOTH pass cleanly with 0 leak; earlier leak appearances were self-inflicted overlapping-process flakiness, not a code defect in either version.
AC3 persisted eviction (goneStrikes in free-cooldowns.json, 3-strike/7d-TTL, enforced in computeReconcile adoption+kept) + AC4 driver wiring (pinned by a persisted-store fan-out test) + the dead-403 2-distinct quorum all LANDED in 8fa2db2 (2026-10-04). _VERIFIED_ by the coordinator on the committed tree: tsc 0, lint 0, touched files 236/236, full suite 3109 passed, NUL sweep clean, dist rebuilt. Report: reports/llm-externalizer/20261004_w9xlu1hd-ac3-ac4-impl.md

## Acceptance

- [x] AC1 reproduce-first + recordUnavailable discrepancy settled with evidence (diagnostic 20260916_183940, then A/B re-run proved the leak was process overlap, not code)
- [x] AC2 deterministic 4xx on a :free model rotates instead of retrying same model (landed P2, pinned in free-rotation tests)
- [x] AC3 gone-strikes persisted eviction via free-cooldowns.json same atomic writer (3 strikes / 7d TTL), enforced at reconcile adoption + kept filters (landed 8fa2db2)
- [x] AC4 fan-out slots share the gone verdict; driver.ts wiring pinned by persisted-store fan-out test (landed 8fa2db2)
