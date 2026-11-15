---
trdd-id: 5B4HPVKO
title: The completion.test.ts circuit-breaker test exceeds its 30 s cap under heavy load
column: backburner
status: tasked
created: 2026-11-05T00:08:55+0100
updated: 2026-11-05T01:37:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T00:08:55+0100
---

# The completion.test.ts circuit-breaker test exceeds its 30 s cap under heavy load

## Symptom

The breaker test in scripts/llm-ext/src/provider/completion.test.ts ("a transient 5xx streak trips the circuit breaker (60s, then 120s) ...") timed out at its 30 s cap in run 3 at a 1-minute load of about 81; it passed in the ci3 run of the same commit (ebeab4fd).

## Cause (not isolated)

Either plain slowness under load, or a load-dependent fake-timer deadlock (an HTTP-layer setTimeout under the faked setTimeout that the test never advances). Reading stoppableSleep (command-stop.ts:76) rules out only a race between its log line and its timer registration.

## Acceptance

- [ ] the cause is measured
- [ ] the test passes at a 1-minute load of 80 or more, or its budget is justified by a measurement

## Notes

Related: TRDD-WTKO255N (the cascade a timeout of this test causes).
2026-11-05T01:10+0100 Run 4b at c668389e (TRDD-YGF9YXF2): the breaker test passed; stage 1 (which holds completion.test.ts) ran at sampled load1 4.60-24.87; the 82.08 peak came in stage 2 after this file finished; per-test time unknown; box 2 not met by this run.
Copied from TRDD-WTKO255N (2026-11-05): when this test times out, its stderr spy stays installed and hides later tests stderr (inferred from code, see TRDD-DTROKVVY), and the stalled run-3 worker held a second, unexplained listening server; neither is fixed.
2026-11-05T01:15+0100 Open known limits 1 and 2 of TRDD-WTKO255N have no other owner and are parked here until this card closes: (1) a breaker-test body abandoned before vi.useFakeTimers can install fake timers during a later test; the file afterEach reset clears them after that test, so at most one later test per abandoned body can hang (inferred from code); (2) a body abandoned in stoppableSleep stays in the wakers set, and a later command stop can wake it so its vi.advanceTimersByTimeAsync runs with real timers, possibly a run-level unhandled error.
The stderr-spy item is tracked on TRDD-DTROKVVY.
Before closing this card, move TRDD-WTKO255N known limits 1 and 2 to a live card (the stderr-spy item is already tracked on TRDD-DTROKVVY); the boxes of this card do not cover them.
2026-11-05T01:27+0100 Run 4b did not exercise the 46b88412 afterEach reset: the breaker test did not time out.

## Approval log

- 2026-11-05T00:08:55+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
