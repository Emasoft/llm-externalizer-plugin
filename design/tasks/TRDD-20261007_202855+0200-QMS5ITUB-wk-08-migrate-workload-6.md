---
trdd-id: QMS5ITUB
title: WK-08 Migrate workload 6
column: backburner
status: tasked
created: 2026-10-07T20:28:55+0200
updated: 2026-10-07T20:28:58+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:28:55+0200
---

# WK-08 Migrate workload 6

## Goal
Move workload 6 of the six (named at card start) onto `benchmark/workload-kit.ts` so its WK-01 characterization test passes unchanged.

## Approval log

- 2026-10-07T20:28:55+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (workload-kit row), §16 (WK table), D16.

## Depends on

WK-02 (TRDD-PCZZCDSR)

## Files

- To be listed at card start (the workload's own file among the files under scripts/llm-ext/src/benchmark/, to be listed at card start, plus `benchmark/workload-kit.ts` only if a step is missing).

## Reuse

Read the code at card start. The kit steps are key, dataset/fingerprint, catalog, pool, gates, ledger, cached per-model loop, `selectSameOrCheaper`, report (§11); `benchmark/pick.ts:165` orders by mean F1 then latency.

## Steps

1. Run the WK-01 characterization test for this workload and record that it passes before any change (derived from done-when).
2. Replace the workload's own copies of the md5-identical helpers with the matching `workload-kit.ts` steps, one step at a time (derived from done-when).
3. Re-run the WK-01 test after each step; do not edit it (derived from done-when).
4. Leave the removal of unused duplicates to WK-09 (derived from §16 WK table).

## Acceptance

- [ ] WK-01 tests unchanged and green for this workload
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The kit itself (WK-02), the other five workloads, deleting dead duplicates (WK-09).
