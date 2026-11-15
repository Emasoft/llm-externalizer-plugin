---
trdd-id: GV21Y5UA
title: Token envelope under-estimates small decision requests by up to 55 percent
column: backburner
status: tasked
created: 2026-11-04T09:51:15+0100
updated: 2026-11-04T09:51:15+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T09:51:15+0100
---

# Token envelope under-estimates small decision requests by up to 55 percent

Found by TRDD-O4MSZIG5 on 2026-10-31: comparing the token estimate with the usage the API reported for the 14 live decision-spec requests, the envelope under-estimated small requests by up to 55 percent (O4MSZIG5 acceptance item 16, capture commit e41d64d8). Next: find where that comparison table was recorded, locate the estimator, and decide whether a fixed per-request overhead term removes the gap. Not yet investigated.

## Approval log

- 2026-11-04T09:51:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
