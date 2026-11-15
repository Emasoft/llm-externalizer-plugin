---
trdd-id: XY8BZ1PL
title: Provider-state raw 503 give-up test runs about 73 s on real timers
column: complete
status: archived
created: 2026-10-10T15:00:43+0200
updated: 2026-10-31T05:28:33+0100
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
implementation-commits: [cc3594d5]
---

# Provider-state raw 503 give-up test runs about 73 s on real timers

The raw-503 give-up test in provider-state-render.test.ts waits out the real retry window and takes about 73 s, which slows every suite run. Switch it to fake timers so the clock is advanced instead of slept. Done when the test finishes in well under a second and still fails under the mutation that makes it fail today. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:43+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T05:28:33+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column backburner).

## Notes

2026-10-31: closed by commit cc3594d5; src/provider/provider-state-render.test.ts passing on 2026-10-31.

## Acceptance

- [x] src/provider/provider-state-render.test.ts passes on 2026-10-31 (commit cc3594d5): an /endpoints route that never answers cannot hold up a give-up once the store is filled.
