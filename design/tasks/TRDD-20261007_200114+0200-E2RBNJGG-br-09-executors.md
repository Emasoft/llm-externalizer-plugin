---
trdd-id: E2RBNJGG
title: BR-09 Executors
column: backburner
status: tasked
created: 2026-10-07T20:01:14+0200
updated: 2026-10-07T20:01:17+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:14+0200
---

# BR-09 Executors

## Goal

Executors for each browse action.

## Approval log

- 2026-10-07T20:01:14+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (executors), E108.

## Depends on

BR-08 (TRDD-5D4X8KFN)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Implement click, type, select, scroll, navigate, back, wait.
3. A `select` on an element with no options is an action error and the step is recorded (E108).

## Acceptance

- [ ] click, type, select, scroll, navigate, back, wait
- [ ] E108: `select` on an element with no options → action error, step recorded
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Typing model (BR-10), password fill (BR-14).
