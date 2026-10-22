---
trdd-id: JDFJLPSS
title: Take the sweep-spawn decision on the dynamic record read inside the lock
column: complete
created: 2026-09-17T05:24:37+0200
updated: 2026-10-07T12:36:06+0200
current-owner: agent
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-17T05:24:37+0200
parent-trdd: 90DM5YHO
review-after: 
blocker-probe: 
blocker-holds-if: 
npt: []
blocked-by: []
unblock-when: []
pre-block-column: 
status: archived
implementation-commits: [6093ef37]
---

# Take the sweep-spawn decision on the dynamic record read inside the lock

WHY: the sweep-spawn decision in dynamic-maintainer.ts reads the dynamic record from a pre-lock snapshot, a TOCTOU gap between snapshot and spawn; safe today only because the duplicate-spawn lock happens to cover it (verified by two reviews, fix2-review N-6, fix-queue item 48). WHAT: move the sweep-spawn decision to read the dynamic record inside the lock, at decision time, removing the reliance on the duplicate-spawn lock as an incidental safety net. ACCEPTANCE: a test with a concurrent record mutation between snapshot and lock acquisition shows the spawn decision using the in-lock value, not the stale snapshot. Deferred from TRDD-90DM5YHO release 14.0.0 on 2026-09-17; fix-queue item 48.

## Approval log

- 2026-09-17T05:24:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-17T05:35:49+0200 — column → blocked. deferred until release 14.0.0 (TRDD-90DM5YHO) reaches a terminal column
- 2026-10-04T11:00:00+0200 — deliberate override recorded by main-agent@llm-externalizer-plugin: blocker 90DM5YHO reached complete (archived); the post-14 deferral is lifted per USER mandate (finish every open card); blocker fields cleared by hand.
- 2026-10-04T12:40:27+0200 — column → todo by main-agent@llm-externalizer-plugin. 90DM5YHO complete; USER mandate lifts the post-14 deferral
- 2026-10-07T04:56:26+0200 — column → dev. USER 2026-10-07: complete all TRDDs
- 2026-10-07T12:36:06+0200 — COMPLETE by main-agent@llm-externalizer-plugin. landed 6093ef37; acceptance verified.

## Acceptance

- [x] A test mutates the dynamic record between the early snapshot and the sweep-spawn decision and shows the decision uses the fresh value (red on the old code with 1 spawn, green after; dynamic-maintainer.test.ts 63/63 on both TMPDIR legs).
- [x] Code evidence, not test evidence: the sweep child stamps lastBenchmarkAt synchronously during its run (benchmark/index.ts recordDynamicBenchmarkAt) and releases the bench lock only in its exit hook (bench-lock.ts releaseOwnBenchLockOnExit); getDynamicProfileRecord re-reads the state file from disk on every call (default-profiles-state.ts readDynamicProfilesState), so a free lock means the stamp is already visible.
