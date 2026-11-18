---
trdd-id: 4JLBB1YT
title: The l1 token estimate undercounts random base64 about 2x so a planned request can exceed the decider limit
column: todo
status: tasked
created: 2026-11-18T05:34:26+0100
updated: 2026-11-18T08:03:37+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:34:26+0100
implementation-commits: [ceb16c5c]
---

# The l1 token estimate undercounts random base64 about 2x so a planned request can exceed the decider limit

## Why
Found in TRDD-1L9VMEY7 (notes of fc3052b0): the l1 token estimate undercounts random base64 about 2x (ratio 1.985 measured in the fc3052b0 run, not re-measured), so a request planned at the decider limit can be over it by the count of the decider and fail with a 422. On code the estimate over-counts about 40 percent (measured 2026-11-17, estimate 22876 against decider 16372).
## Facts
- l1/estimate.ts:19-23 has only character-class rates (letters, digits, other ASCII) and no handling of base64 or random strings; last changed in 4bdd9b1b (14.1.0).
- The decider reports usage.input_tokens on every success and the exact need on a 422 (TRDD-1L9VMEY7 note 2026-11-17T02:30).
## Acceptance
- [x] A measurement of estimate against decider count on base64, random ids and code, saved under reports_dev.
- [x] A fix (for example a higher rate for long runs of the base64 alphabet without spaces) with a unit test on a base64 sample, that does not raise the over-count on code.
- [x] tsc and eslint 0.

## Approval log

- 2026-11-18T05:34:26+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-18T07:59:42+0100 Fix committed in ceb16c5c (estimate.ts, estimate.test.ts, and the config.ts comment). Rule: a run of [A-Za-z0-9+/=-] of 16+ chars with a letter costs 11/12 token per char when it is digit-dense (at least 40 percent digits) or hex-only, and 9/12 when it is mixed case with class changes on at least half of its pairs; other runs keep the per-class rates.
2026-11-18T07:59:46+0100 Measured against the local decider elephant-1 (net = input_tokens minus a 105-token probe; intermediate reports under reports_dev/4jlbb1yt/). Before the fix: base64 0.50, UUID lists 0.52 and 32-char hex ids 0.49 of the decider count; code 0.76 to 0.92 and prose 0.70 were overcounted. After the fix: 18 random samples of 1000 to 12000 chars at 0.967 to 0.997 of the estimate (thinnest margin 12 tokens, on one 4000-char hex list); 4 hex and UUID lists of about 17,700 chars near the 16384 limit at 0.987 to 0.989 (margins 183 to 209); code and prose estimates unchanged. A first rule (digit share only) failed one UUID list by 19 tokens; the hex-only test fixed it.
2026-11-18T07:59:55+0100 Checks by the main agent on the committed tree (parked TRDD-TN8OUZ50 edits set aside): estimate.test.ts 17 passed, planner.test.ts 50, config.test.ts 226, tsc and eslint exit 0. On the working tree, the 35 test files that import the estimate or the planner (found by an import-name grep) passed; one of them, classify-stdin-cli.test.ts, runs the built dist and does not cover the change. The ubs hook reported 0 critical and 15 warnings, all on config.ts lines the commit does not touch.
2026-11-18T08:00:00+0100 The risk in the title is reduced, not removed: the margin on random text is thin, and the planner plans up to the limit with only its 64-token envelope. That remainder is tracked on TRDD-NL2012O9.
2026-11-18T08:03:36+0100 Corrections to the notes above and to the ceb16c5c message (main agent; the message is not amended): (1) the 18 random samples were base64 at 1000 to 12000 chars and hex and UUID lists at 4000 chars, not every kind at every length. (2) The ubs hook reported 15 warnings in 3 rules; every location it printed is on config.ts lines the commit does not touch, but it printed only 5 of the 10 mutation-during-iteration hits, so the other 5 were not seen. (3) The message says the hex-only test newly matches 1 run in 55511 runs of this repo; that count comes from a script copy of the rule run by the worker, not from estimateTokens itself. (4) The message says the UUID test failed on the old rule at 3572 against 3591; 3572 is the estimate of the first version of the new rule (digit share only). (5) The message points to this card for the checks, which were written here after the commit.
