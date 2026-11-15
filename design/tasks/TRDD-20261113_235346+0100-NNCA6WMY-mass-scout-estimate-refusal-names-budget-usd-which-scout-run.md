---
trdd-id: NNCA6WMY
title: mass_scout estimate refusal names --budget-usd which scout run does not take
column: backburner
status: tasked
created: 2026-11-13T23:53:46+0100
updated: 2026-11-13T23:56:43+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T23:53:46+0100
---

# mass_scout estimate refusal names --budget-usd which scout run does not take

## Issue
The mass_scout --estimate refusal tells the user to run the scout with --budget-usd, which scout run does not take.

## Evidence
The mass_scout --estimate refusal says to run the scout with --budget-usd, but scout run --help lists no budget flag (scout estimate takes --budget_usd). Report: reports_dev/58cfbqhn/20261113_235141+0100-refusals.md.
The shared --preview refusal text (no input_files_paths or folder_path given) is tracked on TRDD-51JRJ3M6.

## Acceptance
- [ ] the refusal names the real alternative (for example scout estimate with --budget_usd) or says the command has no dry run, with a test

## Approval log

- 2026-11-13T23:53:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
