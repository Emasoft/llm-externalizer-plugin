---
trdd-id: YHGYWPHQ
title: RL-08 Cross-platform checks
column: blocked
status: tasked
created: 2026-10-07T20:41:19+0200
updated: 2026-11-17T14:07:41+0100
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:19+0200
blocked-by: [61EINA10]
unblock-when: [trdd:61EINA10]
pre-block-column: todo
blocker-probe: 'grep -rqE ''^column: (complete|completed|cancelled)$'' design --include=\*61EINA10\*'
blocker-holds-if: exit-nonzero
---

# RL-08 Cross-platform checks

## Goal
Run the cross-platform checks.

## Approval log

- 2026-10-07T20:41:19+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T17:16:45+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0
- 2026-11-17T14:06:59+0100 — column → blocked by main-agent@llm-externalizer-plugin. macOS and Linux pass; no Windows run exists, waits on TRDD-61EINA10

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-08); §17 execution step 6; D13

## Depends on

RL-04 (TRDD-SJPY3M8K)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. List the platforms and checks at card start; the plan names no platform list.

## Acceptance

- [ ] (derived from title) the cross-platform checks pass on every platform listed at card start
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)
- [x] src/cli/classify-stdin-cli.test.ts passes on Linux with util-linux script, the pty test running and not skipped (its linux branch has never run, TRDD-2GC5DHR7)

## Out of scope

Everything else in RL.

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-14T15:49+0100 for the Linux run of classify-stdin-cli.test.ts (TRDD-2GC5DHR7): if the pty test goes red, look first at util-linux script closing the session at once because its own stdin is /dev/null (EOF), which can drop or truncate the child's stdin is a terminal message; with -e the exit stays 1, so it fails on the message assertion. A skip, not a failure, means the util-linux probe missed.
2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-17T14:06:57+0100 Platforms listed at card start (step 1): the README claims macOS, Linux and Windows (README.md:15, :129). macOS (darwin arm64): typecheck, lint, build and full npm test OK in the 14.6.1 publish run (publish-20261117_122713+0100.log lines 14, 16, 20). Linux (ubuntu-latest): GitHub CI 44079104801 on 04d412ea success, Test Files 345 passed, 5 skipped (the 5 are opt-in real-model suites, each one env-gated describe.skipIf); classify-stdin-cli.test.ts ran 5 tests, none skipped, so the pty test ran on Linux (box 3 met). Windows: no run exists; both workflows use ubuntu-latest only. Box 1 waits on TRDD-61EINA10 (Windows CI job). Box 2 publish authority: decided under the USER delegation of 2026-11-15, see TRDD-6PIGEAN0 Notes.
