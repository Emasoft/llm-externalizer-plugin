---
trdd-id: 1FJAUVBU
title: Path traversal error names the allowed roots
column: todo
status: tasked
created: 2026-10-07T17:26:15+0200
updated: 2026-10-07T17:26:25+0200
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:15+0200
release-via: publish
target-release: 14.1.0
---

# Path traversal error names the allowed roots

## Issue item
Issue 16 smaller note: the path traversal error names no allow-list option.

## Trace and status
OPEN (message only). sanitizeInputPath (scan-pipeline.ts:190-232) allows only cwd, HOME and /tmp; the message today is Path traversal blocked: /etc resolves outside allowed directories. A user-configurable root list would be a separate USER decision.

## Acceptance
- [ ] the message lists the three allowed roots and says to run from a parent directory or copy the files
- [ ] a test asserts the three roots appear in the message

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:15+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
