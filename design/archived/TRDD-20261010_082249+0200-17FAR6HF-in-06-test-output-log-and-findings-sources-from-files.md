---
trdd-id: 17FAR6HF
title: IN-06 test-output (log) and findings (sources) from files
column: published
status: archived
created: 2026-10-10T08:22:49+0200
updated: 2026-11-19T10:39:36+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:22:49+0200
release-via: publish
---

# IN-06 test-output (log) and findings (sources) from files

## Goal

test-output reads its `log` from one file or `-`, and findings reads each distinct `findings[].file` whole into `sources`, so both take files instead of JSON only. Needs a small `cli.document` variant (one named file or `-` into a string field) in `spec.ts`.

## Plan refs

Plan 741-742 (L2-06 dependencies), findings.ts comment "The caller reads the files".

## Depends on

- IN-01 (TRDD-XHHH0N1E), which provides the shared file input modes.
- Open question Q3 (see Notes).

## Acceptance

- [x] named binary/secret/empty/directory refused
- [x] `-` works
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

- Waits on the design note's open question Q3: Do `test-output` (`log`), `findings` (`sources`), `screen` (`text`), `extract` (`document`), `compare` (two passages), `audit`/`verify`/`decide` get any file/stdin flag, or stay JSON only? Plan line 273 says "every command" but lists no mapping; this note proposes JSON only except test-output and findings via IN-06.
Main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): open question Q3 does not block this card: its acceptance covers test-output and findings only; whether screen, extract, compare, audit, verify and decide get file input is not decided here.
Evidence (verifier VA): input-args-document.test.ts test-output block (missing, directory, secret, binary, empty, stdin) 18 pass; input-args.test.ts 69 pass.
DoD by main agent checks on 2026-11-19 at HEAD 55269f3b: the cited test files are in the explicit vitest include list (grep) and contain no vi.mock, vi.spyOn, vi.fn or vi.stubGlobal (grep); npx tsc --noEmit and npx eslint . --quiet exit 0; full npm test inferred from the v14.7.5 release (commit f0766476 is the one scripts/publish.py makes at :1262 only after run_checks at :942 passes, and run_checks runs npm test at :403; no run log read, not rerun), and the cited source is unchanged between v14.7.5 and HEAD (git diff --stat empty); the per-card commit item cannot be met after the 14.3.0 squash c4dc6bd5, and WHY comments were spot-checked in estimate-output.ts only (a 2026-11-05 WHY-comment pass covered the runner and input code, its open items are in TRDD-HZMA4EXK); by main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer) the box is ticked with these two items accepted as stated, and the closing card commit names the id.

## Approval log

- 2026-10-10T08:22:49+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T10:39:36+0100 — column → complete by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit
- 2026-11-19T10:39:36+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit.
