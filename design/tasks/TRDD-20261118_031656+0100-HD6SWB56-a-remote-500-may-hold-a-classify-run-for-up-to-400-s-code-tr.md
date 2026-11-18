---
trdd-id: HD6SWB56
title: A remote 500 may hold a classify run for up to 400 s (code trace, not measured) while mlx-decision is installed but not answering
column: backburner
status: tasked
created: 2026-11-18T03:16:56+0100
updated: 2026-11-18T03:24:28+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T03:16:56+0100
---

# A remote 500 may hold a classify run for up to 400 s (code trace, not measured) while mlx-decision is installed but not answering

## Approval log

- 2026-11-18T03:16:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

Source: reports/sonnet-worker/20261118_031306+0100-rule-check-docs-and-launch-test.md (Task 2 and its open question).
MEASURED: with the deps of classify-launch.test.ts unchanged, the exit-5 test (remote answers 500) times out at its 20 s limit while the other 25 tests pass. The same file with only localFallback enabled false added to the io() deps passes 26 of 26. So the local fallback setting is what changes the outcome.
NOT MEASURED, traced in code only (the stall was not profiled): an absent localFallback section means enabled (l2/local-fallback.ts, localFallbackConfig and LOCAL_FALLBACK_DEFAULTS). The remote 500 is not among the errors excluded from local rescue in run-decision.ts, so answerWithLocalDecider is called. ensureLocalDecider probes /health with the test fetch (500, so not a decider), scans the real process list, finds a running mlx-decision process or the installed LaunchAgent plist (present on the test host), and returns a retryable refusal. The loop then sleeps 2 s per pass until the 400 s requestTimeoutMs. A host without the plist would likely get a non-retryable refusal and pass, so the behaviour is host-dependent.
Consequence for users, same trace: with the fallback on by default, a remote 500 on a host that has mlx-decision installed but not answering can hold a CLI run up to 400 s per request before exit 5. It is bounded; whether that is acceptable is undecided. The 60 s unavailableUntil memo only shortens later lookups that found no decider.

## Lost coverage

classify-launch.test.ts now disables the local fallback for all 26 of its tests (WHY comment in the shared io() helper, same as run-decision.test.ts depsOf). None of them asserts a fallback answer. Exit code 5 is therefore no longer tested with the fallback on.

## Options to decide

1. A shorter wait budget for the escalation to the local decider after a remote 500, instead of the full requestTimeoutMs of 400 s.
2. A test that keeps the fallback on and sets a short requestTimeoutMs, so exit 5 with the fallback on is covered and the 400 s hold is bounded by an assertion.
3. Leave the behaviour as is and keep only the documented limit.

## Decision

The decision between these options is the owner's. Not decided; card parked in backburner until the owner chooses.
