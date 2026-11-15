---
trdd-id: WYY3SPDX
title: classify label takes a context flag for earlier messages
column: blocked
status: tasked
created: 2026-11-04T10:29:25+0100
updated: 2026-11-14T17:18:31+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:29:25+0100
eht: []
implementation-commits: [3d089c03]
blocked-by: [DX4YLNI6]
unblock-when: [trdd:DX4YLNI6]
pre-block-column: dev
blocker-probe: 'grep -rqE ''^column: (complete|completed|cancelled)$'' design --include=\*DX4YLNI6\*'
blocker-holds-if: exit-nonzero
---

# classify label takes a context flag for earlier messages

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-14

- Scope narrowed on 2026-11-14 to classify label. classify filter, and the find/compare decision, moved to TRDD-7ZA3EE6Z, which stands alone. The body below still describes the original filter-and-label scope.
- Done: `classify label --context FILE` in 3d089c03, tested through the recorded-reply seam.
- NEXT ACTION (updated 2026-11-14 17:19): BLOCKED on TRDD-DX4YLNI6. The remote call fails with HTTP 402 Insufficient credits (OpenRouter), which is why the first live run fell back to the local decider. When credits are added, rerun the same 9 pre-registered cases (Acceptance box 2) and confirm the remote model answered. Then archive. The fallback notice hiding the 402 is TRDD-XJE5DDK2.

Gap G1 of TRDD-Q2VTMG4P (capability C2, use previous-message context). Today filter (classifiers/catalog/filter.ts:17,22,61) and label (label.ts:25,201) accept a context string only inside JSON given with --input; there is no --context or --context_file flag, and compare, find, extract and verify take no context at all. Add a context flag to filter and label (and decide for find and compare), document it, and test it with a recorded reply through the GlobalFetch seam.

## Approval log

- 2026-11-04T10:29:25+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T17:11:59+0100 — column → testing by main-agent@llm-externalizer-plugin. label increment done in 3d089c03; filter is the eht TRDD-7ZA3EE6Z
- 2026-11-14T17:15:33+0100 — column → dev by main-agent@llm-externalizer-plugin. live check failed on the local fallback and never reached the remote model
- 2026-11-14T17:18:20+0100 — column → blocked by main-agent@llm-externalizer-plugin. remote rerun needs provider credits (HTTP 402), TRDD-DX4YLNI6

## Notes

Code line numbers were reported by a read-only audit on 2026-11-04 and are not re-read; confirm them at card start. When this ships, update the requirements-pipeline reference of TRDD-Q2VTMG4P.
2026-11-04: the planned classify requirements spec of TRDD-S5KOOT2S carries its own --context flag, so this card no longer blocks requirement extraction; its remaining scope is the context input of classify filter and label.
2026-11-14: increment A landed in 3d089c03: `classify label --context FILE` (- reads stdin), with tests through the recorded-reply seam and docs. Filter moved to TRDD-7ZA3EE6Z (increment B), 2026-11-14: increment A landed in 3d089c03: `classify label --context FILE` (- reads stdin), with tests through the recorded-reply seam and docs. Filter moved to TRDD-7ZA3EE6Z (increment B), set as this card's eht: filter's text-items instruction never references the shared context, so the flag alone would be sent and ignored. The find/compare decision moved there too. This card's own scope (label) is done; it cannot reach complete until TRDD-7ZA3EE6Z is terminal. (Superseded 2026-11-14: the eht was dropped in 01798570; this card no longer waits on TRDD-7ZA3EE6Z.): filter's text-items instruction never references the shared context, so the flag alone would be sent and ignored. The find/compare decision moved there too. This card's own scope (label) is done; it cannot reach complete until TRDD-7ZA3EE6Z is terminal.
2026-11-14: per review, the eht link to TRDD-7ZA3EE6Z is dropped (it was the remainder of this card's own scope, not an effect of it), and this card is narrowed to label.
2026-11-14T17:14:45+0100: analysis rule for Acceptance box 2, added per review BEFORE reading the live results (the worker was still running): if an item's control run already gives the context's implied label a probability of 0.90 or more, the shift test for that item is VOID (not testable, ceiling), not a FAIL. A single run per case has no measured noise floor, so a FAIL or a PASS by a margin under 0.05 is reported as weak. If the check fails, this card goes back to dev, not forward.
2026-11-14T17:15:33+0100: live check run (reports_dev/wyy3spdx/20261114_171407+0100-live-label-context.md, 9 runs, exit 0). It does NOT test the shipped path: every run printed 'no remote System One model answered; the local decider elephant-1 ... did' with no reason, so all verdicts are the local fallback, not typesafe/jev-1.14 the estimate named; no spend. Scored with the pre-registered thresholds and the void rule: I1 shift VOID (control p(bug) 0.9618), I2 shift PASS (+0.38), I3 shift FAIL (-0.095); irrelevant context: I1 PASS, I2 FAIL (top flipped feature to bug), I3 FAIL (-0.22). Box 2 stays open. NEXT: find why the remote model did not answer, then rerun the same pre-registered cases on the remote model.
2026-11-14T17:17:02+0100: review notes on the live check. (a) The void rule changes only I1's shift arm; the overall result is still a FAIL on the irrelevant-context arm (I2, I3), so the rule rescues nothing. It was added on the earlier review's ceiling prediction, before the report was read. (b) Case-design caveat, recorded but deliberately not acted on, since changing cases after seeing results would be fitting: C-rel3 ('always slow, wants a streaming mode') can fairly be read as a performance bug, so the I3 shift FAIL may reflect an ambiguous case rather than an ignored context. The remote rerun keeps the same cases. (c) Release hold: the docs (SKILL.md, classify.md, requirements-pipeline.md) recommend --context since 3d089c03. Before any release that includes the flag, either the remote rerun passes, or the docs gain a caveat that the context's effect on verdicts is unverified. (d) Column: dev while the diagnosis runs. If the cause is the environment, back to testing and rerun. If it is code, a new card.

## Acceptance

- [x] `classify label --context FILE` fills shared.context; refusals, stdin, estimate and planner limits tested through the recorded-reply seam (3d089c03).
- [ ] A pre-registered live label run shows the context matters: a flip case where the context changes the verdict, its control without context, and an irrelevant context that leaves the verdict unchanged. Scores recorded here.
