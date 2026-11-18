---
trdd-id: 6613XO3Q
title: Bump typescript-eslint to 8.73.0 in the lock to clear the minimatch moderate advisories
column: backburner
status: tasked
created: 2026-11-18T15:51:33+0100
updated: 2026-11-18T15:51:33+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:33+0100
---

# Bump typescript-eslint to 8.73.0 in the lock to clear the minimatch moderate advisories

typescript-eslint 8.73.0 exists; its typescript-estree depends on minimatch ^11.0.1 (patched at 11.0.1, GHSA-g3hv-75wg-m249) and 8.73.0 is in range of ^8.57.0 in scripts/llm-ext/package.json, so a lock-only bump clears the typescript-eslint and minimatch moderate advisories (the TRDD-0ETFCKCU note that no in-range fix exists is stale). Constraint: npm ignore-scripts is true on this machine and a node_modules reinstall drops the better-sqlite3 binding, so bump the lock only and install only in a builds_dev worktree. Then run tsc, eslint and npm audit (expect about 6 left: the picomatch cascade and esbuild). Parent: TRDD-0ETFCKCU. Size S.

## Approval log

- 2026-11-18T15:51:33+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
