---
trdd-id: V3Y4W47F
title: RD-16 Light and dark screenshot check of all SVGs
column: backburner
status: tasked
created: 2026-10-07T18:37:39+0200
updated: 2026-10-07T18:50:31+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:39+0200
---

# RD-16 Light and dark screenshot check of all SVGs

## Goal
Screenshots of every README SVG in light and dark themes.

## Plan refs
§13b (rules: SVGs checked with screenshots in both themes; RD-16 row).

## Depends on
Depends on: RD-04 (TRDD-WEC5UW4Z), RD-07 (TRDD-OIY5LAST)

## Files
Files: to be listed at card start (the plan names: screenshots in `reports/screenshots/`).

## Reuse
Reuse: read the code at card start

## Steps
1. Screenshot every SVG in both themes into `reports/screenshots/` (derived from done-when).

## Acceptance
- [ ] screenshots in `reports/screenshots/`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
Drawing the SVGs (RD-04, RD-07).

## Approval log

- 2026-10-07T18:37:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
