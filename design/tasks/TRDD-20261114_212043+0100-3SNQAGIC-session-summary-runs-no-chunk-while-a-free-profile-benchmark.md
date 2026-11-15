---
trdd-id: 3SNQAGIC
title: session-summary runs no chunk while a free-profile benchmark runs, so a 600 s caller gets no summary (issue 19)
column: testing
status: tasked
created: 2026-11-14T21:20:43+0100
updated: 2026-11-15T17:22:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T21:20:43+0100
implementation-commits: [166a0861, 43974a33, cf7873ae, 4825feee]
---

# session-summary runs no chunk while a free-profile benchmark runs, so a 600 s caller gets no summary (issue 19)

Source: GitHub Emasoft/llm-externalizer-plugin#19, filed 2026-11-14 by the perch session. Facts reported (timestamp correlation, not traced in code): at 20:59 llm-ext session-summary --stdout on a 4 MB transcript (janitor /janitor-write-handoff, free profile because settings.yaml has no active: key) logged 3 chunk calls (24.0 s, 26.5 s, 105.9 s) under op-60dbd8da then nothing, killed at 600 s; over the same window op-ac2aadf1 cli:benchmark() ran from the caller cwd, 6 models serially 20:59:42-21:10:40, then populate-default-profile free wrote 5 models (settings.yaml and both *-profiles-state.json mtime 21:10); the benchmark report landed in the caller project reports/ (also one at 20:00:30). Checked 2026-11-14 21:2x: local_llama and locals-mlx profiles survived. To trace: what starts the benchmark (session-summary path, free-profile auto-repopulate, or another process); why the summary stalls behind it; why reports go to the caller cwd; why there is no active: key. Related goal item: Jev compaction and local LFM session summary (TRDD-EB1XGLMJ).

## Approval log

- 2026-11-14T21:20:43+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-11-14T21:25:18+0100 Scope narrowed, owner ruling relayed by the perch session (issue 19 body and title edited, withdrawal comment added): the benchmark rewriting settings.yaml is INTENDED (it tracks provider and model changes so commands keep working; not a suspect for the profile losses) and its report under the project's reports/llm-externalizer/ is the documented default report root. Only the stall remains: session-summary ran no chunk during the ~11-minute serial benchmark, so a caller with a 600 s timeout got no summary.
2026-11-14T21:26:55+0100 TRACE (read-only sonnet worker, code + ~/.llm-externalizer logs): the benchmark did NOT block the summary. Checkpoint session-summary-checkpoints/c9165fdfad93e9f4.json has totalChunks=1 and finalSummary, updatedAt 20:59:25.729 local; the detector spawned 20 ms later from the session-summary dispatch finally (index.ts:8209-8211 spawnDetachedDetector, detectAfterDispatch set ~4735 because settings has no active: so free applies); populate/benchmark child at 20:59:28 (detached grandchild, bench-spawn.ts:179-181). The 3 logged calls are racers for ONE chunk (MAX_FANOUT_MODELS 4, driver.ts:223/1360/1740-1779/1858-1877); the winner committed at 24.0 s, losers at 26.5 s and 105.9 s. ROOT CAUSE (INFERRED, to confirm): driver.ts has no AbortController, loser racers keep running to their 600 s deadline (DEFAULT_CHUNK_TIMEOUT_MS driver.ts:271) and the CLI success path (cli/main.ts ~1018-1022) has no exit, so the process stays alive up to ~600 s after the summary is on stdout; a caller that waits for exit kills it at 600 s. Same shape at 20:49 (op-af514dae) without a benchmark. history.log records no FAILED lines at all, so a hung racer leaves no trace. Q4: missing active: is the documented fallback (config.ts:1712), not dropped by the benchmark.
2026-11-14T22:01:03+0100 Fix landed 166a0861: single-chunk racer losers aborted on commit, signal reaches the HTTP fetch, aborted loser is no verdict; 5 new tests pass. OWED follow-ups: the multi-chunk hedge loser, the idle-slot speculative racers, and local-profile racers still run un-aborted.
- 2026-11-14T22:01:13+0100 — column → testing by main-agent@llm-externalizer-plugin. single-chunk fix landed 166a0861; follow-ups owed; full suite at pre-push
2026-11-15T01:14:39+0100 Local-racer follow-up (uncommitted): sendChat now passes the caller signal to brokerExchange, so an abort cancels the broker job (DELETE); an abort during the broker POST is no longer a networkFailure. New test src/provider/broker-abort.test.ts (real 127.0.0.1 fake broker) passes, fails without the fix. No live caller aborts a broker request yet: the only signalled path (single-chunk race, driver.ts:1816) is remote-only (fanoutK, driver.ts:1415-1416); a replaced slot (driver.ts:2191) can hold the local model but its slot and speculative calls (driver.ts:2275, 2331) pass no signal, and hedge skips local (driver.ts:2543).
2026-11-15T01:21:57+0100 Local-racer follow-up revised after review: the broker POST no longer takes the caller signal. The abort is honoured right after the 202, when the job id is known, so the finally DELETEs the job. WHY: the abandon rule drops only queued jobs (broker/scheduler.ts:166), so a job a mid-POST abort left behind could run on the local server until its timeout. broker-abort.test.ts has 3 tests, all passing. Negative controls: with the old POST code the POST-abort test fails on a missing DELETE; with no signal in sendChat both abort tests fail; the control test is unaffected by design.
2026-11-15T01:24:29+0100 Hedge loser + speculative racers (uncommitted, driver.ts): hedge primary and hedge each get an AbortController and raceForFirstOk aborts the loser on the first ok; fan-out owner and speculative calls go through trackedChunkCall and fireChunkSettled (commit or supersession) aborts every still-running call on the chunk, so a replaced slot holding the local model is covered too; an aborted owner (ChunkAbortedError) is treated as decided elsewhere, never thrown. New src/session_summary/driver-abort.test.ts, 4 tests, real timers, all pass; driver.test.ts not run (pre-push).
- 2026-11-15T17:22:05+0100 the notes saying 'uncommitted' are stale: 43974a33, cf7873ae and 4825feee landed (git log). Left: the pre-push full run.
