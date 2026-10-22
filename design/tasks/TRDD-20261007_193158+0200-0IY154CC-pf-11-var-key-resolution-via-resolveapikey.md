---
trdd-id: 0IY154CC
title: PF-11 VAR key resolution via resolveApiKey
column: human_review
status: tasked
created: 2026-10-07T19:31:58+0200
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
approval-datetime: 2026-10-07T19:31:58+0200
implementation-commits: [3bfa8c58]
---

# PF-11 VAR key resolution via resolveApiKey

## Goal
Resolve a classifier profile's `$VAR` key through `resolveApiKey`, never writing the key.

## Approval log

- 2026-10-07T19:31:58+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:14+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:05:39+0200 — column → human_review. audit 2026-10-10 (docs_dev/20261010_150505+0200-trdd-dev-cards-audit.md): code committed, nobody working it; only the definition-of-done box is open and its clause one commit with the card id in its subject cannot be met without rewriting history (the wave commit names only ZB41KG62); owner ruling needed
- 2026-10-10T15:08:18+0200 — column → ai_review. review of 05726364: no code review of this card ever ran, so human_review overstated it; an AI review of its commits is dispatched 2026-10-10; the subject-id clause question stays with the owner
- 2026-10-10 AI code review, PASS WITH NOTES (read-only): the code calls resolveEnvValue, not a shared resolveApiKey (none exists); key-never-written is tested on the resolved profile only, no end-to-end test that a real run keeps the key out of stdout, logs and reports (run-decision registers it with the redactor); config.ts resolveEnvValue now ignores a whitespace-only plugin option for ALL callers, tested for the classifier only. Open: the definition-of-done subject clause, owner ruling.
- 2026-10-10T15:16:50+0200 — column → human_review. AI code review done 2026-10-10 (PASS WITH NOTES, recorded above); waits only on the owner

## Plan refs

§8 (classifier schema `api_key` `$VAR`); E85.

## Depends on

PF-01 (TRDD-82LIQI5I)

## Files

- `scripts/llm-ext/src/config.ts`
- tests and the vitest include entry: to be listed at card start

## Reuse

- `resolveApiKey`: read the code at card start

## Steps

1. Resolve `api_key: $VAR` through `resolveApiKey`.
2. An unset variable is an error naming the variable.
3. The key is never written to settings, logs or reports.
4. Add WHY comments.

## Acceptance

- [x] key never written
- [x] E85: `$VAR` key not set → error naming the variable
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Field table (PF-01).

## Notes

2026-10-10: resolveClassifierApiKey (environment only, E85 error naming profile and variable) in l2/profile.ts, tested in l2/profile.test.ts, committed in 3bfa8c58; boxes 1 and 2 ticked. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
