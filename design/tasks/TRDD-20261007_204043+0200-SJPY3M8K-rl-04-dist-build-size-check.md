---
trdd-id: SJPY3M8K
title: RL-04 Dist build + size check
column: backburner
status: tasked
created: 2026-10-07T20:40:43+0200
updated: 2026-10-07T20:40:59+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:40:43+0200
---

# RL-04 Dist build + size check

## Goal
Build dist and check its size.

## Approval log

- 2026-10-07T20:40:43+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-04); §17 execution step 6; D13

## Depends on

RL-02 (TRDD-6PIGEAN0)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Run the dist build.
2. Check the size and record it (derived from title).

## Acceptance

- [ ] (derived from title) dist builds and its size is recorded and checked
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Plugin validation (RL-05).
