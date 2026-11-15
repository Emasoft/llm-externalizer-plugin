---
trdd-id: K4FJ9H6Y
title: scout run help names llm-ext benchmark scout-accuracy which is not a command
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

# scout run help names llm-ext benchmark scout-accuracy which is not a command

## Issue
llm-ext scout run --help tells the user to run llm-ext benchmark scout-accuracy, which is not a command.

## Evidence
On the built CLI and on the installed 14.2.0, the PROFILE text of scout run --help names llm-ext benchmark scout-accuracy; running llm-ext benchmark exits with unknown command benchmark. A separate llm-ext-benchmark binary exists. Report: reports_dev/58cfbqhn/20261113_235141+0100-refusals.md.

## Acceptance
- [ ] the help names a command that exists, with a test
- [ ] first determine whether llm-ext-benchmark scout-accuracy exists and is the intended command (the measurement saw only that a separate llm-ext-benchmark binary exists), then decide: point the help at it, or add the subcommand

## Approval log

- 2026-11-13T23:53:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
