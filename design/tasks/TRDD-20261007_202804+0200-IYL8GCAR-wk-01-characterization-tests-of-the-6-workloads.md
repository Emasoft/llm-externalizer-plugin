---
trdd-id: IYL8GCAR
title: WK-01 Characterization tests of the 6 workloads
column: human_review
status: tasked
created: 2026-10-07T20:28:04+0200
updated: 2026-10-10T15:16:50+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:28:04+0200
implementation-commits: [1bb5661d]
---

# WK-01 Characterization tests of the 6 workloads

## Goal
Pin the current outputs of the 6 existing benchmark workloads in tests before any refactor.

## Approval log

- 2026-10-07T20:28:04+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:07+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:44+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed; its test also fakes Date, which falls under the open owner decision on test doubles
- 2026-10-10T15:08:19+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review, PASS WITH NOTES on a NARROWED claim (read-only; the reviewer read lines 1-180 and 425-678 of the test, NOT the SPECS and GOLDEN values in 180-425): the test pins orchestration (ledger names, selection reasons, report names, hashes), not what a workload measures, since all scenarios but force use pre-seeded rows; it fakes Date (ledger day key and timestamps depend on it), a double beyond the fetch seam. Open: the owner decision on test doubles and the definition-of-done subject clause.
- 2026-10-10T15:16:50+0200 — column → human_review. AI code review done 2026-10-10 (PASS WITH NOTES, recorded above); waits only on the owner

## Plan refs

§11 (workload-kit row: "characterization tests first"), §16 (WK table), D16.


## Depends on

none

## Files

- To be listed at card start (test files for the 6 workloads among the files under scripts/llm-ext/src/benchmark/, to be listed at card start, and the explicit vitest include list in `scripts/llm-ext/vitest.config.ts`).

## Reuse

Read the code at card start.

## Steps

1. List the 6 workloads and the outputs each produces (derived from done-when).
2. For each workload, capture its current output and write a test asserting it exactly (derived from done-when).
3. Add the test files to the vitest include list (derived from §16 definition of done).

## Acceptance

- [x] current outputs pinned
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Any change to workload code (WK-02 to WK-09).

## Notes

2026-10-10: characterization tests of the 6 benchmark workloads committed in 1bb5661d (workload-characterization.test.ts, 6 of 6 mutations caught; the file is not in vitest.config.ts include list until 643d7887); box 1 ticked on that file. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62) and the file's include entry arrived only in 643d7887; commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-WK-01-report.md
