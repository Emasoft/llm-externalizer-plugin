---
trdd-id: T6F52GB8
title: Audit the backburner children of ZB41KG62 one card at a time
column: todo
status: tasked
created: 2026-11-18T16:42:19+0100
updated: 2026-11-19T11:21:42+0100
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

## Notes

2026-11-19T11:11:38+0100 final report committed 868920e3 at reports/t6f52gb8-audit/20261119_110902+0100-final-audit.md (100 cards audited, rulings R1-R10); rulings are main agent rulings (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer).
2026-11-19T11:11:39+0100 correction to commit b31a4c45: its body says the main agent checked each claim; 14 of its 23 notes say they were not re-read by the main agent; the main agent checked only the file list and the commit subjects (final report, section Correction to commit b31a4c45).
2026-11-19T11:21:41+0100 final report corrected in 7cf6c10b: R10 now applies the 2026-10-31 test-double ruling as written (the first wording was narrower); R1 cites only plan lines 50 and 53 as quotes for browse. The 14 of 23 figure in the b31a4c45 correction was re-checked by grep and holds.
