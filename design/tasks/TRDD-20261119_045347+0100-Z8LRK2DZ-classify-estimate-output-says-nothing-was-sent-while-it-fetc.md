---
trdd-id: Z8LRK2DZ
title: classify --estimate output says nothing was sent while it fetches the catalog
column: backburner
status: tasked
created: 2026-11-19T04:53:47+0100
updated: 2026-11-19T04:53:47+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:53:47+0100
---

# classify --estimate output says nothing was sent while it fetches the catalog

The classify --estimate output starts 'classify <action> --estimate: nothing was sent'. A worker measurement (reports_dev/fp2saf4p-6910/, item 6, 14.7.3 and HEAD) shows the estimate sends no question and reads no key (run-decision.ts:368), but with a cold or expired cache it GETs the public decisions catalog (l0/catalog.ts via run-decision.ts:344) and the endpoint prompt limit (l0/model.ts:75 via run-decision.ts:393) from openrouter.ai, without a key; behind a blocking proxy it exits 5 'decisions catalog unavailable and cache expired'. 'nothing was sent' reads as no network. Fix: say 'no question was sent' (or equivalent), update the tests and docs that quote the line. Found while working TRDD-FP2SAF4P item 6.

## Approval log

- 2026-11-19T04:53:47+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
