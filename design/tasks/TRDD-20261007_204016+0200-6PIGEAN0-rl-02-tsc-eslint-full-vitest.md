---
trdd-id: 6PIGEAN0
title: RL-02 tsc + eslint + full vitest
column: backburner
status: tasked
created: 2026-10-07T20:40:16+0200
updated: 2026-10-07T20:40:29+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:40:16+0200
---

# RL-02 tsc + eslint + full vitest

## Goal
Typecheck, lint and the full test suite pass on the bumped tree.

## Approval log

- 2026-10-07T20:40:16+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-02); §17 execution step 6; D13

## Depends on

RL-01 (TRDD-E9AQOQ5X)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Run `npm run typecheck`, `npm run lint`, `npx eslint . --quiet` and `npm test` in `scripts/llm-ext/` (§16 definition of done).

## Acceptance

- [ ] (derived from title) typecheck, lint, `npx eslint . --quiet` and full `npm test` all pass
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

The include-list audit (RL-03).
