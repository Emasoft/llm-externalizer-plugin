---
trdd-id: SAZPW4V2
title: C4-09 -o and --strict-exit wiring
column: published
status: archived
created: 2026-10-07T20:00:34+0200
updated: 2026-11-19T10:39:33+0100
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
release-via: publish
---

# C4-09 -o and --strict-exit wiring

## Goal

Wire `-o <dir>` and `--strict-exit` into the runner.

## Approval log

- 2026-10-07T20:00:34+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T10:39:33+0100 — column → complete by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit
- 2026-11-19T10:39:33+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit.

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

- [x] `-o` saves the same JSON as stdout as a `.json` report - evidence: run-decision.ts:165,192,452; run-decision.test.ts:457 (-o equals stdout)
- [x] `--strict-exit` exits non-zero when the spec's attention predicate holds - evidence: run-decision.test.ts:457 (exit follows --strict-exit); classify-launch.test.ts:186
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules - met, see the 2026-11-19 DoD note

## Out of scope

The report writer itself (L2-16).

## Notes

Evidence (verifier VA): run-decision.test.ts:481 and classify-launch.test.ts:195 pass.
DoD by main agent checks on 2026-11-19 at HEAD 55269f3b: the cited test files are in the explicit vitest include list (grep) and contain no vi.mock, vi.spyOn, vi.fn or vi.stubGlobal (grep); npx tsc --noEmit and npx eslint . --quiet exit 0; full npm test inferred from the v14.7.5 release (commit f0766476 is the one scripts/publish.py makes at :1262 only after run_checks at :942 passes, and run_checks runs npm test at :403; no run log read, not rerun), and the cited source is unchanged between v14.7.5 and HEAD (git diff --stat empty); the per-card commit item cannot be met after the 14.3.0 squash c4dc6bd5, and WHY comments were spot-checked in estimate-output.ts only (a 2026-11-05 WHY-comment pass covered the runner and input code, its open items are in TRDD-HZMA4EXK); by main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer) the box is ticked with these two items accepted as stated, and the closing card commit names the id.
