---
trdd-id: HNKRAUMC
title: Does a thrown serviceAbort count as an ordinary exception failure on the single-model path
column: backburner
status: tasked
created: 2026-10-10T15:00:52+0200
updated: 2026-10-10T15:00:52+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:52+0200
---

# Does a thrown serviceAbort count as an ordinary exception failure on the single-model path

Question. The source card CLOSE-OUT item 2 says the single-model catch-path counting claim (counts as an ordinary exception failure) remains the one untraced remainder: the catch site exists, downstream handling was never read. Treat the claim as inference. First step is to trace the single-model catch path from ensureNotServiceAbort (scripts/llm-ext/src/index.ts) through the per-file loop to the failure counter and report whether a thrown ServiceAbortError is counted. Done when the card states the traced result with file and symbol names. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:52+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
