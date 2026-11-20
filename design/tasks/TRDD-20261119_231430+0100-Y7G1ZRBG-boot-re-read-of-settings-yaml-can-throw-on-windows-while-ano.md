---
trdd-id: Y7G1ZRBG
title: Boot re-read of settings yaml can throw on Windows while another process renames it
column: todo
status: tasked
created: 2026-11-19T23:14:30+0100
updated: 2026-11-20T02:35:16+0100
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
implementation-commits: [32865985]
---

# Boot re-read of settings yaml can throw on Windows while another process renames it

335e384e (TRDD-VBAJX5A1) makes loadSettingsAfterMigrations throw when the re-read of settings.yaml after the boot migrations returns null. On Windows a read that lands while another llm-ext process renames its temp file over settings.yaml (writeSettingsAtomic) may fail, and that would now fail the boot with settingsError instead of returning the stale copy. Not reproduced; the risk comes from code reading. Task: find what loadSettings returns on such a failure on Windows (null or a throw), and if a transient sharing error is possible, retry the re-read briefly before throwing.

## Approval log

- 2026-11-19T23:14:30+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] a Windows CI test runs concurrent settings writers against boot re-reads with no spurious settingsError, or the card records why no such failure is possible

## Notes

[2026-11-20T02:29:05+0100] Read-retry change, commit 32865985 (lines at 32865985). Before 32865985, loadSettings returned null on any read error (it caught everything). A Windows sharing error during another process's rename would fail the boot, and ensureSettingsExist took that null for a corrupt file and regenerated settings.yaml.
32865985 adds readSettingsFileRetrying in config.ts (config.ts:1216). It retries only EPERM, EBUSY and EACCES, waits 10, 20, 40, 60 and 70 ms (200 ms in total), and is on by default only on win32. It drops the existsSync pre-check in loadSettings, and ensureSettingsExist (config.ts:2638) regenerates only on a parse failure.
Tests: src/settings-read-retry.test.ts, 15 tests, with injected errors.
Checks run (reported by the dispatching agent, not re-run for this note): tsc 0, eslint 0, build 0; single files: settings-read-retry 15/15, config 227/227, boot-settings 4/4, boot-failed-settings 4/4, boot-default-settings-writers 3/3, profile-type-migration 45/45, boot-reload-validity 11/11.
Not proven: real Windows sharing timing and error codes; whether 200 ms is enough; whether the rename window can surface as ENOENT.
The acceptance box stays unticked and the card stays in its column until a Windows CI run is green.
[2026-11-20T02:35:12+0100] Verification, added after review: the config.ts diff of 32865985 (parent 32865985^ to 32865985) was read in full. loadSettings lost its existsSync pre-check (parent config.ts:1199, the line that returned null when the file was absent) and now reads through readSettingsFileRetrying, returning null only for ENOENT. ensureSettingsExist now tests settingsTextIsCorrupt(readSettingsFileRetrying(...)) where it used to test !loadSettings(). The parent loadSettings had a catch-all that returned null on any error, so the statement that it caught everything is confirmed. The retry delays (10, 20, 40, 60, 70 ms), the codes (EPERM, EBUSY, EACCES) and the win32-only default are in the diff. Test counts and checks are reported, not re-run here.
