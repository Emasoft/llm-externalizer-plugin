---
trdd-id: LFWV2DKG
title: CLI test that discover, get_settings, list_profiles and profile run after a failed settings load
column: todo
status: tasked
created: 2026-11-20T02:00:33+0100
updated: 2026-11-20T02:01:20+0100
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
---

# CLI test that discover, get_settings, list_profiles and profile run after a failed settings load

## Approval log

- 2026-11-20T02:00:33+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

FBWXV4JF (6f1089eb, archived) refuses work commands after a settings load that throws. Its note says discover, get_settings, list_profiles and profile still run without --profile; that rests on reading shouldFailProfileSelection (config.ts:1916-1922, CLI_TOOLS_WITHOUT_RESOLVED_PROFILE) plus two unit tests (boot-failed-settings.test.ts: overrideActiveProfile returns ok:false; cli/active-precedence.test.ts: the gate exempts those tools). No test runs the CLI end to end with a broken settings.yaml; the archived FBWXV4JF note reads as if its test covered it.

## Acceptance

- [ ] a test runs the built CLI with settings.yaml made a directory and asserts discover (or get_settings) exits 0 and a work command exits non-zero naming 'Failed to load settings'
