---
trdd-id: BYHR8EGG
title: llm-ext settings show overwrites an existing settings_edit.yaml copy without keeping it
column: complete
status: archived
created: 2026-11-18T01:47:17+0100
updated: 2026-11-18T16:31:44+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T01:47:17+0100
blocked-by: []
pre-block-column: 
blocker-probe: trddgrep show TYSKX72I --porcelain
blocker-holds-if: not-match:\t(complete|completed|published|live)\t
unblock-when: []
---

# llm-ext settings show overwrites an existing settings_edit.yaml copy without keeping it

## Approval log

- 2026-11-18T01:47:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T15:44:56+0100 — column → dev by main-agent@llm-externalizer-plugin. blocker TYSKX72I complete; fix in progress (tools/settings-copy.ts) Cleared blocked-by (all blockers terminal).
- 2026-11-18T16:31:44+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met; reviewed by the main agent under the USER delegation of 2026-11-18.

## Description

Measured 2026-11-18: get_settings in scripts/llm-ext/src/index.ts (about line 6315) writes settings_edit.yaml with writeFileSync every time `settings show` runs, so an existing copy is replaced with no backup, although its code comment presents the copy as made 'for manual editing'. Incident: a worker ran `settings show` with a temporary config dir and the default output dir, and replaced the owner's reports_dev/llm-externalizer/settings_edit.yaml (written 2026-11-16 09:24) at 2026-11-18 01:29; the main agent rewrote it from the real settings.yaml, so any unapplied edits in the old copy are lost. Fix: when the copy exists and its bytes differ from what is about to be written, rename it to settings_edit.<YYYYMMDD_HHMMSS±HHMM>.yaml first and print both paths. Done when a test shows a differing copy is kept and an identical one is rewritten, and tsc and eslint are clean. Blocked because every index.ts commit is blocked by the ubs taint work limit (TRDD-TYSKX72I).

## Blocker probe

Run blocker-probe with the working directory set to the directory that holds design/ (builds_dev/dev-after-14.3.0 in the llm-externalizer checkout), not the repo root: from the repo root it exits 1, which reads as held, so the probe never releases from there. No trddgrep verb runs blocker-probe, and trddgrep validate says it never executes one.

## Acceptance

- [x] when the settings_edit.yaml copy exists and its bytes differ from what is about to be written, rename it to settings_edit.<YYYYMMDD_HHMMSS+HHMM>.yaml first and print both paths: commits 86a1cabd (scripts/llm-ext/src/tools/settings-copy.ts) and bba77643 (settings show calls writeSettingsCopy; index.ts:5596-5600 prints the copy path and Previous differing copy kept as)
- [x] a test shows a differing copy is kept and an identical one is rewritten: scripts/llm-ext/src/tools/settings-copy.test.ts exists (4 it): "keeps a differing copy under a stamped name and writes the new one" and "rewrites an identical copy in place with no stamped file"
- [x] tsc and eslint are clean: no tsc or eslint result for commits 86a1cabd and bba77643 was found this run

## Notes

2026-11-18T16:24:38+0100 main agent check: tsc --noEmit exit 0 and npx eslint . --quiet exit 0 at HEAD ea68ff6a, which contains 86a1cabd and bba77643.
2026-11-18T16:28:17+0100 note writer (batch-2 worker): the tsc and eslint check note above and box 3 were supplied by the main agent in the brief; the writer did not re-run them.
