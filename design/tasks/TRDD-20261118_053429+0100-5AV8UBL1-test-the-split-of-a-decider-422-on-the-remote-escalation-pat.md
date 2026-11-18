---
trdd-id: 5AV8UBL1
title: Test the split of a decider 422 on the remote escalation path
column: todo
status: tasked
created: 2026-11-18T05:34:29+0100
updated: 2026-11-18T05:34:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:34:29+0100
---

# Test the split of a decider 422 on the remote escalation path

## Why
TRDD-1L9VMEY7 commit a473a6b0 splits a request the local decider refuses as over its limit, on the local-only path and on the local escalation of a remote classifier profile (run-decision.ts:551). Only the local-only path has a test of it (local-decision.test.ts). The escalation path has none, and 628142c0 was tested with one failed piece only, with no nested partial split.
## Acceptance
- [ ] A test drives a remote classifier profile whose remote call fails and whose local decider answers a 422 naming its counts for a two-unit request, and asserts the request is split and both pieces are answered.
- [ ] A test where one piece of that split fails asserts the split_piece_failed warning names the piece, its reason and its question count.
- [ ] tsc and eslint 0; only the touched test file is run.

## Approval log

- 2026-11-18T05:34:29+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
