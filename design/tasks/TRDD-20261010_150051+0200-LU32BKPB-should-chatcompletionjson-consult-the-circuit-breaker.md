---
trdd-id: LU32BKPB
title: Should chatCompletionJSON consult the circuit breaker
column: backburner
status: tasked
created: 2026-10-10T15:00:51+0200
updated: 2026-10-10T15:00:51+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:51+0200
---

# Should chatCompletionJSON consult the circuit breaker

Question. chatCompletionJSON in provider/completion.ts does not call checkServiceHealthOrWait, unlike the other completion entry points, so it cannot return a breaker verdict. The source card lists it as open: chatCompletionJSON never calls the breaker. This is NOT a verified defect. First step is to read chatCompletionJSON and its rotation wrapper in index.ts and confirm whether the omission is intended. If it is a defect, route it through the breaker like its siblings with a test. If intended, record why and close. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:51+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
