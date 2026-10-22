---
trdd-id: STV2Y025
title: DOC-02 Copies + drift test
column: backburner
status: tasked
created: 2026-10-07T20:35:38+0200
updated: 2026-10-07T20:35:43+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:35:38+0200
---

# DOC-02 Copies + drift test

## Goal
Both skills carry the same Jev rulebook, and drift fails the build.

## Approval log

- 2026-10-07T20:35:38+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-02); §16 card template and definition of done; §17; Example 4

## Depends on

DOC-01 (TRDD-EGFYCVC9), DOC-03 (TRDD-YGS3IEJF), DOC-09 (TRDD-OWJJEWBU)

## Files

`skills/llm-externalizer-classify/references/jev-protocol.md`, `skills/llm-externalizer-browse/references/jev-protocol.md`, `scripts/llm-ext/scripts/sync-jev-protocol.mjs`, `scripts/llm-ext/src/docs/jev-protocol-drift.test.ts`, vitest include entry in `scripts/llm-ext/vitest.config.ts`.

## Reuse

none stated in the plan; read the code at card start (awesome-jev `sync_skills.py` pattern, §13).

## Steps

1. Take the source location DOC-01 chose.
2. The sync script copies the source to both references, byte for byte.
3. The test compares each copy with the source and names the stale copy and the sync command.
4. Pattern: awesome-jev `sync_skills.py` (§13).

## Acceptance

- [ ] a changed copy fails the test
- [ ] the sync script restores it
- [ ] CPV clean on both skills
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The rulebook text (DOC-01).
