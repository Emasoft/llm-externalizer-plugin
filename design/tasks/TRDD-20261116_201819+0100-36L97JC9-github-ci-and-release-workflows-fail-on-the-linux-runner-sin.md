---
trdd-id: 36L97JC9
title: GitHub CI and Release workflows fail on the Linux runner since 2026-10-31
column: dev
status: tasked
created: 2026-11-16T20:18:19+0100
updated: 2026-11-16T21:05:03+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T20:18:19+0100
---

# GitHub CI and Release workflows fail on the Linux runner since 2026-10-31

Measured 2026-11-16 from gh run logs. CI and Release have failed on every main push since b632ba52 (2026-10-31); last green 82b0331f (2026-10-27). Causes seen: (1) Release run 43936686211 at 925e8ecb: tests/test_publish_failed_push.py and tests/test_publish_runs_git_in_repo_root.py fail with FileNotFoundError git-cliff (not installed on the runner). (2) CI run 43879351185 at a411a6a8: src/classifiers/l2/local-decider.test.ts listenersOf, 3 tests: lsof failed (spawn /usr/sbin/lsof ENOENT). (3) same run: src/calibration/phase-c.test.ts 'a candidate short of free memory' asserts the largest candidate fits free memory above a 1 % floor; runner free 14183 MiB, candidate 21677211648 bytes. CI at 925e8ecb not yet read. Acceptance: each cause fixed at its root (no test skipped to hide a failure; a platform gate only where the feature itself is platform-specific, stated in a WHY comment), and the CI and Release runs of the next main push are green.

## Approval log

- 2026-11-16T20:18:19+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-16T21:05:02+0100 main agent: fix committed as ffdc019b on dev/after-14.3.0, local checks green (tsc, eslint, phase-c and local-decider tests 106/106, the two pytest files 7/7, actionlint); ci.yml has one job (build), so the git-cliff step (line 110) runs before the pytest step (line 140). PROOF PENDING: the CI and Release runs of the next main push. Plan: carry it in the 14.4.1 patch publish (publish.py --patch, foreground, host load well below 100); then read gh run list --repo Emasoft/llm-externalizer-plugin for the CI and Release runs of that commit and close this card only if both are green.
