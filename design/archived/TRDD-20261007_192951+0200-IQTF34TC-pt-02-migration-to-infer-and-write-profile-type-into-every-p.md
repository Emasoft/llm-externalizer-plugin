---
trdd-id: IQTF34TC
title: PT-02 Migration to infer and write profile-type into every profile
column: complete
status: archived
created: 2026-10-07T19:29:51+0200
updated: 2026-10-09T23:11:33+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:29:51+0200
implementation-commits: [52ca4a6c]
---

# PT-02 Migration to infer and write profile-type into every profile

## Goal
Write the inferred `profile-type` into every existing profile (built-in and custom) after a backup, so the field is always explicit and inference code can be deleted.

## Approval log

- 2026-10-07T19:29:51+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:11:33+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:11:33+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:11:33+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§8 (type field), D32, D33, D19, D36; E81c, E81h.

## Depends on

PT-01 (TRDD-QRF04JVJ)

## Files

- `scripts/llm-ext/src/config.ts` (migration, `migrationsApplied`)
- `scripts/llm-ext/src/benchmark/pick.ts` (existing migration pattern, lines 942-975)
- tests and the vitest include entry: to be listed at card start

## Reuse

- the existing migrations that touch only built-in sections and back the file up first, `benchmark/pick.ts:942-975`
- the current policy that custom profiles are never rewritten, `config.ts:2528-2530` (this card deliberately breaks it, D32)
- read the code at card start for the comment-preserving writer and the `<config>/backups/` helper

## Steps

1. Infer each profile's type with today's rules (§8): the names `free`, `paid`, `local`, `scouting` give that type; else `free_only: true` gives free; else `mode: local` gives local; else paid.
2. Back up `settings.yaml` in `<config>/backups/` before writing.
3. Write `profile-type` into every profile, comment-preserving.
4. Record the migration in `migrationsApplied`.
5. Print each profile's inferred type so the user can correct any.
6. Print every field that PT-06 will reject (a field of another type, or unknown to every type; D33), so nothing breaks without warning.
7. A custom profile without `free_only` and with `allow_paid_models: false` is typed paid and bills nothing (D36, E81h).
8. The test runs only on a temp config dir named `llm-ext-…`, never the real one.
9. Add WHY comments: why the custom-profile no-rewrite policy is broken here (D32).

## Acceptance

- [x] backup in `<config>/backups/`
- [x] comment-preserving
- [x] recorded in `migrationsApplied`
- [x] prints each profile's inferred type and every field that PT-06 will reject
- [x] E81c: profile without `profile-type` (existing install) → inferred once, written by PT-02 with a backup, reported
- [x] E81h: custom profile without `free_only`, `allow_paid_models: false`, typed `paid` by PT-02 → no call is billed (D36)
- [x] the migration backs up settings.yaml in <config>/backups/ before writing, and its test runs only on a temp config dir, never the real one
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 52ca4a6c — migration step profile-type-written + every writer stamps the type (docs_dev/20261009-PT-02-report.md, docs_dev/20261009-PT-02-failures-diagnosis.md). Verified by the coordinator: the real ~/.llm-externalizer/settings.yaml hash is unchanged before and after all test runs; backup precedes the write; the write is the locked atomic writer on the YAML document; a second run writes nothing. Product bug found and fixed in this card: llm-ext wrote untyped sections and would have refused its own file once E81g was on. NOT done as the card says: the inference branch of inferProfileType is kept (profile resolution needs it where the migration has not run). Two of the new writer tests were written after their fixes, not shown failing first. Whole package after the wave, run by the coordinator: npm test 210 files passed / 4 skipped, 3349 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet and build 0 per the fixing worker.

## Out of scope

The type field and field table (PT-01), the strict failure on foreign fields (PT-06), deleting inference code is a consequence stated in §8 and is not otherwise specified here.
