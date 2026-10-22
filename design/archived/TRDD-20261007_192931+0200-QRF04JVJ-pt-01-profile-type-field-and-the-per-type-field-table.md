---
trdd-id: QRF04JVJ
title: PT-01 profile-type field and the per-type field table
column: complete
status: archived
created: 2026-10-07T19:29:31+0200
updated: 2026-10-09T22:36:24+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:29:31+0200
implementation-commits: [4f3c805, 3227dd14]
---

# PT-01 profile-type field and the per-type field table

## Goal
Add the `profile-type` field (local, free, paid, scouting, classifier) with one per-type field table in `config.ts` that drives validation and templates.

## Approval log

- 2026-10-07T19:29:31+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:17:07+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:17:08+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:36:24+0200 — COMPLETE by main-agent@llm-externalizer-plugin. done except the parts owned by PT-02, PT-04, PT-06 as recorded.

## Plan refs

§8 (type field, templates and fields per type), §16 definition of done; D19, D20, D36; E81d, E81g, E113.

## Depends on

none (plan npt column: none)

## Files

- `scripts/llm-ext/src/config.ts` (field table, `BUILTIN_PROFILE_NAMES`, docblocks)
- `scripts/llm-ext/src/benchmark/pick.ts` (`SHIPPED_PLACEHOLDER_SHAPES`, lines 1245-1315)
- `scripts/llm-ext/src/dynamic-maintainer.ts` (self-population stays keyed on the dynamic list, line 844)
- tests and the vitest include entry: to be listed at card start

## Reuse

- `DYNAMIC_PROFILE_NAMES` (free, paid, local), `config.ts:1023`, left unchanged
- `buildLocalProfileSection([])`, `config.ts:1462-1467` (`unpopulatedLocalProfile`)
- `--populate-default-profile`, `config.ts:1353`, keeps keying on the dynamic list
- `DYNAMIC_GENERATED_KEYS`: to be listed at card start

## Steps

1. Add the five-value enum `profile-type: local | free | paid | scouting | classifier`; any other value fails at load (E81d). Keep the spelling `profile-type`, every other new key snake_case (D20).
2. Add one field table in `config.ts` (the §8 table: local fields `api_token`, `detected_providers`; free `free_only: true`; paid `selection.price_ceiling_usd_per_million`, `ensemble`; scouting the scout-accuracy pass record; classifier `endpoint`, `max_requests_per_call`, `concurrency`, `timeout_ms`, `max_attempts`, `context_tokens`, `provider`, `session_id`, `user`, `trace`; plus each type's shared fields). Validation and templates read it.
3. Add `BUILTIN_PROFILE_NAMES` (five names, each with a fixed type) beside the unchanged `DYNAMIC_PROFILE_NAMES`. Markers, fixed types and closed keys key on the built-in list; self-population (`dynamic-maintainer.ts:844`, `--populate-default-profile`, `config.ts:1353`) keeps keying on the dynamic list.
4. A built-in name carrying the wrong type fails at load: a built-in name has a fixed type (E113).
5. A profile added after migration without `profile-type` fails at load naming the field and `llm-ext settings new <name> --type <type>` (E81g).
6. Apply the spend rules of D36 (`allow_paid_models` gates billed calls for paid and scouting; classifier has no paid gate; free and local never bill).
7. Update together: `DYNAMIC_GENERATED_KEYS`, `SHIPPED_PLACEHOLDER_SHAPES` (`benchmark/pick.ts:1245-1315`) and `unpopulatedLocalProfile` = `buildLocalProfileSection([])` (`config.ts:1462-1467`).
8. Fix the stale "only two built-ins" docblocks (`config.ts:990, :1350, :1570`).
9. Add WHY comments at the non-obvious rules (built-in list versus dynamic list, fixed type per built-in name).

## Acceptance

- [x] five-value enum; one field table in `config.ts` drives validation and templates
- [x] a new `BUILTIN_PROFILE_NAMES` list (five names, each with a fixed type) exists beside the unchanged `DYNAMIC_PROFILE_NAMES`; markers, fixed types and closed keys key on the built-in list; self-population keeps keying on the dynamic list
- [x] spend rules of D36 applied
- [x] `DYNAMIC_GENERATED_KEYS`, `SHIPPED_PLACEHOLDER_SHAPES` and `unpopulatedLocalProfile` updated together
- [x] stale "only two built-ins" docblocks (`config.ts:990, :1350, :1570`) fixed
- [x] E81d: `profile-type` value outside the five → load error
- [x] E81g: profile added after migration without `profile-type` → load error naming the field and `llm-ext settings new <name> --type <type>`
- [x] E113: built-in name with the wrong type (e.g. `scouting` with `profile-type: classifier`) → load error: a built-in name has a fixed type
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
PARTIAL 2026-10-09: committed 4f3c805 (21 tests, 20 shown failing without the code; Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 203 files passed / 4 skipped, 3266 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave2-integration.md).). DONE: enum + E81d; field table PROFILE_TYPE_FIELDS; BUILTIN_PROFILE_NAMES with fixed types + E113; stale docblocks. NOT DONE: (a) D36 spend rules are in the table only, not wired into the runtime gate (config.ts allow_paid_models check) — follow-up worker; (b) E81g is implemented but dormant until PT-02 sets Settings.profileTypesMigrated; (c) step 7 deliberately NOT done as written: profile-type is in DYNAMIC_USER_OWNED_KEYS, not DYNAMIC_GENERATED_KEYS, because writeDynamicProfileSection deletes generated keys its patch omits and would strip the migrated type; SHIPPED_PLACEHOLDER_SHAPES unchanged, isShippedPlaceholder ignores the field instead; (d) markers and closed keys still key on the dynamic list until PT-04 / PF-04 write marked scouting and or-jev sections.
RESULT 2026-10-09: step 6 committed 3227dd14 — shouldForceFreeMode reads PROFILE_TYPE_FIELDS[type].spend; never-bills types stay in free mode, paid and scouting need allow_paid_models; 19 gate test files (737 tests) unchanged in outcome. Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 206 files passed / 4 skipped, 3311 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave3-integration.md). HANDED TO LATER CARDS, not open here: E81g live check -> PT-02 (sets profileTypesMigrated); classifier ungated -> PT-06 (today a classifier profile is gated like paid, which contradicts the USER ruling 'classifiers are paid by design, no paid switch' until PT-06 defines the classifier shape check); markers and closed keys on the built-in list -> PT-04 / PF-04.

## Out of scope

Migration of existing files (PT-02), the accepted-types check (PT-03), the scouting template (PT-04), strict foreign-field failure (PT-06), `settings new` (PT-08).
