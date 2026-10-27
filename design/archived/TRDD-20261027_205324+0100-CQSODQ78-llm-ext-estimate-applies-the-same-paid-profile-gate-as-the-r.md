---
trdd-id: CQSODQ78
title: llm-ext --estimate applies the same paid-profile gate as the real run
column: complete
status: archived
created: 2026-10-27T20:53:24+0100
updated: 2026-10-27T21:23:03+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T20:53:24+0100
implementation-commits: [1da7edfa]
---

# llm-ext --estimate applies the same paid-profile gate as the real run

Reported 2026-10-27 by another session: llm-ext scan quality --profile paid --estimate priced 13 requests (expected 0.2297 USD), but the same command without --estimate refused with 'paid profile needs allow_paid_models: true in settings.yaml'. Cause, verified by reading: cli/main.ts returns from the --estimate branch before dispatchCallTool, and the gate (dynamicProfileGate, dynamic-maintainer.ts) runs only inside dispatch (index.ts around 4049). So an estimate prices a run the real command refuses.

## Acceptance
- [x] --estimate runs the same dynamicProfileGate check and refuses with the same message when the real run would refuse
- [x] the check is exposed from the engine next to buildEstimateDeps, not duplicated in main.ts
- [x] a test on the exported check: paid profile with allow_paid_models false refuses
- [x] type-check and the touched test files pass
- [x] follow-up: a permanent CLI-level test of the --estimate refusal is tracked on TRDD-UVU9S4RV (main.ts cannot be imported by a test)

## Approval log

- 2026-10-27T20:53:24+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-27T21:23:03+0100 — COMPLETE by main-agent@llm-externalizer-plugin. released in v14.1.2 and installed; USER grant 2026-10-27 to decide.
