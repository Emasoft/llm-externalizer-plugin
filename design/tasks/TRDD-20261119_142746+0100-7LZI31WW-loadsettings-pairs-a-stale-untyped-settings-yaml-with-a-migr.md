---
trdd-id: 7LZI31WW
title: loadSettings pairs a stale untyped settings yaml with a migrated record under concurrent boots
column: dev
status: tasked
created: 2026-11-19T14:27:46+0100
updated: 2026-11-19T14:39:42+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T14:27:46+0100
---

# loadSettings pairs a stale untyped settings yaml with a migrated record under concurrent boots

## Problem

The 14.7.6 publish gate (attempt 2, 2026-11-19) failed in src/background-singleton.test.ts, case SG2 "N concurrent CLI commands (separate processes) on one EMPTY dynamic profile", at the assertion on line 302. One of 4 CLI processes printed the settings error "Profile free: free_only requires a non-empty free_models list ...; Profile free has no profile-type" instead of "no model of the free profile is working right now". The file passed in the earlier full gate the same day and 5 of 5 solo runs.

## Mechanism (read from the code, not reproduced)

- loadSettings (config.ts) reads and parses settings.yaml first, then calls isMigrationStepApplied(PROFILE_TYPE_STEP) while building the result.
- The 14.1.0 step profile-type-written (benchmark/pick.ts) writes the typed file atomically and only then records the step.
- At boot, index.ts returns the first loaded settings without a re-read when no migration step applied in this process.
- So process B can read the untyped file, process A can write the typed file and record the step, and B then reads the record as applied: B keeps an untyped copy with profileTypesMigrated true, E81g fires, and the settings-level error also cancels the unpopulated-default exemption.

## Fix

loadSettings reads the migration record BEFORE the file. Record not applied: E81g stays off whatever the file holds. Record applied: the writer renamed the typed file before recording, so the later file read sees it. A restored untyped backup is re-stamped by the migration, which marks a step applied, so index.ts re-reads.

## Verification

tsc, eslint, src/background-singleton.test.ts alone, and the config test files that cover loadSettings. No deterministic regression test: interleaving two processes between two file reads cannot be set up without mocks. The full suite runs at the 14.7.6 publish gate.

Diagnosis report (gitignored): reports_dev/diagnosis/20261119_142208+0100-bgsingleton-gate.md. Goal card: TRDD-FC2TX9VU.
2026-11-19T14:39:31+0100 main agent: SG2 passed 5 of 5 alone both before and after the change, so the test passing shows no regression and does not prove the fix. The fix rests on the write order (benchmark/pick.ts writeSettingsAtomic, then recordApplied at line 2215). Residual, not fixed here: an untyped restored or synced file with an applied record until the next migration pass re-stamps it. Checks: tsc 0, eslint 0, 31 single test files exit 0.

## Approval log

- 2026-11-19T14:27:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
