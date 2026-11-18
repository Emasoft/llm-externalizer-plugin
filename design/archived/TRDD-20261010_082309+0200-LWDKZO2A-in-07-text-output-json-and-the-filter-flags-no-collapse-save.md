---
trdd-id: LWDKZO2A
title: IN-07 Text output, --json, and the filter flags (--no-collapse, --save)
column: complete
status: archived
created: 2026-10-10T08:23:09+0200
updated: 2026-11-18T17:11:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:23:09+0200
implementation-commits: [9b95e567, 0f502ba9, c4dc6bd5]
---

# IN-07 Text output, --json, and the filter flags (--no-collapse, --save)

## Goal

Give the runner a text output: the text is printed by default and the JSON envelope with `--json`, and filter gets its text rendering, `--no-collapse` and `--save FILE`. A new `classifiers/l2/render-text.ts` plus an optional `DecisionSpec.renderText?` carry the text rendering; the receipt line stays with card C4-12.

## Plan refs

Plan 279, 296, 461 (E128); qs:898-906 (emit), 921-958 (renderRows, save), 960-984.

## Depends on

- IN-01 (TRDD-XHHH0N1E), which provides the shared file input modes.
- Open question Q4 (see Notes).

## Acceptance

- [x] E128 (p between threshold and threshold+band in both lists, receipt counts p >= threshold)
- [x] collapse and `--no-collapse`
- [x] `--save` file content
- [x] `--json` equals today's stdout
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

- Waits on the design note's open question Q4: Output default: plan line 296 and card C4-12 imply text by default and `--json` for the envelope; today the runner prints the JSON envelope only and no `--json` flag exists. Confirm text becomes the default (changes every existing consumer/test) before IN-07.
2026-11-18T16:52:53+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): Q4 = text is the default stdout, --json prints the envelope. 9b95e567 and 0f502ba9 are pre-squash history pointers (on release/13.6.1, not ancestors of HEAD); evidence is c4dc6bd5 (v14.3.0) plus the HEAD tests: filter.test.ts:152,235,256,267,273,281; run-decision.test.ts:234,251,259,267; no vi import. Single-file runs 2026-11-18 from scripts/llm-ext: src/classifiers/catalog/filter.test.ts 43 passed, exit 0; src/classifiers/run-decision.test.ts 72 passed, exit 0. publish 14.7.2 npm test OK.

## Approval log

- 2026-10-10T08:23:09+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T17:11:10+0100 — COMPLETE by main-agent@llm-externalizer-plugin. all boxes ticked; code in v14.7.2; the covering single test files passed 2026-11-18 (batch 4 report); main agent ruling, delegated by USER 2026-11-18.
