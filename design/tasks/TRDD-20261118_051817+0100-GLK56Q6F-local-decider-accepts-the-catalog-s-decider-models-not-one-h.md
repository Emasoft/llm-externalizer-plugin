---
trdd-id: GLK56Q6F
title: Local decider accepts the catalog's decider models, not one hard-coded name
column: backburner
status: tasked
created: 2026-11-18T05:18:17+0100
updated: 2026-11-18T05:18:17+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:17+0100
---

# Local decider accepts the catalog's decider models, not one hard-coded name

SERVED_MODEL (classifiers/l2/local-decider.ts:37) becomes the catalog decider entries, and adoption accepts any of them. First ask the owner of the mlx-decision server which weights it serves and what its image request body is (classifiers/l0/local-transport.ts is unread). Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
