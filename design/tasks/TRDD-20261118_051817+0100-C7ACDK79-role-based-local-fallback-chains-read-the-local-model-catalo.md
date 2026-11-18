---
trdd-id: C7ACDK79
title: Role-based local fallback chains read the local model catalog
column: backburner
status: tasked
created: 2026-11-18T05:18:17+0100
updated: 2026-11-18T05:18:17+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:17+0100
---

# Role-based local fallback chains read the local model catalog

The chat fallback chain walks eligible catalog chat entries through profiles/resolve-chain.ts and profiles/route-for-tier.ts, the unwired seam of the profile contract, and never a not-eligible entry (eligible means on disk and calibrated). Waits on TRDD-SZ7TO9FW. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
