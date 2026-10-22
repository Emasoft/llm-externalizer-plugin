---
trdd-id: 0T0DBLSP
title: L0-06 Strip openrouter_metadata and user_id in sanitizeProviderError
column: complete
status: archived
created: 2026-10-07T18:48:36+0200
updated: 2026-10-09T22:16:59+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:48:36+0200
implementation-commits: [afe7a88]
---

# L0-06 Strip openrouter_metadata and user_id in sanitizeProviderError

## Goal
`sanitizeProviderError` removes `user_id`, `sk-…` keys and `openrouter_metadata` from messages and logs.

## Approval log

- 2026-10-07T18:48:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:16:58+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:16:58+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:16:59+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 L0 (Reuses: `sanitizeProviderError` + strip `openrouter_metadata`); §7 (Errors); E15.

## Depends on

none (plan npt: —)

## Files

To be listed at card start (the existing `sanitizeProviderError` and its test file, plus vitest include if a new test file is added).

## Reuse

`sanitizeProviderError` itself. Read the code at card start.

## Steps

1. Read `sanitizeProviderError` and every caller. (derived from done-when)
2. Add stripping of `openrouter_metadata` and `user_id` (it already handles `sk-…` per §7).
3. Add a test with an error body echoing `user_id` and `openrouter_metadata` (E15).
4. Run the existing callers' tests unchanged.
5. WHY comment: the error body echoes these fields and they must not reach messages or logs.

## Acceptance

- [x] E15: Error body echoes `user_id` / `openrouter_metadata` → stripped from message and logs
- [x] existing callers' tests still pass
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed afe7a88 — sanitizeProviderError removes the openrouter_metadata object with its value (user_id, generation_id) from parsed and from truncated bodies; 3 tests, shown failing before the fix. Known limit (comment in the code): the pattern matches the object up to two brace levels. Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 203 files passed / 4 skipped, 3266 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave2-integration.md).

## Out of scope

Error classes (L0-01).
