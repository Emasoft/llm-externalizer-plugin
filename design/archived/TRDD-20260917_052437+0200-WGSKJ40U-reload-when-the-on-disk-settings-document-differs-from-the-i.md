---
trdd-id: WGSKJ40U
title: Reload when the on-disk settings document differs from the in-memory one
column: superseded
created: 2026-09-17T05:24:37+0200
updated: 2026-10-07T13:20:10+0200
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
superseded-by: [OE27RD7I]
---

# Reload when the on-disk settings document differs from the in-memory one

WHY: the dispatch's before/after hash pair in index.ts cannot detect a settings-file write that landed between process boot and the pre-maintain hash, because the window is the milliseconds between boot and that hash in a CLI process; a rejected reload is already a refusal so this is not urgent (fix4 gap 2, fix-queue item 55). WHAT: build a canonical serialization of activeSettings and compare it against the on-disk bytes to detect drift missed by the hash-pair window, reloading when they differ. ACCEPTANCE: a test that writes a settings change during the boot-to-pre-maintain window shows the process reloading from the canonical-serialization comparison instead of missing the write. Deferred from TRDD-90DM5YHO release 14.0.0 on 2026-09-17; fix-queue item 55.

## Approval log

- 2026-09-17T05:24:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-17T05:35:50+0200 — column → blocked. deferred until release 14.0.0 (TRDD-90DM5YHO) reaches a terminal column
- 2026-10-04T11:00:00+0200 — deliberate override recorded by main-agent@llm-externalizer-plugin: blocker 90DM5YHO reached complete (archived); the post-14 deferral is lifted per USER mandate (finish every open card); blocker fields cleared by hand.
- 2026-10-04T12:40:35+0200 — column → todo by main-agent@llm-externalizer-plugin. 90DM5YHO complete; USER mandate lifts the post-14 deferral
- 2026-10-07 — closed as superseded by main-agent@llm-externalizer-plugin: the before/after settings hash pair this card would harden no longer exists. Commits a6fec0c and 5842393 (TRDD-OE27RD7I C2b-wire) replaced the synchronous in-process maintainer call with a detached detector; each command is a short-lived process that reads settings.yaml once at boot, and dispatch no longer reloads settings (only the reset tool does, index.ts reloadSettingsFromDisk). Verified in scripts/llm-ext/src/dispatch-reload.test.ts header (lines 6-18) and by grep of index.ts. Worker report: reports/llm-ext-release/20261007_131939+0200-wgskj40u-impl.md. No code change.
- 2026-10-07T13:20:10+0200 — SUPERSEDED by main-agent@llm-externalizer-plugin. the mechanism was removed by OE27RD7I C2b-wire; nothing left to harden.
