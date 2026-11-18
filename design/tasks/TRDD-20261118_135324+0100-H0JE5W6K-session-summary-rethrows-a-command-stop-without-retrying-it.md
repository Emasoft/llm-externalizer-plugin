---
trdd-id: H0JE5W6K
title: session-summary rethrows a command stop without retrying it
column: complete
status: tasked
created: 2026-11-18T13:53:24+0100
updated: 2026-11-18T15:06:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T13:53:24+0100
implementation-commits: [3cb60045]
release-via: publish
---

# session-summary rethrows a command stop without retrying it

GitHub issue 15 item 5 (verification: reports_dev/issue15-verify/20261118_134848+0100-report-consolidated.md). session_summary/driver.ts callWithRetry had no stop handling: a --command_timeout stop error (stoppedError/throwIfStopped, final stop per failureOf) was retried maxRetries times and then wrapped as 'failed after N attempt(s) on model X', blaming one model. Changed: callWithRetry rethrows a CommandStoppedError at once, re-made with stoppedError so it stays final stop, names no model and adds the checkpoint resume hint; it is never wrapped as "failed after N attempt(s) on model X". A plain error that only carries final stop (the TLS verdict, ManagedServerError, BrokerJobError) is a model failure and keeps the model-naming wrapper. (Amended 2026-11-18 by the main agent after reading every throw site that sets final stop; the first wording also promised detection of failureOf(err).final === stop.) Test in driver.test.ts: one call, surfaces as the stop.

## Approval log

- 2026-11-18T13:53:24+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T15:06:34+0100 — column → complete by main-agent@llm-externalizer-plugin. implemented in 3cb60045 and verified (driver.test.ts 85/85, until-done 15/15, driver-abort 4/4 one file at a time, tsc and eslint 0, mutation check fails as expected); acceptance boxes ticked or struck with reason; ships in 14.7.3; approved by the main agent under the USER delegation of 2026-11-18

## Verification

2026-11-18 14:31 commit 3cb60045: driver.test.ts 85/85 pass; until-done.test.ts 15/15 pass; driver-abort.test.ts 4/4 pass (one file at a time); tsc and eslint exit 0; detection is instanceof CommandStoppedError only (a plain Error marked final "stop", the TLS shape, keeps its model-naming wrapper), the stop is re-made with stoppedError(message + "Checkpoint saved at ... re-run the same command to resume.") so it stays final "stop" and names no model; mutation (throw stoppedError replaced by throw err) fails the stop test (1 failed of 3 run with -t stop, vitest-mutation3), driver.ts restored cmp-identical. Not done: a live --command_timeout run; TLS test covers maxRetriesPerChunk 0 only.

## Acceptance

- [x] "callWithRetry rethrows a CommandStoppedError at once, re-made with stoppedError so it stays final stop, names no model and adds the checkpoint resume hint; it is never wrapped as "failed after N attempt(s) on model X"" (source: card body, amended 2026-11-18)
- [~] ~~"failureOf(err).final === stop" (source: card body, first wording)~~ obsolete: the body was amended 2026-11-18; final stop alone also marks model failures (TLS verdict, ManagedServerError, BrokerJobError), which must keep the model-naming wrapper, so detection is instanceof CommandStoppedError only
- [x] "Test in driver.test.ts: one call, surfaces as the stop." (source: card line 22)

## Acceptance evidence

box 1: commit 3cb60045 driver.ts callWithRetry: if (err instanceof CommandStoppedError) throw stoppedError(message + ". Checkpoint saved at <path> — re-run the same command to resume.") placed before the retry/wrap path; tests assert 1 call, no "failed after" in the message — shows a command stop is rethrown at once and not wrapped as a model failure (re-made via stoppedError so the resume hint is kept; original stop object discarded, only its message kept)
box 2: NOT met as written — commit 3cb60045 detects instanceof CommandStoppedError only; ManagedServerError (local-llama-server.ts:52), BrokerJobError (broker/client.ts:99) and the TLS verdict carry final "stop" but are model failures and keep the model-naming wrapper (test: plain Error + attachFailure final "stop" keeps "failed after 1 attempt(s) on model") — shows the card line 22 wording is stale vs the code; the main agent must amend card line 22 or strike box 2; not ticked
box 3: driver.test.ts stop test (3cb60045) asserts callModel called 1 time, err instanceof CommandStoppedError, failureOf(err).final === "stop", message startsWith the reason and contains "Checkpoint saved at"; a second test asserts 1 call across the fallback chain; driver.test.ts 85/85 (report-revision2, run 14:28:39) — shows one call and surfaces as the stop; mutation (throw err instead of throw stoppedError) makes the stop test fail (vitest-mutation3: 1 failed, 2 passed)
box 1 (amended wording), main agent 2026-11-18: the box-1 evidence above holds for the amended wording; the plain-Error TLS test in 3cb60045 driver.test.ts keeps "failed after 1 attempt(s) on model", which is the second sentence of the amended body.
