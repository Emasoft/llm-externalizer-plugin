---
trdd-id: WVG0VPZB
title: L2-18 Ctrl-C handling
column: complete
status: archived
created: 2026-10-07T19:23:30+0200
updated: 2026-10-10T00:01:05+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:23:30+0200
implementation-commits: [282609b7, 0b59bb6a]
---

# L2-18 Ctrl-C handling

## Goal
Ctrl-C during a classify fan-out aborts every request and records the usage of finished ones.

## Approval log

- 2026-10-07T19:23:30+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:04+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:05+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:05+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l2/abort.ts`), §14 row 29 (no Ctrl-C handling before), D11; E53.

## Depends on

L0-04 (TRDD-H2NRKMEY)

## Files

- `scripts/llm-ext/src/classifiers/l2/abort.ts`
- `scripts/llm-ext/src/classifiers/l2/abort.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

The L0-04 deadline and abort composition. Read the code at card start.

## Steps

1. Wire the Ctrl-C signal into the L0-04 abort composition. (derived from done-when)
2. Abort every in-flight request of the fan-out (E53).
3. Record the usage of requests that finished (E53).

## Acceptance

- [x] E53: Ctrl-C during fan-out → all aborted; usage of finished requests recorded
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 282609b7 and 0b59bb6a (vitest include list) — l2/abort.ts (CTRL_C_EXIT_CODE 130, installCtrlC, runCancellable), l2/abort.test.ts 12 tests; E53 proven with real timers and a real EventEmitter signal source (no real process SIGINT is sent: vitest owns SIGINT in-process). Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. NOTE: runCancellable is a concurrency-limited fan-out; the fan-out card must build on it, not duplicate it. Usage recording is the onDone hook; recordDecisionsUsage already runs inside the worker (L1-09).

## Out of scope

Abort inside retry waits (L0-04), browse cleanup (BR-04).
