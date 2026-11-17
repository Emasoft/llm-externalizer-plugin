---
trdd-id: OMVQCY68
title: RL-07 Existing-settings migration test
column: complete
status: archived
created: 2026-10-07T20:41:14+0200
updated: 2026-11-17T09:27:06+0100
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
- 2026-10-31T17:16:43+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0
- 2026-11-17T09:27:06+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met at v14.6.0, output in Notes.

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

- [x] (derived from title) existing settings migrate; every profile gets `profile-type`; the backup exists; inferred types are printed
- [x] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Fresh install (RL-06).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T09:26:24+0100 DONE at v14.6.0 (main agent; evidence reports/sonnet-worker/20261117_092111+0100-rl-04-06-07-runs.md Task B): a settings.yaml with 3 profiles and no profile-type (mine remote, frugal remote free_only, lmstudio local) under a throwaway HOME; settings profiles exit 0 printed 'llm-ext: the 14.1.0 profile-type-written migration wrote profile-type into your profiles (a backup of settings.yaml exists in $T/cfg/backups; edit a wrong type by hand):' then 'profiles.mine: profile-type paid (inferred)', 'profiles.frugal: profile-type free (inferred)', 'profiles.lmstudio: profile-type local (inferred)'. Backup settings-before-14.1-profile-type-<ts>.yaml exists. A second run printed no migration line and did not rewrite the file (mtime unchanged). Input was synthetic, not a real pre-14.1 file. Noted: an inline comment lost one of its two leading spaces.
