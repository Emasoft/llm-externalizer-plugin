---
trdd-id: 4HRFC42S
title: Tests can overwrite the real settings.yaml when vitest runs outside scripts/llm-ext
column: testing
status: tasked
created: 2026-11-14T20:12:42+0100
updated: 2026-11-14T20:40:23+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T20:12:42+0100
implementation-commits: [1616fb78]
---

# Tests can overwrite the real settings.yaml when vitest runs outside scripts/llm-ext

## Approval log

- 2026-11-14T20:12:42+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T20:40:23+0100 — column → testing by main-agent@llm-externalizer-plugin. landed 1616fb78, full suite at pre-push

## Problem

2026-11-14T20:13+0100 On 2026-11-11 05:44-06:28 a vitest run resolved getConfigDir() (config.ts:858, LLM_EXT_CONFIG_DIR or ~/.llm-externalizer) to the real ~/.llm-externalizer; fixtures of mass_scouting/cli.test.ts:171-183, scout-gate.test.ts and the parallel-repair family overwrote settings.yaml (backups settings-before-14.1-scouting-marker-20261111_060318 and settings-before-regenerate-free-20261111_0628* match those fixtures), and test lines landed in the real model-events.log. local_llama, locals-mlx, or-jev and paid were lost; the add-once migration then never re-added the local profiles (state marks them applied). Product writers preserve unknown profiles (all document-level via writeSettingsAtomic, benchmark/pick.ts:312-334). INFERRED cause of the missing isolation: test-hermetic-config.ts is a setupFiles entry of scripts/llm-ext/vitest.config.ts, loaded only when vitest runs with that config (cwd scripts/llm-ext). Evidence: reports_dev/settings-rewrite/20261114_201216+0100-root-cause.md. The local profiles were restored by hand 2026-11-14 20:05 (TRDD-EB1XGLMJ).

## Fix

getConfigDir() throws when process.env.VITEST is set and the resolved dir is the real ~/.llm-externalizer (realpath compare), fail fast; one guard covers every test, every spawned CLI child (they inherit VITEST) and every writer, independent of cwd. An explicit opt-in env exists only if a test that legitimately needs the real dir is found.
2026-11-14T20:40:22+0100 Landed 1616fb78: assertNotRealConfigDirUnderTest in config.ts, called by getConfigDir; 3 unit tests pass. data-dir.mjs not guarded (native-deps path only). Full suite owed at the pre-push run.
