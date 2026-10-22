---
trdd-id: LWDKZO2A
title: IN-07 Text output, --json, and the filter flags (--no-collapse, --save)
column: backburner
status: tasked
created: 2026-10-10T08:23:09+0200
updated: 2026-10-10T08:23:09+0200
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

- [ ] E128 (p between threshold and threshold+band in both lists, receipt counts p >= threshold)
- [ ] collapse and `--no-collapse`
- [ ] `--save` file content
- [ ] `--json` equals today's stdout
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

- Waits on the design note's open question Q4: Output default: plan line 296 and card C4-12 imply text by default and `--json` for the envelope; today the runner prints the JSON envelope only and no `--json` flag exists. Confirm text becomes the default (changes every existing consumer/test) before IN-07.

## Approval log

- 2026-10-10T08:23:09+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
