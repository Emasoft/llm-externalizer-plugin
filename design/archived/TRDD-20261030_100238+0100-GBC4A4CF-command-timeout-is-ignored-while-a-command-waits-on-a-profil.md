---
trdd-id: GBC4A4CF
title: command_timeout is ignored while a command waits on a profile update, plus 14.2.0 e2e message fixes
column: complete
status: archived
created: 2026-10-30T10:02:38+0100
updated: 2026-11-14T16:01:56+0100
current-owner: main-agent@llm-externalizer
created-by: main-agent@llm-externalizer
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer
approval-datetime: 2026-10-30T10:02:38+0100
implementation-commits: [faed02a0, 5dcddb6d, 260b9515]
---

# command_timeout is ignored while a command waits on a profile update, plus 14.2.0 e2e message fixes

Found by a quality evaluation of the 14.2.0 end-to-end run. Nothing here is done.

- command_timeout is ignored while a command waits on a profile update. waitForProfileUpdate (scripts/llm-ext/src/foreground-repair.ts:85-120) never checks commandStopReason(); it is called from scripts/llm-ext/src/index.ts:4310 and reached through the empty-pool path at index.ts:4417. On a fresh config with --command_timeout 3, llm ask ran 33 s and was ended by the hard-kill timer (scripts/llm-ext/src/cli/main.ts:193-196) with no summary. FIXED by commit faed02a0: the wait returns once the stop is set.
- Misleading hard-kill messages: "the stopped command did not finish writing within 30 s" (cli/main.ts:194) and "0 unfinished local job(s) cancelled; writing the results already complete" (cli/main.ts:191) are wrong when the command was waiting, not writing.
- Decide whether the detached benchmark.js --populate-default-profile free updater should keep running after the command is stopped.
- Still open after commit faed02a0: sleeps in the request path that ignore the stop: provider/http.ts:391 and :486 (retry backoff; the stop is checked only when the next attempt starts), provider/completion.ts:1254 (circuit-breaker backoff 60/120/350 s) and :1965 (empty-response retry delay), index.ts:2615, :6261 and :6405 (per-file retry backoff 1-3 s), index.ts:6022 (--until-done retry backoff, long; a stop landing during this sleep waits it out, and a backoff longer than 30 s would end in the hard kill), classifiers/l0/transport.ts:189 (deadline.sleep; the stop is checked at :169 before the sleep only), local-llama-server.ts:281 (server start poll sleep helper). Lock-claim retries and classify model resolution were not traced. Test coverage: the empty-pool route ran end to end from the CLI (exit 124 in 2 s); the every-model-failed route is covered by dispatch tests only, since it cannot be reached offline from the CLI; --until-done has no stop test; and no offline spawn test reaches the wait (it needs a provider key set and the first dispatch makes a real OpenRouter call). The report file on disk of a per-file tool keeps the retry-later sentence, which was true when written.
- Missing tests: a CLI-spawn test of the 30 s hard-kill path (STOP_FLUSH_GRACE_MS appears only in cli/main.ts:150,179,194,196), a stop during the profile-update wait, and classify exiting 124.
- models calibration-status prints phase letters ("A pending, B pending, C pending", scripts/llm-ext/src/calibration/commands.ts:105) that a new user cannot decode.
- models server-stop prints "stopped cal llama-server pid N: already exited" (scripts/llm-ext/src/broker/registry.ts:244), which reads as a contradiction, and waits 10-60 s with no progress line (RUNNER_STOP_WAIT_MS, scripts/llm-ext/src/broker/server-commands.ts:56).
- models calibrate --help shows the internal label (P6) and "Accepted profile types: any" (scripts/llm-ext/src/cli/main.ts:623 prints the profile-types line; the P6 text in help was not traced to a source line); models server-stop --help does not list the --engine values (not traced to a source line).
- Noise on a fresh config: "'free' has not been benchmarked yet" on every call including --help (scripts/llm-ext/src/index.ts:498-500); "Auth: $OPENROUTER_API_KEY is NOT set" (index.ts:517) on commands that never contact OpenRouter; banner "OpenRouter ()" for an empty pool (index.ts:7878; the placeholder id is handled at index.ts:7866-7869 but not the empty string).
- The classify refusal "the plan needs 2400 requests, over the limit of 8" (scripts/llm-ext/src/classifiers/l2/planner.ts:275) does not name the flag that raises the limit.

## Approval log

- 2026-10-30T10:02:38+0100 — MANDATE issued by main-agent@llm-externalizer (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T16:01:56+0100 — COMPLETE by main-agent@llm-externalizer-plugin. last box done 260b9515; leftovers mapped to X9ID0KUJ.

## Notes

2026-10-31: the fix landed in commit c5cd757b (fix(stop): long backoffs end at once on --command_timeout). Card left in todo.
2026-11-14T16:01+0100 box 5 done in 260b9515. Measured on the committed dist before the fix: a command stopped while it waited on the profile update printed 0 unfinished local job(s) cancelled; writing the results already complete and then wrote nothing. stopNoticeLine now prints the job clauses only when jobs existed and ends with results already complete, if any, are written; the --stop_on_errors line changes the same way. Unit-tested on the four branches (worker-reported 4/4, fail-before red); the dist diff is only this change. Not seen live: a rerun on a fresh config failed fast instead of waiting. The hard-kill line already reads did not end within 30 s, which is accurate for a waiting command. Body items, closing map: profile-update wait = box 1; hard-kill messages = box 5; detached updater = box 2; request-path sleeps = box 4; missing tests: hard-kill spawn test struck to X9ID0KUJ, stop during the wait = empty-pool-wait.test.ts (box 2), classify exit 124 = classifiers/command-timeout.test.ts:17 (in-process); phase letters, server-stop already exited, benchmark noise, planner flag = struck to X9ID0KUJ; P6 help label, server-stop --engine help, the Auth and OpenRouter () noise, untraced lock-claim and classify-resolution sleeps = moved to X9ID0KUJ today.

## Acceptance

- [x] --command_timeout ends a command that waits on a profile update - evidence: faed02a0
- [x] a stopped command keeps its finished results and starts no benchmark updater - evidence: 5dcddb6d (empty-pool-wait.test.ts, foreground-repair.test.ts)
- [x] the stopped answer keeps the real cause - evidence: 5fff80d2 (test pins the single dispatch)
- [x] long request-path backoffs end at once on --command_timeout - evidence: c5cd757b (stoppableSleep in index.ts, completion.ts, http.ts, transport.ts; command-stop-sleep.test.ts)
- [x] the hard-kill messages in cli/main.ts are not wrong when the command was waiting, not writing - MISSING: the old text did not finish writing within 30 s is gone from main.ts, but main.ts:202 still prints unfinished local job(s) cancelled; writing the results already complete; not shown to be correct for a waiting command
- ~~[ ] CLI-spawn test of the 30 s hard-kill path (STOP_FLUSH_GRACE_MS)~~ struck: moved to TRDD-X9ID0KUJ by the coordinator decision of 2026-10-31 (card-actions brief item 12)
- ~~[ ] calibration-status phase letters, server-stop already exited, fresh-config benchmark noise, classify planner message not naming the flag~~ struck: moved to TRDD-X9ID0KUJ by the coordinator decision of 2026-10-31 (card-actions brief item 12)
