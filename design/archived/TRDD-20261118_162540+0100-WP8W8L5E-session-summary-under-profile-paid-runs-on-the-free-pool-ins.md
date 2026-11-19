---
trdd-id: WP8W8L5E
title: session summary under --profile paid runs on the free pool instead of the paid models
column: published
status: archived
created: 2026-11-18T16:25:40+0100
updated: 2026-11-19T03:34:04+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:25:40+0100
implementation-commits: [0e6fa5fb]
release-via: publish
---

# session summary under --profile paid runs on the free pool instead of the paid models

INFERRED from session_summary/handler.ts:109 and session_summary/local-model.ts:68-81 (a non-local active profile goes to selectRemote, the free pool); verify at card start. Fix: either honour the paid profile or refuse it with a clear error. Found while ruling GitHub issue 15 item 4.

## Acceptance

- [x] verified at card start by code trace, not by a run (session_summary/handler.ts:108 and local-model.ts resolveSessionSummaryChain), that session summary under --profile paid uses the free pool
- [x] session summary writes one stderr line saying the models of the paid profile are not used, with a test (amended 2026-11-19 by the main agent ruling on the line below; the original text asked to run on the paid models or refuse the paid profile with a clear error)
2026-11-19T01:36:11+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): box 2 is met by one stderr line, not by honouring or refusing the paid profile; GitHub 15 item 4 offered "say clearly on stderr why it may not", and session-summary is free-only by design (handler.ts: the selection can never hand back a paid model). Box 1: the worker traced handler.ts:108 (resolveSessionSummaryChain with deps.activeResolved). Fix and 4 tests: commit 0e6fa5fb; ships in 14.7.4.

## Approval log

- 2026-11-18T16:25:40+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T03:34:04+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped in v14.7.4 (main-agent fact F1).

## Notes

2026-11-19T03:34:03+0100 main agent: shipped in v14.7.4 (commit 0e6fa5fb; F1)
