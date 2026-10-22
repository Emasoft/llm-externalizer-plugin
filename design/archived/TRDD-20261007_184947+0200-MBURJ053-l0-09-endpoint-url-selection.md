---
trdd-id: MBURJ053
title: L0-09 Endpoint URL selection
column: complete
status: archived
created: 2026-10-07T18:49:47+0200
updated: 2026-10-09T23:29:48+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:49:47+0200
implementation-commits: [42f1671e]
---

# L0-09 Endpoint URL selection

## Goal
Choose the request URL from `endpoint: "decisions" | "systemone"`.

## Approval log

- 2026-10-07T18:49:47+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:29:48+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:29:48+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:29:48+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 L0 (`DecisionsCall.endpoint`); §16 L0 table.

## Depends on

L0-02 (TRDD-CWQOWEHO)

## Files

- `scripts/llm-ext/src/classifiers/l0/transport.ts`
- the matching test file and vitest include entry (to be listed at card start)

## Reuse

Read the code at card start.

## Steps

1. Map `decisions` and `systemone` to their URLs, taken from the P-01 captures. (derived from done-when)
2. An unknown endpoint value is refused. (derived from done-when)

## Acceptance

- [x] `decisions` selects its URL
- [x] `systemone` selects its URL
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 42f1671e — endpoint selection in l0/transport.ts; an unknown endpoint is refused before sending. Same commit as L0-03 (same file); the worker briefly overwrote the retry loop and restored it with fastedit undo, the 27 transport tests pass after. Whole package, run by the coordinator on the committed tree: npm test 215 files passed / 4 skipped, 3414 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet, build 0 per the integration worker; the real settings.yaml hash unchanged.

## Out of scope

Header and body building (L0-02).
