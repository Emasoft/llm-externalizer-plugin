---
trdd-id: 90BXJ2KO
title: Partly answered benchmark runs score empty and API-error cases as quality fails
column: testing
status: tasked
created: 2026-11-15T02:16:37+0100
updated: 2026-11-15T17:49:38+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T02:16:37+0100
implementation-commits: [f4e5e20e]
---

# Partly answered benchmark runs score empty and API-error cases as quality fails

Found by the 2026-11-15 free-pool sweep (worker report in reports_dev/sonnet-worker/free-bench-20261115/). The isNonEvidence rule in dist/benchmark.js abstains only when NO case in a run produced a usable answer. A run where some cases came back empty or with an API 400 is scored as an ordinary fail, and the row is written to the ~/.llm-externalizer ledgers with qualityPass false. verdicts.ts and validated.ts read those rows, so the model is excluded from routing for that tool until re-probed. Rows with qualityPass false, read per key from the ledgers on 2026-11-15 (six rows, three models; ling-3.2-flash has none): code-task-results.json ernie-5.5-flash-preview (failedCases 4 of 8), particle-1 (failedCases 2 of 8), dots-3-note-preview (failedCases 6 of 8), all 2026-11-14 rows; check-specs-results.json particle-1 (1 of 13 files unscored) and dots-3-note-preview (6 of 13 unscored); text-tools-results.json describe dots-3-note-preview (failedCases 4 of 6). VERIFIED: profiles/verdicts.ts and benchmark/validated.ts route on qualityPass, so these rows exclude the model for that tool. NOT VERIFIED (from the sweep worker's report): that the failed code-task cases and the describe cases were empty or API-error responses rather than wrong answers; an empty returned list in a code-task case can also be a genuine empty answer. The particle-1 check-specs fail may be a genuine quality fail (F1 0.67 with only 1 file unscored). Proposed fix: count an empty or transport-error case as unscored, not as a wrong answer, and abstain when unscored cases exceed a threshold. Repairing the existing ledger rows changes state outside git and needs USER approval. OPEN QUESTION for the USER: fix the scoring rule, and re-probe or remove the six rows.

## Approval log

- 2026-11-15T02:16:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-15T17:49:34+0100 — column → testing. f4e5e20e committed; tsc and eslint clean; covering tests 309 passed, 1 failed in dataset.test.ts on a stray gitignored .pyc fixture (inferred unrelated, not re-run)

## Notes

2026-11-15T17:35:05+0100 AGENT DECISIONS (orchestrator, not USER words; the USER may override at the publish gate): (a) a run abstains (no qualityPass) when more than 25% of its cases went unanswered; 0.25 is an agent choice; (b) the tool's own ledger backfill removes a stored qualityPass:false from rows the widened rule classifies as non-evidence, logging one stderr line per removal; (c) select.ts and the benchmark progress PASS/FAIL lines use the same answered-only judgement, so selection and the stored verdict cannot disagree (scope widened by the orchestrator); (d) before any benchmark or backfill runs, the ~/.llm-externalizer/*-results.json ledgers were copied to ~/.llm-externalizer/backups/<name>.bak-pre-90bxj2ko-<timestamp> (9 files, 2026-11-15). Rows with 25% or fewer unanswered keep a stored false until a fresh run re-scores them.
2026-11-15T17:49:38+0100 OPEN after f4e5e20e: rows with 25% or fewer unanswered keep a stored false until re-run; hq-scan-quality.ts (S5 path) still fails empty replies and timeouts on the raw score; bench-runner pass fields still use the raw score; comment typo 'clean cases vacuous F1' in quality-evidence.ts. Worker report: reports_dev/sonnet-worker/20261115_174500+0100-90bxj2ko-final.md
