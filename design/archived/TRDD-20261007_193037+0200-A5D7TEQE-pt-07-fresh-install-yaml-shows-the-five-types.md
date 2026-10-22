---
trdd-id: A5D7TEQE
title: PT-07 Fresh-install YAML shows the five types
column: complete
status: archived
created: 2026-10-07T19:30:37+0200
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
approval-datetime: 2026-10-07T19:30:37+0200
implementation-commits: [3bfa8c58, 67649b69, 03c7d5a9]
---

# PT-07 Fresh-install YAML shows the five types

## Goal
Make the trailing example comment of the fresh-install `settings.yaml` show one example per profile type, copied from the templates.

## Approval log

- 2026-10-07T19:30:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:15+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:28+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed
- 2026-10-10T15:08:16+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review: the copied-from-templates half of the box was proven only by a circular test; fixed by a test against generateDefaultSettings in 03c7d5a9 (shown red under a mutation). Definition of done now met, including a commit with this card id in its subject (03c7d5a9). Stale citation config.ts 1626-1651 in the body, the code is now near 2049. tsc, eslint clean, suite 4975 passed.
- 2026-10-10T15:16:57+0200 — COMPLETE by main-agent@llm-externalizer-plugin. all acceptance boxes ticked; AI code review 2026-10-10 passed after the added tests.

## Plan refs

§8 (five built-in profiles, templates); `config.ts:1626-1651`.

## Depends on

PT-04 (TRDD-N2L9BN1Q), PF-03 (TRDD-W418LXJK)

## Files

- `scripts/llm-ext/src/config.ts` (`renderDefaultSettingsYaml`, trailing comment at `:1626-1651`)
- tests and the vitest include entry: to be listed at card start

## Reuse

- the five templates (PT-01, PT-04, PF-03)
- read the code at card start for how the current comment is built

## Steps

1. Replace the trailing example comment (`config.ts:1626-1651`) with one example per type.
2. (derived from done-when) Generate each example from its template, never typed by hand.
3. (derived from done-when) Test that each example equals its template.
4. Add WHY comments.

## Acceptance

- [x] the trailing example comment (`config.ts:1626-1651`) shows one example per type, copied from the templates
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The templates themselves (PT-04, PF-03).

## Notes

2026-10-10: default settings.yaml trailing comment now generates one example per profile type plus the ensemble (profileExampleLines in config.ts, config-default-settings.test.ts), committed in 3bfa8c58; box 1 ticked. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
2026-10-10: 67649b69 changed the example caption for this card: the pool note (list at least one model under free_models) now appears only for a free_only example with an empty pool, and the PT-07 test validates every rendered example with the validator as oracle (profileTypeFieldIssues) instead of repeating the code's condition; 67649b69's body names this card id. Report: docs_dev/20261010-wave9-final-fixes-report.md
