---
trdd-id: 2L1JAJG1
title: PF-08 provider trace session_id and user validation
column: human_review
status: tasked
created: 2026-10-07T19:31:35+0200
updated: 2026-10-10T15:16:49+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:35+0200
implementation-commits: [3bfa8c58]
---

# PF-08 provider trace session_id and user validation

## Goal
Validate `provider`, `trace`, `session_id` and `user` strictly.

## Approval log

- 2026-10-07T19:31:35+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:11+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:34+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed
- 2026-10-10T15:08:17+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review, PASS WITH NOTES (read-only; each box has a named test and a named breaking change, none applied): provider VALUES are not validated, only keys; the 257-character refusal is asserted for user in the PF-08 test and for session_id in an older test. Open: the definition-of-done subject clause, owner ruling.
- 2026-10-10T15:16:49+0200 — column → human_review. AI code review done 2026-10-10 (PASS WITH NOTES, recorded above); waits only on the owner

## Plan refs

§8 (classifier schema).

## Depends on

PF-01 (TRDD-82LIQI5I)

## Files

- `scripts/llm-ext/src/config.ts`
- tests and the vitest include entry: to be listed at card start

## Reuse

- the PF-01 field table

## Steps

1. `provider`: only strict OpenRouter ProviderPreferences keys are accepted.
2. `session_id` and `user`: at most 256 characters.
3. `trace`: known keys plus custom keys allowed.
4. Add WHY comments.

## Acceptance

- [x] strict provider keys
- [x] session_id and user at most 256 characters
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Other classifier fields (PF-01).

## Notes

2026-10-10: strict OpenRouter provider keys and trace key checks plus session_id and user 256 versus 257 tested in classifier-profile.test.ts, committed in 3bfa8c58; boxes 1 and 2 ticked. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id; the provider key list is a maintained contract to update with the OpenRouter docs. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
