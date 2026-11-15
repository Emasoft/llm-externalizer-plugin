---
trdd-id: B1NW5GN9
title: Stage-2 broker and governor tests fail intermittently under load
column: backburner
status: tasked
created: 2026-11-05T01:09:34+0100
updated: 2026-11-05T01:29:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T01:09:34+0100
---

# Stage-2 broker and governor tests fail intermittently under load

## Symptom

Stage 2 of npm test (--no-file-parallelism: 5 broker and governor files) fails intermittently. Observed: ci2 at 62e2c030 stage 2: 2 broker.test.ts failures (long-polls repeatedly while queued; config-dir-deleted exit), governor passed, load1 19-97 (18 samples, 20:28-20:45, logs/ci2-load.log). ci3 at ebeab4fd: governor-direct.test.ts:472 (leftover lease after 100 processes) and governor-threads.test.ts:377 (peakServers 1 < 2) failed, AssertionError not timeouts, broker passed, load1 39-63. Stage-2-only rerun 1 at ebeab4fd (22:24:34-22:40:21): 2 broker.test.ts failures (M3 sweep of a SIGKILLed cal server; --command_timeout on a multi-file command). Rerun 2: 216 passed, 2 skipped. Run 4b at c668389e: stage 2 passed (216 passed, 2 skipped) at load1 up to 82.08. Earlier at 23f40c1e: broker.test.ts:697 config-dir-deleted and the M3 sweep timeout. Rerun 1 (wt-ci, ebeab4fd) totals: 2 failed, 213 passed, 3 skipped (reports_dev/ygf9yxf2/logs/s2r1.log); rerun 2 from 22:53:56 (logs/s2r2.log); no third rerun. Earlier stage-2 passes: 9e036052 (stage 2 run separately, 216 passed, 2 skipped) and 9b1abbb0 (stage 2 run alone, 215 passed, 3 skipped; better-sqlite3 binding missing in that install). Observed: 3 failing of the 7 stage-2 runs with recorded totals; the 23f40c1e run also had 2 broker.test.ts failures (totals not recorded).

## Cause

Open. The reporter gives no per-test time, so no failure is tied to load. These runs tested committed HEAD; another session holds uncommitted edits in the broker, governor and calibration sources. Related: TRDD-ZTO9K8EK. Per-run detail: TRDD-YGF9YXF2 Notes. Evidence (gitignored, this machine only): reports_dev/ygf9yxf2/20261104_204900+0100-ci2-suite.md, 20261104_220707+0100-ci3-suite.md, 20261105_010300+0100-run4b-suite-result.md, logs/ci2-stage2.log, logs/ci3-npm-test.log, logs/s2r1.log, logs/s2r2.log, logs/r4b-npm-test.log. Before working this card, check TRDD-ZTO9K8EK and the state of the other session, and re-measure at the first HEAD that contains the broker and governor commits of that session.

## Acceptance

- [ ] each failing test classified as a product defect or a test race, with a reproduction or a measurement
- [ ] every cause classified as a product defect is fixed; each cause classified as a test race is fixed, or 5 consecutive full stage-2 runs pass, each with at least half of its 60 s load1 samples at or above 40

## Notes

## Approval log

- 2026-11-05T01:09:34+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
