---
trdd-id: 4JLBB1YT
title: The l1 token estimate undercounts random base64 about 2x so a planned request can exceed the decider limit
column: todo
status: tasked
created: 2026-11-18T05:34:26+0100
updated: 2026-11-18T05:34:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:34:26+0100
---

# The l1 token estimate undercounts random base64 about 2x so a planned request can exceed the decider limit

## Why
Found in TRDD-1L9VMEY7 (notes of fc3052b0): the l1 token estimate undercounts random base64 about 2x (ratio 1.985 measured in the fc3052b0 run, not re-measured), so a request planned at the decider limit can be over it by the count of the decider and fail with a 422. On code the estimate over-counts about 40 percent (measured 2026-11-17, estimate 22876 against decider 16372).
## Facts
- l1/estimate.ts:19-23 has only character-class rates (letters, digits, other ASCII) and no handling of base64 or random strings; last changed in 4bdd9b1b (14.1.0).
- The decider reports usage.input_tokens on every success and the exact need on a 422 (TRDD-1L9VMEY7 note 2026-11-17T02:30).
## Acceptance
- [ ] A measurement of estimate against decider count on base64, random ids and code, saved under reports_dev.
- [ ] A fix (for example a higher rate for long runs of the base64 alphabet without spaces) with a unit test on a base64 sample, that does not raise the over-count on code.
- [ ] tsc and eslint 0.

## Approval log

- 2026-11-18T05:34:26+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
