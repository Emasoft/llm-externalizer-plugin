---
trdd-id: OKK9JVK6
title: Ensemble slots that flatten an error to text never show the provider-state line
column: backburner
status: tasked
created: 2026-10-10T15:00:38+0200
updated: 2026-10-10T15:02:09+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:38+0200
---

# Ensemble slots that flatten an error to text never show the provider-state line

In ensembleStreaming (scripts/llm-ext/src/index.ts) the per-slot catch block turns a thrown error into text with slotErrorContent and keeps the error only as cause, so the cached N of M providers degraded line added in commit 6256d303 (appended in classifyError) is not shown for that slot. The source card says: Not covered: ensemble slots (ensembleStreaming, pickEnsembleAllFailedError) where a slot flattens an error to text. First step is to read slotErrorContent and pickEnsembleAllFailedError and confirm whether the line really is missing from the ensemble report. Done when a provider-side give-up in an ensemble slot shows the same provider-state line as a single-model call, with a test that fails without the fix. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:38+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
