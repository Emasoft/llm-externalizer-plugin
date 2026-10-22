---
trdd-id: 58CFBQHN
title: Subcommand help lists --estimate and --preview
column: todo
status: tasked
created: 2026-10-07T17:26:14+0200
updated: 2026-10-07T17:26:25+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:14+0200
release-via: publish
target-release: 14.1.0
---

# Subcommand help lists --estimate and --preview

## Issue item
Issue 16 item 5: --estimate is not in the subcommand help.

## Trace and status
OPEN. llm-ext scan folder --help and llm-ext llm ask --help print no line containing estimate (nor --preview); llm-ext --help has none either (only scout estimate). The flags are stripped in cli/launcher.ts:206-218 and handled in cli/main.ts:696-779 but never rendered in help.

## Acceptance
- [ ] both help screens list --estimate and --preview with one sentence each
- [ ] a test that every LLM-sending tool's help contains both

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:14+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
