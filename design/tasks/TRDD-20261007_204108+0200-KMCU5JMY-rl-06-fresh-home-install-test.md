---
trdd-id: KMCU5JMY
title: RL-06 Fresh-HOME install test
column: backburner
status: tasked
created: 2026-10-07T20:41:08+0200
updated: 2026-10-07T20:41:13+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:08+0200
---

# RL-06 Fresh-HOME install test

## Goal
Install on a fresh HOME and check the written profiles.

## Approval log

- 2026-10-07T20:41:08+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-06); §17 execution step 6; D13; E112, D19

## Depends on

RL-04 (TRDD-SJPY3M8K)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Install with a fresh HOME and config dir (see the local memory note: set HOME, LLM_EXT_CONFIG_DIR to fresh dirs and LLM_EXT_INSTALL_RULE=0 when running the CLI).
2. Check the written profiles against E112 (D19).

## Acceptance

- [ ] E112: fresh HOME install → `free`, `paid`, `local`, `scouting` (placeholders) and `or-jev` written, each with its `profile-type` and marker; `active: free`, `active_classifier: or-jev` (D19)
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

The migration test (RL-07).
