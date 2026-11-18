---
trdd-id: IO0B25CV
title: The user settings.yaml lost the or-jev classifier profile and active_classifier after 2026-10-29
column: complete
status: archived
created: 2026-11-15T17:35:00+0100
updated: 2026-11-18T16:31:41+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T17:35:00+0100
implementation-commits: [b41cdc26]
---

# The user settings.yaml lost the or-jev classifier profile and active_classifier after 2026-10-29

Reported 2026-11-15 by the apple-docs-mcp Claude session (peer report, not verified here): ~/.llm-externalizer/settings.yaml has no or-jev profile and no active_classifier line, while backups/settings-before-local-profiles-*-20261029_120112+0100.yaml still has both. Without them, classify commands on this machine fail with 'classify rank needs a classifier profile'. Related: TRDD-4HRFC42S (tests could overwrite the real settings.yaml; guard landed 1616fb78), and the 2026-11-14 EB1XGLMJ STATE note that settings.yaml was rewritten on 2026-11-14 around 20:00 and that the local profiles vanished between 10-29 and 11-11. RELEASE BLOCKER for 14.3.0 (the release exists to give sessions the local Jev fallback). To do: (1) find every writer of settings.yaml in scripts/llm-ext/src and the conditions under which it drops a profile or a top-level key it did not generate; (2) fix so a regenerating write never drops a user-owned profile or active_classifier; (3) a test that a regenerate keeps an or-jev classifier profile and active_classifier; (4) restoring the user's own settings.yaml needs the USER's word (outside git, DS6OM3KX 2026-10-07 reading).

## Approval log

- 2026-11-15T17:35:00+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T10:02:20+0100 — column → testing by main-agent@llm-externalizer-plugin. writers covered by a mutation-checked test; restore of the user file waits for the USER
- 2026-11-16T20:16:02+0100 — column → human_review by main-agent@llm-externalizer-plugin. writers covered by a mutation-checked test, shipped; restoring the or-jev profile in the user settings.yaml is the USER's action
- 2026-11-18T16:31:41+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met; reviewed by the main agent under the USER delegation of 2026-11-18.

## Notes

2026-11-15T17:39:27+0100 CHECKED by the main agent (read-only grep of profile-name lines only, no content diff, 2026-11-15). Live ~/.llm-externalizer/settings.yaml (mtime 2026-11-15 17:30, 3218 bytes) has profiles scouting, free, local_llama, locals-mlx; no or-jev, no paid, no active_classifier, no top-level active line. backups/settings.yaml.bak-pre-local-restore-20261114_200442+0100 already lacked or-jev and active_classifier (profiles scouting, free only). Both backups/settings-before-local-profiles-*-20261029_120112+0100.yaml have active free, or-jev, paid and active_classifier or-jev. So the loss happened between 2026-10-29 12:01 and 2026-11-14 20:04, and the classifier profile was already missing before today's 17:30 rewrite (what that rewrite changed is not known). The 17:30 rewrite is unattributed: candidates are two unisolated --version runs by a research worker (its report in reports_dev/sonnet-worker/20261115_173458+0100-classify-local-fallback-howto.md) or another session using llm-ext.
2026-11-16T10:02:18+0100 Items 1-3 by the main agent: (1) settings.yaml writers are writeSettingsAtomic (benchmark/pick.ts) and the two writes in ensureSettingsExist (config.ts); other renameSync/writeFileSync sites write JSON sidecars or reports. (2) No current writer drops or-jev or active_classifier: settings-keep-or-jev.test.ts 19/19 (b41cdc26); with writeSettingsAtomic mutated to delete both, all 14 writer tests fail. So no code fix was needed. The cause of the 10-29 to 11-14 loss is not proven: there is no .corrupt- backup in ~/.llm-externalizer, so the corrupt-file regenerate did not do it; the vitest guard 1616fb78 landed 2026-11-14 20:30, after the window closed (20:04), so a test run writing the real file before the guard is the leading suspect (inferred). (4) Restoring the user settings.yaml waits for the USER.
2026-11-16T10:08:22+0100 CORRECTION by the main agent to the previous note: no writer drops or-jev from a PARSEABLE settings.yaml. An unparseable file is replaced by ensureSettingsExist with the default template, and the user or-jev survives only in the .corrupt- backup (settings-keep-or-jev.test.ts pins this). Item 2 is therefore met for parseable files only; for a corrupt file no profile can be kept, because the YAML cannot be read. The mutation check covered the 14 pick.ts writer tests, not the ensureSettingsExist tests.
2026-11-16T15:14:32+0100 Left open after v14.3.1 (b41cdc26 is in the tag): item 4, restoring the user's own ~/.llm-externalizer/settings.yaml (or-jev profile and active_classifier), is outside git and waits for the USER; the cause of the 10-29 to 11-14 loss is still unproven (leading suspect inferred: test run before guard 1616fb78); a corrupt YAML cannot keep a profile.
2026-11-18T15:52:31+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): Item 4 is moot: the user settings.yaml now lists the or-jev classifier profile and active_classifier or-jev (profile names read only, no key value read; triage B3, reports_dev/card-triage/20261118_151523+0100-b3-review2.md). Who restored it is unknown. The code guard is released in 14.3.1 (b41cdc26). The cause of the 2026-10-29 to 2026-11-14 loss stays unproven (leading suspect, inferred: a test run before guard 1616fb78) and is accepted as a residual; a corrupt YAML cannot keep a profile.

## Acceptance

- [x] (1) find every writer of settings.yaml in scripts/llm-ext/src and the conditions under which it drops a profile or a top-level key: writers are writeSettingsAtomic (scripts/llm-ext/src/benchmark/pick.ts:314, 7 call sites) and ensureSettingsExist (scripts/llm-ext/src/config.ts:2535); inventory per the 2026-11-16T10:02:18 note, function definitions checked this run
- [x] (2) a regenerating write never drops a user-owned profile or active_classifier: met for a parseable file by commit b41cdc26 (no code change was needed, note 2026-11-16T10:02:18 and its 10:08:22 correction); a corrupt YAML cannot keep a profile, accepted residual (main agent ruling 2026-11-18T15:52:31, delegated by USER 2026-11-18; not an owner answer)
- [x] (3) a test that a regenerate keeps an or-jev classifier profile and active_classifier: commit b41cdc26 (test(settings): every settings.yaml writer keeps a user or-jev), file scripts/llm-ext/src/settings-keep-or-jev.test.ts exists with 11 it() blocks (writeDynamicProfileSection, writeDynamicUserKeys, dropKeysOutsideClosedSet, regenerateInvalidMarkedSection, migrateProfileSections, migrateSettingsTo141, valid file byte-identical, corrupt file)
- [x] (4) restoring the user own settings.yaml: moot per main agent ruling 2026-11-18T15:52:31 (delegated by USER 2026-11-18; not an owner answer), the report reports_dev/card-triage/20261118_151523+0100-b3-review2.md exists and names IO0B25CV as DONE with item 4 moot; the user settings.yaml was not read in this run
