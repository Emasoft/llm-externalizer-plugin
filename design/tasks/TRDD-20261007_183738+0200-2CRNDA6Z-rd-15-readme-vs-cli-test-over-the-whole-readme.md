---
trdd-id: 2CRNDA6Z
title: RD-15 README-vs-CLI test over the whole README
column: backburner
status: tasked
created: 2026-10-07T18:37:38+0200
updated: 2026-10-07T18:40:32+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:38+0200
---

# RD-15 README-vs-CLI test over the whole README

## Goal
One test that fails when the README names a command, flag or default the CLI lacks, or misses one it has.

## Plan refs
§13b (rules: extends DOC-13 to the whole README; RD-15 row); DOC-13.

## Depends on
Depends on: RD-09 (TRDD-FWQ383XD), RD-10 (TRDD-I31R0ZG1), RD-11 (TRDD-ZAO7AGEO)

## Files
Files: to be listed at card start (the plan names: the README-vs-CLI test).

## Reuse
Reuse: read the code at card start

## Steps
1. Fail on an unknown or missing command, flag or default (derived from done-when).
2. Never compare example output text (derived from done-when).

## Acceptance
- [ ] fails on an unknown or missing command, flag or default
- [ ] never compares example output text
- [ ] the only such test
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
Skill references and classify/browse commands (DOC-13).

## Approval log

- 2026-10-07T18:37:38+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
