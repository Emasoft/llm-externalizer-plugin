---
trdd-id: NB7JXJGF
title: L1-05 Score validation
column: complete
status: archived
created: 2026-10-07T19:20:53+0200
updated: 2026-10-10T00:01:00+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:20:53+0200
implementation-commits: [3d316947, 0b59bb6a]
---

# L1-05 Score validation

## Goal
Validate score answers by expected value and by integer index.

## Approval log

- 2026-10-07T19:20:53+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:00+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:00+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:00+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§6 (`score` row, `probabilities` row), §3; E25.

## Depends on

L1-03 (TRDD-P7OR5OQP)

## Files

- `scripts/llm-ext/src/classifiers/l1/validate.ts`
- `scripts/llm-ext/src/classifiers/l1/validate.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Policy `expected-value`: the score is a float in [0, N−1] within tolerance of Σi·pᵢ, tolerance 0.02 + 0.005·N(N−1)/2 (§6). (derived from done-when)
2. Policy `integer-index`: the score is an integer index. (derived from done-when)
3. `probabilities` is optional for score (§6). (derived from done-when)
4. A score outside [0, N−1] or far from Σi·pᵢ is invalid (E25).

## Acceptance

- [x] expected-value rule
- [x] integer-index rule
- [x] E25: Score value outside [0, N−1] or far from Σi·pᵢ → invalid
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 3d316947 and 0b59bb6a (vitest include list) — l1/validate-score.ts validateScore (expected-value rule, integer-index rule, E25), l1/validate-score.test.ts 16 tests incl. real dec/sys score3/5/10 replies. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. Deviation: the code is in l1/validate-score.ts, not validate.ts as the card's file list says (written in parallel with L1-04); validate.ts untouched.

## Out of scope

Noul and choice validation (L1-03, L1-04), answer-set rules (L1-06).
