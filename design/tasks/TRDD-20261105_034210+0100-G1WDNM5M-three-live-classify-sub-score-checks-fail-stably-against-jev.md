---
trdd-id: G1WDNM5M
title: Three live classify sub-score checks fail stably against Jev
column: backburner
status: tasked
created: 2026-11-05T03:42:10+0100
updated: 2026-11-05T04:00:58+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T03:42:10+0100
---

# Three live classify sub-score checks fail stably against Jev

## Problem

Three soft asserts in scripts/llm-ext/src/live-classify.test.ts fail in both recorded live runs against the decisions service (Jev), while each command's headline verdict is right. Commit 8939291f (2026-10-31) added them as discriminating sub-scores after a quality evaluation and records them failing in its live run (on HEAD e2496d89 plus its changes, 16 of 19 pass), kept failing as findings. Because of them the live suite exited 1 in both recorded runs, so its exit code cannot tell a regression in the other 16 tests from these known failures. No other card was found by a case-sensitive grep of design/ for off_target, "spec_match 0.78" and "needs no server", run before this card existed.

## Evidence

Live rerun on 2026-11-05 of a fresh build of e93f89b2's source, `LIVE_TESTS=1 npx vitest run --config vitest.live.config.ts src/live-classify.test.ts`: 16 of 19 pass (live.log); the same 3 fail again when rerun alone (`-t`). The model id typesafe/jev-1.14-20261014, the rerun values and the audit scores below come from the worker's report, not from log lines the orchestrator read. Report, corrections and raw runs: reports_dev/classify-e2e/20261105_034016+0100-live-rerun.md, 20261105_034414+0100-live-rerun-corrections.md and 20261105_034016+0100-live-rerun-artifacts/ (all gitignored).

| test (line at e93f89b2) | headline verdict | assert | Jev's answer |
|---|---|---|---|
| decide (:286) | sqlite selected, right | Firestore's check on requirement index 1 (the second, "Needs no server for the team to operate") is not contradicted | contradicted, both runs |
| audit (:340) | kickoff_date flagged wrong, right | the top check of the stale date is off_target | hallucinated 0.98 over off_target 0.85 (rerun 0.98 over 0.81) |
| review (:369) | off-by-one escalated, correctness 0, right | spec_match below 0.5 (scale 0 to 2, per the test's comment at :366) | 0.83, rerun 0.85 (0.78 in 8939291f's run) |

## Owner question

For each assert, which of three: (a) Jev's error, so the spec's check descriptions or prompt change until it passes; (b) a debatable expectation, so the assert changes; (c) keep the planted expectation in a comment and assert the observed outcome until Jev changes, by analogy with the owner's rule to convert xtests into normal tests that assert the negative outcome. The orchestrator's reading, not verified: audit looks like a model error (the stale date is in the source verbatim, so hallucinated is wrong); decide is debatable (the evidence says Firestore needs a Google Cloud project with billing); review is between the two.

## Done when

The owner has ruled on each assert; the ruling is applied (spec text, assert, or observed-outcome assert); two consecutive clean live runs exit 0; and the catalog capture tests pass, re-captured if a spec's prompt changed.

## Notes and lessons
2026-11-05T03:49+0100 Related: the specs these asserts test belong to SP-06 decide (TRDD-N1FQ8A8K), SP-10 audit (TRDD-N2TDAXL4) and SP-11 review (TRDD-QFPC4Z8P), all archived complete; a spec-text ruling here changes their code, so name this card in that commit. The approval fields and the MANDATE log line were written by trddgrep new and are not an owner decision.
2026-11-05T03:59+0100 6ff92785's commit message misstates the cause: the failing soft asserts make live-classify.test.ts exit 1, not the missing card. The fix2 edits of the Problem, Owner question and Done when lines (about 03:53) did not bump updated:.

## Approval log

- 2026-11-05T03:42:10+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
