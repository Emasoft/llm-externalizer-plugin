---
trdd-id: VEQYFGON
title: RL-10 Publish (USER gate)
column: backburner
status: tasked
created: 2026-10-07T20:41:27+0200
updated: 2026-10-07T20:41:31+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:27+0200
---

# RL-10 Publish (USER gate)

## Goal
Publish 14.2.0, only on the USER's word.

## Approval log

- 2026-10-07T20:41:27+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-10); §17 execution step 6; D13; D13

## Depends on

RL-05 (TRDD-7KQ7OMPS), RL-06 (TRDD-KMCU5JMY), RL-07 (TRDD-OMVQCY68), RL-08 (TRDD-YHGYWPHQ), RL-09 (TRDD-5Q62G07R)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. USER gate: this step waits for the USER's word (D13: the 14.2.0 publish stays the USER's). Do not publish before it.
2. On the USER's word, publish and record the command output on the card.

## Acceptance

- [ ] (derived from title) published only after the USER's word, with the command output recorded
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Install (RL-11).
