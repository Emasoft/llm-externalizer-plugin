---
trdd-id: NYEA7BR3
title: C4-11 Help texts from catalog
column: backburner
status: tasked
created: 2026-10-07T20:00:39+0200
updated: 2026-10-07T20:00:41+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:39+0200
---

# C4-11 Help texts from catalog

## Goal

Generate command help from the catalog specs so the defaults shown match the spec.

## Approval log

- 2026-10-07T20:00:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§4 (command flags/defaults text: catalog spec; `definitions.ts` entries checked against it by test), DOC-04 (`commands.md`, flags checked by DOC-13).

## Depends on

C4-02 (TRDD-V8Q20MLW)

## Files

To be listed at card start.

## Reuse

Read the code at card start.

## Steps

1. Build help text from spec thresholds, ranges and flags, never retyped (derived from §4).
2. Add a test comparing each help default with the spec default (derived from done-when).

## Acceptance

- [ ] defaults shown match spec
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Entry registration (C4-02), `commands.md` (DOC-04).
