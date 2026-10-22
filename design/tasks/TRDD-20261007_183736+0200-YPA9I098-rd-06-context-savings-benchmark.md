---
trdd-id: YPA9I098
title: RD-06 Context-savings benchmark
column: backburner
status: tasked
created: 2026-10-07T18:37:36+0200
updated: 2026-10-07T18:40:29+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:36+0200
---

# RD-06 Context-savings benchmark

## Goal
Measure Claude-reading versus llm-ext on tasks with deterministic truth, within the D25 spend cap.

## Plan refs
§13b (RD-06 row); D25 (go-ahead given; one $2 total across RD-06 and RD-19 on one spend ledger); D12.

## Depends on
Depends on: RD-05 (TRDD-CRIOJB1O)

## Files
Files: to be listed at card start (the plan names: `truth/*.json`, a fixture repo).

## Reuse
Reuse: read the code at card start

## Steps
1. Pick tasks with deterministic truth only: files relevant to X, planted bugs in a fixture repo, functions that do Y (derived from done-when).
2. Commit `truth/*.json` (derived from done-when).
3. Baseline: headless `claude -p` with a fixed model, tokens from its usage output; llm-ext path on a fixed profile; exact-match scoring (derived from done-when).
4. Measure one pilot task first and restate the $2 cap from it (derived from done-when).

## Acceptance
- [ ] tasks with deterministic truth only
- [ ] `truth/*.json` committed
- [ ] baseline: headless `claude -p`, fixed model, tokens from its usage output
- [ ] llm-ext path on a fixed profile; exact-match scoring
- [ ] one pilot task measured first; $2 cap restated from it
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
RD-19 cost matrix; RD-07 chart rendering.

## Approval log

- 2026-10-07T18:37:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
