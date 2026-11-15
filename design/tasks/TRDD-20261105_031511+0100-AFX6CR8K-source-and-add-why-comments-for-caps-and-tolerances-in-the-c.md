---
trdd-id: AFX6CR8K
title: Source and add WHY comments for caps and tolerances in the classify catalog specs
column: backburner
status: tasked
created: 2026-11-05T03:15:11+0100
updated: 2026-11-05T04:09:37+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T03:15:11+0100
---

# Source and add WHY comments for caps and tolerances in the classify catalog specs

## Goal

Give a sourced reason, as a WHY comment, for each uncommented rule that the WHY-comment scan of commit 643d7887 (2026-11-05, run for TRDD-BUL4EEBP) found in the classify catalog spec files, or record that no reason can be sourced. Reasons may come from the jev-mcp reference the specs were aligned to (643d7887: "reference alignment"); a reason that cannot be sourced is not invented. Line numbers are at commit df6c89bb. Ownership by card is inferred from the card slugs (sp-08-compare and so on), not from blame.

## Items by owner card

- TRDD-FPD1G0VB (SP-08 compare, archived complete): catalog/compare.ts:86, the null-prototype copy of c.probabilities; decide.ts states the reason for its twin, compare.ts does not.
- TRDD-N1FQ8A8K (SP-06 decide, archived complete): catalog/decide.ts:34, 35, 36, 38, 39, the length caps 1500, 12000, 2000, 2000 and 500; the nearby WHY explains only the absent count caps.
- TRDD-B19TVE91 (SP-09 extract, blocked): catalog/extract.ts:47, pattern .max(500); catalog/extract.ts:140, the whole-number check of --candidate-cap inside prepare.
- TRDD-OHLMZONY (SP-14 findings, blocked): catalog/findings.ts:20, window max 100 and default 10; catalog/findings.ts:177, SEVERITY[Math.round(sev)] (rounding rule and range unexplained).
- TRDD-O5NUD6IT (SP-17 test-output, human_review): catalog/test-output.ts:30, context max 100 and default 5; catalog/test-output.ts:179, the same rounding shape as findings.ts:177.
- TRDD-QFPC4Z8P (SP-11 review, archived complete): catalog/review.ts:32-34, MAX_CLAIMS, MAX_EVIDENCE and MAX_FILES = 16 with only a reference tag (jev-mcp lib.ts:259-281); review.ts:148, TOP = 2 and its link to the 0..2 score scale; review.ts:299, the clamp to 0..1; review.ts:319, the 1e-12 tolerance for a tied lowest rubric.
- TRDD-N2TDAXL4 (SP-10 audit, archived complete): catalog/audit.ts:39, MAX_RECORDS = 32 with only a reference tag (jev-mcp lib.ts:206).

## Open owner questions

1. One WHY standard for every card: is "ported verbatim from a named source" (a reference tag) a sufficient WHY? The answer settles the 400 clip on TRDD-XHHH0N1E, review.ts:32-34 and audit.ts:39 here. Related: is a reason labelled as inferred acceptable? That covers two rules in run-decision.ts on TRDD-BUL4EEBP: the issues.slice(0, 5) cap, and failureCode's order of aborted, then budget, then timeout if that order can matter; the value === "" refusal was judged obvious and is not part of it.
2. Four owner cards are archived complete while their files carry these gaps under the scan's standard: reopen them, keep this card as their successor, or judge the standard too strict.

## Notes and lessons

Source: reports_dev/ygf9yxf2/20261105_030559+0100-bul4eebp-why-scan.md (gitignored, raw). The scan's 643d7887 table hit its cap of 10 and lists 5 overflow items; it does not state that the overflow list is exhaustive, so more gaps may exist in these files.
2026-11-05T03:23+0100 The scan's per-file lists are lower bounds, not only capped: a full re-read of run-decision.ts's hunks in the same commits found 7 more uncommented rules than the scan listed for that file (reports_dev/ygf9yxf2/20261105_031855+0100-runner-why-fix4.md). Re-read each catalog file's hunks in full before working this card. The approval fields and the MANDATE log line were written by trddgrep new and are not an owner decision.
2026-11-05T03:29+0100 Owner question 1 also covers failureCode's order of aborted, then budget, then timeout in run-decision.ts (TRDD-BUL4EEBP): no reason found for it; see the BUL4EEBP notes of 2026-11-05.
2026-11-05T04:08+0100 Question 1 now names its run-decision.ts scope (e93f89b2 review); the 03:23 count of 7 more rules is the worker's judgement, not tool-verified.

## Approval log

- 2026-11-05T03:15:11+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
