---
trdd-id: W57VQ346
title: PT-06 Strict per-type fields
column: complete
status: archived
created: 2026-10-07T19:30:29+0200
updated: 2026-10-10T00:56:02+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:29+0200
implementation-commits: [3e16f0a1, e8d7d255, 0421472e]
---

# PT-06 Strict per-type fields

## Goal
Fail at load on any field that belongs to another type or is unknown to every type, naming the field and its type (D33).

## Approval log

- 2026-10-07T19:30:29+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:55:54+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:55:59+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:56:02+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§8, D33; `config.ts:2662` (today unknown keys are silently ignored); E81e.

## Depends on

PT-02 (TRDD-IQTF34TC)

## Files

- `scripts/llm-ext/src/config.ts` (custom-profile validation near `:2662`)
- tests and the vitest include entry: to be listed at card start

## Reuse

- the per-type field table from PT-01
- read the code at card start for the load-time validator

## Steps

1. Validate each profile's keys against its type's field table (PT-01).
2. A foreign field fails at load naming the field and the type it belongs to.
3. A field unknown to every type fails at load naming it.
4. Ships only after PT-02 has listed such fields in the user's files (D33).
5. Add WHY comments (custom profiles used to ignore unknown keys).

## Acceptance

- [x] a foreign or unknown field fails at load naming it and its type
- [x] E81e: field of another type in a profile (e.g. `free_only` in a paid profile) → load error naming the field and its type
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 3e16f0a1 (one commit for PT-06 and PF-03), e8d7d255 (test include list), 0421472e (rebuilt dist) — config.ts PROFILE_TYPE_FIELDS, validateProfile, profileTypeFieldIssues, profileTypesSettingsErrors (a foreign or unknown field fails at load naming field, type and the fix), profile-strict-fields.test.ts, profile-review-round.test.ts; benchmark/pick.ts migration notice names profile, field, type and fix. E81e pinned. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Deviations: the plan field table omitted app_name and http_referer, added to the chat types; strictness applies only to a profile with an explicit profile-type. OPEN ITEMS: a migrated custom profile carrying another type's fields (e.g. free_models without free_only, typed paid) fails the load, and the migration notice now names profile, field, type and fix.

## Out of scope

The migration that lists the offending fields (PT-02), the field table (PT-01).
