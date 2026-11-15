---
trdd-id: FUHTNE04
title: Wire the hq scan quality benchmark so high_quality_scan gets verdicts
column: todo
status: tasked
created: 2026-11-15T00:24:58+0100
updated: 2026-11-15T00:24:58+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T00:24:58+0100
parent-trdd: SZ7TO9FW
---

# Wire the hq scan quality benchmark so high_quality_scan gets verdicts

runHqScanQualityBenchmark is exported in scripts/llm-ext/src/benchmark/hq-scan-quality.ts but has no caller and no benchmark CLI flag, so every model reads untested for high_quality_scan and its resolution chain stays empty (found by the free-pool benchmark worker 2026-11-15). Add a benchmark CLI flag that runs it and writes hq-scan-quality-results.json, with the same free-only cost guard as the other tools.

## Approval log

- 2026-11-15T00:24:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
