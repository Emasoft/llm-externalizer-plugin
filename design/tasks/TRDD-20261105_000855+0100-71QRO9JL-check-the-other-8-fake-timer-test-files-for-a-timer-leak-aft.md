---
trdd-id: 71QRO9JL
title: Check the other 8 fake-timer test files for a timer leak after a timeout
column: backburner
status: tasked
created: 2026-11-05T00:08:55+0100
updated: 2026-11-16T20:16:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T00:08:55+0100
---

# Check the other 8 fake-timer test files for a timer leak after a timeout

## Scope

Files under scripts/llm-ext/src: command-stop-sleep.test.ts, scan-folder-http-failures.test.ts (read the HEAD copy, changed in ed040185), install-lock.test.ts, benchmark/workload-characterization.test.ts, provider/provider-state-render.test.ts, provider/retry-clock.test.ts, provider/supported-params-negative-cache.test.ts, session_summary/driver.test.ts.

A single-line grep could not tell whether any of them restores real timers in a shared hook (a multi-line afterEach is invisible to it), nor whether a timeout would cascade; each needs a read.

## Acceptance

- [ ] each file classified (restores in a shared hook / leaks on a timeout / not applicable)
- [ ] a fix card for each leaking file

## Notes

Related: TRDD-WTKO255N (the leak that hung completion.test.ts).
2026-11-16T20:16:26+0100 main agent: new hazard to check in each file, found by TRDD-FC2TX9VU (folded in from the duplicate TRDD-LVJHDIHI): a send to 127.0.0.1 through chatCompletionWithRetry or fetchWithRetry429 takes a local-governor lease whose retry poll waits on setTimeout, so faked setTimeout plus the governor on can hang the test, and the dead poller then hangs later tests in the file. Guards used in completion.test.ts: LLM_EXT_GOVERNOR_ENABLED=false in the test, and resetGovernorPollersForTests() plus the variable restore in the file afterEach. Also check provider/http.test.ts and local-fallback.test.ts. Do not put the reset in the shared setup: governor test files run real concurrent lease waits.

## Approval log

- 2026-11-05T00:08:55+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
