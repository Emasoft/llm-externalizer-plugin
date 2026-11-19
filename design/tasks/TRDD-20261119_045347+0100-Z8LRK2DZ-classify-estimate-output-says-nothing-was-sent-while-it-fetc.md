---
trdd-id: Z8LRK2DZ
title: classify --estimate output says nothing was sent while it fetches the catalog
column: dev
status: tasked
created: 2026-11-19T04:53:47+0100
updated: 2026-11-19T05:48:38+0100
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
implementation-commits: [16426995]
---

# classify --estimate output says nothing was sent while it fetches the catalog

The classify --estimate output starts 'classify <action> --estimate: nothing was sent'. A worker measurement (reports_dev/fp2saf4p-6910/, item 6, 14.7.3 and HEAD) shows the estimate sends no question and reads no key (run-decision.ts:368), but with a cold or expired cache it GETs the public decisions catalog (l0/catalog.ts via run-decision.ts:344) and the endpoint prompt limit (l0/model.ts:75 via run-decision.ts:393) from openrouter.ai, without a key; behind a blocking proxy it exits 5 'decisions catalog unavailable and cache expired'. 'nothing was sent' reads as no network. Fix: say 'no question was sent' (or equivalent), update the tests and docs that quote the line. Found while working TRDD-FP2SAF4P item 6.

## Approval log

- 2026-11-19T04:53:47+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T05:48:38+0100 — column → dev. landed in 16426995 (main agent)

## Notes

2026-11-19T05:48:35+0100 main agent: done in 16426995. renderEstimateText (classifiers/estimate-output.ts) now prints "classify <action> --estimate: no question was sent"; the tests that asserted the old text (live-capture, run-decision, classify-launch, classify-review-cli, classify-stdin-cli) and the classify.md:24 and SKILL.md:151 paragraphs follow, with "nothing was sent" dated to 14.7.4 and earlier ("the release after 14.7.4" is rewritten to the release number at publish, FP2SAF4P item 8). Worker build, lint and tsc exit 0; after the later ubs:ignore comment edit (profile-accept.test.ts:267) tsc exit 0 by the report of the worker that made the edit, and lint exit 0 in a later worker re-run; commit hook UBS critical 0. Open: release at the next publish. Follow-up card: TRDD-HUBGO80N (the two non-classify dry-run headers).
