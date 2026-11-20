---
trdd-id: 8DMLEAW8
title: Settings diagnostic commands exit 0 or list the default profiles after a failed settings load
column: complete
status: archived
created: 2026-11-20T02:41:13+0100
updated: 2026-11-20T03:41:36+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T02:41:13+0100
implementation-commits: [89d7c5d8, 63ea0b0d]
---

# Settings diagnostic commands exit 0 or list the default profiles after a failed settings load

## Approval log

- 2026-11-20T02:41:13+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T03:41:36+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column dev).

## Problem

[2026-11-20T02:41:51+0100] Evidence (probe of the built CLI with settings.yaml made a directory, TRDD-LFWV2DKG worker, reports_dev/lfwv2dkg/20261120_022212+0100-cli-failed-settings.md): settings show and settings status exit 1 with a diagnostic; settings profiles and settings profile exit 0 while printing "Failed to read/parse ... Check YAML syntax." (config.ts formatProfilesList and formatActiveProfileSummary return the failure as text only). After a failed load activeSettings holds the in-memory defaults, so `settings profile --show <name>` can resolve a default profile and discover's NOT CONFIGURED branch (src/tools/discover.ts ~line 28) lists the default profile names as "Available profiles". The boot can fail while the file is readable again (ensureSettingsExist throws on a read error since 32865985), so a check on the formatter's own re-read is not enough.

## Decision

[2026-11-20T02:41:51+0100] main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): after a failed settings load the four gate-exempt tools (discover, get_settings, list_profiles, profile) must run (no gate refusal line) and print their diagnostic, and all four must exit non-zero; no error text behind a success code.
[2026-11-20T03:00:53+0100] main agent ruling, widening the one above (delegated by USER 2026-11-18, 'solve all issues yourself. i need results.'; not an owner answer): the same rule (no error text behind a success code) also covers the text-only failure branches of the two formatters on a loaded file: formatActiveProfileSummary 'Effective profile not found' and 'Failed to resolve effective profile', and formatProfilesList 'No profiles defined' (empty profiles map). These now return isError true, so settings show (dangling active: or an unresolvable profile) and settings profiles (empty map) exit non-zero. A missing settings.yaml stays exit 0 (it is created on the first command). Checked before ruling: active-precedence.test.ts asserts only that these tools resolve without throwing on a dangling active:, never exit 0; settings status (discover) already returns isError on a dangling active:.
[2026-11-20T03:00:57+0100] get_settings keeps its settings.yaml copy (to the scratch dir) when the effective profile is missing or unresolvable, and still returns isError true: the copy is what the user needs to fix the file. Only a failed boot load (settingsLoadFailed) returns before the copy; a file that cannot be read makes the copy fail and the existing catch returns isError.

## Plan

[2026-11-20T02:41:51+0100] formatters return {text, isError}; index.ts get_settings, list_profiles and profile return isError with settingsError when settingsLoadFailed; discover omits Available profiles after a failed load; tests: src/cli/failed-settings-cli.test.ts (built CLI) and one in-process test where the boot fails and the file is readable afterwards. Implemented by the TRDD-LFWV2DKG worker.

## Acceptance

- [x] all four exempt verbs exit non-zero after a failed load, built CLI test green
- [x] no exempt verb prints the in-memory default profiles after a failed load, in-process test green

## Notes
2026-11-20T03:41:36+0100 main agent (via card worker): closing. Commits 89d7c5d8 (formatters return {text, isError}) and 63ea0b0d (index.ts get_settings, list_profiles and profile return isError after a failed load; discover omits Available profiles). Evidence: src/boot-failed-settings-exempt-tools.test.ts, src/cli/failed-settings-cli.test.ts and the get_settings case in src/cli/active-precedence.test.ts all passed alone 2026-11-20 03:24-03:26; tsc exit 0, eslint exit 0. The fix needed two commits because of the ubs taint limit (TRDD-5SGTYL11).


