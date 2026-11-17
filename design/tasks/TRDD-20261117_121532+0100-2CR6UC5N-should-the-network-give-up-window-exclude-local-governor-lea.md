---
trdd-id: 2CR6UC5N
title: Should the network give-up window exclude local-governor lease-wait time
column: backburner
status: tasked
created: 2026-11-17T12:15:32+0100
updated: 2026-11-17T12:15:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T12:15:32+0100
---

# Should the network give-up window exclude local-governor lease-wait time

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-17
- NEXT ACTION: USER decision — should the network give-up window exclude local-governor lease-wait time (as the retry deadline already does), or keep counting it?
- Meanwhile the window tests in scripts/llm-ext/src/network-give-up-dispatch.test.ts run with the governor off (TRDD-FC2TX9VU), so no test exercises the window together with a lease wait. A test for the chosen semantics must turn that back on.

## Facts (reports_dev/flake2/20261117-network-give-up-timing.md)
- Before every loopback attempt the call takes a governor lease: provider/http.ts:409 gate, completion.ts:619 directAttemptGate, governor/direct.ts:39-51 takeDirectLease, then acquire.
- The retry deadline excludes the wait: completion.ts:622 adds it to time.startTime and brokerQueuedMs.
- The give-up window does not: failingSince is set at http.ts:330 and compared with now in the verdict (budget verdict built at http.ts:911, final set at :615), so a lease wait between two failed attempts counts toward the window and is not capped by it.
- The governor's contract, printed with every wait: "requests queue, nothing fails".
- Forced denial (CPU limit 10, floor 3000 ms): the 2 s window test took 7073, 7418, 7346 ms (3 of 3).

## Options
- (a) Exclude lease-wait time from the window, like the retry deadline. Keeps "nothing fails". Recommended by the main agent.
- (b) Keep counting it (today).
- (c) Cap the wait by the window: rejected by the main agent, it turns a queued local wait into a failure verdict.

## Approval log

- 2026-11-17T12:15:32+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
