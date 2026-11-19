---
trdd-id: 7B7TAQGD
title: queueTimeoutMs is dead data in the governor after the CPU floor was removed
column: published
status: archived
created: 2026-11-18T12:36:56+0100
updated: 2026-11-19T03:37:48+0100
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
implementation-commits: [ffc13d81]
release-via: publish
---

# queueTimeoutMs is dead data in the governor after the CPU floor was removed

Commit 5a1658b5 (TRDD-ZTO9K8EK) removed the CPU floor, the only reader of queueTimeoutMs in governor/controller.ts; the value is still computed and passed, including from src/index.ts. Done when the field and its plumbing are gone or a reader is shown, and tsc, eslint and the governor tests pass. src/index.ts also holds uncommitted TRDD-TN8OUZ50 work: coordinate with it.

## Approval log

- 2026-11-18T12:36:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T03:37:48+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. fixed by ffc13d81, shipped in v14.7.3.

## Notes

2026-11-19T03:34:17+0100 main agent: ffc13d81 dropped the waiter queueTimeoutMs from the governor, shipped in v14.7.3 (F2). The value still passed from src/index.ts:1980 is the broker queue timeout with a reader at src/broker/scheduler.ts:217 (F5). tsc, eslint and the governor tests passed at the v14.7.3 publish gate (F3; governor tests in the include list, F4).

## Acceptance

- [x] (from the card's Done when) the governor waiter queueTimeoutMs is gone (ffc13d81); the value still passed from src/index.ts:1980 is the broker queue timeout, read at src/broker/scheduler.ts:217
- [x] (from the card's Done when) tsc, eslint and the governor tests passed: v14.7.3 publish log reports_dev/publish/20261118-14.7.3-publish.log lines 14, 16, 20 (OK typecheck, lint, test); governor tests are in the explicit include list, vitest.config.ts:297-310
