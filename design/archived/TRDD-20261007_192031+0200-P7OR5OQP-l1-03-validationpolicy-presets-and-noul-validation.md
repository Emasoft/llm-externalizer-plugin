---
trdd-id: P7OR5OQP
title: L1-03 ValidationPolicy presets and noul validation
column: complete
status: archived
created: 2026-10-07T19:20:31+0200
updated: 2026-10-09T23:29:56+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:20:31+0200
implementation-commits: [fa872c06]
---

# L1-03 ValidationPolicy presets and noul validation

## Goal
The `ValidationPolicy` presets of §6 and validation of noul answers under them.

## Approval log

- 2026-10-07T19:20:31+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:29:55+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:29:55+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:29:56+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§6 (validation policy table and answer-set rule), §3 (`ValidationPolicy`, `validateAnswer`), §4 (tolerances owned by `l1/validate.ts`), D6; P-04 (final numbers); E26.

## Depends on

P-04 (TRDD-BQZZFA7R)

## Files

- `scripts/llm-ext/src/classifiers/l1/validate.ts`
- `scripts/llm-ext/src/classifiers/l1/validate.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Define `ValidationPolicy` with the fields of §6: `sum`, `tie`, `score`, `confidence`, `probabilities`, `legend`, with the §6 defaults. Final tolerance numbers come from P-04. (derived from done-when)
2. Export the presets so every caller reads them from this file (§4: validation tolerances have one owner).
3. `validateAnswer` for a noul answer: a null probability is invalid (E26). (derived from done-when)
4. Apply the `confidence` field (`reject` or `coerce-null`) as §6 states. (derived from done-when)

## Acceptance

- [x] presets match the §6 table defaults
- [x] E26: Noul with null probability → invalid
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed fa872c06 — l1/validate.ts policy presets + noul validation, 10 tests; tolerances from P-04. Whole package, run by the coordinator on the committed tree: npm test 215 files passed / 4 skipped, 3414 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet, build 0 per the integration worker; the real settings.yaml hash unchanged.

## Out of scope

Choice validation (L1-04), score validation (L1-05), answer-set rules (L1-06).
