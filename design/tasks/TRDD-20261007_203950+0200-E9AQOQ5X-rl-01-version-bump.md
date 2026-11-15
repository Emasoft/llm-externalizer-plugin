---
trdd-id: E9AQOQ5X
title: RL-01 Version bump
column: todo
status: tasked
created: 2026-10-07T20:39:50+0200
updated: 2026-10-31T17:16:32+0100
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:39:50+0200
---

# RL-01 Version bump

## Goal
Bump the plugin version to 14.3.0.

## Approval log

- 2026-10-07T20:39:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T17:16:32+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-01); §17 execution step 6; D13

## Depends on

every other card of this plan done (checked against the execution-order list in ZB41KG62's STATE, §17 pass 2)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Check every other card of the plan is done against the execution-order list in ZB41KG62's STATE (§17 pass 2).
2. Bump the version files (derived from title).

## Acceptance

- [ ] (derived from title) version reads 14.3.0 in every file that carries it
- [ ] every other card of this plan is done, checked against the execution-order list in ZB41KG62's STATE
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Tests and build (RL-02, RL-04).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).
