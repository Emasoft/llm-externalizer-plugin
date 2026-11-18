---
trdd-id: XIGEYC35
title: Latched local errors with a transient shape are retried per file against a dead local server
column: backburner
status: tasked
created: 2026-11-18T15:51:31+0100
updated: 2026-11-18T15:51:31+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:31+0100
---

# Latched local errors with a transient shape are retried per file against a dead local server

After a command latches to the local fallback, a local error whose shape looks transient is retried for every remaining file against a local server that is already dead (TRDD-WSPV40Y5 card note F5, found by reading the code, not measured). Decide and implement: stop retrying a latched local error once the local target is known dead for this command, and pin it with a real local server that is shut down mid-run. Size S to M. Parent: TRDD-WSPV40Y5.

## Approval log

- 2026-11-18T15:51:31+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
