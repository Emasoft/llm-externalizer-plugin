---
trdd-id: I6KUI1X6
title: Check whether any writer persists the default settings the boot catch returns
column: todo
status: tasked
created: 2026-11-19T23:14:37+0100
updated: 2026-11-19T23:14:39+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T23:14:37+0100
---

# Check whether any writer persists the default settings the boot catch returns

When the boot IIFE in index.ts catches an error it sets settingsError and returns generateDefaultSettings() as activeSettings; 335e384e adds a new throw on that path (re-read null). index.ts reaches settings.yaml through three writers found by a name grep: ensureSettingsExist (creates the file only when missing), writeSettingsCopy (a copy to a target dir) and writeDynamicProfileSection in overrideActiveProfile (index.ts:1097, adds an absent section to the file read under the write lock). Other modules (dynamic maintainer, profile detector, pick.ts writers, settings commands) were not swept. Task: sweep every settings.yaml writer reachable after a boot with settingsError set, and show that none writes the in-memory defaults over the user file; fix any that does.

## Approval log

- 2026-11-19T23:14:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] the sweep lists each writer with file:line and why it cannot persist the defaults, and any writer that could is fixed with a test
