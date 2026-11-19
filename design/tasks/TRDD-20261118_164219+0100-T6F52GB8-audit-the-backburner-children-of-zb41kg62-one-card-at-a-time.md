---
trdd-id: T6F52GB8
title: Audit the backburner children of ZB41KG62 one card at a time
column: todo
status: tasked
created: 2026-11-18T16:42:19+0100
updated: 2026-11-19T09:10:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:42:19+0100
parent-trdd: ZB41KG62
derived: true
---

# Audit the backburner children of ZB41KG62 one card at a time

Audit the 89 backburner children of TRDD-ZB41KG62 one card at a time. Verdict per card: done, obsolete or still wanted, with file:line evidence. No scripted sweep (rule governance-trdd-kanban: each card needs a per-card judgment). Includes the browse epic question: the 24 BR-* cards plus SP-20, SP-21, DOC-09 and SEC-06 are not started and not required by any shipped feature (no browse source in scripts/llm-ext/src); decide whether to treat the browse epic as one backburner epic under its own parent card rather than as children of the classify group. Known examples to check: C4-07 classify ping (MVT4DCHS, backburner while classifiers/commands/ping.ts exists) and DOC-03, which targets a skill dir llm-externalizer-classify that does not exist. Parent TRDD-ZB41KG62.

## Approval log

- 2026-11-18T16:42:19+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T09:10:10+0100 — column → todo by main-agent@llm-externalizer-plugin. next drain item of TRDD-ZB41KG62; the RL-01 strike of 2026-11-19 points the open plan cards at this audit
