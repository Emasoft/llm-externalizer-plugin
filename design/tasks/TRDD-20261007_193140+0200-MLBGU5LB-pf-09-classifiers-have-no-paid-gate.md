---
trdd-id: MLBGU5LB
title: PF-09 Classifiers have no paid gate
column: human_review
status: tasked
created: 2026-10-07T19:31:40+0200
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
approval-datetime: 2026-10-07T19:31:40+0200
implementation-commits: [3bfa8c58]
---

# PF-09 Classifiers have no paid gate

## Goal
Assert and document that classifiers are paid by design: no `allow_paid` field and no paid gate (D2).

## Approval log

- 2026-10-07T19:31:40+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:12+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:36+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed
- 2026-10-10T15:08:18+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review, PASS WITH NOTES (read-only): box 2 scan covers src/classifiers only; the browse root does not exist yet and the classify wiring in cli/launcher.ts is outside the scan and was not grepped; box 3 (docs) has no test, read at docs/setup-and-configuration.md 198-201. Open: the definition-of-done subject clause, owner ruling.
- 2026-10-10T15:16:50+0200 — column → human_review. AI code review done 2026-10-10 (PASS WITH NOTES, recorded above); waits only on the owner

## Plan refs

§1 D2, D36; §8 (Spend).

## Depends on

PF-02 (TRDD-FFPDWWGN)

## Files

- `scripts/llm-ext/src/config.ts`
- `docs/*.md` (settings docs): to be listed at card start
- tests and the vitest include entry: to be listed at card start

## Reuse

- the PF-01 field table
- read the code at card start for every `allow_paid_models` consumer

## Steps

1. The classifier type has no `allow_paid` field; a profile carrying one fails as an unknown key.
2. Add a test that `allow_paid_models` is not consulted by any classify or browse path; the test asserts the absence of a gate.
3. The only spend cap is the opt-in `--max-budget=<usd>` (not added here).
4. Docs say `allow_paid_models` applies to chat profiles only.
5. Add WHY comments (classifiers are paid by design, D2).

## Acceptance

- [x] the classifier type rejects an `allow_paid` field as unknown
- [x] `allow_paid_models` is not consulted by any classify or browse path (test asserts the absence of a gate)
- [x] its docs say it applies to chat profiles only
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

`--max-budget` (L2-11, L2-12).

## Notes

2026-10-10: allow_paid rejected as unknown, test scanning classify and browse paths for allow_paid_models use (classifier-profile.test.ts), docs paragraph in docs/setup-and-configuration.md, committed in 3bfa8c58; boxes 1 to 3 ticked. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
