---
trdd-id: KMCU5JMY
title: RL-06 Fresh-HOME install test
column: complete
status: archived
created: 2026-10-07T20:41:08+0200
updated: 2026-11-17T09:26:59+0100
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
- 2026-10-31T17:16:41+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0
- 2026-11-17T09:26:59+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met at v14.6.0, output in Notes.

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

- [x] E112: fresh HOME install → `free`, `paid`, `local`, `scouting` (placeholders) and `or-jev` written, each with its `profile-type` and marker; `active: free`, `active_classifier: or-jev` (D19)
- [x] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

The migration test (RL-07).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T09:26:24+0100 DONE at v14.6.0 (main agent; evidence reports/sonnet-worker/20261117_092111+0100-rl-04-06-07-runs.md Task A): no install command exists, so the fresh-HOME default generation was run: env -u CLAUDE_PID -u OPENROUTER_API_KEY HOME=$T LLM_EXT_CONFIG_DIR=$T/cfg LLM_EXT_INSTALL_RULE=0 node dist/llm-ext.js settings show, exit 0, printed 'Generated default settings at $T/cfg/settings.yaml'. settings.yaml: free :38 profile-type free :45, paid :57/:62, local :64/:70, scouting placeholder :72/:77, or-jev :79 profile-type classifier :80, each under the marker line (:37 :56 :63 :71 :78); active: free :25; active_classifier: or-jev :26. All E112 items PASS. Observed, not a defect: the dynamic profiles local_llama, locals-mlx, local-decision are added after generation (unmarked), and a settings-before-14.1-migration backup is written for the brand-new file.
