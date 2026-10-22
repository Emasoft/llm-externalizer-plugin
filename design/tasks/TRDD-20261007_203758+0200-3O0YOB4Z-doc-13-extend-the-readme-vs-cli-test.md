---
trdd-id: 3O0YOB4Z
title: DOC-13 Extend the README-vs-CLI test
column: backburner
status: tasked
created: 2026-10-07T20:37:58+0200
updated: 2026-10-07T20:38:18+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:37:58+0200
---

# DOC-13 Extend the README-vs-CLI test

## Goal
Extend RD-15's README-vs-CLI test to skill references and the classify/browse commands (no second test).

## Approval log

- 2026-10-07T20:37:58+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-13); §16 card template and definition of done; §17

## Depends on

DOC-04 (TRDD-VN6KKM2U), RD-15 (TRDD-2CRNDA6Z)

## Files

RD-15's test file (extended, not duplicated); vitest include entry; to be listed at card start for the rest.

## Reuse

RD-15's test (extend it); catalog and `definitions.ts` (§13); read the code at card start.

## Steps

1. Extend RD-15's test; do not add a second test (title).
2. Make it compare README and skill flag tables and defaults with the catalog and `definitions.ts` (§13 docs-vs-code checks).

## Acceptance

- [ ] (derived from title) the one test covers skill references and the classify/browse commands as well as the README
- [ ] (derived from title) no second test file exists
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The README flag tables (RD-15's scope).
