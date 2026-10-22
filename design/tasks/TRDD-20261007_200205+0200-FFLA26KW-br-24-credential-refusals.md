---
trdd-id: FFLA26KW
title: BR-24 Credential refusals
column: backburner
status: tasked
created: 2026-10-07T20:02:05+0200
updated: 2026-10-07T20:02:12+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:02:05+0200
---

# BR-24 Credential refusals

## Goal

Refuse unsafe combinations of credentials with debug env, recording and screenshots.

## Approval log

- 2026-10-07T20:02:05+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

- §10 Credentials, E105, §16 Example 3 out-of-scope note.
- Browse safety refusals copied from §10 and the BR rows:
  - password filled by code from `--password-file` or `--password-env`; the variable name must start with `LLM_EXT_PASSWORD_`; checked against `--password-origin`; POSIX only.
  - seed cookies from `--cookie-file` or `--cookie-env` (variable name starts with `LLM_EXT_COOKIE_`), mutually exclusive.
  - handoff file consumed and deleted (D23).
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

BR-14 (TRDD-WTAFTRR1), BR-23 (TRDD-MGNQNSCW), BR-15 (TRDD-KDV69JW8)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Refuse credentials (password or cookies) together with recording.
3. Refuse credentials or recording when `PWDEBUG`, `DEBUG` or `DEBUG_FILE` is set.
4. Suppress the screenshot after any credential use.

## Acceptance

- [ ] debug env, recording, screenshot suppression
- [ ] E105: credentials or recording with `PWDEBUG`/`DEBUG`/`DEBUG_FILE` set → refused
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Password fill (BR-14), cookie seeding (BR-23), recording itself (BR-15).
