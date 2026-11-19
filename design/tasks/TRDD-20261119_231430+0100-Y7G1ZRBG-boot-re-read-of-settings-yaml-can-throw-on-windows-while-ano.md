---
trdd-id: Y7G1ZRBG
title: Boot re-read of settings yaml can throw on Windows while another process renames it
column: todo
status: tasked
created: 2026-11-19T23:14:30+0100
updated: 2026-11-19T23:14:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T23:14:30+0100
---

# Boot re-read of settings yaml can throw on Windows while another process renames it

335e384e (TRDD-VBAJX5A1) makes loadSettingsAfterMigrations throw when the re-read of settings.yaml after the boot migrations returns null. On Windows a read that lands while another llm-ext process renames its temp file over settings.yaml (writeSettingsAtomic) may fail, and that would now fail the boot with settingsError instead of returning the stale copy. Not reproduced; the risk comes from code reading. Task: find what loadSettings returns on such a failure on Windows (null or a throw), and if a transient sharing error is possible, retry the re-read briefly before throwing.

## Approval log

- 2026-11-19T23:14:30+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] a Windows CI test runs concurrent settings writers against boot re-reads with no spurious settingsError, or the card records why no such failure is possible
