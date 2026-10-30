---
trdd-id: GBC4A4CF
title: command_timeout is ignored while a command waits on a profile update, plus 14.2.0 e2e message fixes
column: todo
status: tasked
created: 2026-10-30T10:02:38+0100
updated: 2026-10-30T10:02:38+0100
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
---

# command_timeout is ignored while a command waits on a profile update, plus 14.2.0 e2e message fixes

Found by a quality evaluation of the 14.2.0 end-to-end run. Nothing here is done.

- command_timeout is ignored while a command waits on a profile update. waitForProfileUpdate (scripts/llm-ext/src/foreground-repair.ts:85-120) never checks commandStopReason(); it is called from scripts/llm-ext/src/index.ts:4310 and reached through the empty-pool path at index.ts:4417. On a fresh config with --command_timeout 3, llm ask ran 33 s and was ended by the hard-kill timer (scripts/llm-ext/src/cli/main.ts:193-196) with no summary. Fix: return once the stop is set.
- Misleading hard-kill messages: "the stopped command did not finish writing within 30 s" (cli/main.ts:194) and "0 unfinished local job(s) cancelled; writing the results already complete" (cli/main.ts:191) are wrong when the command was waiting, not writing.
- Decide whether the detached benchmark.js --populate-default-profile free updater should keep running after the command is stopped.
- Missing tests: a CLI-spawn test of the 30 s hard-kill path (STOP_FLUSH_GRACE_MS appears only in cli/main.ts:150,179,194,196), a stop during the profile-update wait, and classify exiting 124.
- models calibration-status prints phase letters ("A pending, B pending, C pending", scripts/llm-ext/src/calibration/commands.ts:105) that a new user cannot decode.
- models server-stop prints "stopped cal llama-server pid N: already exited" (scripts/llm-ext/src/broker/registry.ts:244), which reads as a contradiction, and waits 10-60 s with no progress line (RUNNER_STOP_WAIT_MS, scripts/llm-ext/src/broker/server-commands.ts:56).
- models calibrate --help shows the internal label (P6) and "Accepted profile types: any" (scripts/llm-ext/src/cli/main.ts:623 prints the profile-types line; the P6 text in help was not traced to a source line); models server-stop --help does not list the --engine values (not traced to a source line).
- Noise on a fresh config: "'free' has not been benchmarked yet" on every call including --help (scripts/llm-ext/src/index.ts:498-500); "Auth: $OPENROUTER_API_KEY is NOT set" (index.ts:517) on commands that never contact OpenRouter; banner "OpenRouter ()" for an empty pool (index.ts:7878; the placeholder id is handled at index.ts:7866-7869 but not the empty string).
- The classify refusal "the plan needs 2400 requests, over the limit of 8" (scripts/llm-ext/src/classifiers/l2/planner.ts:275) does not name the flag that raises the limit.

## Approval log

- 2026-10-30T10:02:38+0100 — MANDATE issued by main-agent@llm-externalizer (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
