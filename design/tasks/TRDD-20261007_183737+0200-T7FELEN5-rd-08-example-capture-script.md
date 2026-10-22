---
trdd-id: T7FELEN5
title: RD-08 Example capture script
column: backburner
status: tasked
created: 2026-10-07T18:37:37+0200
updated: 2026-10-07T18:40:31+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:37+0200
---

# RD-08 Example capture script

## Goal
A script that runs each README example on a fixture repo and stores sanitized, stamped outputs.

## Plan refs
§13b (rules: examples from a real run on a fixture repo, sanitized; RD-08 row).

## Depends on
Depends on: RD-02 (TRDD-VJTBC6IC)

## Files
Files: to be listed at card start (the plan names: a capture script, a fixture repo).

## Reuse
Reuse: read the code at card start

## Steps
1. Provide a `--profile` flag and retries (derived from done-when).
2. Run each README example on a fixture repo (derived from done-when).
3. Sanitize outputs and stamp them with date, model and profile as illustrative snapshots (derived from done-when).
4. Report any failed example and commit nothing partial (derived from done-when).

## Acceptance
- [ ] `--profile` flag, retries
- [ ] each README example runs on a fixture repo
- [ ] outputs sanitized and stamped (date, model, profile) as illustrative snapshots
- [ ] failed example reported, nothing partial committed
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope
Writing the README sections that use the examples (RD-09, RD-10, RD-11).

## Approval log

- 2026-10-07T18:37:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
