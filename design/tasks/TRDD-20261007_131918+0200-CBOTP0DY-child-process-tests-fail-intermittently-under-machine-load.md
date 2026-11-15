---
trdd-id: CBOTP0DY
title: Child-process tests fail intermittently under machine load
column: backburner
status: tasked
created: 2026-10-07T13:19:18+0200
updated: 2026-11-14T18:51:02+0100
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T13:19:18+0200
---

# Child-process tests fail intermittently under machine load

## Approval log

- 2026-10-07T13:19:18+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

2026-10-07 investigation (report reports/llm-ext-release/20261007_131813+0200-profile-chain-402-flake.md): on the tree before b22bfae8, 4 of 7 full runs failed, each with a different set of failing tests, and reruns of the same seed passed or failed differently; the current tree was clean in 7 runs. Failures were mostly CLI child-process symptoms: exit code null, empty stderr, truncated JSON, 5 s and 15 s timeouts, and background-update counts of 0 where 1 was expected (profile-chain-402 Row 102, free-pool).
Likely cause, not yet proven: tests that spawn the CLI and wait on detached children with fixed timeouts are sensitive to machine load (a concurrent test suite from another session may have overlapped; not checked). Not seed-bound, so not test order.
Next step: record load (uptime) per run and repeat under controlled load to confirm; then raise the affected timeouts or replace fixed waits with readiness polling, per file.
Caveat: the 7-vs-7 comparison is confounded (the earlier tree ran later, under /private/tmp, with a symlinked node_modules, load unrecorded); only "the symptom also occurs before b22bfae8" is established.
Before raising any timeout: rerun both trees under identical conditions (both outside /tmp, each with its own node_modules, load logged per run, runs alternated).
2026-10-23 recurrence: under load average 70-146 the background-update count symptom (expected 1, got 0) reappeared in profile-chain-402 (two full runs, a different test each time) and in empty-pool-wait D2 (one of four sequential runs). Both read the count after a fixed wait. Seen while verifying 1e5adabe (TRDD-YG72CYY7), whose change cannot reach these tests.
2026-10-30: during the 14.2.0 final checks a full-suite run with TMPDIR set to the user temp folder had 5 failures (profile-chain-402.test.ts:394 and :443 hit the 30 s test timeout, plus a cascade at :575 where the two timed-out tests left their dispatch running and its fetch calls landed on the next test mock server; retry-clock.test.ts:123 and :154 failed). Full runs with that TMPDIR and with a fresh TMPDIR then passed, as did both files alone with and without 56 CPU burners; load average was 66-86 on 14 cores, so TMPDIR is not the cause. Inferred cause (not reproduced): wall-clock starvation of real-timer margins (retry-clock.test.ts around lines 106-155) and the 30 s test timeouts, since each profile-chain-402 test reloads src/index.js with vi.resetModules() (loadFreshIndex, profile-chain-402.test.ts:302-327) and the failing run showed transform 173 s / import 197 s against 9 s / 28 s in a passing leg. Proposed test fixes: (1) profile-chain-402.test.ts:394, :443 and the ensemble test near :575: raise the per-test timeout from 30000 to about 120000, and make each test await or abort its dispatch in its finally block, or have the redirectFetchTo spy reject calls from a previous test, so a timed-out test cannot pollute the next. (2) retry-clock.test.ts:106-125 and :140-155: derive deadlineAt after the server is up and widen the 1500/3000 ms margins (only about 0.3-1 s above the 1800/2000 ms events), or use vi.useFakeTimers with a fake server clock. (3) Process: run the release test gate on an unloaded machine or with fewer workers (--maxWorkers) and re-run the two files alone on a failure.
2026-11-13 new occurrence: broker.test.ts 'jobs held for calibration (P6) > review F7: a held job nobody polls is given back as requeued' failed once in a full-suite stage 2 run (TypeError: Cannot read properties of null (reading 'port') at broker.test.ts:1023; readBrokerState returned null, so the broker had run shutdown or died; the test's non-null assertion hides why, and cleanup deletes broker-local.log). Not reproduced in 4/4 solo F7 runs; cause unknown, possibly an external kill (a process-cleanup hook) rather than load. Suggested fix (not done): in poll() replace the non-null assertion with a throw that includes brokerLog(dir), so the next failure names the exit reason, and keep broker-local.log on failure, since cleanup deletes it. Evidence: reports_dev/broker-f7/20261113_214229+0100-report.md.
2026-11-13T23:53+0100 unconfirmed occurrence: broker.test.ts > calibration runner (P6 step 2) > review M1: a held model whose enqueue failed (state lock busy) is queued by the next runner re-check timed out at 92 s (timed out waiting for the re-check to queue B) in a 15-file vitest run in the llm-externalizer main tree on 2026-11-13 about 23:40, under load with other workers running; it passed in the baseline run; not rerun; whether it is the known flake is not established (report reports_dev/58cfbqhn/20261113_234912+0100-dist-rebuild.md).
2026-11-14T01:04+0100 in-process timing miss, not a child-process test: src/provider/completion.test.ts:780 (HTTP 400 payment-error case) asserted elapsed < 5000 ms and measured 5187 ms during npm test batch 1 while a second full suite ran at the same time; alone it passed 12/12. Recorded here because this card covers tests failing under machine load; a 5000 ms wall-clock bound in that test is the likely weak point (inferred). Tracked on its own card TRDD-WCVCBXMB: it is outside this card child-process scope.

## Notes

2026-11-14T07:38+0100 2026-11-14 broker.test.ts failed 3 tests in two main-tree runs (full-suite-f63fa46b stage 2 and broker-solo-20261114_065401+0100) but passed 97/2 in clean worktrees of a00ef96d and f63fa46b (reports_dev/o93lfmf3/20261114_073659+0100-broker-bisect.md). Candidate cause: a session node-close hook that ends node and llama-server processes when a tool call finishes (observed killing a broker test's processes at about 07:07); unproven, since one tool call finished during a passing run without breaking it.
2026-11-14T18:51:01+0100: during the TRDD-3CG178O7 work (d6fad12e), parallel vitest runs over provider, broker, classifiers and the free-rotation files failed in src/broker/broker.test.ts twice. Round 1: M3 sweep timeout. Round 2: M1 re-check queue timeout, M3 sweep timeout, M9 kill ESRCH (not a timeout), and a command_timeout end-to-end assertion. dispatch-reload hit a 15 s timeout once. Every one passed when the file ran serially (97 passed) or alone; no baseline run before the change. A harness hook in the same session reported a leaked llama-server (tiny-llamas stories260K) and a broker bundle node process left after a background test command, and ended them. A test that leaks child processes may explain the cross-test interference. Logs: reports_dev/3cg178o7/logs/vitest-areas.log, fu-vitest-areas.log, fu-broker-serial.log.
