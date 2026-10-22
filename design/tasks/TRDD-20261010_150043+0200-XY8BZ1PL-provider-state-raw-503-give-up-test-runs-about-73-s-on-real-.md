---
trdd-id: XY8BZ1PL
title: Provider-state raw 503 give-up test runs about 73 s on real timers
column: backburner
status: tasked
created: 2026-10-10T15:00:43+0200
updated: 2026-10-10T15:00:43+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:43+0200
---

# Provider-state raw 503 give-up test runs about 73 s on real timers

The raw-503 give-up test in provider-state-render.test.ts waits out the real retry window and takes about 73 s, which slows every suite run. Switch it to fake timers so the clock is advanced instead of slept. Done when the test finishes in well under a second and still fails under the mutation that makes it fail today. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:43+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
