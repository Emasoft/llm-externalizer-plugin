---
trdd-id: 2GIA66AK
title: A profile rewrite never writes an ensemble its own settings check rejects
column: dev
status: tasked
created: 2026-10-27T20:53:23+0100
updated: 2026-10-27T21:02:46+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T20:53:23+0100
implementation-commits: [5c06fd5d]
---

# A profile rewrite never writes an ensemble its own settings check rejects

On 2026-10-22 the automatic free-profile rewrite passed only 1 of 6 free models and wrote it with mode remote-ensemble (scripts/llm-ext/src/benchmark/index.ts, the free populate writer). The settings check (config.ts, free_only remote-ensemble needs at least 2 members) rejects that, so every llm-ext command exited 1 on this machine until 2026-10-27, when the settings file was set to mode remote by hand. The paid writer has the same shape: it always writes remote-ensemble, and the check rejects a non-free ensemble without second_model.

## Acceptance
- [x] the free writer writes mode remote when fewer than 2 models pass, remote-ensemble otherwise
- [x] the paid writer writes mode remote when there is no second pick, remote-ensemble otherwise
- [x] a test per writer: a sweep where exactly one model passes produces a section that validateProfile accepts
- [x] type-check and the touched test files pass

## Approval log

- 2026-10-27T20:53:23+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
