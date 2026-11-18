---
trdd-id: BYHR8EGG
title: llm-ext settings show overwrites an existing settings_edit.yaml copy without keeping it
column: blocked
status: tasked
created: 2026-11-18T01:47:17+0100
updated: 2026-11-18T02:02:23+0100
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
blocked-by: [TYSKX72I]
pre-block-column: todo
blocker-probe: test -f design/tasks/TRDD-20261117_224108+0100-TYSKX72I-split-scripts-llm-ext-src-index-ts-so-the-ubs-taint-analysis.md
blocker-holds-if: exit-0
---

# llm-ext settings show overwrites an existing settings_edit.yaml copy without keeping it

## Approval log

- 2026-11-18T01:47:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Description

Measured 2026-11-18: get_settings in scripts/llm-ext/src/index.ts (about line 6315) writes settings_edit.yaml with writeFileSync every time `settings show` runs, so an existing copy is replaced with no backup, although its code comment presents the copy as made 'for manual editing'. Incident: a worker ran `settings show` with a temporary config dir and the default output dir, and replaced the owner's reports_dev/llm-externalizer/settings_edit.yaml (written 2026-11-16 09:24) at 2026-11-18 01:29; the main agent rewrote it from the real settings.yaml, so any unapplied edits in the old copy are lost. Fix: when the copy exists and its bytes differ from what is about to be written, rename it to settings_edit.<YYYYMMDD_HHMMSS±HHMM>.yaml first and print both paths. Done when a test shows a differing copy is kept and an identical one is rewritten, and tsc and eslint are clean. Blocked because every index.ts commit is blocked by the ubs taint work limit (TRDD-TYSKX72I).

## Blocker probe

Run blocker-probe with the working directory set to the directory that holds design/ (builds_dev/dev-after-14.3.0 in the llm-externalizer checkout), not the repo root: from the repo root it exits 1 and the block reads as released. No trddgrep verb runs blocker-probe, and trddgrep validate says it never executes one.
