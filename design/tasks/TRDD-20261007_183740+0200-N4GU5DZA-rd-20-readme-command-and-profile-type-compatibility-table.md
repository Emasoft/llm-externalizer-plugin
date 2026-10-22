---
trdd-id: N4GU5DZA
title: RD-20 README command and profile-type compatibility table
column: backburner
status: tasked
created: 2026-10-07T18:37:40+0200
updated: 2026-10-07T18:40:35+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:40+0200
target-release: 14.2.0
---

# RD-20 README command and profile-type compatibility table

## Goal
A README table `SUPPORTED PROFILE TYPES` generated from each command's `acceptedProfileTypes`, guarded by a test (14.2.0).

## Plan refs
§13b (RD-20 row); §8; §2 rulings of 2026-10-07 (table layout, ✅/❌); PT-03.

## Depends on
Depends on: RD-02 (TRDD-VJTBC6IC), PT-03 (TRDD-B9FWID59)

## Files
Files: to be listed at card start (the plan names: the README table, `acceptedProfileTypes` in `tools/definitions.ts`).

## Reuse
Reuse: read the code at card start

## Steps
1. Heading `SUPPORTED PROFILE TYPES`; columns `command name`, `command description` (one line from the command's own help text), `free`, `paid`, `classifier`, `scouting`, `local` in that order; ✅ supported, ❌ not (derived from done-when).
2. One row per CLI command, names from RD-02, generated from `acceptedProfileTypes`, never by hand (derived from done-when).
3. Test fails if the README table differs from the generated one (derived from done-when).
4. Check required rows: mass-scouting commands ✅ only `scouting`; plain code review ✅ `local`, `free`, `paid`; `classify review` (classifier code review) ✅ only `classifier` (derived from done-when).

## Acceptance
- [ ] layout exactly as the user sketched it
- [ ] one row per CLI command
- [ ] generated from `acceptedProfileTypes`, never typed by hand
- [ ] test fails if README table differs from generated
- [ ] required rows hold
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
The `acceptedProfileTypes` field and runtime check (PT-03).

## Approval log

- 2026-10-07T18:37:40+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
