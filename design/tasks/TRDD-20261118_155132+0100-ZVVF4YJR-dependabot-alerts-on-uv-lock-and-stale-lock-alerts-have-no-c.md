---
trdd-id: ZVVF4YJR
title: Dependabot alerts on uv.lock and stale lock alerts have no card
column: backburner
status: tasked
created: 2026-11-18T15:51:32+0100
updated: 2026-11-18T15:51:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:32+0100
---

# Dependabot alerts on uv.lock and stale lock alerts have no card

On 2026-11-18 41 Dependabot alerts were open (triage b2): scripts/llm-ext/package-lock.json 16, mcp-server/package-lock.json 9, uv.lock 15 (3 critical, 3 high). The main locks already carry fixes for several (npm: zod 4.6.7, vite 8.3.8, postcss 8.5.33, source-map-js 1.2.2, brace-expansion 5.0.13; uv.lock: certifi 2026.10.23, sentence-transformers 5.7.0, transformers 5.23.0, filelock 4.2.10, fsspec 2026.9.0), so a Dependabot rescan lag is inferred, not shown. Do: re-read the alerts with gh api repos/Emasoft/llm-externalizer-plugin/dependabot/alerts; dismiss with a reason those whose lock is already fixed or whose directory is gone (mcp-server alerts 136 and 137; vite alert 118 is fixed, vite 8.3.8 is at or above 8.3.3); card or fix the Python medium and low alerts in uv.lock. Dismissing alerts is outward-facing on an Emasoft-owned repo. Parent: TRDD-EH91LD5F.

## Approval log

- 2026-11-18T15:51:32+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
