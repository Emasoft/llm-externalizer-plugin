---
trdd-id: EHFRBJHK
title: RD-18 14.1.x docs release
column: backburner
status: tasked
created: 2026-10-07T18:37:39+0200
updated: 2026-10-07T18:40:34+0200
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

# RD-18 14.1.x docs release

## Goal
Release the README redesign as the 14.1.x docs release.

## Plan refs
§13b (RD-18 row, order paragraph); D13.

## Depends on
Depends on: RD-12 (TRDD-14PYGVQD), RD-13 (TRDD-0EMNXBWM), RD-14 (TRDD-NVXSE7WX), RD-15 (TRDD-2CRNDA6Z), RD-16 (TRDD-V3Y4W47F), RD-19 (TRDD-XJKL495A)

## Files
Files: to be listed at card start (the plan names: version bump).

## Reuse
Reuse: read the code at card start

## Steps
1. Version bump (derived from done-when).
2. Typecheck, lint, tests (derived from done-when).
3. CPV (derived from done-when).
4. Publish on the user's word, D13 (derived from done-when).
5. Install and run `llm-ext --version` (derived from done-when).

## Acceptance
- [ ] version bump
- [ ] typecheck, lint, tests
- [ ] CPV
- [ ] publish on the user's word (D13)
- [ ] install, `llm-ext --version`
- [ ] missing RD-19 cells did not block this card
- [ ] definition of done for a release card: every listed release step checked, CPV clean, publish only on the USER's word, installed version verified with the bare `llm-ext --version`

## Out of scope
RD-17 and RD-20 (14.2.0).

## Approval log

- 2026-10-07T18:37:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
