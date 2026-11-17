---
trdd-id: VEQYFGON
title: RL-10 Publish (USER gate)
column: complete
status: archived
created: 2026-10-07T20:41:27+0200
updated: 2026-11-17T14:08:44+0100
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
Publish 14.3.0, only on the USER's word.

## Approval log

- 2026-10-07T20:41:27+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T17:16:48+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0
- 2026-11-17T14:08:44+0100 — COMPLETE by main-agent@llm-externalizer-plugin. 14.6.1 published under the USER goal of 2026-11-16; output recorded.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-10); §17 execution step 6; D13; D13

## Depends on

RL-05 (TRDD-7KQ7OMPS), RL-06 (TRDD-KMCU5JMY), RL-07 (TRDD-OMVQCY68), RL-08 (TRDD-YHGYWPHQ), RL-09 (TRDD-5Q62G07R)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. USER gate: this step waits for the USER's word (D13: the 14.3.0 publish stays the USER's). Do not publish before it.
2. On the USER's word, publish and record the command output on the card.

## Acceptance

- [x] (derived from title) published only after the USER's word, with the command output recorded
- [x] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Install (RL-11).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T14:08:38+0100 Published 14.6.1. USER word: the goal of 2026-11-16 (verbatim: "complete all TRDDs. fix all issues. publish and update."); whether it covers this publish was decided by the main agent under the USER delegation of 2026-11-15 (verbatim: "on the other things, do as you think is better. but base your decisions on verified facts."). Command: env -u CLAUDE_PID uv run scripts/publish.py --patch. Output (reports_dev/release-next/publish-20261117_122713+0100.log): line 339 'All checks passed', line 346 'Planned: 14.6.0 -> 14.6.1 (tags: v14.6.1, llm-externalizer--v14.6.1)', line 427 'Published v14.6.1'. Result: origin main fast-forwarded to 04d412ea; tags v14.6.1 and llm-externalizer--v14.6.1 at 04d412ea (git ls-remote); CI 44079104801, Release 44079103262 and Notify Marketplace 44079105098 success; installed llm-ext --version prints 14.6.1 after /reload-plugins --force.
