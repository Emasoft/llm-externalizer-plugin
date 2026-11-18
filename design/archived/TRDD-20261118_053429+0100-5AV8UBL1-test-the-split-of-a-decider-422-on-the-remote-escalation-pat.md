---
trdd-id: 5AV8UBL1
title: Test the split of a decider 422 on the remote escalation path
column: complete
status: archived
created: 2026-11-18T05:34:29+0100
updated: 2026-11-18T07:38:23+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:34:29+0100
implementation-commits: [52e605b5, 4841f953]
---

# Test the split of a decider 422 on the remote escalation path

## Why
TRDD-1L9VMEY7 commit a473a6b0 splits a request the local decider refuses as over its limit, on the local-only path and on the local escalation of a remote classifier profile (run-decision.ts:551). Only the local-only path has a test of it (local-decision.test.ts). The escalation path has none, and 628142c0 was tested with one failed piece only, with no nested partial split.
## Acceptance
- [x] A test drives a remote classifier profile whose remote call fails and whose local decider answers a 422 naming its counts for a two-unit request, and asserts the request is split and both pieces are answered.
- [x] A test where one piece of that split fails asserts the split_piece_failed warning names the piece, its reason and its question count.
- [x] tsc and eslint 0; only the touched test file is run.

## Approval log

- 2026-11-18T05:34:29+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T07:38:23+0100 — COMPLETE by main-agent@llm-externalizer-plugin. all three Acceptance boxes ticked on tests 52e605b5 and 4841f953.

## Notes

2026-11-18, box 1, commit 52e605b5: a new test in local-decider-remote-error.test.ts drives a remote 402 and a decider 422 (needs 20001 tokens, limit 16384) on a 2-question escalation, and asserts the request sizes [2, 1, 1], exit 0, no split_piece_failed warning, no invalid row and both rows. With 2 questions a split by the 422 counts and a split in halves give the same sizes, so the test does not prove that the counts drive the split; planner.ts replanRequest (lines 169-212, read by the worker) scales by limit over needed and has no halving branch.
Box 2 is covered by the first test of local-decider-remote-error.test.ts (from 628142c0, 2026-11-17): on the escalation path, with 4 propositions, the decider refuses every multi-question request and the second single question; the test asserts one split_piece_failed warning whose text carries the reason (needs 16460 tokens; the limit is 16384) and the count (a split piece of 1 question), and one matching stderr line. The warning names a piece only by its question count; it carries no question keys, which are reported as answer missing from reply. Whether that test splits more than one level was not measured.
Correction of the Why above: the escalation path already had a test when this card was written (628142c0, the first test of local-decider-remote-error.test.ts); the missing case was a split whose pieces are all answered.
Box 3: tsc --noEmit exit 0 and eslint exit 0 on the test file, run by the main agent on 2026-11-18 at about 07:06; only that test file was run (3 passed). The ubs pre-commit hook reported 0 critical and 20 warnings in the file (JSON.parse without try, non-null assertions), the same patterns as the existing tests.
2026-11-18T07:31:18+0100 Box 2 now rests on the test of commit 4841f953 in local-decider-remote-error.test.ts (one refused piece of a two-question local escalation): remote 402; the decider refuses the 2-question request (needs 20001 tokens, limit 16384), answers the first single question and refuses the second (needs 16460 tokens). The test asserts request sizes [2, 1, 1], one split_piece_failed warning whose text carries the reason and the count (a split piece of 1 question), warning count 1, one matching stderr line, the answered row, and the refused question as one invalid entry (answer missing from reply). This supersedes the Box 2 note above, which rested on the 4-proposition test of 628142c0. By the worker's report, each assertion of the new test failed when mutated alone; the main agent did not re-run the mutations. Run by the main agent: this file 4 passed, eslint exit 0, tsc --noEmit exit 0 (working tree with other uncommitted edits).
