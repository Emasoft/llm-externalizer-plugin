---
trdd-id: 3ZVURQ58
title: PF-06 settings commands for classifier profiles
column: backburner
status: tasked
created: 2026-10-07T19:31:21+0200
updated: 2026-10-07T19:31:29+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:21+0200
---

# PF-06 settings commands for classifier profiles

## Goal
Make the `settings` commands work for classifier profiles: list, show, validate, select.

## Approval log

- 2026-10-07T19:31:21+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§8 (selection, `settings validate`), §8 table row `settings *`.

## Depends on

PF-03 (TRDD-W418LXJK)

## Files

- the settings command module and `scripts/llm-ext/src/config.ts`: to be listed at card start
- tests and the vitest include entry: to be listed at card start

## Reuse

- the existing `settings` commands: read the code at card start

## Steps

1. List classifier profiles in `settings list`.
2. `settings show` prints a classifier profile.
3. `settings validate` runs the schema check and the PF-02 catalog checks.
4. `settings select` can select the active classifier (`active_classifier`). (derived from done-when)
5. Add WHY comments.

## Acceptance

- [ ] list works for classifier profiles
- [ ] show works for classifier profiles
- [ ] validate works for classifier profiles
- [ ] select works for classifier profiles
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Profile docs (DOC-10), `settings new` (PT-08).
