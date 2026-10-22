---
trdd-id: XJKL495A
title: RD-19 Per-command cost matrix on the four default profiles
column: backburner
status: tasked
created: 2026-10-07T18:37:39+0200
updated: 2026-10-07T18:40:35+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:39+0200
---

# RD-19 Per-command cost matrix on the four default profiles

## Goal
Measure each model-calling CLI command on each default profile it is compatible with, within the D25 cap.

## Plan refs
§13b (RD-19 row); D25 (4 default profiles = `free`, `paid`, `local`, `scouting`; $2 total with RD-06, one spend ledger); D12.

## Depends on
Depends on: RD-02 (TRDD-VJTBC6IC), RD-08 (TRDD-T7FELEN5)

## Files
Files: to be listed at card start (the plan names: `assets/data/cost-matrix.json`).

## Reuse
Reuse: read the code at card start

## Steps
1. Scope: CLI commands that send a model request; others show "no model call" (derived from done-when).
2. Run each on a fixed fixture input under each compatible default profile only; compatibility from RD-02's per-command field; incompatible cells never run, show "n/a"; pairs RD-02's disagreement list marks are "not measured (disallowed by the profile-type ruling)" (derived from done-when).
3. Per run record USD cost from usage records, input/output tokens, wall time, model actually used, outcome (success, command failure, rate-limited, kept apart) (derived from done-when).
4. 3 runs per cell with RD-08's retry policy; median only when all 3 runs used the same model, else list each run (derived from done-when).
5. Paid cell = resolved model with non-zero catalog price in any column (scouting model and fallback models included): pilot, then D25 estimate, stop and ask if over the cap, hard stop on the spend ledger marks the rest "not measured (cap)" (derived from done-when).
6. `local`: ask the user to start the local server at run time, else "not measured (no local server)"; `scouting`: only if it already exists, never created here, else "profile absent" (derived from done-when).
7. Write `assets/data/cost-matrix.json` with date and models; RD-07 renders a chart and RD-09/RD-10 print a cost line per command from it (derived from done-when).

## Acceptance
- [ ] scope: model-calling commands; others "no model call"
- [ ] incompatible cells "n/a", never run; disallowed pairs skipped as stated
- [ ] per run: cost, tokens, wall time, model, outcome kept apart
- [ ] 3 runs per cell; median only when same model
- [ ] paid cells: pilot, estimate, ask if over cap, hard stop "not measured (cap)"
- [ ] `local` and `scouting` fallbacks as stated
- [ ] results in `assets/data/cost-matrix.json` with date and models
- [ ] missing cells never block RD-18
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
RD-06; the `or-jev` column (RD-17); rendering (RD-07).

## Approval log

- 2026-10-07T18:37:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
