---
trdd-id: OMVQCY68
title: RL-07 Existing-settings migration test
column: backburner
status: tasked
created: 2026-10-07T20:41:14+0200
updated: 2026-10-07T20:41:19+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:14+0200
---

# RL-07 Existing-settings migration test

## Goal
Run the migration on an existing settings file and check the result.

## Approval log

- 2026-10-07T20:41:14+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-07); §17 execution step 6; D13; D32, D33

## Depends on

RL-04 (TRDD-SJPY3M8K)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Run the PT-02 migration against an existing settings file (backup in `<config>/backups/`, `profile-type` written into every profile, inferred types printed) (D32).
2. Check the result (derived from title).

## Acceptance

- [ ] (derived from title) existing settings migrate; every profile gets `profile-type`; the backup exists; inferred types are printed
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Fresh install (RL-06).
