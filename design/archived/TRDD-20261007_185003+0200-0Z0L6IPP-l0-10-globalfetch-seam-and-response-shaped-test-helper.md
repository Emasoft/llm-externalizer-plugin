---
trdd-id: 0Z0L6IPP
title: L0-10 GlobalFetch seam and Response-shaped test helper
column: complete
status: archived
created: 2026-10-07T18:50:03+0200
updated: 2026-10-09T21:58:47+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:50:03+0200
implementation-commits: [f2126da]
---

# L0-10 GlobalFetch seam and Response-shaped test helper

## Goal
Define the `GlobalFetch` type and a helper that builds real `Response` objects for tests, used by all classifier tests.

## Approval log

- 2026-10-07T18:50:03+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T21:58:43+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T21:58:45+0200 — column → dev by main-agent@llm-externalizer-plugin. worked 2026-10-09
- 2026-10-09T21:58:47+0200 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met, committed f2126da.

## Plan refs

§3 L0 (`type GlobalFetch = (url: string, init: RequestInit) => Promise<Response>`); §7 (Seam); D21.

## Depends on

none (plan npt: —)

## Files

To be listed at card start (the seam type in `l0/transport.ts` and the test helper beside it; vitest include if a test file is added).

## Reuse

Read the code at card start.

## Steps

1. Declare `GlobalFetch` returning a real `Response` (headers needed).
2. Write a helper that replays captured P-01/P-02 fixtures as `Response`, and builds synthetic `Response` objects named `synthetic: …` for faults that cannot be produced on demand (D21).
3. (derived from done-when) Use it in at least one test to prove the shape.

## Acceptance

- [x] `GlobalFetch` type exported
- [x] helper replays a fixture as a `Response` with headers
- [x] helper builds a synthetic `Response`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed f2126da: l0/transport.ts (GlobalFetch type), l0/test-fetch.ts (replayFixture, syntheticResponse, replayFetch) and its test (3 tests); the worker did not show the test failing without the code (the helper is the code under test). Whole-package checks run once for the wave by the coordinator's integration worker: tsc 0, eslint . --quiet 0, npm test 201 files passed / 4 skipped, 3209 tests passed / 5 skipped / 0 failed (3195 before the wave: +14 = 5 deadline + 3 test-fetch + 6 estimate), build 0. Worker report: docs_dev/20261009-L0-10-report.md.

## Out of scope

The transport that consumes it (L0-02).
