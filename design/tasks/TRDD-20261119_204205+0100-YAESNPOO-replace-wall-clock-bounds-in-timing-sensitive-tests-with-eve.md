---
trdd-id: YAESNPOO
title: Replace wall-clock bounds in timing-sensitive tests with event waits or a fake clock
column: todo
status: tasked
created: 2026-11-19T20:42:05+0100
updated: 2026-11-19T20:42:11+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T20:42:05+0100
release-via: publish
---

# Replace wall-clock bounds in timing-sensitive tests with event waits or a fake clock

## Problem

Tests assert wall-clock bounds (a Date.now() difference below N ms, a short retry window, a timer racing a fixed delay). On a loaded host those bounds fail although the code is right: the host load swung between 10 and 165 during the 14.7.6 publish attempts, and each attempt failed a different timing-dependent test. Seven bounds were widened in commit 8d63a8d4 for 14.7.6 (governor-burn stop test, first-failure-consumers reset-socket test, completion HTTP 500 test, three retry-clock N3 tests, local-fallback-setting control). Widening only moves the threshold; the fix that removes the load dependence is an event wait, or a fake clock, in place of the wall-clock bound. This card is that follow-up.

Source: a read-only audit of the suite timing bounds on 2026-11-19 (code arithmetic, no test run; every minimum-needed figure is read from code or inferred, none was measured). The audit found 30 THIN rows (9 high risk, 14 medium, 7 low), 8 UNSURE rows and 37 OK rows. Excluded below: the rows 8d63a8d4 already widened. Treat each row as a candidate; THIN-M, THIN-L and UNSURE rows need a measured elapsed time before a bound is changed. Line numbers are at 8d63a8d4; paths are relative to the repository root. In provider/completion.test.ts and governor/governor-burn.test.ts the audit lines 859 and 470 shifted by +2 and are shown shifted; provider/retry-clock.test.ts lines shifted by about +6, re-grep.

## Facts the arithmetic rests on

- http.ts retries 6 times with backoff 1000*2^n +-25% (750-1250, 1500-2500, 3000-5000 ms); a retry happens only if now + backoff is before deadlineAt, so a window must be sized for the worst jitter.
- A RetryDeadlineError message ("Retry window closed without a successful answer ...") does not contain "API error NNN"; a toThrow(/API error 500/) under a deadlineAt fails if the window closes first.
- Every send to 127.0.0.1 takes a governor lease per attempt, which needs a fresh reading (first poll 200-250 ms), so each attempt after a gap of over 2 s pays about 0.25 s before the POST.
- The same 2 s reset-window scenario took 8921 ms in a gate run against 2 s alone (TRDD-XIS2EGGK).

## Rows to fix, riskiest first (THIN-H)

| file | line | bound | risk | why it is thin |
|---|---|---|---|---|
| scripts/llm-ext/src/governor/governor-burn.test.ts | stop test at about 444-450 | --command_timeout 60 (widened in 8d63a8d4) | H | still fails if the CLI start-up (settings migrations, backups; about 33 s on a loaded host, 37 s seen) exceeds 60 s; the test always takes about 60 s; needs a wait on the RAM-wait line, not a fixed timeout |
| scripts/llm-ext/src/governor/governor-direct.test.ts | 267 (+271) | soft timeout 2000 (JSON variant deadlineAt +2000) | H | a request that waited needs the full conn.timeout; server delay 1500, 500 ms slack |
| scripts/llm-ext/src/governor/governor-direct.test.ts | 306 | 150 ms | H | abort must end the lease wait at once, but the governor poll is 200-250 ms so the bound cannot widen past about 200; use a macrotask check (setImmediate, then assert rejected) |
| scripts/llm-ext/src/foreground-repair.test.ts | 395 | 400 ms | H | waitForProfileUpdate returns with no grace sleep (3 sync fs reads); the poll sleep is 500 ms, so a wall bound cannot be wider; assert that no timer was armed, or drop |
| scripts/llm-ext/src/classifiers/l2/fan-out.test.ts | 315 | 400 ms | H | 60 instant replies, no limiter wait; the limiter path is about 0.9 s per the test comment, so about 350 ms slack on an inferred minimum; scale the request count instead of the bound |
| scripts/llm-ext/src/classifiers/l2/abort.test.ts | 62-76 (SIGINT timer at 64) | SIGINT after 150 ms | H | outcomes [done, done, aborted, done, aborted, aborted] need item 3 to finish before the 150 ms SIGINT timer; about 130 ms of event-loop stall loses the race; fire SIGINT from onDone when 3 items are recorded (the 2000 ms bound at 76 is fine) |
| scripts/llm-ext/src/provider/provider-state-render.test.ts | 114 (giveUp helper; asserts at 152 and 173) | deadlineAt now+1500 | H | one retry must fit after probes, lease and POST; slack 250 ms at worst jitter, and the equal-attempts assertion at 152 flips at about 500 ms overhead; a window of 2200 fixes attempts at exactly 2 |
| scripts/llm-ext/src/profile-chain-402.test.ts | 961 (it timeout 5000) | 1000 ms | H | price refusal then second entry answers; the minimum (about 0.1-0.4 s: dispatch boot, 1 POST, report write) is inferred, not measured |

## Rows to fix (THIN-M)

