---
trdd-id: X9ID0KUJ
title: Stop path leftovers after GBC4A4CF (hard-kill test, phase letters, already exited, benchmark noise)
column: backburner
status: tasked
created: 2026-10-31T17:17:09+0100
updated: 2026-11-14T16:07:22+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-31T17:17:09+0100
---

# Stop path leftovers after GBC4A4CF (hard-kill test, phase letters, already exited, benchmark noise)

Leftovers still open at HEAD after the core fix of GBC4A4CF:
1. No test for the 30 s hard-kill path (STOP_FLUSH_GRACE_MS appears only in cli/main.ts:150,179,205).
2. calibration/commands.ts:105 phase letters.
3. broker/registry.ts:244 "already exited".
4. index.ts:502 "has not been benchmarked yet" noise.
Also noted: classifiers/l2/planner.ts:275 message does not name the flag; per-file retry sleeps at index.ts 2615/6261/6405 not individually confirmed.

Parent: TRDD-GBC4A4CF

## Approval log

- 2026-10-31T17:17:09+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-14T16:01+0100 moved here from TRDD-GBC4A4CF at its closing (its body items with no box): models calibrate --help shows the internal label P6 and Accepted profile types any (cli/main.ts about :623; the P6 source line not traced); models server-stop --help does not list the --engine values; on a fresh config Auth: $OPENROUTER_API_KEY is NOT set prints on commands that never contact OpenRouter (index.ts:517) and the banner shows OpenRouter () for an empty pool (index.ts:7878); lock-claim retries and classify model resolution were never traced for sleeps that ignore the stop. New, 2026-11-14 (worker-reported): a fresh-config llm ask with an invalid key that failed fast (exit 1, not stopped) left a detached benchmark.js --detect-profile-changes free from the repo dist (pid 83576, ppid 1), which the harness ended; whether a failed command should leave that updater running is undecided.
2026-11-14T16:07+0100 more GBC4A4CF leftovers that its closing map missed (review of 623aad62): models server-stop waits 10-60 s with no progress line (RUNNER_STOP_WAIT_MS, broker/server-commands.ts:56); the report file on disk of a per-file tool keeps the retry-later sentence after a stop, which was true when written; --until-done has no stop test (box 4 of GBC4A4CF cites command-stop-sleep.test.ts for the sleeps, not an --until-done stop); the every-model-failed stop route is covered by dispatch tests only.
2026-11-14T16:07+0100 GBC4A4CF box 5 follow-up, landed as d3a4b80c: the stop notice now ends finished results, if any, are kept (the earlier are written promised a write the 30 s hard kill can prevent). Observed live after the fix (worker-reported): a local TCP server that never answers, reached through a profile url, gave exit 124 in 5.35 s with that line, no hard-kill line and no result written. Three README runs with an invalid key gave exits 1, 124, 1: whether a fresh-config command waits or fails fast is a race between the timer and the foreground repair's benchmark attempt (about 1.9 s), inferred and not proven, so a spawned test of the waiting stop must use the never-answering server, not the free profile. Notes on the GBC4A4CF closing: the 260b9515 dist was diff-inspected, and only d3a4b80c was byte-compared against a clean-worktree build; the hard-kill line being accurate for a waiting command comes from reading the code, not from seeing it; the order of the asynchronous stop line against the summary is not tested; the pre-fix measurement came from the MEASURE fork; the ubs pre-commit scan of 260b9515 timed out on its own at 180 s, with no bypass. A stale git worktree registration for the removed /tmp/__gbc_wt remains, because git_safety_guard gates git worktree prune.
