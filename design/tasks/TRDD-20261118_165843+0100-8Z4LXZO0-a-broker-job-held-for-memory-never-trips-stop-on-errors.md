---
trdd-id: 8Z4LXZO0
title: A broker job held for memory never trips --stop_on_errors
column: backburner
status: tasked
created: 2026-11-18T16:58:43+0100
updated: 2026-11-18T16:58:43+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:58:43+0100
parent-trdd: 1OOAH3LD
---

# A broker job held for memory never trips --stop_on_errors

Child of TRDD-1OOAH3LD (local_llama) and TRDD-ZGSGGHQG (locals-mlx), parent link only. Source: reports_dev/open-cards/20261118_162804+0100-set1-report.md. Scope: a test (and a fix if it fails) that a broker job held for memory never trips --stop_on_errors; the USER ruling of 2026-10-28 is that not having enough memory is not a failure, it only queues the request (1OOAH3LD Notes 2026-11-14T16:20+0100: TRDD-SWNIIFTF closed its box (c) on the governor queue, not on the broker memory queue). No such test was found at 2026-11-18 (report item 6, INFERRED).

## Approval log

- 2026-11-18T16:58:43+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
