---
trdd-id: 28BAL5ER
title: Fall back from Jev to another System One model under a price ceiling
column: complete
status: archived
created: 2026-10-27T23:56:08+0100
updated: 2026-10-28T02:18:42+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T23:56:08+0100
implementation-commits: [55af55b3]
---

# Fall back from Jev to another System One model under a price ceiling

Parent: TRDD-UT7UC025. Independent of the other cards.

## Scope
- or-jev keeps ~typesafe/jev-latest first. On 404 (removed), 5xx, timeout or any model-not-working error (never a key error) the decision runner (scripts/llm-ext/src/classifiers/run-decision.ts:236-240 sends only profile.model today) tries the other models the decisions catalog marks System One (classifiers/l0/catalog.ts:64-65).
- Price ceiling: only models whose prompt price is at or below Jev's (catalog.ts:30, 55 read the prompt price only).
- The command reports which model answered.
- Write the alias_target_change drift event (declared at model-events.ts:49, 63, 75, never written).

## Acceptance
- [x] a test with no other System One model shows a clean skip with Jev's original error
- [x] a test with a removed Jev and a second System One model shows the fallback answer and the model name
- [x] a key error never falls back

## Approval log

- 2026-10-27T23:56:08+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-28T02:18:42+0100 — COMPLETE by main-agent@llm-externalizer-plugin. implemented and reviewed in 55af55b3; acceptance tests pass.

## Progress

- 2026-10-28: done in 55af55b3 after two review rounds; tests in src/classifiers/system-one-fallback.test.ts cover no-other-model, removed Jev, key error, price ceiling, transient 503, shared deadline.
