---
trdd-id: GG44R65K
title: Check whether a non-map profile entry fails the settings load on its own
column: todo
status: tasked
created: 2026-11-19T23:14:49+0100
updated: 2026-11-19T23:14:53+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T23:14:49+0100
---

# Check whether a non-map profile entry fails the settings load on its own

The PT-02 profile-type step (benchmark/pick.ts migrateSettingsTo141) leaves settings.yaml untouched when a profile is not a map (problem 'profiles.X is not a map'). The TRDD-VBAJX5A1 window (b) decision assumes the blocking profile fails the load on its own; that was checked only for an invalid explicit profile-type (E81d/E113), not for a non-map profile, and profileTypesSettingsErrors skips non-object profiles. Task: load a settings.yaml with a non-map profile on an already-migrated record and see what the load reports; if it does not name the non-map profile, make it.

## Approval log

- 2026-11-19T23:14:49+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] a test loads a settings.yaml with a non-map profile after the migration was recorded and asserts an error naming that profile
