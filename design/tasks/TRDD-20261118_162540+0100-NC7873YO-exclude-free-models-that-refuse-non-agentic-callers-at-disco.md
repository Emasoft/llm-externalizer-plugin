---
trdd-id: NC7873YO
title: Exclude free models that refuse non-agentic callers at discovery, not only at runtime
column: backburner
status: tasked
created: 2026-11-18T16:25:40+0100
updated: 2026-11-18T16:25:40+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:25:40+0100
---

# Exclude free models that refuse non-agentic callers at discovery, not only at runtime

GitHub issue 15 item 3 (Emasoft/llm-externalizer-plugin). Since 14.4.0 such models are excluded at runtime by the gone cooldown and the persisted eviction, not at discovery.

## Acceptance

- [ ] a discovery-time exclusion of free models that refuse non-agentic callers, with a test

## Approval log

- 2026-11-18T16:25:40+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
