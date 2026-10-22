---
trdd-id: S8CS3RRF
title: Check whether a free model refusing a wait beyond the window loses its rate-limit cause
column: backburner
status: tasked
created: 2026-10-10T11:00:58+0200
updated: 2026-10-10T11:02:36+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T11:00:58+0200
---

# A free model refusing a wait beyond the window ends as all free models exhausted, not rate-limit

## Goal

Check whether, when the free path's only model answers 429 with a Retry-After beyond the retry window, the final AllFreeModelsExhaustedError (after one request) loses the rate-limit cause and the time to retry. If it does, it should carry or print the last cause's retryAt and say it was a rate limit.
2026-10-10T11:01:54+0200 Correction (review): it is unverified whether AllFreeModelsExhaustedError already surfaces the last cause's rate limit and retryAt (the cooldown records retryAt). First step: read and report what the error's message and fields contain for this case; change it only if the rate limit and retry time are missing. With one model in the pool, 'all free models exhausted' is literally true, so this may be intended behaviour.

## Evidence

scripts/llm-ext/src/provider/issue16-burst.test.ts (commit 2a49592b), test 'free path: a Retry-After beyond the window is one model's refusal: cooldown with retryAt, pool exhausted (no other model to try)'. Recorded as an open nuance on the issue-16 box of TRDD-YG72CYY7.

## Acceptance

- [ ] read and report what AllFreeModelsExhaustedError's message and fields carry for this case (rate limit named? retryAt present?)
- [ ] only if the rate limit or the retry time is missing: the free-path test above asserts both, failing before the change
- [ ] the other free-path and issue-16 tests stay green
- [ ] definition of done: typecheck, lint and eslint . --quiet clean, full npm test green, one commit with the TRDD id in its subject

## Related

TRDD-YG72CYY7 (issue-16 box note).

## Approval log

- 2026-10-10T11:00:58+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
