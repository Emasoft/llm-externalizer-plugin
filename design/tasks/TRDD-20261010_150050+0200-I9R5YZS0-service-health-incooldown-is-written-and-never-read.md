---
trdd-id: I9R5YZS0
title: SERVICE_HEALTH.inCooldown is written and never read
column: backburner
status: tasked
created: 2026-10-10T15:00:50+0200
updated: 2026-10-10T15:00:50+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:50+0200
---

# SERVICE_HEALTH.inCooldown is written and never read

In scripts/llm-ext/src/provider/completion.ts the field inCooldown of SERVICE_HEALTH is initialised and assigned in several places (reset hook, recordServiceSuccess, the wait path, and the sleep path), and a search of the sources and tests found no read. The source card lists it as open: SERVICE_HEALTH.inCooldown written and never read. Done when the field and every write to it are removed, unless a re-search finds a consumer, in which case record it and close the card. The suite must pass. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:50+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
