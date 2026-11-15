---
trdd-id: AGD7QUOK
title: Do the benchmark runners score a serviceAbort result as model output
column: complete
status: archived
created: 2026-10-10T15:00:47+0200
updated: 2026-10-31T05:28:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T15:00:47+0200
implementation-commits: [9bb359ec]
---

# Do the benchmark runners score a serviceAbort result as model output

Question (L-B). Do the benchmark runners compare-files and check-references score a result flagged serviceAbort as if the model had produced it? The source card says: latent, no production caller found. This is NOT a verified defect. First step is to read both runners and confirm whether a serviceAbort result can reach their scoring. If it can, the fix is to report the run as an outage instead of scoring it, with a test. If not, record why and close the card. Found during TRDD-YG72CYY7 (increment 4 close-out, 2026-10-10).

## Approval log

- 2026-10-10T15:00:47+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T05:28:10+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column backburner).

## Notes

2026-10-31: closed by commit 9bb359ec; both bench-runner tests (check-references and compare-files) passing on 2026-10-31.

## Acceptance

- [x] Both bench-runner tests (src/benchmark/check-references and src/benchmark/compare-files) pass on 2026-10-31, commit 9bb359ec.
