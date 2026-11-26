---
trdd-id: UPBYUMMW
title: Bump esbuild, torch and setuptools for the three Dependabot alerts still real on dev
column: testing
status: tasked
created: 2026-11-26T20:38:43+0100
updated: 2026-11-26T20:43:42+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-26T20:38:43+0100
implementation-commits: [9f7d898a, 26affe4a]
---

# Bump esbuild, torch and setuptools for the three Dependabot alerts still real on dev

Open Dependabot alerts (2026-11-26, against main v14.7.8): 33. Checked against the dev lock files (reports_dev/backlog-triage/20261126-dep-versions.md): only three are still vulnerable on dev - npm esbuild 0.27.4 (fixed 0.28.1, direct devDependency of scripts/llm-ext, also pulled by vite), uv setuptools 81.0.0 (fixed 84.1.0, via torch) and uv torch 2.12.0 (fixed 2.13.0, via sentence-transformers, extra embeddings). The other 30 are already fixed on dev or point at mcp-server/, which no longer exists; they clear when dev is released. Done when: npm ls shows no esbuild below 0.28.1, uv.lock pins setuptools >= 84.1.0 and torch >= 2.13.0, build, tsc and the esbuild-using tests pass, the better-sqlite3 binding still loads.

## Approval log

- 2026-11-26T20:38:43+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-26T20:43:41+0100 Done on dev/after-14.3.0: 9f7d898a (esbuild 0.28.2, torch 2.15.0, setuptools 84.2.1) and 26affe4a (dist rebuilt). Checked: binding loads, build, tsc and the regex-worker, parallel-repair and pick-lock tests pass. The GitHub alerts close only when the release reaches main.
