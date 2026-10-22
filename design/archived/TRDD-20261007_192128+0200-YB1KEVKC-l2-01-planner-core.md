---
trdd-id: YB1KEVKC
title: L2-01 Planner core
column: complete
status: archived
created: 2026-10-07T19:21:28+0200
updated: 2026-10-10T00:48:45+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:28+0200
implementation-commits: [539e0804, e8d7d255, 0421472e]
---

# L2-01 Planner core

## Goal
`planRequests` core: greedy packing of units into requests under the model limits, with the envelope and refusals.

## Approval log

- 2026-10-07T19:21:28+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:48:44+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:48:45+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:48:45+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§5 (input, limits, unit kinds, rules), §3 (`ModelLimits`, `planRequests`), §2b (jev-tutorial: independent questions about one state in one request); E42, E43.

## Depends on

L1-02 (TRDD-9TF7SI2I), L1-07 (TRDD-1V68E408)

## Files

- `scripts/llm-ext/src/classifiers/l2/planner.ts`
- `scripts/llm-ext/src/classifiers/l2/planner.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`estimateTokens` (L1-07), request checks (L1-02). Read the code at card start.

## Steps

1. Implement `planRequests<U>(job: SplitJob<U>, limits: ModelLimits): Plan<U> | Refusal` with the `SplitJob` input of §5 (`sharedState`, `units[]`).
2. Pack `atomic` units that share a state greedily in input order; each request is shared state + units + questions at most limit − 64 (§5 rules).
3. An `atomic` unit that alone does not fit is refused naming the unit, never truncated (E42).
4. A plan needing more than `maxRequests` is refused with the needed count (E43).
5. Questions per request stay at most `maxQuestionsPerRequest` when set (§5 rules). (derived from done-when)

## Acceptance

- [x] greedy packing
- [x] envelope
- [x] refusals
- [x] E42: One `atomic` unit alone exceeds the limit → refused naming the unit, never truncated
- [x] E43: Plan needs more than `max_requests_per_call` → refused with the needed count
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 539e0804 (one commit for L2-01, L2-02 and L2-03), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/planner.ts planRequests (greedy packing, envelope = contextTokens - 64, refusals unit-too-large, unit-too-many-questions, too-many-requests), l2/planner.test.ts, vitest.config.ts include entry. E42 and E43 pinned by tests; review fixes: duplicate question keys throw, token accounting re-measures the real body, empty job refused. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Deviation: the request state wire shape {shared, units} is my choice (plan silent); text units are one per request (L2-19). OPEN ITEMS: none for this card.

## Out of scope

Unsplittable questions and renumbering (L2-02), limits from the catalog (L2-03), `text` chunking (L2-19).
