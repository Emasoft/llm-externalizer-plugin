---
trdd-id: 7W3JFF7V
title: L1-04 Choice validation
column: complete
status: archived
created: 2026-10-07T19:20:41+0200
updated: 2026-10-10T00:01:12+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:20:41+0200
implementation-commits: [e2dce2c8, 0b59bb6a]
---

# L1-04 Choice validation

## Goal
Validate choice answers: scaled probability sum, tie detection, unknown keys, NaN and range.

## Approval log

- 2026-10-07T19:20:41+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:00:59+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:00:59+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:12+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§6 (`sum`, `tie`, `probabilities` rows), §3, D6; E20, E21, E22, E23, E24.

## Depends on

L1-03 (TRDD-P7OR5OQP)

## Files

- `scripts/llm-ext/src/classifiers/l1/validate.ts`
- `scripts/llm-ext/src/classifiers/l1/validate.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Sum check under policy `scaled`: tolerance min(0.05, max(0.01, 0.005·nonzero)) plus 1e-9 (§6, D6). (derived from done-when)
2. Tie: when the top two probabilities are within the policy `tie` (0.001), set `tie: true` (E22).
3. A probability that is NaN, negative or above 1 makes the answer invalid (E23).
4. An answer naming a choice key the question does not have is invalid (E24).
5. `probabilities` is `required` for choice (fail closed), per §6. (derived from done-when)

## Acceptance

- [x] scaled sum
- [x] tie
- [x] unknown keys
- [x] NaN and range
- [x] E20: 3-option choice summing 1.01 / 0.97 → accepted / rejected (scaled tol 0.015)
- [x] E21: 60-option choice summing 0.95 → accepted (tol capped at 0.05)
- [x] E22: Top two probabilities within 0.001 → `tie: true`; policies demote to review
- [x] E23: NaN, negative or >1 probability → invalid
- [x] E24: Answer names an unknown choice key → invalid
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed e2dce2c8 and 0b59bb6a (vitest include list) — l1/validate-choice.ts validateChoice (scaled-tolerance sum, tie flag, unknown choice and probability keys, NaN and range), l1/validate-choice.test.ts 20 tests incl. real dec-/sys- choice2/3/10/60 replies. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. Deviation: the code is in l1/validate-choice.ts, not validate.ts as the card's file list says (written in parallel with L1-05); validate.ts untouched. The tie flag is set here; the policies that demote a tie to review belong to the L3 specs.

## Out of scope

Noul validation (L1-03), score validation (L1-05), demoting a tie to review (the L3 spec policy).
