---
trdd-id: 7J5GP4QZ
title: snapshotWeightFiles in calibration fingerprint follows directory symlinks through readdirSync recursive
column: backburner
status: tasked
created: 2026-11-18T06:52:24+0100
updated: 2026-11-18T06:52:24+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T06:52:24+0100
---

# snapshotWeightFiles in calibration fingerprint follows directory symlinks through readdirSync recursive

Derived from TRDD-4W3Q2B4S. scripts/llm-ext/src/calibration/fingerprint.ts line 77 (snapshotWeightFiles) lists a snapshot with readdirSync and the recursive option. In a Node v26.12.1 probe during TRDD-4W3Q2B4S that option followed a directory symlink back to a parent about 40 levels deep, to the OS limit, so a snapshot holding such a link makes the walk huge. Fix: a hand walk that enters only real directories, as snapshotRelativePaths in network-give-up.ts does since commit 9f9e8c9a. Found by reading and by the probe; not observed in a real snapshot.

## Approval log

- 2026-11-18T06:52:24+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
