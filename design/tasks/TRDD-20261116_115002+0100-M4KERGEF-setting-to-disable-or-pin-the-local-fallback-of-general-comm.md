---
trdd-id: M4KERGEF
title: Setting to disable or pin the local fallback of general commands
column: testing
status: tasked
created: 2026-11-16T11:50:02+0100
updated: 2026-11-16T15:46:17+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T11:50:02+0100
parent-trdd: UT7UC025
derived: true
implementation-commits: [5c1ca371, 73ebd59c]
---

# Setting to disable or pin the local fallback of general commands

Sibling of TRDD-WSPV40Y5, both EHTs of TRDD-UT7UC025 (WSPV40Y5 card section 3, agent decision B). Add one validated setting: enabled (default true) and profile (pin one local profile or none). Location: a new top-level section, NOT under local_fallback (that section holds the mlx-decision decider settings whose survival TRDD-O93LFMF3 leaves open; if it is kept, reconcile both in the same commit). Validate like localFallbackErrors in config.ts: unknown key is an error, fail fast. The setting must gate readyLocalTarget, so that a disabled fallback also leaves the 1b network give-up window (TRDD-PN0N4290) unarmed. Docs: models-and-settings.md and README settings table. Tests: disabled gives the original error with no local send and no armed window; a pinned profile is the only one tried. WHY split out of 1d (agent decision 2026-11-16): the key name and location are an agent proposal not derived from any ruling, it adds a settings.yaml key with validation and docs, and one TRDD is one atomic task. Release gate: commits 42c67aa3 and 1e5ca0d7 do not ship until this card and the end-to-end local-answer test land.

## Approval log

- 2026-11-16T11:50:02+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-16T15:06:12+0100 main agent: implemented as 5c1ca371 (section name fallback_to_local, gate in readyLocalTarget). Main-agent run: local-fallback-setting, local-fallback-dispatch, settings-keep-or-jev gave 75 passed. Open: full suite (before the next push), a completed UBS scan (the pre-commit scan hit 180 s again), the migrateSettingsTo141 local-profile branches are not exercised by the round-trip test, and the interactive pick.ts handlers that call writeSettingsAtomic are covered only by reading the code.
- 2026-11-16T15:46:16+0100 main agent: review finding F8 fixed in 73ebd59c: a fallback_to_local.profile pin naming a locals-local profile is now a settings error where Locals cannot run (only macOS on Apple silicon), also with enabled: false, because readyLocalTarget skipped it there and the fallback silently never ran. Consequence open to USER veto: on such a machine every command stops at load until the pin is fixed (a warning instead would be the alternative).
