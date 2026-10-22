---
trdd-id: 9TF7SI2I
title: L1-02 Request shape checks
column: complete
status: archived
created: 2026-10-07T19:20:21+0200
updated: 2026-10-10T00:00:59+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:20:21+0200
implementation-commits: [4926f059, 0b59bb6a]
---

# L1-02 Request shape checks

## Goal
Question-count and serialized-size checks on a request, with clear refusals.

## Approval log

- 2026-10-07T19:20:21+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:00:59+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:00:59+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:00:59+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (L1 primitives: build and check requests), §5 (limits: questions per request).

## Depends on

L1-01 (TRDD-V6HL0ERI)

## Files

To be listed at card start (the module that holds request checks; §3 assigns request building and checking to `l1/questions.ts`), plus its test file and `scripts/llm-ext/vitest.config.ts`.

## Reuse

Read the code at card start.

## Steps

1. Read L1-01's builders and the request shape in §3 (`DecisionsCall`). (derived from done-when)
2. Refuse a request whose question count is over the limit, naming the count. (derived from done-when)
3. Refuse a request whose serialized size is over the limit, naming the size. (derived from done-when)
4. Each refusal message states what to change. (derived from done-when)

## Acceptance

- [x] question count check refuses with a clear message
- [x] serialized size check refuses with a clear message
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 4926f059 and 0b59bb6a (vitest include list) — l1/request-shape.ts checkRequestShape plus MAX_REQUEST_BODY_BYTES, l1/request-shape.test.ts 8 tests, vitest.config.ts include entry. Refuses a question count over the limit, zero questions, and a body over the byte limit with a clear message. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. Note: the plan gives no numeric question limit, so maxQuestions is a required caller argument.

## Out of scope

Splitting a plan across requests (L2-01), model limits from the catalog (L2-03).
