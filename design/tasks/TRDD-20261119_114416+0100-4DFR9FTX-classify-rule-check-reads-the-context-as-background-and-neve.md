---
trdd-id: 4DFR9FTX
title: classify rule-check reads the context as background and never judges it
column: todo
status: tasked
created: 2026-11-19T11:44:16+0100
updated: 2026-11-19T11:44:16+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T11:44:16+0100
---

# classify rule-check reads the context as background and never judges it

With a context, classify rule-check sends, in both its relation question and its contradiction question, dataGuard(subject) with the default verb "judge" (catalog/shared.ts:12) and a subject that names `shared.context` (catalog/rule-check.ts:142, used at :150-151), plus the sentence "Use `shared.context` as background." So the model is told to judge the earlier messages. That goes against the USER design of 2026-11-18 (archived TRDD-7ZA3EE6Z, Notes line 64, verbatim): "we need to making clear to the classifier that it must not evaluate/classify the context part, but only the input part. this is why the prompt must clarify this and add the specific context block when the --context option is used." classify filter (994bfbce, TRDD-7ZA3EE6Z) and classify label and requirements (53e41288, TRDD-WYY3SPDX) already read the context as background and never judge it. Give rule-check the same treatment, keep the context inside an injection guard (TRDD-0W932B0H), keep the no-context text byte-identical, and pre-register a rule-check check on this card before any run, with its own items and bars and both wordings measured.

## Approval log

- 2026-11-19T11:44:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
