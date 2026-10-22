---
trdd-id: KP4DWUF9
title: End-to-end test of the ensemble all-failed rule wiring
column: backburner
status: tasked
created: 2026-10-10T15:02:10+0200
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
approval-datetime: 2026-10-10T15:02:10+0200
---

# End-to-end test of the ensemble all-failed rule wiring

The all-failed rule pickEnsembleAllFailedError is unit-tested, but its wiring inside ensembleStreaming and the non-free serviceAbort branch have no end-to-end test. The source card says: Its wiring inside ensembleStreaming and the non-free serviceAbort branch have NO end-to-end test (no harness reaches them). First step is to find out whether a harness can reach ensembleStreaming with every slot failing against a real local server. Done when such a test exists and fails if the wiring is removed, or when the card records why no harness can reach it. Found during TRDD-YG72CYY7 (increment 2 round A, noted at the increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:02:10+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
