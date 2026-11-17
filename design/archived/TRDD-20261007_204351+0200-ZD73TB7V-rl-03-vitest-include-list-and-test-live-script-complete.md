---
trdd-id: ZD73TB7V
title: RL-03 Vitest include list and test-live script complete
column: complete
status: archived
created: 2026-10-07T20:43:51+0200
updated: 2026-11-17T09:21:34+0100
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
- 2026-11-17T09:21:34+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met, evidence in Notes.

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

- [x] every new test file listed
- [x] `src/live-classify.test.ts` added by name to `test:live` (`package.json:15`)
- [x] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Running the live tests (RL-12).

## Notes

2026-11-17T09:21:17+0100 DONE (main agent, checked on v14.6.0 tree): find src -name '*.test.ts' gives 361 files; 357 are named in scripts/llm-ext/vitest.config.ts, the other 4 are the live files (live.test.ts, live-extended, live-websearch, live-classify), which vitest.live.config.ts:10 includes by name; package.json:15 test:live = 'vitest run --config vitest.live.config.ts' (a config, not a file list as step 2 assumed; same effect, the config comment lines 3-4 say why). Nothing published or installed by this step.
