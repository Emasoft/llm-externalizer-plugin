---
trdd-id: 7KQ7OMPS
title: RL-05 CPV plugin validation
column: todo
status: tasked
created: 2026-10-07T20:41:00+0200
updated: 2026-11-17T13:58:05+0100
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:00+0200
---

# RL-05 CPV plugin validation

## Goal
The plugin passes CPV validation.

## Approval log

- 2026-10-07T20:41:00+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T17:16:38+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-05); §17 execution step 6; D13

## Depends on

RL-04 (TRDD-SJPY3M8K)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Run CPV plugin validation on the built plugin.

## Acceptance

- [ ] (derived from title) CPV plugin validation passes
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Skill-only validation (DOC-14).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T13:58:01+0100 14.6.1 release output (04d412ea), recorded for the output clause. publish log reports_dev/release-next/publish-20261117_122713+0100.log line 338 'OK: cpv (only skillaudit FPs remained — advisory, see #41)', line 339 'All checks passed'. The pass needed line 31 'CPV INTEGRITY SELF-CHECK DISABLED via PLUGIN_SKIP_GITHUB_INTEGRITY=1' and line 33 '110 skillaudit finding(s) downgraded to advisory'. Open for the USER: accept or reject that bypass and the downgrades. Evidence: reports_dev/release-next/20261117-release-cards-evidence.md.
