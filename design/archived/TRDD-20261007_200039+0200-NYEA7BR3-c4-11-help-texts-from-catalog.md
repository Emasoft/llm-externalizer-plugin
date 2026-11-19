---
trdd-id: NYEA7BR3
title: C4-11 Help texts from catalog
column: published
status: archived
created: 2026-10-07T20:00:39+0200
updated: 2026-11-19T10:39:34+0100
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:39+0200
release-via: publish
---

# C4-11 Help texts from catalog

## Goal

Generate command help from the catalog specs so the defaults shown match the spec.

## Approval log

- 2026-10-07T20:00:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T10:39:34+0100 — column → complete by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit
- 2026-11-19T10:39:34+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit.

## Plan refs

§4 (command flags/defaults text: catalog spec; `definitions.ts` entries checked against it by test), DOC-04 (`commands.md`, flags checked by DOC-13).

## Depends on

C4-02 (TRDD-V8Q20MLW)

## Files

To be listed at card start.

## Reuse

Read the code at card start.

## Steps

1. Build help text from spec thresholds, ranges and flags, never retyped (derived from §4).
2. Add a test comparing each help default with the spec default (derived from done-when).

## Acceptance

- [x] defaults shown match spec
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Entry registration (C4-02), `commands.md` (DOC-04).

## Notes

Evidence (verifier VA): tools/definitions.ts:53-63 classifyTools() builds each entry from spec thresholds; definitions-classify.test.ts:51-56 compares each to its spec (22 pass).
DoD by main agent checks on 2026-11-19 at HEAD 55269f3b: the cited test files are in the explicit vitest include list (grep) and contain no vi.mock, vi.spyOn, vi.fn or vi.stubGlobal (grep); npx tsc --noEmit and npx eslint . --quiet exit 0; full npm test inferred from the v14.7.5 release (commit f0766476 is the one scripts/publish.py makes at :1262 only after run_checks at :942 passes, and run_checks runs npm test at :403; no run log read, not rerun), and the cited source is unchanged between v14.7.5 and HEAD (git diff --stat empty); the per-card commit item cannot be met after the 14.3.0 squash c4dc6bd5, and WHY comments were spot-checked in estimate-output.ts only (a 2026-11-05 WHY-comment pass covered the runner and input code, its open items are in TRDD-HZMA4EXK); by main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer) the box is ticked with these two items accepted as stated, and the closing card commit names the id.
