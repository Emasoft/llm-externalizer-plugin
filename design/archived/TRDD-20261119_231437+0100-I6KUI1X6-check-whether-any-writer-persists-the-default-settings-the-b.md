---
trdd-id: I6KUI1X6
title: Check whether any writer persists the default settings the boot catch returns
column: complete
status: archived
created: 2026-11-19T23:14:37+0100
updated: 2026-11-20T02:42:17+0100
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
implementation-commits: [5b16ee5b]
---

# Check whether any writer persists the default settings the boot catch returns

When the boot IIFE in index.ts catches an error it sets settingsError and returns generateDefaultSettings() as activeSettings; 335e384e adds a new throw on that path (re-read null). index.ts reaches settings.yaml through three writers found by a name grep: ensureSettingsExist (creates the file only when missing), writeSettingsCopy (a copy to a target dir) and writeDynamicProfileSection in overrideActiveProfile (index.ts:1097, adds an absent section to the file read under the write lock). Other modules (dynamic maintainer, profile detector, pick.ts writers, settings commands) were not swept. Task: sweep every settings.yaml writer reachable after a boot with settingsError set, and show that none writes the in-memory defaults over the user file; fix any that does.

## Approval log

- 2026-11-19T23:14:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T02:42:17+0100 — COMPLETE by main-agent@llm-externalizer-plugin. writer sweep complete; test 5b16ee5b.

## Acceptance

- [x] the sweep lists each writer with file:line and why it cannot persist the defaults, and any writer that could is fixed with a test

## Notes

