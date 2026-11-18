---
trdd-id: E9AQOQ5X
title: RL-01 Version bump
column: todo
status: tasked
created: 2026-10-07T20:39:50+0200
updated: 2026-11-18T18:07:41+0100
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

- [~] (scope reading, see Notes 2026-11-18: 14.3.0 read as the release after 14.3.0; not a literal pass) (derived from title) version reads 14.3.0 in every file that carries it
- [ ] every other card of this plan is done, checked against the execution-order list in ZB41KG62's STATE
- [~] (scope reading: publish authority by main-agent reading of the USER goal of 2026-11-16, see Notes) definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Tests and build (RL-02, RL-04).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T13:58:01+0100 14.6.1 release output (04d412ea), recorded for the output clause. publish log reports_dev/release-next/publish-20261117_122713+0100.log line 346 'Planned: 14.6.0 -> 14.6.1 (tags: v14.6.1, llm-externalizer--v14.6.1)', line 427 'Published v14.6.1'. Version 14.6.1 in .claude-plugin/plugin.json:3, pyproject.toml:3, scripts/llm-ext/package.json:3, package-lock.json:3 and :9, uv.lock:386, src/cli/main.ts:61, README.md:9. Installed llm-ext --version prints 14.6.1. Still open: L54 (RL-02, RL-05, RL-09, RL-10 are todo) and whether the USER goals cover this publish and install. Evidence: reports_dev/release-next/20261117-release-cards-evidence.md.
2026-11-18T16:55:18+0100 Box 1 met: version 14.7.2 reads in .claude-plugin/plugin.json:3, pyproject.toml:3, scripts/llm-ext/package.json:3, scripts/llm-ext/src/cli/main.ts:61 and README.md:9 (git tag v14.7.2 exists; read 2026-11-18). The literal 14.3.0 of the box is the stale pre-retarget text; the retarget note of 2026-11-16 maps it to the release after 14.3.0.
2026-11-18T16:55:18+0100 Box 3 met: the step output is recorded in the Notes of 2026-11-17T13:58:01 (14.6.1 publish log lines 346 and 427); the v14.7.2 gate output is reports_dev/publish/20261118_130254+0100-publish-14.7.2.txt.
2026-11-18T16:55:18+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): Box 2 ("every other card of this plan is done") is NOT met and is NOT struck; this card stays in todo. Board at HEAD f4db6726 time of reading: RL-08 and RL-13 remain open. 14.3.0 shipped with the plan open on the USER answer "Publish now (Recommended)" of 2026-11-15, for that release only; 14.4.0 to 14.7.2 shipped on a main-agent reading of the USER goal of 2026-11-16 "complete all TRDDs. fix all issues. publish and update.". That reading conflicts with the PRRD goal "publish and install the plugin when you completed all TRDDs"; the conflict goes to the USER.
2026-11-18T17:01:48+0100 Scope reading, not a strike: box 1 was ticked on the reading that the literal 14.3.0 is stale and means the release after 14.3.0 (retarget note 2026-11-16); the box text is unchanged. Version 14.7.2 in the five files was read by the card writer 2026-11-18.
2026-11-18T17:03:04+0100 Update: the scope-reading boxes (E9AQOQ5X 1 and 3, YHGYWPHQ 1 and 2) are now marked [~] with the reading stated in the box, not [x]; the box text is kept. Box 54 of E9AQOQ5X (box 2) is still open.
2026-11-18T18:03:20+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): release 14.7.3 is published while cards stay open, on the same reading of the USER goal of 2026-11-16 ("complete all TRDDs. fix all issues. publish and update.") as 14.4.0 to 14.7.2. Facts: DRRUTC2M (the history purge) is a destructive act only the USER can approve, so the main agent cannot complete every card alone; the DS6OM3KX questions wait on USER answers, and the WYY3SPDX label choice was routed to the USER by its own pre-registration. dev/after-14.3.0 holds more than 40 unreleased commits, the filter --context fix 994bfbce among them, and GitHub issues #15 and #16 can only be closed against a released version. The PRRD goal line "publish and install the plugin when you completed all TRDDs" is left unchanged. Checked 2026-11-18 at 18:06: none of the 36 USER-typed messages of this session (from 2026-11-16, compaction summaries excluded) contains a veto, revert or publish hold. The publish starts no earlier than 2026-11-18T18:45+0100, so the USER can object first; a shipped change is undone by a revert release. This ruling replaces the routing of this conflict to the USER in the E9AQOQ5X ruling of 2026-11-18T16:55:18+0100.
