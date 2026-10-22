---
trdd-id: RFDHRB1O
title: Can the test reset hook drive the breaker sleeper count negative
column: backburner
status: tasked
created: 2026-10-10T15:00:48+0200
updated: 2026-10-10T15:02:10+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:48+0200
---

# Can the test reset hook drive the breaker sleeper count negative

Question (L-C). The source card says: the test reset hook can drive sleepers negative when a sleeper is pending. The reset hook in provider/completion.ts sets the sleepers field of SERVICE_HEALTH to zero, and checkServiceHealthOrWait decrements it when a pending sleeper wakes, so by reading the count may go below zero after a reset. First step is to write a fake-timer test that resets with a pending sleeper and shows the count. Done when the count can never be negative, with that test. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:48+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
