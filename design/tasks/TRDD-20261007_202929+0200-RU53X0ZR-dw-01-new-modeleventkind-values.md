---
trdd-id: RU53X0ZR
title: DW-01 New ModelEventKind values
column: human_review
status: tasked
created: 2026-10-07T20:29:29+0200
updated: 2026-10-10T15:16:51+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:29+0200
implementation-commits: [1bb5661d]
---

# DW-01 New ModelEventKind values

## Goal
Extend the `ModelEventKind` union with the drift event kinds and make every reader handle them.

## Approval log

- 2026-10-07T20:29:29+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:09+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:49+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed; one design point to confirm, drift events excluded from aggregateModelHealth totals
- 2026-10-10T15:08:19+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review, PASS WITH NOTES (read-only): drift events ARE excluded from aggregateModelHealth totals (model-events.ts 226, pinned by model-events-drift.test.ts 38), so a model with only drift events has no entry; the 1bb5661d commit message claims a test that auto-replace stays in step with the union, but only the type check enforces it; no producer writes the new kinds yet (DW-02). Open: the definition-of-done subject clause, owner ruling.
- 2026-10-10T15:16:51+0200 — column → human_review. AI code review done 2026-10-10 (PASS WITH NOTES, recorded above); waits only on the owner

## Plan refs

§11 (snapshot-drift watcher row), §16 (DW table), D24.

## Depends on

none

## Files

- To be listed at card start (the file defining `ModelEventKind` and its readers).

## Reuse

Read the code at card start (`tldr references ModelEventKind`).

## Steps

1. Add kinds for `canonical_slug`, `alias_target`, price and presence changes (derived from §11).
2. Update every reader of the union (found with `tldr references`) (derived from done-when).

## Acceptance

- [x] union extended; readers handle them
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Producing the events (DW-02).

## Notes

2026-10-10: four drift kinds added to ModelEventKind, readers handle them, committed in 1bb5661d (model-events-drift.test.ts, not in the include list until 643d7887); box 1 ticked on that file. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id; open: drift events are excluded from aggregateModelHealth totals, to be confirmed. Report: docs_dev/20261010-EV-01-DW-01-report.md
