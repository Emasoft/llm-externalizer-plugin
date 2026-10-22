---
trdd-id: CE9B7S8N
title: Key the dynamic-profile sweep floor on sweep completion not spawn
column: complete
created: 2026-09-17T05:24:36+0200
updated: 2026-10-05T14:55:04+0200
current-owner: agent
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-17T05:24:36+0200
parent-trdd: 90DM5YHO
review-after: 
blocker-probe: 
blocker-holds-if: 
npt: []
blocked-by: []
unblock-when: []
pre-block-column: 
status: archived
implementation-commits: 29d3cf19
---

# Key the dynamic-profile sweep floor on sweep completion not spawn

WHY: lastSweepAt advances on spawn, not on sweep completion; a child killed before it books a failure blocks the next sweep for 6 hours (the patch-before-throttles order was verified on the fix2 tree by the fix2 review Q2(b) and not re-checked after fix3/fix4; safe for money, slow for free — fix-queue item 37). WHAT: key the dynamic-profile sweep throttle on sweep completion (success or booked failure) instead of spawn time, so a killed child does not stall the next sweep window. ACCEPTANCE: a test that kills a spawned sweep child before it books a result shows the next sweep is NOT blocked for the full 6h window. Deferred from TRDD-90DM5YHO release 14.0.0 on 2026-09-17; fix-queue item 37.

## Approval log

- 2026-09-17T05:24:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-17T05:35:48+0200 — column → blocked. deferred until release 14.0.0 (TRDD-90DM5YHO) reaches a terminal column
- 2026-10-04T11:00:00+0200 — deliberate override recorded by main-agent@llm-externalizer-plugin: blocker 90DM5YHO reached complete (archived); the post-14 deferral is lifted per USER mandate (finish every open card); blocker fields cleared by hand.
- 2026-10-04T12:40:21+0200 — column → todo by main-agent@llm-externalizer-plugin. 90DM5YHO complete; USER mandate lifts the post-14 deferral
- 2026-10-05T14:55:04+0200 — COMPLETE by main-agent@llm-externalizer-plugin. AC1 verified: kill-child acceptance RED at HEAD, GREEN after; coordinator A/B control (pristine HEAD as-is reproduces the 44 as-is failures — YUML4ISF, not the change); typecheck/lint/build 0; 67/67 isolated on three env legs. Commit 29d3cf19..

## Acceptance

AC1 — a test that kills a spawned sweep child before it books a result shows the next sweep is NOT blocked for the full 6h window: src/dynamic-maintainer.test.ts 'CE9B7S8N: the 6 h sweep floor keys on sweep COMPLETION, not spawn' (spawn 1; no completion evidence; immediate next pass spawns again; a COMPLETED sweep still floors the full 6 h) — RED at HEAD, GREEN after. Plus a real-primitive SIGKILL case in src/background-singleton.test.ts. Maintainer file 62/62 on three env legs.
AC1 verified by main-agent@llm-externalizer-plugin 2026-10-05: [x] the kill-child proof ran RED then GREEN; gates typecheck 0 / lint 0 / build 0 / three env legs 62/62.
- [x] AC1: a test that kills a spawned sweep child before it books a result shows the next sweep is NOT blocked for the full 6h window — killed-child acceptance in src/dynamic-maintainer.test.ts (spawn, no booking, immediate respawn) + real-primitive SIGKILL case in src/background-singleton.test.ts; RED at HEAD, GREEN after; three env legs 62/62.

## Follow-ups

2026-10-05 review round on the implementation: ACCEPTED follow-up — an unbooked child death (dies before recordBenchmarkFailure books anything) now respawns on every maintainer pass with no floor (inherent to the card's acceptance: the old spawn-stamp bounded a crash-loop to 1/6h). Fix shape for a future row: a cheap unbooked-retry floor (~15 min) read from a spawn-attempt marker. Not a redesign; logged here so it is not lost. NOTE: transfer this row to a LIVE card (OE27RD7I follow-ups) at this card's archival — archived cards are not polled for open work (precedent: 12ed51c0 transferred rows 79/80/84 at 90DM5YHO archival).
