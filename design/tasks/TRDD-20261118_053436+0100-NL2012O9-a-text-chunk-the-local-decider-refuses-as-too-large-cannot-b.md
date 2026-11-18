---
trdd-id: NL2012O9
title: A text chunk the local decider refuses as too large cannot be cut again and the 16384 clamp raises the remote request count
column: todo
status: tasked
created: 2026-11-18T05:34:36+0100
updated: 2026-11-18T08:00:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:34:36+0100
---

# A text chunk the local decider refuses as too large cannot be cut again and the 16384 clamp raises the remote request count

## Why
Found in TRDD-1L9VMEY7 (root analysis reports_dev/1l9vmey7-check/20261118_051637+0100-root-and-ubs.md in the dev-after-14.3.0 worktree; a hypothesis read from the code, not reproduced).
## Facts (read in the code)
- The plan cuts a text unit once, against one window: expandTextUnits in planner.ts:111-145, run once in planRequests (:148-151).
- A text unit and each of its chunks travel alone in a request (planner.ts:311-312, decision D31).
- replanRequest refuses a request of one unit (planner.ts:172), so on a decider 422 answerWithSplit (split-on-overflow.ts:29-35) cannot cut a single chunk again and its questions fail. Callers: run-decision.ts:301 (local-only) and :551 (remote escalation).
- Remote classify on Apple silicon plans under min(remote limit, 16384) while the local fallback is on (run-decision.ts:409-410, added in fc3052b0), so each piece fits the decider. With chunks halving from 60000 chars this can about double the requests of a long text.
- Measured once (a473a6b0 build): or-jev test-output was refused with "the plan needs 19 requests, over the limit of 16". 16 is the max_requests_per_call value in the user settings; the built-in default is 8 (config.ts:1576).
- On the local-only path a chunk the l1 estimate undercounts (TRDD-4JLBB1YT) is planned under 16384 and can still be refused by the decider.
## Options
1. Re-cut a refused chunk on the local escalation and on the local-only path: re-chunk the unit state, validate the piece answers with the spec policy, merge per question type (mergeChunks with the default labels), and hand back one answer per original key. Touches split-on-overflow.ts and the fan-out merge; find windows are atomic, so the find spec would have to rebuild its questions. With this in place the 16384 clamp could go.
2. Keep the clamp for the chunk size but let adjacent chunks of one source share a remote request (relax planner.ts:312). Against D31: an owner decision.
3. Raise max_requests_per_call in the user settings (16 to 32). A USER setting; 32 covers only the one recorded run.
## Acceptance
- [ ] A red test first: a single text chunk the fake decider refuses with a 422 fails today, on the local-only path and on the remote escalation.
- [ ] The chosen option, with that test green, tsc and eslint 0.
- [ ] or-jev test-output re-run on the same input is not refused for its request count, or the refusal is the limit the USER chose.

## Approval log

- 2026-11-18T05:34:36+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-18T08:00:08+0100 From TRDD-4JLBB1YT (main agent): the planner fills a request up to the limit: budget = contextTokens - envelopeTokens (planner.ts:255) with ENVELOPE_TOKENS 64 (planner.ts:13), a request closes only when the next unit would pass the budget (planner.ts:313), and text units travel alone (planner.ts:311-312). After the estimator fix ceb16c5c, random hex and UUID text still comes out at up to 0.997 of the estimate (12 tokens of margin on one 4000-char list), so an under-count stays possible. Inferred, not measured: the decider fixed overhead is 105 input tokens for the state x and a one-line question; if that question costs 15 to 20 tokens, the decider own wrapper is about 85 to 90 tokens, above the 64 the planner reserves. Planner headroom is one more option for this card, next to re-cutting the chunk and max_requests_per_call.
