---
trdd-id: SAZPW4V2
title: C4-09 -o and --strict-exit wiring
column: backburner
status: tasked
created: 2026-10-07T20:00:34+0200
updated: 2026-10-07T20:00:36+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:34+0200
---

# C4-09 -o and --strict-exit wiring

## Goal

Wire `-o <dir>` and `--strict-exit` into the runner.

## Approval log

- 2026-10-07T20:00:34+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

D10 (`-o <dir>` saves the same JSON as stdout as a `.json` report, not the `.md` saveResponse format), §9 (per-command attention predicates drive `--strict-exit`), E52 (owned by L2-16).

## Depends on

C4-01 (TRDD-BUL4EEBP), L2-16 (TRDD-FFWAXZRN)

## Files

To be listed at card start.

## Reuse

`defaultOutputDir` (plan §3 L2); L2-16 report writer. Otherwise read the code at card start.

## Steps

1. Wire `-o` to the L2-16 report writer: same JSON as stdout, saved as a `.json` file (D10).
2. Wire `--strict-exit` to each spec's attention predicate (derived from §9).

## Acceptance

- [ ] `-o` saves the same JSON as stdout as a `.json` report
- [ ] `--strict-exit` exits non-zero when the spec's attention predicate holds
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The report writer itself (L2-16).
