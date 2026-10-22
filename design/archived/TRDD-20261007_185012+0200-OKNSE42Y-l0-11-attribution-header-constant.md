---
trdd-id: OKNSE42Y
title: L0-11 Attribution header constant
column: complete
status: archived
created: 2026-10-07T18:50:12+0200
updated: 2026-10-09T21:59:00+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:50:12+0200
implementation-commits: [fccf1a6]
---

# L0-11 Attribution header constant

## Goal
One constant for the attribution headers, reusing the existing one if llm-ext has it.

## Approval log

- 2026-10-07T18:50:12+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T21:58:57+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T21:58:58+0200 — column → dev by main-agent@llm-externalizer-plugin. worked 2026-10-09
- 2026-10-09T21:59:00+0200 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met, committed fccf1a6.

## Plan refs

§7 (Request: `HTTP-Referer: https://github.com/Emasoft/llm-externalizer-plugin`, `X-OpenRouter-Title: llm-externalizer`); §16 L0 table.

## Depends on

none (plan npt: —)

## Files

To be listed at card start (`provider/http.ts` if a new constant is needed).

## Reuse

The existing attribution header if llm-ext has one; read the code at card start.

## Steps

1. Search the code for an existing attribution header. (derived from done-when)
2. If found, reuse it. Otherwise add one constant in `provider/http.ts`.
3. Make L0-02 import it.

## Acceptance

- [x] one attribution constant exists
- [x] no duplicate definition remains
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed fccf1a6: OPENROUTER_ATTRIBUTION_HEADERS in src/provider/http.ts; no earlier attribution constant existed (index.ts sends a configurable X-Title, a different header). Step 3 (L0-02 imports it) is owed by L0-02, which does not exist yet. Whole-package checks run once for the wave by the coordinator's integration worker: tsc 0, eslint . --quiet 0, npm test 201 files passed / 4 skipped, 3209 tests passed / 5 skipped / 0 failed (3195 before the wave: +14 = 5 deadline + 3 test-fetch + 6 estimate), build 0. Worker report: docs_dev/20261009-L0-11-report.md.

## Out of scope

Request building (L0-02).
