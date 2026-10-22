---
trdd-id: N2L9BN1Q
title: PT-04 scouting as the fifth built-in template
column: complete
status: archived
created: 2026-10-07T19:30:12+0200
updated: 2026-10-10T00:05:45+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:12+0200
implementation-commits: [6bf80ac5, 0b59bb6a, f09e1c3e, cc7c4c19, b2261ad9, 633f1ef3, 821cb085]
---

# PT-04 scouting as the fifth built-in template

## Goal
Make `scouting` a built-in template written on fresh install as a marked placeholder, with a safe writer for the benchmark and a clear refusal for mass scouting.

## Approval log

- 2026-10-07T19:30:12+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:05:45+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:05:45+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:05:45+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§8 (five built-in profiles), D19, D34; `scout-accuracy.ts:137, 143-150`.

## Depends on

PT-01 (TRDD-QRF04JVJ), PT-02 (TRDD-IQTF34TC)

## Files

- `scripts/llm-ext/src/config.ts` (fresh-install template)
- `scripts/llm-ext/src/benchmark/pick.ts` (writer, `:603-618`; migrations `:942-975`)
- `scripts/llm-ext/src/mass_scouting/cli.ts` (refusal, `:662, :681`)
- `scripts/llm-ext/src/benchmark/scout-accuracy.ts`
- tests and the vitest include entry: to be listed at card start

## Reuse

- the locked, marked, backed-up writer: read the code at card start
- migration pattern, `benchmark/pick.ts:942-975`
- `profile-fallback.ts:179-185` (shows `paid_models` in `scouting` is never read)
- the two duplicated scouting constants stay (import-cycle comment, `scout-accuracy.ts:137`)

## Steps

1. Write `scouting` on a fresh install as a placeholder with the generated marker.
2. Add a migration that gives existing unmarked `scouting` sections the marker, with a backup.
3. Make `benchmark scout-accuracy` write through the locked, marked, backed-up writer (today it writes with no marker, lock or backup, `benchmark/pick.ts:603-618`).
4. Stop writing the unused `paid_models` list into `scouting`.
5. Mass scouting on the placeholder refuses with "run `llm-ext benchmark scout-accuracy`", not "no PASS" (`mass_scouting/cli.ts:662, :681`).
6. Add WHY comments (keep the two duplicated scouting constants, import cycle).

## Acceptance

- [x] written on fresh install as a placeholder with marker
- [x] existing unmarked `scouting` sections get the marker by migration (with backup)
- [x] `benchmark scout-accuracy` writes through the locked, marked, backed-up writer and stops writing the unused `paid_models`
- [x] mass scouting on the placeholder refuses with the benchmark hint, not "no PASS" (`mass_scouting/cli.ts:662, :681`)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 6bf80ac5, 0b59bb6a, f09e1c3e, cc7c4c19, b2261ad9, 633f1ef3, 821cb085 - scouting is the fifth built-in template: a marked typed scouting placeholder is written on fresh install; migration step scouting-section-marked marks an existing unmarked section with a backup and removes keys outside the closed set (the old paid_models), sanctioned by plan lines 236 and 700; benchmark scout-accuracy writes through the locked marked writer without paid_models; mass scouting on the placeholder refuses with the benchmark hint. Whole package: full suite 225 files / 3572 passed / 0 failed on the committed tree, tsc and eslint clean. Adversarial-review follow-ups fixed: the step now does its work on every pass and records once, so restoring a backup no longer locks the user out (cc7c4c19); a re-running step writes one backup per identical content (cc7c4c19); an unreadable entry in backups/ no longer aborts the migration and the notices say where the backup is (633f1ef3).
OPEN 2026-10-10: url is kept in the scouting closed key set although the plan field table omits it (existing benchmarked sections carry it); no placeholder is created for existing installs without a scouting section; active: free still delegates mass scouting to the free pool (card PT-05 owns that); the worker used exact-string scripted edits where fastedit could not target a line, and a second worker re-read the diffs (one cosmetic finding, fixed).

## Out of scope

Type enum and field table (PT-01), the type-inference migration (PT-02), mass-scouting model resolution (PT-05), the `or-jev` template (PF-03).
