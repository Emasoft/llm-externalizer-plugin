---
trdd-id: WCVCBXMB
title: completion.test.ts payment-error case has a 5000 ms wall-clock bound that a loaded machine can miss
column: backburner
status: tasked
created: 2026-11-14T01:05:29+0100
updated: 2026-11-19T01:11:01+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T01:05:29+0100
implementation-commits: [055abc42]
---

# completion.test.ts payment-error case has a 5000 ms wall-clock bound that a loaded machine can miss

src/provider/completion.test.ts:780 (HTTP 400 payment-error case, D1) asserts elapsed < 5000 ms. During npm test batch 1 on 2026-11-14 between 00:34:02 and 00:42:10+0100 (birth and last write of the test log) it measured 5187 ms while a second full suite ran in the same tree; run alone it passed 12/12. In-process test, not a child-process one (TRDD-CBOTP0DY covers those). Cause inferred, not shown: machine load. Acceptance: the bound is justified or replaced by a check that does not depend on wall-clock speed, and the test passes under a concurrent full suite.

## Approval log

- 2026-11-14T01:05:29+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-19T01:06:49+0100 main agent (written by worker): completion.test.ts timing bound seen again in the 14.7.3 publish runs. 14.7.3 publish runs (facts verified by the main agent 2026-11-19, corrected the same day): runs 1-5 failed timing-dependent tests, a different set each run. Start loads (1/5 min) read from the run outputs: run 1 not recorded; run 2 8.65/11.17 (failed broker M3); run 3 33.02/33.24 (failed governor-direct); run 4 9.09/30.19 (failed completion and empty-pool-wait); run 5 26.07/29.58 (failed index.test, completion, retry-clock); run 6 10.15/11.98 (all tests passed: unit 6593, broker stage 222, burn, e2e; then stopped on two CPV findings fixed in 1b7b3d82); run 7 6.19/13.62 (published v14.7.3, release commit ac3fcdef, 2026-11-19T00:57+0100). The start load does NOT separate passing from failing runs (run 2 started low and failed): the data is consistent with load during the run at most, with one green test run at low start load; the cause is not established. The load gate (start only when the 1-min and 5-min load are both <= 14) lives only in a session scratchpad wrapper, not in publish.py or any tracked file; run 2 shows that a start-load gate alone is weak. Run 5 failed completion.test.ts:789 (the 500-after-401 call threw 'Retry window closed without a successful answer (4 request(s) over 6s, last status 500 from openrouter)' instead of the raw 500 message). 055abc42 changed the bound of the completion 500-after-400/401 call from 5000 to 10000 ms and the test timeout from 20 s to 30 s (worker report reports_dev/flaky-fix/20261118_211000+0100-report.md, not re-run by the main agent; each changed test passed 2 of 2 single runs at load 10-20, the originals passed 15 of 15 single runs at load 21-66 with burners (per the worker report, not on a quiet host), so no failure was reproduced). Whether the :780 case of this card is the test 055abc42 changed was not established by the worker, so 055abc42 is not added to this card (it has no implementation-commits field); the card stays in backburner.
2026-11-19T01:10:02+0100 correction by the worker: the note above of 2026-11-19 was first written with the spec's start-load lines and the '15 of 15 loaded baseline runs' wording; both were replaced in place the same day by the main agent's corrected facts (per-run start loads read from the run outputs; originals passed 15 of 15 single runs at load 21-66 with burners, per the worker report).
2026-11-19T01:11:01+0100 correction by the worker after review: 055abc42 is now in implementation-commits. The note above said it was not added because the :780 case was not established as the changed test; checked: in 055abc42^ completion.test.ts the only 'toBeLessThan(5000)' is line 791, inside describe 'payment errors — skip when certain, retry once when not, never a breaker pause (D1)', in the test 'HTTP %i makes %i request(s) per call over %i calls ...' (400 and 401); 055abc42 changes exactly that assertion to 10_000 (test timeout 20 s -> 30 s). WPH1158N also cites it as completion.test.ts:791. The line number differs from this card's :780 (the file changed since 2026-11-14). The fix is a bound loosening, rests on code reading and is not shown under load, so the card's acceptance stays open.