| file | line | bound | risk | why it is thin |
|---|---|---|---|---|
| scripts/llm-ext/src/provider/completion.test.ts | 861 | under 10000 (it timeout 20000) | M | 6 x 403 then one 500 call: 4 outer tries x one 750-1250 ms sleep = 3-5 s, so 2x the worst legitimate time; the 4 outer tries are inferred (MAX_TRUNCATION_RETRIES 3) |
| scripts/llm-ext/src/network-give-up-dispatch.test.ts | 133, 143, 156 | 5000 | M | closed port, .invalid host, reset server with a 2 s window must end in under 5 s; 3000 ms slack plus probe and DNS |
| scripts/llm-ext/src/network-give-up.test.ts | 522 | 5000 | M | .invalid host, window 2 s, plus a strict probe of up to 5 s (PROBE_TIMEOUT_MS), design maximum 7 s above the bound |
| scripts/llm-ext/src/governor/governor-burn.test.ts | 472 | 2000 | M | a SIGKILLed holder lease is reclaimed after a 200-250 ms poll plus a fresh reading (vm and CPU sampling); about 0.8-1.7 s slack, sample time inferred |
| scripts/llm-ext/src/benchmark/pick-lock.test.ts | 171-172 | busy-wait 2000 ms, then expect(existsSync) | M | a child node must create the lock dir; node cold start about 0.2 s, up to 10x under load |
| scripts/llm-ext/src/empty-pool-wait.test.ts | 196 | 2900 | M | two dispatches bounded by a 600 ms repair limit rounded up by a 500 ms poll (1000-1100 ms) plus spawn; ratio 2.6 |
| scripts/llm-ext/src/stop-on-errors.test.ts | 404 | 60000 (guard 90000) | M | CLI ends through a bounded exit of about 30 s after hung siblings; boot up to 37 s was seen elsewhere; ratio 2.0 |
| scripts/llm-ext/src/local-fallback-dispatch.test.ts | 246 | 15000 | M | reset server, 2 s window, then the local step; the same scenario took 8.9 s elsewhere |
| scripts/llm-ext/src/classifiers/l2/regex-worker.test.ts | 211 | 1000 | M | worker "did not start" with startupMs 50; 950 ms slack |
| scripts/llm-ext/src/classifiers/l2/regex-worker.test.ts | 229 | 1500 | M | totalMs 250, timeoutMs 100, 6 fields, 2-3 worker thread starts and terminations; ratio about 2.7, thread start about 100 ms inferred |
| scripts/llm-ext/src/classifiers/l0/transport.test.ts | 176 | 500 | M | 401 thrown first failure with no wait; r.calls length 1 already proves it, so the wall clock is redundant |
| scripts/llm-ext/src/classifiers/l0/transport.test.ts | 232 | 500 | M | Retry-After beyond the 5 s deadline fails now; same redundancy with r.calls |
| scripts/llm-ext/src/security_scan/security_scan.test.ts | 926 | 500 | M | redaction of a 200 KB newline blob, about 10-30 ms (the old O(n^2) took 8 s); minimum inferred |

## Rows to fix (THIN-L)

| file | line | bound | risk | why it is thin |
|---|---|---|---|---|
| scripts/llm-ext/src/provider/classify-failure.test.ts | 274 | deadlineAt now+3500 | L | resetting socket, clock.attempts >= 2; one backoff 750-1250 ms plus a lease; ratio 2.8 |
| scripts/llm-ext/src/classifiers/l0/deadline.test.ts | 12 | 1000 | L | abort during sleep rejects at once; 20 ms timer, 980 ms slack |
| scripts/llm-ext/src/mkdir-lock.test.ts | 141, 155, 172 | 1000 (WAIT_MS 5000) | L | stale lock taken over, not waited out; sync fs |
| scripts/llm-ext/src/session_summary/local-model-lock.test.ts | 49 | 1000 (old wait 30 s) | L | busy lock skipped at once; one 20 ms poll |
| scripts/llm-ext/src/scan-pipeline.test.ts | 345, 414 | 1000 | L | ReDoS guard on redactSecrets with 100 KB and with 20000 BEGIN headers; about 10-30 ms (old 2.4 s) |
| scripts/llm-ext/src/classifiers/catalog/review.test.ts | 201 | 1000 each | L | dropBinary on 1 MB inputs; about 5-20 ms, minimum inferred |
| scripts/llm-ext/src/security_scan/security_scan.test.ts | 1109, 1120, 1854 | 1000 each | L | ReDoS guards (20000 PEM headers, 500000 eyJ, 60000 newlines); about 10-100 ms (the old code took 20.8 s, over 120 s and about 5 s); 900-990 ms slack |

## Not THIN, but the same shape

- provider/retry-clock.test.ts, not audited, comparison only: the tests at about lines 283, 410 and 620 (window 1500) and about 464 (elapsed below 500 ms) have the same thin slack as the rows above; the N3 tests and the five bounds of 120912d4 are already widened.
- UNSURE rows (need a measured time): network-give-up.test.ts:512 (closed port, armed window 1 s, bound 5000, but the same file showed 8921 ms); broker/broker.test.ts:1490 and local-fallback-e2e.test.ts:266 (real llama-server, minimum unknown); local-fallback-dispatch.test.ts:145 and :334; classifiers/system-one-fallback.test.ts:201 (deadline 300 ms must hold two POSTs before the hang); cluster/cluster_synonyms_main.test.ts:489; benchmark/pick-lock.test.ts:213.

## Done when

Each H row asserts through an event (a recorded count, a done callback, a rejected promise after setImmediate) or a fake clock, not a wall-clock bound; M and L rows either get a measured time with a bound of at least 3x it, or the same treatment. The suite passes at host load above 100 with the same test list.

## Approval log

- 2026-11-19T20:42:05+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
