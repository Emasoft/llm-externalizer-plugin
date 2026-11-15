---
trdd-id: WCVCBXMB
title: completion.test.ts payment-error case has a 5000 ms wall-clock bound that a loaded machine can miss
column: backburner
status: tasked
created: 2026-11-14T01:05:29+0100
updated: 2026-11-14T01:05:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T01:05:29+0100
---

# completion.test.ts payment-error case has a 5000 ms wall-clock bound that a loaded machine can miss

src/provider/completion.test.ts:780 (HTTP 400 payment-error case, D1) asserts elapsed < 5000 ms. During npm test batch 1 on 2026-11-14 between 00:34:02 and 00:42:10+0100 (birth and last write of the test log) it measured 5187 ms while a second full suite ran in the same tree; run alone it passed 12/12. In-process test, not a child-process one (TRDD-CBOTP0DY covers those). Cause inferred, not shown: machine load. Acceptance: the bound is justified or replaced by a check that does not depend on wall-clock speed, and the test passes under a concurrent full suite.

## Approval log

- 2026-11-14T01:05:29+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
