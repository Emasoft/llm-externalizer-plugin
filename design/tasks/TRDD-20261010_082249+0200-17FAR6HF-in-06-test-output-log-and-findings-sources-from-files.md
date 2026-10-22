---
trdd-id: 17FAR6HF
title: IN-06 test-output (log) and findings (sources) from files
column: backburner
status: tasked
created: 2026-10-10T08:22:49+0200
updated: 2026-10-10T08:22:49+0200
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

- [ ] named binary/secret/empty/directory refused
- [ ] `-` works
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

- Waits on the design note's open question Q3: Do `test-output` (`log`), `findings` (`sources`), `screen` (`text`), `extract` (`document`), `compare` (two passages), `audit`/`verify`/`decide` get any file/stdin flag, or stay JSON only? Plan line 273 says "every command" but lists no mapping; this note proposes JSON only except test-output and findings via IN-06.

## Approval log

- 2026-10-10T08:22:49+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
