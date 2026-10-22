---
trdd-id: OIY5LAST
title: RD-07 Chart renderer readme-charts.mjs
column: backburner
status: tasked
created: 2026-10-07T18:37:36+0200
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
approval-datetime: 2026-10-07T18:37:36+0200
---

# RD-07 Chart renderer readme-charts.mjs

## Goal
One script that renders every README chart from `assets/data/`.

## Plan refs
§13b (rules: charts rendered by one script from committed files; RD-07 row).

## Depends on
Depends on: RD-05 (TRDD-CRIOJB1O)

## Files
Files: to be listed at card start (the plan names: `scripts/llm-ext/scripts/readme-charts.mjs`, `assets/data/`, the committed SVG).

## Reuse
Reuse: read the code at card start

## Steps
1. Render every chart from `assets/data/` (derived from done-when).
2. Make the output deterministic (derived from done-when).
3. Add a test that compares a rerender with the committed SVG (derived from done-when).

## Acceptance
- [ ] renders every chart from `assets/data/`
- [ ] deterministic output
- [ ] test compares rerender with committed SVG
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
Producing the data (RD-05, RD-06, RD-19); screenshot check (RD-16).

## Approval log

- 2026-10-07T18:37:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
