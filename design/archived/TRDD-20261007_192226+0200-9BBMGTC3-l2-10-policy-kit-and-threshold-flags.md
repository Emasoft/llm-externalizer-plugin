---
trdd-id: 9BBMGTC3
title: L2-10 Policy kit and threshold flags
column: complete
status: archived
created: 2026-10-07T19:22:26+0200
updated: 2026-10-10T00:01:03+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:26+0200
implementation-commits: [25cfcb6f, 0b59bb6a]
---

# L2-10 Policy kit and threshold flags

## Goal
Shared threshold math for specs: bands, margin, max-gated and range checks.

## Approval log

- 2026-10-07T19:22:26+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:03+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:03+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:03+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l2/policy-kit.ts`), §3 (`thresholds: Record<string, ThresholdSpec>` in `DecisionSpec`).

## Depends on

none

## Files

- `scripts/llm-ext/src/classifiers/l2/policy-kit.ts`
- `scripts/llm-ext/src/classifiers/l2/policy-kit.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Band helper for threshold bands. (derived from done-when)
2. Margin helper (top versus runner-up). (derived from done-when)
3. Max-gated helper. (derived from done-when)
4. Range checks for threshold flags, refusing out-of-range values. (derived from done-when)

## Acceptance

- [x] bands
- [x] margin
- [x] max-gated
- [x] range checks
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 25cfcb6f and 0b59bb6a (vitest include list) — l2/policy-kit.ts (band, marginMet, maxGate, ThresholdSpec, parseThresholdFlag, resolveThresholds, PolicyError), l2/policy-kit.test.ts 26 tests. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. OPEN ITEM: the p+auto<=1 and auto>=threshold+band rules are left to SP-03. The card is vague; semantics were taken from plan section 9 rows classify filter/label/audit.

## Out of scope

Each decision's default thresholds (its L3 spec), thresholds that break `p + auto ≤ 1` (SP-03).
