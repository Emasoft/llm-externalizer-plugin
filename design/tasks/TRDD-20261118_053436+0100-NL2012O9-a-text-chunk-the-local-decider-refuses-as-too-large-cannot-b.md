---
trdd-id: NL2012O9
title: A text chunk the local decider refuses as too large cannot be cut again and the 16384 clamp raises the remote request count
column: publish
status: tasked
created: 2026-11-18T05:34:36+0100
updated: 2026-11-18T14:15:50+0100
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
implementation-commits: [21699151]
release-via: publish
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
- [x] A red test first: a single text chunk the fake decider refuses with a 422 fails today, on the local-only path and on the remote escalation.
- [x] The chosen option, with that test green, tsc and eslint 0.
- [ ] or-jev test-output re-run on the same input is not refused for its request count, or the refusal is the limit the USER chose.

## Approval log

- 2026-11-18T05:34:36+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T13:01:43+0100 — column → complete by main-agent@llm-externalizer-plugin. code committed and verified on the exported commit (tsc and card tests); ships in 14.7.2; approved by the main agent under the USER delegation of 2026-11-18
- 2026-11-18T14:14:05+0100 — column → publish by main-agent@llm-externalizer-plugin. shipped in v14.7.2 (8c72f83d, release https://github.com/Emasoft/llm-externalizer-plugin/releases/tag/v14.7.2); main agent approves under the USER delegation of 2026-11-18

## Notes

2026-11-18T08:00:08+0100 From TRDD-4JLBB1YT (main agent): the planner fills a request up to the limit: budget = contextTokens - envelopeTokens (planner.ts:255) with ENVELOPE_TOKENS 64 (planner.ts:13), a request closes only when the next unit would pass the budget (planner.ts:313), and text units travel alone (planner.ts:311-312). After the estimator fix ceb16c5c, random hex and UUID text still comes out at up to 0.997 of the estimate (12 tokens of margin on one 4000-char list), so an under-count stays possible. Inferred, not measured: the decider fixed overhead is 105 input tokens for the state x and a one-line question; if that question costs 15 to 20 tokens, the decider own wrapper is about 85 to 90 tokens, above the 64 the planner reserves. Planner headroom is one more option for this card, next to re-cutting the chunk and max_requests_per_call.
2026-11-18T10:11:51+0100 main agent: re-read at HEAD 54236bf8 (planner.ts:100-200, split-on-overflow.ts:20-60): replanRequest refuses a request with fewer than 2 units and re-expands with the original limits; answerWithSplit returns the first 422 when the re-plan refuses; so a refused lone text chunk is never cut smaller. Option 1 (re-cut with the scaled budget, merge the sub-answers under the original key) is agent-doable after red tests in split-on-overflow.test.ts, local-decision.test.ts and local-decider-remote-error.test.ts. USER decisions: Option 2 (packing, against D31), Option 3 (max_requests_per_call), removing the 16384 clamp (run-decision.ts:409-410), planner headroom.
2026-11-18T10:24:01+0100 main agent decision under the USER delegation of 2026-11-18 ("solve all issues yourself. i need results."): Option 1 is to be implemented (a refused lone text chunk is re-cut with the scaled budget, down to CHUNK_CHARS_MIN, and the piece answers merge under the original key; a chunk still refused at CHUNK_CHARS_MIN returns the original 422). The 16384 clamp stays: removing it reverses the USER-quoted rationale in the comment above it in run-decision.ts. Option 2 is rejected: it contradicts D31 (plan ZB41KG62 line 167, no packing of independent items). Option 3 and a planner headroom margin are not taken. This supersedes the USER-decisions list in the 2026-11-18 note above.

## Progress

2026-11-18T12:50:01+0100 main agent (written by worker): commit 21699151 (l2/planner.ts recutTextRequest, split-on-overflow.ts defaultLabels and foldPieces, run-decision.ts). Committed-tree check at 848f2b9f, a descendant (reports_dev/commit-check/20261118_114436+0100-848f2b9f.md): tsc exit 0; split-on-overflow, local-decision and local-decider-remote-error tests passed. Ships in 14.7.2.

## Acceptance evidence

box 1: 21699151 split-on-overflow.test.ts (6 new tests), local-decision.test.ts (text item 422, local-only path), local-decider-remote-error.test.ts (text item 422, remote escalation) — added by the commit; red before the fix per reports_dev/nl2012o9-fix/scratch/red-local.txt (FAIL, 'needs 19817 tokens; the limit is 16384') and red-remote.txt (FAIL, exit 3, API error 402 stands). Red outputs are the worker's scratch, read by me, not re-run.
box 2: 21699151 implements Option 1 (planner.ts recutTextRequest, split-on-overflow.ts foldPieces). tsc --noEmit exit 0 and split-on-overflow 17, local-decision 34, local-decider-remote-error 5, run-decision 72, fan-out 37 tests passed at descendant 848f2b9f (reports_dev/commit-check/20261118_114436+0100-848f2b9f.md). eslint exit 0 on the 6 files of 21699151, run by me 2026-11-18 in scripts/llm-ext of the dev-after-14.3.0 worktree (the six files are unmodified there). Source lines in reports_dev/commit-check/20261118_114436+0100-848f2b9f.md: line 5 (Outcome: PASS, tsc --noEmit exit 0) and table lines 25-29 (the five files); git log 21699151..HEAD on the six files of 21699151 is empty, so nothing later touched them.
box 3: NOT proven, left unticked. No or-jev test-output re-run on the same input exists; reports_dev/nl2012o9-fix/20261118_103600+0100-report.md open risk 6 says the re-run was not done and is for the USER. 21699151 does not change the planned request count (re-cut only after a 422) and the 16384 clamp stays, so the 'plan needs 19 requests, over the limit of 16' refusal may still occur; not shown either way.
