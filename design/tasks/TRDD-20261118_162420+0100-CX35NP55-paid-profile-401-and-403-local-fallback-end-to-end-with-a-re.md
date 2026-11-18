---
trdd-id: CX35NP55
title: Paid profile 401 and 403 local fallback end to end with a real answer
column: backburner
status: tasked
created: 2026-11-18T16:24:20+0100
updated: 2026-11-18T16:24:20+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:24:20+0100
---

# Paid profile 401 and 403 local fallback end to end with a real answer

Moved from TRDD-WSPV40Y5 (section 6 cases 13 and 14, paid 402 and refused key 401/403): the end-to-end proof that a paid profile whose key is refused (401 or 403) falls back to the local profile with a REAL OpenRouter answer. Needs OpenRouter credit, a USER money action (card note 2026-11-16T12:28:19 item a and the 2026-11-16T20:16:01 approval log line of TRDD-WSPV40Y5). Dispatch-level tests with real node:http 401/403/402 servers already exist in local-fallback-dispatch.test.ts.

## Acceptance

- [ ] paid profile 401 and 403 fall back to the local profile end to end against a real OpenRouter answer (USER funds the OpenRouter credit)

## Approval log

- 2026-11-18T16:24:20+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
