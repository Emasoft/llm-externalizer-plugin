---
trdd-id: VBAJX5A1
title: Concurrent boots on a restored untyped settings yaml can fail the load once with E81g
column: complete
status: tasked
created: 2026-11-19T20:56:57+0100
updated: 2026-11-19T22:42:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T20:56:57+0100
release-via: publish
implementation-commits: [335e384e, 3a7ac8b3]
---

# Concurrent boots on a restored untyped settings yaml can fail the load once with E81g

## Problem

TRDD-7LZI31WW (shipped in 14.7.6) fixed the read order in loadSettings. A single process booting on a restored or synced untyped settings.yaml while the migration record says applied is healed on the first boot: the profile-type step (PT-02) re-stamps the file, pushes the step, and index.ts re-reads before validation. Remaining windows:

- (a) Two processes boot together on such a file. B loads the untyped file, A re-stamps it under the write lock, B PT-02 then finds nothing missing and pushes nothing, so index.ts returns the stale untyped loaded copy of B and validation fails the command once with E81g. Expected to clear once no other boot is racing; not reproduced.
- (b) A profile whose type cannot be inferred on a restored file. PT-02 leaves the file untouched, but the record already says applied, so E81g fails every load until the user fixes the file by hand. The comment in benchmark/pick.ts says E81g should never switch on for an uninferable profile, so this is a possible defect; open question.
- (c) The same stale loaded copy reaches validation when the backup or the locked write throws (the catch only notifies) or when the YAML does not parse (early return).
2026-11-19T20:59:46+0100 main agent: windows (a), (b) and (c) come from code reading only and were not reproduced. The sentence 'Expected to clear once no other boot is racing' in window (a) is an untested assumption, not a verified fact.

## Mechanism

- benchmark/pick.ts:2167 WHY comment: the profile-type step is not gated on the record, so a restored or synced untyped file is re-stamped.
- benchmark/pick.ts:2171: if (doc.errors.length > 0) return result; (early return, nothing pushed).
- benchmark/pick.ts:2197-2200: un-inferable types go to problems, then notify "left settings.yaml untouched"; no write, nothing pushed.
- benchmark/pick.ts:2202-2208: when missing.length > 0, backup and locked write.
- benchmark/pick.ts:2215-2216: if (firstRun) recordApplied(...); else if (missing.length > 0) result.applied.push(PROFILE_TYPE_STEP).
- benchmark/pick.ts:2218-2221: any throw goes to the catch that only notifies.
- index.ts:542 loaded = ensureSettingsExist(); 563 migrateSettingsTo141; 568 return loaded when migration.alreadyDone and migration141.applied.length is 0; 572 otherwise return loadSettings() or loaded.
- E81g comes from profileTypesSettingsErrors (config.ts:1754), called only by settingsLevelErrors (config.ts:3987) and validateSettings (config.ts:4041); index.ts evaluateSettingsValidity (519) calls both on the settings it is given. loadSettings itself does not call them.
- index.ts:618 calls evaluateSettingsValidity(activeSettings), where activeSettings is the boot result (the stale loaded copy in the race); on !verdict.valid (index.ts:619-622) it sets settingsError, prints it to stderr and returns null, so the command reports the settings error.

## Proposed fix (superseded: the fix in 335e384e always re-reads, see Notes)

In index.ts, also re-read settings when the loaded copy has profileTypesMigrated true and some profile lacks profile-type. For (b), decide whether an uninferable profile on an already-migrated file should load with a type error for that profile only instead of failing the whole load.

## Done when

A test drives the boot logic with an applied record, an untyped loaded copy and an already-typed file on disk, and the command loads without E81g. Window (b) has a recorded decision and a test.

## Approval log

- 2026-11-19T20:56:57+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T22:42:34+0100 — column → complete by main-agent@llm-externalizer-plugin. fixed in 335e384e, window (b) decided with no code change, comment corrected in 3a7ac8b3; ships in the next release

## Notes

2026-11-19T22:41:21+0100 main agent: fixed in 335e384e. The boot migrations and the re-read moved from the index.ts boot IIFE to scripts/llm-ext/src/boot-settings.ts (loadSettingsAfterMigrations), which always re-reads settings.yaml after the migrations (no early return when nothing was recorded) and throws when the re-read is null; the boot catch in index.ts turns the throw into settingsError. Window (a): fixed. boot-settings.test.ts case 1 drives loadSettingsAfterMigrations (the function the boot IIFE calls, not the CLI) with an applied record, an untyped loaded copy and a file another process typed, and the result has no E81g (has no profile-type); case 2 does the same for the scouting marker. Limit: both cases would also pass against any plain re-read; they pin the outcome, not the mechanism. Window (c): the stale copy no longer reaches validation. When the backup or the locked write throws, the re-read returns the file as it is on disk and E81g fails the load after the step's own notice, which is the real state; a file that stopped parsing makes the boot throw (case 4). Window (b), main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): no code change. The step leaves the file untouched when inferProfileType throws, which it does for an invalid explicit profile-type (profileTypeErrors, E81d/E113), and also when a profile is not a map (whether that alone fails the load was not checked). The invalid type fails the load on its own whatever E81g does, and the step's notice tells the user to fix it by hand; after the fix the next boot stamps the remaining profiles, because the step is not gated on the record. Tests: profile-type-migration.test.ts 'an invalid explicit type after the step was recorded still leaves the file untouched and reports' (the window) and 'restoring the step's own backup: the next run re-stamps it' (the re-stamp of a recorded file). The pick.ts comment that said E81g never switches on for such a profile held only on a first run; corrected in 3a7ac8b3. Checked by a grep of index.ts for writer names (writeFileSync, renameSync, writeSettingsAtomic, withSettingsWriteLock, loadSettingsRoot, writeDynamicProfileSection, writeSettingsCopy, ensureSettingsExist): it reaches settings.yaml through three writers, none of which writes activeSettings: ensureSettingsExist (creates settings.yaml only when it is missing), writeSettingsCopy (a copy to a target dir) and the writeDynamicProfileSection call in overrideActiveProfile (index.ts:1097), which adds an absent dynamic-profile section to the file read under the write lock; the writeFileSync and renameSync at index.ts:2160-2161 write response reports. Helpers in other modules were not checked for a writer of the default settings the boot catch returns. Known risk, not handled: on Windows a read inside another process atomic rename can fail; it now throws at boot instead of returning the stale copy.

## Acceptance

- [x] a test drives the boot logic with an applied record, an untyped loaded copy and an already-typed file on disk, and the result has no E81g (boot-settings.test.ts in 335e384e; it drives loadSettingsAfterMigrations, not the CLI)
- [x] window (b) has a recorded decision (Notes 2026-11-19T22:41:21+0100) and a test (profile-type-migration.test.ts, 'an invalid explicit type after the step was recorded still leaves the file untouched and reports')
