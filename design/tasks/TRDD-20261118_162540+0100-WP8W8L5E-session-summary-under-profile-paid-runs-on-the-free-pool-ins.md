---
trdd-id: WP8W8L5E
title: session summary under --profile paid runs on the free pool instead of the paid models
column: backburner
status: tasked
created: 2026-11-18T16:25:40+0100
updated: 2026-11-18T16:25:40+0100
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
---

# session summary under --profile paid runs on the free pool instead of the paid models

INFERRED from session_summary/handler.ts:109 and session_summary/local-model.ts:68-81 (a non-local active profile goes to selectRemote, the free pool); verify at card start. Fix: either honour the paid profile or refuse it with a clear error. Found while ruling GitHub issue 15 item 4.

## Acceptance

- [ ] verified at card start that session summary under --profile paid uses the free pool
- [ ] session summary either runs on the paid models or refuses the paid profile with a clear error, with a test

## Approval log

- 2026-11-18T16:25:40+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
