---
trdd-id: HZMA4EXK
title: Comment hygiene and deferred WHY wording in the classify runner, spec and shared flags
column: published
status: archived
created: 2026-11-05T03:07:03+0100
updated: 2026-11-19T20:48:53+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T03:07:03+0100
implementation-commits: [b9c307e2, c4dc6bd5]
---

# Comment hygiene and deferred WHY wording in the classify runner, spec and shared flags

## Goal

Fix comment defects recorded by the WHY-comment pass of 2026-11-05 on TRDD-BUL4EEBP, TRDD-XHHH0N1E and TRDD-DCI7C2Y7, so that they are not stranded in notes on cards that will close. Comments only, unless item 6 is taken up. Line numbers are at commit 948870d4.

## Items

1. scripts/llm-ext/src/classifiers/run-decision.ts:221: state the reason, not the build status. Proposed by the second review of 948870d4: this runner has no source fallback; decision D1 of the ZB41KG62 plan puts its two elsewhere (the decide --hook defer prints no envelope; browse's keyword query belongs to browse run). Read the other failure paths of runDecision first: that claim was checked only through degrade() having no production caller and the default-label merge in l2/fan-out.ts.
2. run-decision.ts:468: the -o sync rule should also name INPUT_FLAGS, the spec flags and launcher.ts classifyArgv, because the refusal covers all three lists and classifyArgv special-cases -o.
3. run-decision.ts:438: the WHY about INPUT_FLAGS sits above the JSDoc of runDecisionArgv and detaches it from the function.
4. scripts/llm-ext/src/classifiers/catalog/spec.ts:95: a second JSDoc is stacked above the JSDoc of parse(raw).
5. scripts/llm-ext/src/classifiers/shared-flags.ts:39 and :50: two "Help sentences checked against l2/inputs.ts" comments cite different line numbers; one is stale.
6. Optional, a test: classify refuses -x and accepts -o, so the rule in item 2 is enforced, not only stated. Check first whether such a test exists.
7. DONE in 89461dc7: run-decision.ts:129 WHY (added in df6c89bb): its parenthetical "request not sent or aborted" leaves out the fatal request itself, which l2/fan-out.ts:250 records with kind error and no error object; reword.
8. run-decision.ts failureCode fallback-5 WHY (as reworded in 89461dc7): say that 5 is a last resort and that both callers need it (the Refusal of a failed whole-result run and the exitCodeForRun call). Before writing that every failure kind the comment lists is handled above or by conclude's fatal throw, verify it: stopped presumably maps through m.stopped "budget" and "timeout" at :123 and :125 at 3882b844, and whether every stopped failure sets m.stopped was not checked.
9. run-decision.ts value-flag else branch (WHY added in 3882b844): it states that only --max-budget and --chunk-chars reach it; add the obligation that a new value flag needs its own branch above or it is read as --chunk-chars, and consider a test that every non-boolean SHARED_FLAGS and INPUT_FLAGS entry has a branch.
10. run-decision.ts default-label order (WHY added in 3882b844): it states the order, not the reason. Trace who sets defaultLabels before writing the reason; the RunRequest JSDoc line "users cannot know the keys" explains why defaultLabels is internal, not why it overrides the user's --default.
11. run-decision.ts fatal-refusal and input-error WHYs (added in 3882b844): first settle a behaviour question: a fatal failure drops the other requests' answers even for a per-item spec, while plan row E46 covers one chunk failing while others succeed and says nothing about a fatal failure; check the intent before a WHY blesses it. Then add what the comments leave out (inferred, check first: the input-error classes exit with no result envelope), and read "the failure's own message" for "the transport's own message" if a fatal failure can be an auth or credits class (inferred from FatalFailure.class being an ErrorClass).

## Notes and lessons

Source: reports_dev/ygf9yxf2/20261105_021126+0100-why-review-findings.md (gitignored) and the reviews of 61efae4e and 948870d4 (commit messages 948870d4 and the card notes of 2026-11-05 on TRDD-BUL4EEBP and TRDD-XHHH0N1E).
2026-11-05T03:15+0100 Correction to the Source line: the reviews of 61efae4e and 948870d4 exist only in a session transcript; the durable sources are the 948870d4 commit message and the 2026-11-05 card notes on TRDD-BUL4EEBP and TRDD-XHHH0N1E. The approval fields and the MANDATE log line were written by trddgrep new and are not an owner decision.
2026-11-05T03:23+0100 Item 7 is done: 89461dc7 reworded the failureCode fallback-5 comment to include the fatal request itself.
2026-11-05T03:29+0100 Corrections to items 10 and 11 (review of the spec-5 text): item 10's cited reason is wrong; the RunRequest JSDoc line "users cannot know the keys" explains why defaultLabels is internal, not why it overrides the user's --default, so trace who sets defaultLabels before writing the reason. Item 11: "the input-error classes exit with no result envelope" is the worker's reading, and "a fatal failure can be an auth or credits class" is inferred (FatalFailure.class is an ErrorClass). That a fatal failure drops the other requests' answers even for a per-item spec is a behaviour question, not only wording: plan row E46 covers one chunk failing while others succeed, and the plan says nothing about a fatal failure; check the intent before a WHY blesses it.
2026-11-05T03:59+0100 Items 7, 8, 10 and 11 edited in place to carry the 03:29 corrections and the e93f89b2 review; the 03:23 and 03:29 notes stay as history.

## Approval log

- 2026-11-05T03:07:03+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T20:48:53+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped in v14.7.6, release commit 53a415e0, tag v14.7.6.

## Notes

T6F52GB8 audit 2026-11-19 (verifier VA, not re-read by the main agent): PARTLY. Done: item 7 done in content; item 6 test split over run-decision.test.ts:273 and input-args.test.ts:281-282; items 8, 9 partial. Remaining: items 1 (run-decision.ts:245), 2 (:677), 3 (:647), 4 (catalog/spec.ts:95-96), 5 (shared-flags.ts:41 and :52), 10 (:263) and 11 (:217-218) open; 8, 9 partial; 6 optional.
2026-11-19 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): all items closed. Items 1 to 5 and 8 to 11 in b9c307e2, each checked against the code by the main agent (commit body). Item 10 removed the unused RunRequest.defaultLabels instead of documenting it: no writer anywhere in the package, the only production RunRequest is built from argv. Item 11 behaviour question: settled by the 2026-11-18 16:14 ruling on TRDD-BUL4EEBP (kept as built), now cited in the comment. Items 6 and 7 done earlier (run-decision.test.ts:273, input-args.test.ts:281-282; 89461dc7); item 9 optional test not added, reason in the b9c307e2 body. npx tsc --noEmit and npx eslint . --quiet exit 0, run-decision.test.ts 72 pass. Waits for the full npm test at the 14.7.6 publish gate.
2026-11-19T20:44:30+0100 worker (not the main agent): implementation-commits attribution, checked with one git log -S per string on 53a415e0: the item 7 wording ('the fatal request itself') first appears in c4dc6bd5, the 14.3.0 squash that stands in for the pre-squash 89461dc7 (not an ancestor of the release); the item 8 wording ('a last resort') comes from b9c307e2, which also holds items 1 to 5 and 9 to 11. Both are ancestors of 53a415e0.

## Acceptance

- [x] items 1-5 comment fixes in b9c307e2 (ancestor of 53a415e0; touches run-decision.ts, catalog/spec.ts, shared-flags.ts)
- [x] item 6 tests at run-decision.test.ts:273 (-o accepted) and input-args.test.ts:281-282 (-x.txt refused), read at 53a415e0
- [x] item 7 wording shipped via c4dc6bd5 (the 14.3.0 squash that replaced the non-ancestor 89461dc7)
- [x] items 8-11 in b9c307e2 (item 9 optional test deliberately not added, reason in the b9c307e2 commit body)
- [x] full suite green at the 14.7.6 publish gate (release commit 53a415e0)
