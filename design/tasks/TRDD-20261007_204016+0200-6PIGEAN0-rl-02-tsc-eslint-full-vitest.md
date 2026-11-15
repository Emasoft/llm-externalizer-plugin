---
trdd-id: 6PIGEAN0
title: RL-02 tsc + eslint + full vitest
column: todo
status: tasked
created: 2026-10-07T20:40:16+0200
updated: 2026-11-14T15:43:48+0100
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
- 2026-10-31T17:16:34+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0

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
- [ ] the full vitest includes src/cli/classify-stdin-cli.test.ts and it passes (local macOS run; the Linux run is owed on RL-08, TRDD-YHGYWPHQ)

## Out of scope

The include-list audit (RL-03).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-14T15:40+0100 owed for the full vitest: src/cli/classify-stdin-cli.test.ts (TRDD-XM2OSVC0, 1c41b721) has not run inside a full suite as of 2026-11-14 (sqlite binding missing, TRDD-G0MS9B63) and not on Linux as of this date (local macOS runs only, not pushed).
