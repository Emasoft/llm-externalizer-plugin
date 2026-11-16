---
trdd-id: VCEX28LN
title: Scope the test temp-dir leak guard to its own vitest run
column: todo
status: tasked
created: 2026-11-16T11:59:45+0100
updated: 2026-11-16T11:59:45+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T11:59:45+0100
---

# Scope the test temp-dir leak guard to its own vitest run

src/test-tmpdir-guard.ts:35-45 snapshots the whole machine /tmp and tmpdir() and fails on ANY new entry matching /llm[-_]?ext/i. A concurrent vitest run on the same host (another worktree, an agent, a publish stage) therefore trips it with that run's in-flight temp dirs. Evidence 2026-11-16: the 14.3.1 publish dry run failed with 19 entries created 11:26-11:27, inside a concurrent worker run of index.test.ts (start 11:24:50, 90 s); the leak-probe run 11:32:46-11:33:57 failed the same way while a worker run of index.test.ts ran 11:32:50-11:34:00; a guard-only observer run reproduced the 19-entry shape deterministically next to a live index.test.ts run (reports_dev/leak-fix/20261116_115619+0100-report.md). Fix (proposal): the guard sets a per-run id in the environment (for example LLM_EXT_TEST_RUN_ID) in globalSetup; every test temp prefix (test-helpers.ts:234, 246, 372, index.test.ts:468, and the mkdtemp tracker) embeds it; teardown flags only entries carrying this run id, plus entries with no run id that were created by this process tree. Detection of a real own leak must not weaken: add a negative-control test that leaks on purpose and must fail. Until then: never run two vitest processes on one host while the publish gate runs.

## Approval log

- 2026-11-16T11:59:45+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
