---
trdd-id: NHOPHWGA
title: classify requirements returns three vague imperatives as requirements at 8 to 10 of 10 under context
column: todo
status: tasked
created: 2026-11-19T13:03:06+0100
updated: 2026-11-19T13:03:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T13:03:06+0100
---

# classify requirements returns three vague imperatives as requirements at 8 to 10 of 10 under context

In requirements check 1 of TRDD-WYY3SPDX (2026-11-19, report reports/wyy3spdx/20261119_125849+0100-requirements-check-1-run.md), classify requirements returned three vague imperatives of the S5KOOT2S vague set as requirements at the same high rate under both context wordings, with --context "we built the settings page yesterday." and model typesafe/jev-1.14-20261014: v02 "make it feel better somehow" embedded 10 of 10 in both builds; v07 "make it a bit more professional" 10 of 10 in both forms and both builds; v09 "make it shine a little" embedded 9 of 10 (old wording) and 8 of 10 (new wording). One output per item of the same embedded inputs from 2026-11-04, kept outside the repository, gave v02 0.37, v09 0.45 and v10 0.37 (below the 0.6 gate) and v07 0.79 (returned). The baseline V of 43 returned vague calls of 200 is far above the per-item rates the WYY3SPDX pre-registration assumed. Since both wordings give the same rate, the wording change of 53e41288 is not the cause. Task: find out what raises P(requirement) on these items, by a measurement that varies one thing at a time (first with and without --context on the same build, 10 runs per item and form), pre-registered before any call; then decide whether the gold label of v07 is wrong, or the requirement question needs a change, and open a card for that change.

## Approval log

- 2026-11-19T13:03:06+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
