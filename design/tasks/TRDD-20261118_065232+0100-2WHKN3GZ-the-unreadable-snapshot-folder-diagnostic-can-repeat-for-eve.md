---
trdd-id: 2WHKN3GZ
title: The unreadable snapshot folder diagnostic can repeat for every failed file
column: backburner
status: tasked
created: 2026-11-18T06:52:32+0100
updated: 2026-11-18T06:52:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T06:52:32+0100
---

# The unreadable snapshot folder diagnostic can repeat for every failed file

Derived from TRDD-4W3Q2B4S, commit e1f1fb47. llamaModelOnDisk writes one stderr line when a snapshot folder cannot be listed. By reading the code, not run: the give-up window is armed once per dispatch (http.ts:332) and tryLocalFallback runs once per failed dispatch with no latch while no model is ready, so up to 2 identical lines per failed file in a multi-file command. Option: write the line once per process for each model and folder. Measure the real count first.

## Approval log

- 2026-11-18T06:52:32+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
