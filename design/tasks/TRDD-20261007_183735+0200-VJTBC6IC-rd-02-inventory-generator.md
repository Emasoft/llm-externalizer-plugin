---
trdd-id: VJTBC6IC
title: RD-02 Inventory generator
column: backburner
status: tasked
created: 2026-10-07T18:37:35+0200
updated: 2026-10-07T18:40:28+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:35+0200
---

# RD-02 Inventory generator

## Goal
A script that lists, as JSON, every CLI group, command, slash command, skill, agent, hook and the statusline, with per-command profile-type and estimate support read from today's code.

## Plan refs
§13b (RD-02 row); §8; the profile-type ruling in §2; D25.

## Depends on
Depends on: none

## Files
Files: to be listed at card start (the plan names: the inventory script; `cli/launcher.ts` group registry and `tools/definitions.ts` as its sources).

## Reuse
Reuse: read the code at card start

## Steps
1. List every CLI group and command from `cli/launcher.ts`'s group registry and `tools/definitions.ts`, including `benchmark` (derived from done-when).
2. List slash commands, skills, agents, hooks and the statusline (derived from done-when).
3. Per CLI command emit `acceptedTypes` over the five profile types and `--estimate` support, read from today's code, each entry citing file:line (derived from done-when).
4. Emit the list of places where today's code disagrees with the profile-type ruling, first known: mass scouting on the free pool under a free profile, `mass_scouting/cli.ts` `resolveScoutModel` (derived from done-when).
5. Hand that list to the profile-type cards as input (derived from done-when).

## Acceptance
- [ ] JSON lists every CLI group and command (including `benchmark`), slash commands, skills, agents, hooks, statusline
- [ ] per command: `acceptedTypes` over the five profile types and `--estimate` support, each with file:line
- [ ] disagreement list exists and includes the `resolveScoutModel` case
- [ ] disagreement list handed to the profile-type cards
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
Runtime enforcement of profile types (PT-03); the README table (RD-20).

## Approval log

- 2026-10-07T18:37:35+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
