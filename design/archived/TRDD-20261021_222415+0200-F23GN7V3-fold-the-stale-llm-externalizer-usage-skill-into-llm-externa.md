---
trdd-id: F23GN7V3
title: Fold the stale llm-externalizer-usage skill into llm-externalizer-cli-reference and update old flat command names
column: complete
status: archived
created: 2026-10-21T22:24:15+0200
updated: 2026-10-31T17:20:05+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-21T22:24:15+0200
---

# Fold the stale llm-externalizer-usage skill into llm-externalizer-cli-reference and update old flat command names

Follow-up of TRDD-ACPIIS6Y. skills/llm-externalizer-usage documents the older flat command form (llm-ext code-task); fold what it still adds into skills/llm-externalizer-cli-reference and retire it. Update the old flat command names in the scan, review, compact-session, mass-scouting, or-model-info, free-scan and config skills to the grouped form. Related: TRDD-AG99QCM7.

## Approval log

- 2026-10-21T22:24:15+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T17:20:05+0100 — COMPLETE by main-agent@llm-externalizer-plugin. 6d59bc34 + 8e9533d6; the usage skill is folded into cli-reference and no reference to it remains.

## Acceptance

- [x] the llm-externalizer-usage skill is folded into llm-externalizer-cli-reference and retired - evidence: 6d59bc34 + 8e9533d6 deleted skills/llm-externalizer-usage (4 files, -673 lines); no remaining reference to the name outside design/ and reports/
- [x] old flat command names in the scan, review, compact-session, mass-scouting, or-model-info, free-scan and config skills are updated to the grouped form - evidence: grep under skills/ finds no flat llm-ext tool_name form
