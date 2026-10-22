---
trdd-id: WTAFTRR1
title: BR-14 Password fill by code
column: backburner
status: tasked
created: 2026-10-07T20:01:28+0200
updated: 2026-10-07T20:01:35+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:28+0200
---

# BR-14 Password fill by code

## Goal

Fill a password field without Jev, the typing model or any log ever seeing it.

## Approval log

- 2026-10-07T20:01:28+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

- §16 Example 3 (BR-14), §10 Credentials, D23.
- Browse safety refusals copied from §10 and the BR rows:
  - password filled by code from `--password-file` or `--password-env`; the variable name must start with `LLM_EXT_PASSWORD_` (renamed from jev-browser's `JEV_PASSWORD_*`); checked against `--password-origin`; POSIX only.
  - seed cookies from `--cookie-file` or `--cookie-env` (variable name starts with `LLM_EXT_COOKIE_`), mutually exclusive.
  - handoff file read once and deleted (D23), documented in `--help` and the browse skill.
  - credentials are refused together with recording; refused with debug env `PWDEBUG`, `DEBUG`, `DEBUG_FILE`.
  - screenshot suppressed after any credential use.
  - host guard `--allow-private` refuses private and localhost targets (BR-05).
  - E90: private/localhost target, or redirect into one → refused without `--allow-private`
  - E94: password typed → never logged; masked in recordings
  - E98: credentials file readable by others → refused
  - E99: credentials on Windows → refused with message
  - E105: credentials or recording with `PWDEBUG`/`DEBUG`/`DEBUG_FILE` set → refused
  - E106: password origin differs from the page origin → refused
  - E107: `--cookie-file` and `--cookie-env` together → refused

## Depends on

BR-09 (TRDD-E2RBNJGG)

## Files

`src/browser/credentials.ts`, `src/browser/credentials.test.ts`, vitest include entry (paths under `scripts/llm-ext/`).

## Reuse

L2-15 redaction (the password is registered as a redaction value), `sanitizeInputPath` (`src/scan-pipeline.ts:193`) for the file path.

## Steps

1. Read the credentials section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit. List every refusal.
2. Sources: `--password-file` (refused on Windows; refused if group or others can read it) or `--password-env` (name must start with `LLM_EXT_PASSWORD_`).
3. `--password-origin` must equal the page's `URL.origin` exactly at fill time, checked again after any redirect.
4. A handoff file is read once and then removed (deleted), as the source does.
5. Once the password is used, the screenshot is suppressed for the rest of the run.

## Acceptance

- [ ] E98: credentials file readable by others → refused
- [ ] E99: credentials on Windows → refused with message
- [ ] E106: password origin differs from the page origin → refused
- [ ] the password string appears in no stdout, stderr, `-o` report or log (searched by the test)
- [ ] the handoff file is gone after the run
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Debug-env and recording refusals (BR-24), the real-browser case (BR-20).
