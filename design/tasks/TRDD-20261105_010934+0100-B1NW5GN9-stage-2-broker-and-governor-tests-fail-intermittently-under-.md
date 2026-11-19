---
trdd-id: B1NW5GN9
title: Stage-2 broker and governor tests fail intermittently under load
column: backburner
status: tasked
created: 2026-11-05T01:09:34+0100
updated: 2026-11-19T01:10:02+0100
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
implementation-commits: [055abc42]
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
2026-11-19T01:06:48+0100 main agent (written by worker): broker stage failures in the 14.7.3 publish runs. 14.7.3 publish runs (facts verified by the main agent 2026-11-19, corrected the same day): runs 1-5 failed timing-dependent tests, a different set each run. Start loads (1/5 min) read from the run outputs: run 1 not recorded; run 2 8.65/11.17 (failed broker M3); run 3 33.02/33.24 (failed governor-direct); run 4 9.09/30.19 (failed completion and empty-pool-wait); run 5 26.07/29.58 (failed index.test, completion, retry-clock); run 6 10.15/11.98 (all tests passed: unit 6593, broker stage 222, burn, e2e; then stopped on two CPV findings fixed in 1b7b3d82); run 7 6.19/13.62 (published v14.7.3, release commit ac3fcdef, 2026-11-19T00:57+0100). The start load does NOT separate passing from failing runs (run 2 started low and failed): the data is consistent with load during the run at most, with one green test run at low start load; the cause is not established. The load gate (start only when the 1-min and 5-min load are both <= 14) lives only in a session scratchpad wrapper, not in publish.py or any tracked file; run 2 shows that a start-load gate alone is weak. Commit 055abc42 (in v14.7.3) hardened five tests: broker M1, broker M3, governor-direct --command_timeout, completion 500-after-400/401 bound, empty-pool-wait stop during repair. Narrowing of its message: 'code paths unchanged since v14.7.2' holds only for the paths read; ffc13d81 (broker/server.ts leaseLimits, governor client) and e19e5609 (index.ts handler move) changed code those tests run, and reading their diffs found no timer, lock or wait changed (main agent). Per the worker report reports_dev/flaky-fix/20261118_211000+0100-report.md (not re-run by the main agent): each changed test passed 2 of 2 single runs at load 10-20; the originals passed 15 of 15 single runs at load 21-66 with burners (per the worker report, not on a quiet host), so no failure was reproduced and the changes rest on reading the code. Of the five, broker M1 and broker M3 (the M3 sweep of a SIGKILLed cal server is a symptom named above) and governor-direct --command_timeout are this card's; 055abc42 is added to implementation-commits as a partial fix. Acceptance boxes stay open: no 5 consecutive loaded stage-2 runs were recorded, and run 6 and run 7 started at load 10 and 6.
2026-11-19T01:10:02+0100 correction by the worker: the note above of 2026-11-19 was first written with the spec's start-load lines and the '15 of 15 loaded baseline runs' wording; both were replaced in place the same day by the main agent's corrected facts (per-run start loads read from the run outputs; originals passed 15 of 15 single runs at load 21-66 with burners, per the worker report).

## Approval log

- 2026-11-05T01:09:34+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
