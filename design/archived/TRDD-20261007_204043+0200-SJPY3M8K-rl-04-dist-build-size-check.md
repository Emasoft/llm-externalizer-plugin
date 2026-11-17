---
trdd-id: SJPY3M8K
title: RL-04 Dist build + size check
column: complete
status: archived
created: 2026-10-07T20:40:43+0200
updated: 2026-11-17T09:27:17+0100
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
- 2026-10-31T17:16:35+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0
- 2026-11-17T09:27:17+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met at v14.6.0, output in Notes.

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

- [x] (derived from title) dist builds and its size is recorded and checked
- [x] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Plugin validation (RL-05).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T09:26:24+0100 DONE at v14.6.0 (main agent; evidence reports/sonnet-worker/20261117_092111+0100-rl-04-06-07-runs.md Task C): the publish.py gate built dist OK for every release 14.3.1-14.6.0 (log reports_dev/release-14.6.0 'OK: build', 'dist rebuilt'). Sizes recorded (git ls-tree -l v14.6.0): dist/llm-ext.js 16405456 B, dist/benchmark.js 11066125 B; v14.3.0 16365762 / 11061955 (+0.24 % since). No size limit is defined on this card or found elsewhere searched (WIO13P1P only requires dist/ to stay git-tracked), so the size is recorded, not judged.
