---
trdd-id: VBAJX5A1
title: Concurrent boots on a restored untyped settings yaml can fail the load once with E81g
column: todo
status: tasked
created: 2026-11-19T20:56:57+0100
updated: 2026-11-19T20:59:48+0100
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

## Proposed fix (not implemented)

In index.ts, also re-read settings when the loaded copy has profileTypesMigrated true and some profile lacks profile-type. For (b), decide whether an uninferable profile on an already-migrated file should load with a type error for that profile only instead of failing the whole load.

## Done when

A test drives the boot logic with an applied record, an untyped loaded copy and an already-typed file on disk, and the command loads without E81g. Window (b) has a recorded decision and a test.

## Approval log

- 2026-11-19T20:56:57+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
