---
trdd-id: T229KMOU
title: consumer-guidelines.md re-check against the current release
column: dev
status: tasked
created: 2026-11-19T04:31:39+0100
updated: 2026-11-19T04:43:52+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:31:39+0100
---

# consumer-guidelines.md re-check against the current release

skills/llm-externalizer-cli-reference/references/consumer-guidelines.md line 3 says its statements and release markers were checked against the source at the tag v14.7.2, 'the latest release', and the line 5 legend defines the marker '(next release after 14.7.2: TRDD-xxxx)'. v14.7.3 and v14.7.4 are released (both release commits dated 2026-11-19). Re-check every statement and every '(since X)' marker against the latest release tag, then update line 3 and the legend to name that tag. Found while working TRDD-FP2SAF4P; split out of TRDD-SZ7TO9FW, whose open box (questions 1 and 5 rewritten in final form) waits on nine backburner children. Size S.

## Approval log

- 2026-11-19T04:31:39+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T04:43:41+0100 — column → dev by main-agent@llm-externalizer-plugin. consumer-guidelines.md rechecked against v14.7.4; header lines 3 and 5 and the Q1 session-compact clause edited
2026-11-19T04:43:52+0100 main agent: worker report reports_dev/t229kmou/20261119_043816+0100-consumer-guidelines-recheck.md; lines 3 and 5 now name v14.7.4; Q1 profile-types bullet gained the 14.7.4 session-summary clause (source v14.7.4 session_summary/local-model.ts:354-355, commit 0e6fa5fb, first tag v14.7.4), added by the main agent after two harness reviews found line 3 overstated the check without it. Uncovered 14.7.3/14.7.4 behaviours listed in the report were judged outside the nine questions.
