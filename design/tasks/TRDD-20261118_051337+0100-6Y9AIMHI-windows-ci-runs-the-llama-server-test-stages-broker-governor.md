---
trdd-id: 6Y9AIMHI
title: Windows CI runs the llama-server test stages (broker, governor, e2e)
column: backburner
status: tasked
created: 2026-11-18T05:13:37+0100
updated: 2026-11-18T05:13:37+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:13:37+0100
---

# Windows CI runs the llama-server test stages (broker, governor, e2e)

windows.yml runs only test:unit; test:broker, test:burn and test:e2e need a pinned Windows llama-server asset and model cache. Until then the Windows claim covers build, CLI and stage 1 only. Parent TRDD-61EINA10.

## Approval log

- 2026-11-18T05:13:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
