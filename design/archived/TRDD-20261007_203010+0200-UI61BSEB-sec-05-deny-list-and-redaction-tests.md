---
trdd-id: UI61BSEB
title: SEC-05 Deny list and redaction tests
column: published
status: archived
created: 2026-10-07T20:30:10+0200
updated: 2026-11-19T10:39:39+0100
current-owner: user
created-by: user
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:30:10+0200
release-via: publish
---

# SEC-05 Deny list and redaction tests

## Goal
Test the secret deny list and redaction.

## Approval log

- 2026-10-07T20:30:10+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T10:39:39+0100 — column → complete by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit
- 2026-11-19T10:39:39+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit.

## Plan refs

§2b (secret deny list from claude-jev and quicksilver), §16 (SEC table; npt L2-07). The plan gives no done-when.

## Depends on

L2-07 (TRDD-6NYXR3FE)

## Files

- To be listed at card start.

## Reuse

Read the code at card start (L2-07; L2-15 redaction).

## Steps

1. Test that files on the deny list are never sent (derived from title).
2. Test that registered values are redacted from output (derived from title).

## Acceptance

- [x] deny-listed files are refused and registered values are redacted (derived from title; the plan gives no done-when)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Deny list and redaction implementation (L2-07, L2-15).

## Notes

Evidence (verifier VB): l2/inputs.test.ts:64-66,:106-113,:182-189; l2/redact.test.ts:8-17; l2/content-redact.test.ts:46-50; inputs 41, redact 22, content-redact 28 pass at 55269f3b.
DoD by main agent checks on 2026-11-19 at HEAD 55269f3b: the cited test files are in the explicit vitest include list (grep) and contain no vi.mock, vi.spyOn, vi.fn or vi.stubGlobal (grep); npx tsc --noEmit and npx eslint . --quiet exit 0; full npm test inferred from the v14.7.5 release (commit f0766476 is the one scripts/publish.py makes at :1262 only after run_checks at :942 passes, and run_checks runs npm test at :403; no run log read, not rerun), and the cited source is unchanged between v14.7.5 and HEAD (git diff --stat empty); the per-card commit item cannot be met after the 14.3.0 squash c4dc6bd5, and WHY comments were spot-checked in estimate-output.ts only (a 2026-11-05 WHY-comment pass covered the runner and input code, its open items are in TRDD-HZMA4EXK); by main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer) the box is ticked with these two items accepted as stated, and the closing card commit names the id.
