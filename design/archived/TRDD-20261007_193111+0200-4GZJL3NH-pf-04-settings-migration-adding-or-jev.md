---
trdd-id: 4GZJL3NH
title: PF-04 Settings migration adding or-jev
column: complete
status: archived
created: 2026-10-07T19:31:11+0200
updated: 2026-10-10T03:12:56+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:11+0200
implementation-commits: [bf6bdbbd, 21875b8b, f651b119, da2da099]
---

# PF-04 Settings migration adding or-jev

## Goal
Add `or-jev` to existing installs by a comment-preserving migration with a backup.

## Approval log

- 2026-10-07T19:31:11+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:12:50+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:12:51+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:12:56+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§8 (existing installs get `or-jev` through migrations); E83.

## Depends on

PF-03 (TRDD-W418LXJK)

## Files

- `scripts/llm-ext/src/config.ts` (migration)
- tests and the vitest include entry: to be listed at card start

## Reuse

- the existing migration pattern, `benchmark/pick.ts:942-975` (touches built-in sections, backs the file up first)
- the PT-02 backup and comment-preserving writer

## Steps

1. Add a migration that inserts the `or-jev` section, comment-preserving, after a backup.
2. If the user already has a profile named `or-jev`, leave it and warn.
3. Record it in `migrationsApplied`. (derived from done-when)
4. Add a byte-diff test: only the added section differs.
5. Add WHY comments.

## Acceptance

- [x] comment-preserving, byte-diff test
- [x] E83: user already has a profile named `or-jev` → migration leaves it, warns
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed bf6bdbbd (migration, config and lister changes, tests), 21875b8b (the zero-profile self-heal change in src/index.ts rode in this commit), f651b119 (test include list), da2da099 (rebuilt dist) — benchmark/pick.ts migrateOrJevSection and runOrJevStep (step or-jev-section-added, one call line in migrateSettingsTo141, recorded in migrationsApplied): with no or-jev section it inserts the marked classifier template comment-preserving after a backup, sets active_classifier: or-jev right after active: only when unset, prints a notice naming the backup; an end-to-end byte-diff test shows only the added section and the active_classifier line differ. E83 followed literally: an existing or-jev is left byte-identical (no backup, no marker), warned about once, step recorded once; a chat profile named or-jev fails the load saying to rename it or make it a classifier (config.ts built-in name fixes the type, E113). Also: no/empty/null profiles: ends loadable, a dangling active_classifier gets a fix message, hasNoTextProfile in config.ts drives the index.ts self-heal, the profile lister prints the type of classifier and scouting profiles; new src/or-jev-migration.test.ts (19 tests), existing migration fixtures updated. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. OPEN OWNER DECISION: The migration runs at program start for every command, so the first command after an upgrade, even a read-only one such as settings show, rewrites settings.yaml once (adds or-jev and active_classifier, saves a backup, prints a notice). The plan does not say when the migration runs. Owner to choose: keep as built, or have read-only commands skip it and report it as pending. The card closes as built (this was already the design of the earlier 14.1.0 steps); one new test states it. Unverified: profile --show or-jev (resolveProfile of a classifier) was not examined.

## Out of scope

The template (PF-03). The test runs on a temp config dir only (derived from done-when).
