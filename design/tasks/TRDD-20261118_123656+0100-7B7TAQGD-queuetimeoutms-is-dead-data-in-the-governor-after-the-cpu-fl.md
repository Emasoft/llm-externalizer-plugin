---
trdd-id: 7B7TAQGD
title: queueTimeoutMs is dead data in the governor after the CPU floor was removed
column: todo
status: tasked
created: 2026-11-18T12:36:56+0100
updated: 2026-11-18T12:36:56+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T12:36:56+0100
---

# queueTimeoutMs is dead data in the governor after the CPU floor was removed

Commit 5a1658b5 (TRDD-ZTO9K8EK) removed the CPU floor, the only reader of queueTimeoutMs in governor/controller.ts; the value is still computed and passed, including from src/index.ts. Done when the field and its plumbing are gone or a reader is shown, and tsc, eslint and the governor tests pass. src/index.ts also holds uncommitted TRDD-TN8OUZ50 work: coordinate with it.

## Approval log

- 2026-11-18T12:36:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
