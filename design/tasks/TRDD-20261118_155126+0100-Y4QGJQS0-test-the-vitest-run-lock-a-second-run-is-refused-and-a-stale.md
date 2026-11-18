---
trdd-id: Y4QGJQS0
title: Test the vitest run lock, a second run is refused and a stale lock is replaced
column: backburner
status: tasked
created: 2026-11-18T15:51:26+0100
updated: 2026-11-18T15:51:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:26+0100
---

# Test the vitest run lock, a second run is refused and a stale lock is replaced

src/test-tmpdir-guard.ts acquireRunLock (b239d2b4, shipped in v14.4.0, lock file /tmp/vitest-llmx-run.lock) has no test of its own. Cases to pin with real processes, no mocks: (1) a second llm-ext vitest run started while the first holds the lock is refused at once and the message names the holder; (2) a stale lock is replaced: a dead pid, a pid reused by a process started after the lock, and an empty lock older than 10 s. The lock is POSIX-only (/tmp lock file, ps lstart), so it is also relevant to TRDD-61EINA10 (Windows). Parent: TRDD-VCEX28LN (ruling: one llm-ext vitest run per machine). Size S to M.

## Approval log

- 2026-11-18T15:51:26+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
