---
trdd-id: 8Y0LXT93
title: Ensemble merge reports a partial cost sum as a known cost
column: backburner
status: tasked
created: 2026-11-04T22:52:11+0100
updated: 2026-11-04T22:58:51+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T22:52:11+0100
---

# Ensemble merge reports a partial cost sum as a known cost

index.ts:3876-3887, read 2026-11-04 at HEAD d1171a30: the merged cost is the sum over succeeded slots, a slot without a cost counting as 0, whenever at least one succeeded slot carried a numeric cost. formatUsageTotals then treats the file cost as known, against its own rule (usage-totals.ts:27-28) that any missing cost makes the total unknown. Two smaller gaps in the same block: the merged usage object is always defined, so a file whose slots sent no usage at all is summed as 0 tokens instead of Usage unknown; and, not verified by the main agent (index.ts:3812 was read only by an audit worker), the spend of a billed slot that ends in the failed list may be dropped from the totals, while an HTTP 503 or 429 slot usually costs nothing. Found during TRDD-RPLLP8CF (audit reports under reports_dev/rpllp8cf/).

## Approval log

- 2026-11-04T22:52:11+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] the merged cost is undefined unless every succeeded slot carried a numeric cost
- [ ] a file whose slots sent no usage at all counts as a file without usage in the scan totals (Usage: unknown when it is the only file, the (from N of M files) suffix otherwise)
- [ ] a real-server test with two local ensemble members on the scripted server, one priced and one without a cost, prints cost unknown

## Notes

2026-11-04T22:55+0100 pointer for the fixer: the WHY comment at index.ts:3886 states the intended rule (a slot that sent no cost must not turn unknown into a free run); the code applies it only when no slot has a cost.
2026-11-04T22:55+0100 related: TRDD-RPLLP8CF, where this was found.
2026-11-04T22:58+0100 before deciding a fix for billed failed slots, read index.ts:3812 (only an audit worker has read it).
