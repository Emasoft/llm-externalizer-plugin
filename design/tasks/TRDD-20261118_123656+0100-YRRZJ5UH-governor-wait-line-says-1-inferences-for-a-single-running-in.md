---
trdd-id: YRRZJ5UH
title: Governor wait line says 1 inferences for a single running inference
column: todo
status: tasked
created: 2026-11-18T12:36:56+0100
updated: 2026-11-18T12:36:56+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T12:36:56+0100
---

# Governor wait line says 1 inferences for a single running inference

governor/client.ts near line 552 builds the waiting text with a plural that reads 1 inferences when one inference runs. Cosmetic. Found during TRDD-ZTO9K8EK.

## Approval log

- 2026-11-18T12:36:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
