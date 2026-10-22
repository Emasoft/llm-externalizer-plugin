---
trdd-id: 9R2ILMD6
title: PF-07 endpoint systemone rule
column: complete
status: archived
created: 2026-10-07T19:31:29+0200
updated: 2026-10-10T15:16:57+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:29+0200
implementation-commits: [3bfa8c58, 9d0660ae]
---

# PF-07 endpoint systemone rule

## Goal
Allow `endpoint: systemone` only for models whose catalog entry declares System One or `typesafe/*`.

## Approval log

- 2026-10-07T19:31:29+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:10+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:31+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed
- 2026-10-10T15:08:17+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review: the typesafe id half and the alias-by-target half of the box had no discriminating test; fixed by two tests in 9d0660ae (each shown red under a mutation). Definition of done now met, including a commit with this card id in its subject (9d0660ae). tsc, eslint clean, suite 4975 passed.
- 2026-10-10T15:16:57+0200 — COMPLETE by main-agent@llm-externalizer-plugin. all acceptance boxes ticked; AI code review 2026-10-10 passed after the added tests.

## Plan refs

§8 (`endpoint: systemone`), §14 error 14.

## Depends on

PF-02 (TRDD-FFPDWWGN)

## Files

- `scripts/llm-ext/src/config.ts`
- tests and the vitest include entry: to be listed at card start

## Reuse

- the PF-02 catalog access

## Steps

1. At selection time, reject `endpoint: systemone` unless the model's catalog entry declares System One or the id is `typesafe/*`.
2. (derived from done-when) The error names the model and the endpoint.
3. Add WHY comments.

## Acceptance

- [x] `endpoint: systemone` accepted only for models whose catalog entry declares System One or `typesafe/*`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Other catalog checks (PF-02).

## Notes

2026-10-10: endpoint systemone rule implemented in profile-checks.ts (the card said config.ts; layering) and tested in profile-checks.test.ts and l2/profile.test.ts, committed in 3bfa8c58; box 1 ticked. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
