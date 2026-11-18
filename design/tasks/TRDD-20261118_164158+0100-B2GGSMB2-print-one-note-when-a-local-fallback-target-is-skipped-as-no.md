---
trdd-id: B2GGSMB2
title: Print one note when a local fallback target is skipped as not ready
column: backburner
status: tasked
created: 2026-11-18T16:41:58+0100
updated: 2026-11-18T16:41:58+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:41:58+0100
parent-trdd: 4AKLHLB4
derived: true
---

# Print one note when a local fallback target is skipped as not ready

When a ready-check skips a local fallback target, print one stderr line naming the target and the reason (not on disk, not calibrated, engine missing, wrong platform), then return the ORIGINAL remote error; never exit with a new error and never download. Parent TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T16:41:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
