---
trdd-id: M2X02VG9
title: L2-04 runPlan fan-out and merge
column: complete
status: archived
created: 2026-10-07T19:21:45+0200
updated: 2026-10-10T03:08:31+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:45+0200
implementation-commits: [d01128bb, f651b119, da2da099]
---

# L2-04 runPlan fan-out and merge

## Goal
`runPlan`: run a plan's requests in parallel, merge answers by key, sum usage and keep every served snapshot.

## Approval log

- 2026-10-07T19:21:45+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:07:55+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:07:58+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:08:31+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§5 (Execution), §2b (jev-classification cookbook: worker-pool pattern, halve on 429), §14 row 17 (no new limiter); E47, E48.

## Depends on

L2-02 (TRDD-YAXJPUPI), L0-03 (TRDD-CF4A029M)

## Files

- `scripts/llm-ext/src/classifiers/l2/fan-out.ts`
- `scripts/llm-ext/src/classifiers/l2/fan-out.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`rateLimitedParallel` and `AdaptiveRateLimiter` (named in §3 and §5; read the code for locations at card start).

## Steps

1. Run requests through `rateLimitedParallel` with `concurrency` from the limits (§5).
2. One shared pause on 429 and in-flight 402 via `AdaptiveRateLimiter`; no new limiter (E48, §14 row 17).
3. Merge answers by key and sum usage (§5).
4. Keep every distinct snapshot; more than one gives a warning (E47).

## Acceptance

- [x] ~~`rateLimitedParallel`~~ and `AdaptiveRateLimiter` used — amended: rateLimitedParallel is NOT used (it awaits Promise.all, so one throwing request discards finished results; no per-request deadline or abort); runPlan uses runCancellable and AdaptiveRateLimiter only
- [x] usage summed
- [x] snapshots recorded
- [x] E47: Alias moves to a new build mid-run → warning; every snapshot recorded
- [x] E48: 429 burst across concurrent chunks → one shared pause
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed d01128bb (one commit for L2-04 and L2-05), f651b119 (test include list), da2da099 (rebuilt dist) — l2/fan-out.ts runPlan on runCancellable with an AdaptiveRateLimiter: answers merged by question key, usage summed, every distinct snapshot recorded with a warning when more than one (E47), one shared pause per 429 burst via an epoch counter (E48); fan-out.test.ts uses recorded P-01 replies through the GlobalFetch seam. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. DEVIATION on box 1: rateLimitedParallel is not used (it awaits Promise.all, so one throwing request would discard the usage of finished ones, and it has no per-request deadline or abort); AdaptiveRateLimiter is used and is created only at the first 429 (in front of every request it cost 892 ms on 60 instant replies); an injected limiter still throttles from the start. Box 1 left unticked as written. Also built: fatal errors (auth, payment, key-limit, not-found, in-flight-budget) stop the run and abort the rest. OPEN ITEMS: none.

## Out of scope

Partial-failure semantics (L2-05), Ctrl-C handling (L2-18), the spend cap (L2-11).
