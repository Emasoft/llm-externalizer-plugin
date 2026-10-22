---
trdd-id: FDSC7O4P
title: BR-22 Cross-platform paths (Windows and Linux)
column: backburner
status: tasked
created: 2026-10-07T20:01:56+0200
updated: 2026-10-07T20:01:58+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:56+0200
---

# BR-22 Cross-platform paths (Windows and Linux)

## Goal

Make the browser module's paths work on Windows and Linux.

## Approval log

- 2026-10-07T20:01:56+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§16 row BR-22 (no further detail in the plan), E99 (credentials refused on Windows, owned by BR-14).

## Depends on

BR-01 (TRDD-RZPFS4SW)

## Files

To be listed at card start.

## Reuse

Read the code at card start.

## Steps

1. List every path the browser module builds (Playwright dir, temp record dir, handoff files) (derived from done-when).
2. Use platform-neutral path handling for each; credentials stay POSIX only (§10).
3. Verify on Linux and Windows (derived from done-when).

## Acceptance

- [ ] browser module paths work on Windows and Linux
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Credential Windows refusal (BR-14).
