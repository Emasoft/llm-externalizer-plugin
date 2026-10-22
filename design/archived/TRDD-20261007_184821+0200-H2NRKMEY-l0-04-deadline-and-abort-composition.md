---
trdd-id: H2NRKMEY
title: L0-04 Deadline and abort composition
column: complete
status: archived
created: 2026-10-07T18:48:21+0200
updated: 2026-10-09T21:58:19+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:48:21+0200
implementation-commits: [92b6476]
---

# L0-04 Deadline and abort composition

## Goal
One deadline per call across all attempts, combined with the caller's abort signal, so an abort stops waits at once.

## Approval log

- 2026-10-07T18:48:21+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T21:58:10+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T21:58:14+0200 — column → dev by main-agent@llm-externalizer-plugin. worked 2026-10-09
- 2026-10-09T21:58:19+0200 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met, committed 92b6476.

## Plan refs

§3 L0 (`l0/deadline.ts`, in L0 because the transport uses it); §7 (Deadline: `timeout_ms` default 60,000, browse passes its run deadline); E10.

## Depends on

none (plan npt: —)

## Files

- `scripts/llm-ext/src/classifiers/l0/deadline.ts`
- `scripts/llm-ext/src/classifiers/l0/deadline.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. `Deadline` type: one deadline of `timeout_ms` (default 60,000) shared by all attempts of a call.
2. Combine it with the caller's abort signal; a browse run passes its own run deadline.
3. Make waits abortable: an abort during a retry wait ends it immediately with no further attempt (E10). (derived from done-when)
4. WHY comment on why one deadline spans attempts, not one per attempt. (derived from done-when)

## Acceptance

- [x] E10: Ctrl-C during a retry wait → stops at once, no further attempt
- [x] one deadline spans all attempts
- [x] abort stops waits
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 92b6476: src/classifiers/l0/deadline.ts (createDeadline, DeadlineError, DEFAULT_TIMEOUT_MS 60000) and deadline.test.ts (5 tests incl. E10 abort during a wait). Whole-package checks run once for the wave by the coordinator's integration worker: tsc 0, eslint . --quiet 0, npm test 201 files passed / 4 skipped, 3209 tests passed / 5 skipped / 0 failed (3195 before the wave: +14 = 5 deadline + 3 test-fetch + 6 estimate), build 0. Worker report: docs_dev/20261009-L0-04-report.md.

## Out of scope

The retry loop (L0-03), Ctrl-C handling in the runner (L2-18).
