---
trdd-id: OSIGZK0O
title: L0-05 Response parsing
column: complete
status: archived
created: 2026-10-07T18:48:29+0200
updated: 2026-10-09T23:11:19+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:48:29+0200
implementation-commits: [56660912]
---

# L0-05 Response parsing

## Goal
Parse a decisions reply into `RawDecisionsReply`, rejecting malformed replies as `bad-response` and recording the served snapshot.

## Approval log

- 2026-10-07T18:48:29+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:11:19+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:11:19+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:11:19+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 L0 (`RawDecisionsReply`); §7 (Response, Snapshot); D8 context; E01, E11, E13.

## Depends on

L0-01 (TRDD-NL788NGR)

## Files

- `scripts/llm-ext/src/classifiers/l0/transport.ts` (or a sibling parser file, to be decided at card start)
- the matching test file and `scripts/llm-ext/vitest.config.ts` include entry

## Reuse

`safeReadText` (`src/safe-body.ts:20`). Other reuse: read the code at card start.

## Steps

1. A 200 with unparseable JSON, non-object `answers`, missing, blank or non-string `model`, or bad `usage` becomes `bad-response`; the message holds a sanitized excerpt (E01).
2. A missing `usage` is `bad-response`; nothing is recorded as free (E13).
3. Record usage and cost from the raw reply before answer validation, so invalid but billed replies are counted (§7).
4. The reply `model` is the served build: record it on every result; a differing alias is no error (E11).

## Acceptance

- [x] E01: 200 with HTML body (proxy page) → `bad-response`, sanitized excerpt
- [x] E11: Reply `model` differs from the requested alias → snapshot recorded, no error
- [x] E13: `usage` missing → `bad-response`; nothing recorded as free
- [x] each bad-response rule of §7 has a test
- [x] snapshot recorded
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 56660912 — l0/response.ts parseDecisionsReply, 10 tests; usage recorded before validation, proven by moving the record (2 tests fail). Whole package after the wave, run by the coordinator: npm test 210 files passed / 4 skipped, 3349 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet and build 0 per the fixing worker.

## Out of scope

The usage record itself and the estimated-cost flag (L1-09), error classes (L0-01).
