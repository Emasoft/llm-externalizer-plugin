---
trdd-id: V8Q20MLW
title: C4-02 definitions.ts classify entries
column: complete
status: archived
created: 2026-10-07T20:00:10+0200
updated: 2026-10-10T05:02:35+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:10+0200
implementation-commits: [6cc2a9ad, 3c3db86f]
---

# C4-02 definitions.ts classify entries

## Goal

Register the classify commands in `tools/definitions.ts` so that they are checked against the catalog specs.

## Approval log

- 2026-10-07T20:00:10+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:41:05+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 10 starts: C4-02 dispatched to a worker; C4-01 runner is committed (643d7887, 67649b69)
- 2026-10-10T05:02:35+0200 — COMPLETE by main-agent@llm-externalizer-plugin. consistency test and definition of done met by evidence on the card; wiring moved to C4-03.

## Plan refs

§3 L4 row (wiring in `tools/definitions.ts`), §4 (command flags/defaults text: catalog spec; `definitions.ts` entries checked against it by test), PF-05 (classifier rows of `acceptedProfileTypes`).

## Depends on

C4-01 (TRDD-BUL4EEBP)

## Files

- `scripts/llm-ext/src/tools/definitions.ts` (change).
- Test file and vitest include entry: to be listed at card start.

## Reuse

Read the code at card start.

## Steps

1. Read `tools/definitions.ts` and the catalog registry `classifiers/catalog/index.ts` (derived from done-when).
2. Add one entry per classify command, with flags and defaults taken from the catalog spec, never retyped (§4).
3. Add the consistency test: every catalog spec has an entry and every entry matches its spec (derived from done-when).

## Acceptance

- [x] consistency test vs catalog
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Launcher wiring and help (C4-03), help text generation (C4-11), profile-type acceptance rows (PF-05).

## Notes

2026-10-10: classify tool entries generated from the decision catalog (classifyTools, SHARED_FLAGS in classifiers/shared-flags.ts, classifierProfileRows), consistency test vs catalog in src/tools/definitions-classify.test.ts, committed in 6cc2a9ad and 3c3db86f; box 1 ticked on that file. Definition-of-done clauses against the evidence: include-list entry (vitest.config.ts line 686) met; typecheck, lint and full suite clean at 3c3db86f (262 files, 4685 tests, per coordinator) met; no test doubles beyond the fetch seam met (the test passes a throwing fetch and plain data settings, no vi.mock); one commit with the TRDD id in its subject met (6cc2a9ad subject ends '(TRDD-V8Q20MLW)', 3c3db86f names it too); WHY comments met (comments in definitions.ts and shared-flags.ts, spot-checked by count only). Wiring the entries into the tool list moved to C4-03 (TRDD-4Q1IVJOE) by coordinator decision; this card's box did not require it. Catalog gaps for C4-11: a DecisionSpec has no description field (entry and help text are generic), no way to mark a threshold as integer (top, chunk, candidate-cap are declared number). Known cost: about +17 ms CLI start from the catalog import (buildTools is synchronous). Reports: docs_dev/20261010-C4-02-report.md, docs_dev/20261010-PF-05-report.md
