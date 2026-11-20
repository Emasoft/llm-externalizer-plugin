---
trdd-id: LFWV2DKG
title: CLI test that discover, get_settings, list_profiles and profile run after a failed settings load
column: complete
status: archived
created: 2026-11-20T02:00:33+0100
updated: 2026-11-20T03:42:01+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T02:00:33+0100
implementation-commits: [89d7c5d8, 63ea0b0d]
---

# CLI test that discover, get_settings, list_profiles and profile run after a failed settings load

## Approval log

- 2026-11-20T02:00:33+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T03:42:01+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column todo).

## Problem

FBWXV4JF (6f1089eb, archived) refuses work commands after a settings load that throws. Its note says discover, get_settings, list_profiles and profile still run without --profile; that rests on reading shouldFailProfileSelection (config.ts:1916-1922, CLI_TOOLS_WITHOUT_RESOLVED_PROFILE) plus two unit tests (boot-failed-settings.test.ts: overrideActiveProfile returns ok:false; cli/active-precedence.test.ts: the gate exempts those tools). No test runs the CLI end to end with a broken settings.yaml; the archived FBWXV4JF note reads as if its test covered it.

## Acceptance

- [x] a test runs the built CLI with settings.yaml made a directory and asserts the four gate-exempt verbs (settings show, status, profiles, profile) run without a gate refusal, print their diagnostic and exit non-zero, and a work command exits non-zero naming 'Failed to load settings'
- [x] a test asserts the formatter failure branches (unparseable file, empty profiles map, effective profile not found) return isError true
- [x] a test asserts a missing settings.yaml still returns the plain 'No settings file found' note
- [x] a test asserts get_settings on a dangling active: keeps its settings.yaml copy and returns isError true

## Notes

[2026-11-20T02:41:51+0100] the card's premise "discover (or get_settings) exits 0" was wrong for show and status (both exit 1 with a diagnostic) and hid a bug for profiles and profile (exit 0 with an error text); the ruling and the fix are in TRDD-8DMLEAW8; this card keeps the built-CLI test.
2026-11-20T03:41:59+0100 main agent (via card worker): closing. Acceptance rewritten to the rulings recorded on TRDD-8DMLEAW8 (Decision). Evidence: commits 89d7c5d8 and 63ea0b0d; src/cli/failed-settings-cli.test.ts (built CLI, four exempt verbs plus a work command), src/boot-failed-settings-exempt-tools.test.ts (formatter failure branches, exempt tools stay errors after a failed boot), src/settings-group.test.ts (missing settings.yaml note; it asserts the note text, not isError false), get_settings case in src/cli/active-precedence.test.ts; all passed alone 2026-11-20 03:24-03:26, tsc 0, eslint 0.
