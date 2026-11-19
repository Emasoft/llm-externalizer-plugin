---
trdd-id: YRRZJ5UH
title: Governor wait line says 1 inferences for a single running inference
column: published
status: archived
created: 2026-11-18T12:36:56+0100
updated: 2026-11-19T03:37:48+0100
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
implementation-commits: [ffc13d81]
release-via: publish
---

# Governor wait line says 1 inferences for a single running inference

governor/client.ts near line 552 builds the waiting text with a plural that reads 1 inferences when one inference runs. Cosmetic. Found during TRDD-ZTO9K8EK.

## Approval log

- 2026-11-18T12:36:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T03:37:48+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. fixed by ffc13d81, shipped in v14.7.3.

## Notes

2026-11-19T03:34:08+0100 main agent: fixed by ffc13d81 (governor/client.ts:554-557 singular branch with WHY comment), shipped in v14.7.3 (F2, F3).

## Acceptance

- [x] (derived from title) the governor wait line reads "1 inference is running" for one inference and "N inferences are running" otherwise: governor/client.ts:554-557, commit ffc13d81, shipped in v14.7.3
