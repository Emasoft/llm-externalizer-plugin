---
trdd-id: 1FJAUVBU
title: Path traversal error names the allowed roots
column: published
status: archived
created: 2026-10-07T17:26:15+0200
updated: 2026-11-18T08:12:09+0100
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
implementation-commits: [a30f4d22, 9ce1b79d]
---

# Path traversal error names the allowed roots

## Issue item
Issue 16 smaller note: the path traversal error names no allow-list option.

## Trace and status
OPEN (message only). sanitizeInputPath (scan-pipeline.ts:190-232) allows only cwd, HOME and /tmp; the message today is Path traversal blocked: /etc resolves outside allowed directories. A user-configurable root list would be a separate USER decision.
2026-10-31 closing note: implemented in commit a30f4d22. Closed by main-agent under the USER grant to complete all cards autonomously.

## Acceptance
- [x] the message lists the three allowed roots and says to run from a parent directory or copy the files
- [x] a test asserts the three roots appear in the message

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:15+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T03:53:59+0100 — column → complete by main-agent@llm-externalizer-plugin.
- 2026-10-31T03:57:59+0100 — column → testing by main-agent@llm-externalizer-plugin.
- 2026-10-31T03:57:59+0100 — column → complete by main-agent@llm-externalizer-plugin. archive after closing boxes
- 2026-10-31T03:59:43+0100 — column → testing by main-agent@llm-externalizer-plugin.
- 2026-10-31T03:59:43+0100 — column → complete by main-agent@llm-externalizer-plugin.
- 2026-11-18T08:12:00+0100 — column → publish by main-agent@llm-externalizer-plugin. implementation lines present in the v14.7.0 tree (content check 2026-11-18; the SHAs are pre-squash, so not tag ancestors)
- 2026-11-18T08:12:09+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped: implementation lines present in the v14.7.0 tree (content check 2026-11-18; the SHAs are pre-squash, so not tag ancestors).
