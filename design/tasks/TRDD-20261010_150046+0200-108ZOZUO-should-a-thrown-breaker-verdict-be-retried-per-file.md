---
trdd-id: 108ZOZUO
title: Should a thrown breaker verdict be retried per file
column: backburner
status: tasked
created: 2026-10-10T15:00:46+0200
updated: 2026-10-10T15:00:46+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:46+0200
---

# Should a thrown breaker verdict be retried per file

Question (L-A). Is a thrown breaker verdict (ServiceAbortError) retried up to 3 times per file by omission rather than by an explicit branch, and is that wrong? The source card says: the thrown verdict is retried up to 3 times per file by omission, not by an explicit branch. This is NOT a verified defect. First step is to read the per-file loops (index.ts and scan-folder/core.ts) and confirm whether the retry happens and whether it is intended. If it is a defect, the fix is an explicit branch that stops on a breaker verdict, with a test. If it is intended, record why and close the card. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:46+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
