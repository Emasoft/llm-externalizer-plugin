---
trdd-id: G0MS9B63
title: better-sqlite3 native binding missing in a checkout installed with npm ignore-scripts on
column: complete
status: archived
created: 2026-11-14T12:46:52+0100
updated: 2026-11-16T09:24:28+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T12:46:52+0100
---

# better-sqlite3 native binding missing in a checkout installed with npm ignore-scripts on

## Approval log

- 2026-11-14T12:46:52+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T09:24:28+0100 — COMPLETE by main-agent@llm-externalizer-plugin. binding works in the release and dev worktrees; npm test OK in the 14.3.0 publish run.

## Problem

2026-11-14T12:47+0100 When npm runs with ignore-scripts enabled in its config, npm ci or any reinstall of scripts/llm-ext/node_modules installs better-sqlite3 without its native binding. Every sqlite-backed test (mass_scouting, cluster checkpoint and wiring, scout; 196 tests in 15 files as measured on 2026-11-14) and every repo-local CLI path that opens the database then fails with Could not locate the bindings file. A guard that forbids re-enabling install scripts leaves only a person able to rebuild it. Full-suite checks on any card are blocked until the binding exists.
2026-11-14T15:39+0100 owed with the binding: the first full npm test after the rebuild must include src/cli/classify-stdin-cli.test.ts (TRDD-XM2OSVC0, 1c41b721), which has run only alone and beside classify-launch-cli and classify-review-cli (31/31, worker-reported). Its membership in the first vitest run step was read from package.json, not run; untried there are the temp-dir leak guard, its three spawns under parallel load and the NODE_OPTIONS --import preload. It has never run on Linux.

## Acceptance

- [x] an npm rebuild of better-sqlite3 in scripts/llm-ext with install scripts enabled has been run, and requiring better-sqlite3 from scripts/llm-ext succeeds
- [x] the full npm test passes the 15 sqlite-backed files
- [x] the first full npm test after the rebuild includes src/cli/classify-stdin-cli.test.ts and it passes

## Notes

2026-11-14T15:43+0100 the line about the stdin test in the Problem section was kept there on purpose; the Acceptance box added in 1c32b0ac is the gate.
2026-11-15T17:21:00+0100 the binding loads (require succeeds); rebuilt outside this session. Boxes 2 and 3 wait for the pre-push full npm test (RL-02, TRDD-6PIGEAN0).
2026-11-15T17:23:11+0100 correction to the binding line above: the binding does NOT load. A require of better-sqlite3 succeeds lazily, but new Database(':memory:') fails with Could not locate the bindings file, so the native binding is still absent. Box 1 unticked again; boxes 2 and 3 unchanged.
2026-11-16T09:24:22+0100 the binding exists and works in the release worktree builds_dev/release-14.3.0 and in builds_dev/dev-after-14.3.0 (a copy of that node_modules, lockfiles identical): new Database(:memory:) succeeds there. The 14.3.0 publish (reports_dev/main/publish-14.3.0-20261115_222906+0100.log lines 20-21) ran npm test in that worktree with result OK; that run includes the 15 sqlite-backed files and src/cli/classify-stdin-cli.test.ts (vitest.config.ts include list, line 812). The main checkout scripts/llm-ext/node_modules still lacks the binding; work now happens in the worktree, so that no longer blocks anything.
