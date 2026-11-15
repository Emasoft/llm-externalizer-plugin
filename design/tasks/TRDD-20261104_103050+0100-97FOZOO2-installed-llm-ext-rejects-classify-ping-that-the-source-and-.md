---
trdd-id: 97FOZOO2
title: Installed llm-ext rejects classify ping that the source and skill document
column: todo
status: tasked
created: 2026-11-04T10:30:50+0100
updated: 2026-11-04T10:30:50+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:30:50+0100
---

# Installed llm-ext rejects classify ping that the source and skill document

Found by the TRDD-Q2VTMG4P audit on 2026-11-04: the installed llm-ext reports 14.2.0 and rejects classify ping (unknown action), while scripts/llm-ext/src/classifiers/commands/ping.ts exists, package.json says 14.1.2, and skills/llm-externalizer-cli-reference/references/classify.md documents ping. Find out which build the installed binary came from, whether ping is released or unreleased, and fix the install or the docs accordingly; do not delete the ping docs before knowing. Check the classify --estimate note at the same time.

## Approval log

- 2026-11-04T10:30:50+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