[2026-11-20T02:23:55+0100] Writer sweep re-checked at commit 32865985. Lines are at 32865985; paths are relative to scripts/llm-ext/src. Source: reports_dev/i6kui1x6/20261120_015755+0100-default-settings-writers.md. Conclusion unchanged: no writer persists the in-memory defaults.
Row 1, config.ts:2638 ensureSettingsExist: writes at config.ts:2656 (file missing) and config.ts:2678 (file read and does not parse, after a byte backup at config.ts:2670). It runs before the boot catch (index.ts:542), and the in-memory defaults that the catch returns (index.ts:548) never reach it. A read error throws at config.ts:2663 before any write.
Row 1 change in 32865985 (TRDD-Y7G1ZRBG): ensureSettingsExist now regenerates only when the file was read and does not parse; a read error propagates and the file stays untouched.
Row 2, benchmark/pick.ts:314 writeSettingsAtomic (the only settings.yaml primitive): 18 call sites at pick.ts:385, :413, :491, :564, :627, :684, :1273, :1311, :1560, :1733, :1808, :1934, :2039, :2085, :2138, :2212, :2261, :2383. Each handle comes from a fresh disk read (loadSettingsRoot pick.ts:251, loadSettingsAllowingNoProfiles pick.ts:2308), never from activeSettings.
Row 3, benchmark/pick.ts:1114 writeDynamicProfileSection (settings write lock): the callback receives the section read under the lock. Callers: index.ts:1115 (only writer call in index.ts; guarded by index.ts:1088; its callback at index.ts:1122 keeps an existing section and creates only an absent one), dynamic-maintainer.ts:239 and :575, benchmark/index.ts:1671, :1902, :2154, benchmark/scout-accuracy.ts:200, benchmark/pick.ts:1577 and :1721.
Row 4, index.ts:893 repairInvalidActiveGeneratedProfile, then dynamic-maintainer.ts:209 regenerateInvalidMarkedSection, then writeDynamicProfileSection at dynamic-maintainer.ts:239. This is the one path fed an in-memory profile (current = activeSettings.profiles[effective], index.ts:906). The guard at index.ts:896 returns before any write when settingsLoadFailed is set, so the defaults never reach the writer after a failed load.
Row 5, dynamic-maintainer.ts:822 maintainDynamicProfiles: settings come from loadSettings() at dynamic-maintainer.ts:833, and it returns false on null (:834); it never reads activeSettings. Its regenerate call at dynamic-maintainer.ts:422 (inside maintainOneDynamicProfile at :336, called at :911 with that settings value) therefore takes the disk copy.
Row 6, benchmark/pick.ts writers: dropKeysOutsideClosedSet :377, applyPicksToSettings :390, applyToolModelToSettings :454, applyFreePoolToSettings :537, applyEnsembleSlotToSettings :601, addProfileToSettings :666, writeDynamicUserKeys :1292, migrateProfileSections :1462, migrateSettingsTo141 :1656. Each reaches writeSettingsAtomic (row 2 call sites) with a disk handle. benchmark/update-all.ts:602 and :773 pass opts.settingsPath to applyPicksToSettings and applyToolModelToSettings. In the boot, migrations run only after ensureSettingsExist succeeded (index.ts:542, :543, both inside the try).
Row 7, tools/settings-copy.ts:20 writeSettingsCopy (called at index.ts:5593): writes only settings_edit.yaml in the target directory (tools/settings-copy.ts:21 and :30), never settings.yaml.
Other write calls, none of them settings.yaml: calibration/fingerprint.ts:56-57; calibration/record.ts:385; calibration/runner.ts:201 and :390-391; calibration/state.ts:45-46, :69, :99 and :187-188; calibration/test-gguf.ts:33; governor/state.ts:283-284; default-profiles-runner.ts:429; model-reconcile.ts:296-297; profile-detector.ts:126-127; benchmark/update-all.ts:1031 (report file); classifiers/run-decision.ts:235 (classifier output file).
Evidence level, rows 2 and 6: Rows 2 and 6 rest on grep, not on re-reading each of the 18 call sites. Check run by the main agent on 2026-11-20: index.ts calls pick.ts writers only at index.ts:3252 (applyFreePoolToSettings) and :5484 (addProfileToSettings), both passing getSettingsPath(), a path, so the writer reloads from disk via loadSettingsRoot (pick.ts:251, writeSettingsAtomic pick.ts:314). Of the other modules that reference activeSettings (tools/*, check-imports/handler.ts, session_summary/handler.ts), the only write call is tools/or-model-info-json.ts:130, a JSON output file, not settings.yaml.
Test commit 5b16ee5b (src/boot-default-settings-writers.test.ts, 3 tests): mutating the index.ts settingsLoadFailed guard in repairInvalidActiveGeneratedProfile (index.ts:896) made tests 1 and 2 fail; test 3 is the control. The mutation run is recorded in the sweep report, not repeated here.
[2026-11-20T02:32:57+0100] Correction to the row 3 phrase above: 'only writer call in index.ts' means the only writeDynamicProfileSection call in index.ts. index.ts also calls applyFreePoolToSettings at index.ts:3252 and addProfileToSettings at index.ts:5484 (pick.ts writers, row 6) and writeSettingsCopy at index.ts:5593 (row 7). Qualifier on the Other write calls line: its line numbers and write calls were checked by grep at 32865985; the target file of each write was not re-read (sweep report).
[2026-11-20T02:35:12+0100] Verification scope, added after review. Rows 2 and 6: the handle source of each of the 18 writeSettingsAtomic call sites was checked at 32865985. Direct loadSettingsRoot at pick.ts:379, 675, 1121, 1298, 1525, 1731, 1795, 1894, 2008, 2081, 2129 and 2210 (12 sites). loadProfileForMutation at pick.ts:282, which calls loadSettingsRoot, for pick.ts:413, 491, 564 and 627 (applyPicksToSettings, applyToolModelToSettings, applyFreePoolToSettings, applyEnsembleSlotToSettings). loadAllowingNoProfiles at pick.ts:2253, wrapping loadSettingsAllowingNoProfiles at pick.ts:2308, for pick.ts:2261. Direct loadSettingsAllowingNoProfiles for pick.ts:2383. pick.ts has no activeSettings reference at 32865985. The enclosing functions were read at the handle and call lines, not in full.
[2026-11-20T02:35:12+0100] Conclusion scope, added after review: rows 1 to 5 and row 7 were re-read at 32865985 for the functions and guards they cite (ensureSettingsExist in full, the config.ts diff of 32865985 in full, index.ts 893 to 925 and 1084 to 1124, dynamic-maintainer.ts 209 to 245, 336 to 425 and 822 to 842, tools/settings-copy.ts in full). The other-writes row is grep only: its line numbers and write calls were checked by grep, and its target files were not re-read.
[2026-11-20T02:36:53+0100] Acceptance box unticked after review. The move to complete was refused by trddgrep (no --approver), so the card is still in todo and its box stays open until the move runs. Re-tick with check-box I6KUI1X6 1 when the move succeeds. The other-writes row (update-all.ts, run-decision.ts, calibration, governor and the other write calls listed above) is grep-level evidence: line numbers and write calls were checked by grep, and each write target and its handle were not traced.
[2026-11-20T02:41:51+0100] Main agent read index.ts:3195-3256 and cli/main.ts:895-930 on 2026-11-20. index.ts:3252 applyFreePoolToSettings is reached only from applyFreePool, which returns false before any write when activeResolved is null (index.ts:3236 `if (!s || !activeResolved) return false`), and activeResolved is null after a failed load (6f1089eb). index.ts:5484 addProfileToSettings writes one new profile built from a discovered service; the in-memory defaults supply only the existing names for the collision check. The CLI gate (cli/main.ts:902-918) refuses every non-exempt, non-classify tool after a failed load.
[2026-11-20T02:42:12+0100] Correction to the note above: the guard line is index.ts:3234, not index.ts:3236 (grep -n confirmed `if (!s || !activeResolved) return false` at index.ts:3234).
[2026-11-20T02:42:12+0100] Evidence level: index.ts callers and the CLI gate read by the main agent; the 18 pick.ts writeSettingsAtomic call sites and the other-writes row rest on grep.
