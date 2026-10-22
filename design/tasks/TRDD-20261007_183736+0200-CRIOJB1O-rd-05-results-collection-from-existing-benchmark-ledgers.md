---
trdd-id: CRIOJB1O
title: RD-05 Results collection from existing benchmark ledgers
column: backburner
status: tasked
created: 2026-10-07T18:37:36+0200
updated: 2026-10-07T18:40:28+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:36+0200
---

# RD-05 Results collection from existing benchmark ledgers

## Goal
Export the existing free benchmark ledgers to sanitized `assets/data/*.json`.

## Plan refs
§13b (rules: every number comes from a committed results file with date, models and cost; RD-05 row).

## Depends on
Depends on: RD-02 (TRDD-VJTBC6IC)

## Files
Files: to be listed at card start (the plan names: `assets/data/*.json`).

## Reuse
Reuse: read the code at card start

## Steps
1. Export the free-pool bench, the security-triage bench and the scout-accuracy ledger to `assets/data/*.json` (derived from done-when).
2. Sanitize them (derived from done-when).
3. Stamp each file with date, models and profile (derived from done-when).

## Acceptance
- [ ] free-pool bench, security-triage bench and scout-accuracy ledger exported to `assets/data/*.json`
- [ ] sanitized
- [ ] each file stamped with date, models, profile
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
RD-06 benchmark; RD-19 cost matrix; RD-07 renderer.

## Approval log

- 2026-10-07T18:37:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
