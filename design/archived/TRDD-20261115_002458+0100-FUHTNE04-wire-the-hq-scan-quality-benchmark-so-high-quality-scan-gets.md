---
trdd-id: FUHTNE04
title: Wire the hq scan quality benchmark so high_quality_scan gets verdicts
column: complete
status: archived
created: 2026-11-15T00:24:58+0100
updated: 2026-11-16T09:44:43+0100
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
2026-11-16T09:44:31+0100 — closing evidence (main agent): benchmark/cli-args.ts:369 parses --hq-scan-quality; benchmark/index.ts:2413-2456 runHqScanQualityPhase calls runHqScanQualityBenchmark with the cost guards; hq-scan-quality.ts:271 records the verdict in the ledger; all in v14.3.0 (card triage reports_dev/card-triage/20261116_094135+0100-todo-design-cards.md).
- 2026-11-16T09:44:43+0100 — COMPLETE by main-agent@llm-externalizer-plugin. wired in 14.3.0: flag, phase, ledger write.

## Acceptance

- [x] llm-ext-benchmark has a --hq-scan-quality flag that runs runHqScanQualityBenchmark (benchmark/cli-args.ts:369, benchmark/index.ts:2413-2456)
- [x] the run records its verdict in the fitness ledger (hq-scan-quality.ts:271)
