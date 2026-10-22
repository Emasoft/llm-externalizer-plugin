---
trdd-id: HBCCFOUF
title: fitness benchmarks for mass_scout and high_quality_scan on free models
column: complete
created: 2026-09-16T19:17:37+0200
updated: 2026-10-04T15:19:12+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-16T19:17:37+0200
status: archived
---

# fitness benchmarks for mass_scout and high_quality_scan on free models

Why (user decision): addendum H of the dynamic-profiles design (TRDD-90DM5YHO, P4) says mass_scout and high_quality_scan MAY be set under the dynamic 'free' profile once a real fitness benchmark validates a free model for each — until then the refusal 'no free model is fit for <tool>; use --profile paid' always applies for those two tools under free, and decideDynamicProfile (default-profiles.ts) hard-excludes both tool keys from any free-profile patch/refill (FREE_FORBIDDEN_TOOLS).

What is missing (measured H10, T2 design report section 4): neither a mass-scout throughput benchmark (a sustained request burst sized to the tool's real concurrency, recording rate-limit responses) nor a high_quality_scan quality benchmark (its existing quality bar) exists today anywhere in the benchmark/ tree.

Scope: add the two fitness benchmarks (reusing the existing keyword-sweep/F1 scoring infrastructure benchmark/index.ts's runKeywordSweep where it fits), wire their PASS verdicts into the same benchmarkFailedModels()/security-triage cache the rest of the system already reads, then remove mass_scout/high_quality_scan from default-profiles.ts's FREE_FORBIDDEN_TOOLS set once each benchmark exists and a model has passed it.

## Approval log

- 2026-09-16T19:17:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T15:19:12+0200 — COMPLETE by main-agent@llm-externalizer-plugin. Both addendum-H benchmarks landed and verified; the unlock is fail-closed (no recorded pass = still refused); dynamic-maintainer.ts deliberately untouched (it shares the predicate, no conflict created).

## Acceptance

- [x] Both fitness benchmarks built and wired: mass-scout-throughput (16-worker/64-call burst, 429s recorded) and hq-scan-quality (scan-folder's quality bar over the golden corpus via the real bench-runner); verdicts flow through a fail-closed own-ledger unlock (benchmark/free-fitness-ledger.ts) inside isFreeForbiddenTool; FREE_FORBIDDEN_TOOLS shrunk 5 -> 3 (mass_scout + high_quality_scan fitness-gated); doc pins updated incl. README table; vitest include list registers the three new test files; coordinator reran the five touched test files 37/37, NUL 0 on all 11 files, vitest include entries confirmed at vitest.config.ts:554-556 (commit b71ff5d; report reports/llm-externalizer/20261004_hbccfouu-fitness-benchmarks.md)
