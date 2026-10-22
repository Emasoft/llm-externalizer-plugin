---
trdd-id: AC9MBN8D
title: BR-19 Secret masking in browse
column: backburner
status: tasked
created: 2026-10-07T20:01:44+0200
updated: 2026-10-07T20:01:50+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:44+0200
---

# BR-19 Secret masking in browse

## Goal

Make sure a typed password is never logged and is masked in recordings.

## Approval log

- 2026-10-07T20:01:44+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

- E94, §10 Credentials, L2-15 redaction (cyclic, deep, Map and class-instance values, E54).
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

BR-09 (TRDD-E2RBNJGG), L2-15 (TRDD-LHBW770C)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

L2-15 redaction (`l2/redact.ts`); read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Register the password as a redaction value so every log, report and step record passes through L2-15.
3. Mask the password in recordings (E94).

## Acceptance

- [ ] E94: password typed → never logged; masked in recordings
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The password fill (BR-14), debug-env refusals (BR-24).
