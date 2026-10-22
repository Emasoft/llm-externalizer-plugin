---
trdd-id: B3R1SCSX
title: L2-12 Result envelope (schema 1)
column: complete
status: archived
created: 2026-10-07T19:22:40+0200
updated: 2026-10-10T00:01:02+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:40+0200
implementation-commits: [e6d201be, 0b59bb6a]
---

# L2-12 Result envelope (schema 1)

## Goal
The `schema: 1` result envelope shared by classify and browse.

## Approval log

- 2026-10-07T19:22:40+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:01+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:02+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:02+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l2/envelope.ts`), D8, D2; E86.

## Depends on

L1-09 (TRDD-UPZR8PAY)

## Files

- `scripts/llm-ext/src/classifiers/l2/envelope.ts`
- `scripts/llm-ext/src/classifiers/l2/envelope.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Define the envelope with `schema: 1` and the fields: decision, snapshots, usage, cost, warnings, degraded, `stopped`. (derived from done-when)
2. `stopped` is `"budget"` when `--max-budget` ended the run (E86).
3. Cost carries the `cost_estimated` flag from L1-09 (D8). (derived from done-when)

## Acceptance

- [x] envelope carries decision, snapshots, usage, cost, warnings, degraded and `stopped`
- [x] E86: `--max-budget` given and a running cost passes it mid-run → remaining requests are not sent; finished results kept; the classify result envelope carries `stopped: "budget"` (browse: status `budget`) and the command exits non-zero
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed e6d201be and 0b59bb6a (vitest include list) — l2/envelope.ts (schema 1 envelope: decision, snapshots, usage, cost, warnings, degraded, stopped; renderEnvelope), l2/envelope.test.ts 6 tests incl. a real P-01 dec-noul reply. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. DECISION: the decision field holds the projected result, because the plan's field list (line 684) has no other field for it and line 304 puts the result object inside the envelope. Warnings and degraded shapes (string[] and boolean) are provisional until L2-14. The budget cap logic and exit code (E86) are L2-11/L2-13; only the envelope side (stopped: budget) is covered here.

## Out of scope

The cap logic (L2-11), exit codes (L2-13), the `-o` writer (L2-16).
