---
trdd-id: ZD73TB7V
title: RL-03 Vitest include list and test-live script complete
column: backburner
status: tasked
created: 2026-10-07T20:43:51+0200
updated: 2026-10-07T20:44:03+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:43:51+0200
---

# RL-03 Vitest include list and test-live script complete

## Goal
Every new test file is in the vitest include list and the live test is in `test:live`.

## Approval log

- 2026-10-07T20:43:51+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-03); §17 execution step 6; D13; D21

## Depends on

RL-02 (TRDD-6PIGEAN0)

## Files

`scripts/llm-ext/vitest.config.ts`, `package.json` (`test:live`, line 15)

## Reuse

read the code at card start

## Steps

1. List every new test file in `scripts/llm-ext/vitest.config.ts`.
2. Add `src/live-classify.test.ts` by name to `test:live` in `package.json:15` (it lists files, not a glob) (D21).

## Acceptance

- [ ] every new test file listed
- [ ] `src/live-classify.test.ts` added by name to `test:live` (`package.json:15`)
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Running the live tests (RL-12).
