---
trdd-id: BQZZFA7R
title: P-04 Tolerance spike
column: complete
status: archived
created: 2026-10-07T18:47:12+0200
updated: 2026-10-09T22:36:19+0200
current-owner: user
created-by: user
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:47:12+0200
---

# P-04 Tolerance spike

## Goal
Choose the final validation tolerances so every P-01 answer passes the chosen policy, and write the numbers into §6 and the STATE block.

## Approval log

- 2026-10-07T18:47:12+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:36:18+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:36:18+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:36:19+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§1 D6 (tolerances scale with option count, final numbers fixed from probe fixtures); §6 (validation policy table, answer-set rule: a fixture the chosen policy rejects fails the build); E20, E21 context; §16 P table.

## Depends on

P-03 (TRDD-OP8ZMLOZ)

## Files

To be listed at card start. Output: the numbers in plan §6 and the STATE block of TRDD-ZB41KG62.

## Reuse

Read the code at card start.

## Steps

1. Run every P-01 answer fixture against the §6 starting policy: `sum` scaled `min(0.05, max(0.01, 0.005·nonzero))` (+1e-9), `tie` 0.001, `score` expected-value with tol `0.02 + 0.005·N(N−1)/2`. (derived from done-when)
2. Adjust the numbers until every fixture passes. (derived from done-when)
3. Write the final numbers into §6 and the STATE block.

## Acceptance

- [x] every P-01 answer passes the chosen policy
- [x] final numbers written into §6
- [x] final numbers written into the STATE block
- [x] definition of done for a decision card: final tolerances and the fixture evidence recorded in plan §6 (fastedit, committed) and in TRDD-ZB41KG62's STATE; no code
RESULT 2026-10-09: committed - — no code. Final tolerances for the L1 validation card, from the 14 recorded replies (docs_dev/20261009-P-04-report.md): choice sum min(0.05, max(0.01, 0.005*N)) + 1e-9 with N = the NON-ZERO options; tie 0.001; score 0.02 + 0.005*N(N-1)/2. All 14 replies pass. Sample limit: one reply per case and only one non-unit sum (dec-choice60 at 0.99), so the 0.05 cap and the 0.005 slope are the plan's assumptions, not measured. Plan section 6 is not edited: its formula stands. Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 206 files passed / 4 skipped, 3311 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave3-integration.md).

## Out of scope

The policy code and its tests (L1-03 to L1-05), and the validators (L1-06).
