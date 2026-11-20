---
trdd-id: 8DMLEAW8
title: Settings diagnostic commands exit 0 or list the default profiles after a failed settings load
column: dev
status: tasked
created: 2026-11-20T02:41:13+0100
updated: 2026-11-20T02:45:06+0100
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
---

# Settings diagnostic commands exit 0 or list the default profiles after a failed settings load

## Approval log

- 2026-11-20T02:41:13+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

[2026-11-20T02:41:51+0100] Evidence (probe of the built CLI with settings.yaml made a directory, TRDD-LFWV2DKG worker, reports_dev/lfwv2dkg/20261120_022212+0100-cli-failed-settings.md): settings show and settings status exit 1 with a diagnostic; settings profiles and settings profile exit 0 while printing "Failed to read/parse ... Check YAML syntax." (config.ts formatProfilesList and formatActiveProfileSummary return the failure as text only). After a failed load activeSettings holds the in-memory defaults, so `settings profile --show <name>` can resolve a default profile and discover's NOT CONFIGURED branch (src/tools/discover.ts ~line 28) lists the default profile names as "Available profiles". The boot can fail while the file is readable again (ensureSettingsExist throws on a read error since 32865985), so a check on the formatter's own re-read is not enough.

## Decision

[2026-11-20T02:41:51+0100] main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): after a failed settings load the four gate-exempt tools (discover, get_settings, list_profiles, profile) must run (no gate refusal line) and print their diagnostic, and all four must exit non-zero; no error text behind a success code.

## Plan

[2026-11-20T02:41:51+0100] formatters return {text, isError}; index.ts get_settings, list_profiles and profile return isError with settingsError when settingsLoadFailed; discover omits Available profiles after a failed load; tests: src/cli/failed-settings-cli.test.ts (built CLI) and one in-process test where the boot fails and the file is readable afterwards. Implemented by the TRDD-LFWV2DKG worker.

## Acceptance

- [ ] all four exempt verbs exit non-zero after a failed load, built CLI test green
- [ ] no exempt verb prints the in-memory default profiles after a failed load, in-process test green

## Notes

[2026-11-20T02:45:04+0100] Check of the I6KUI1X6 Notes correction (index.ts:3234): git show 32865985:scripts/llm-ext/src/index.ts then grep -n for the guard line returns 3234 at that commit. The working tree file has it at line 3271 now, so the line moved after that commit. The line was supplied by the coordinator; this check confirms it. I6KUI1X6 is archived and cannot take this note.
