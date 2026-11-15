---
trdd-id: TYHKAKCB
title: session-summary and Jev compaction accept local profiles and prefer Locals with LFM3 1.7B
column: design
status: tasked
created: 2026-11-14T21:26:56+0100
updated: 2026-11-15T01:24:30+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T21:26:56+0100
---

# session-summary and Jev compaction accept local profiles and prefer Locals with LFM3 1.7B

Goal item (USER /goal 2026-11-14, TRDD-EB1XGLMJ): 'jev compaction must work perfectly too, local or remote api, and so the summariztion of the session via local models like liquidai LFM3 1.7B. Always use the locale inferencer because it handles multiple requests without reducing speed.' Measured 2026-11-14 (TRDD-3SNQAGIC trace): session_summary selects models only from the OpenRouter catalog, :free ids only (session_summary/model-select.ts, tools/definitions.ts:352-353 'a local server cannot serve them'), and its accepted profile types are free and paid (definitions.ts:353), so --profile locals-mlx is refused by profileSelectionRefusal (profile-accept.ts:55-61). A local path does not exist. Design owed: how session_summary and Jev compaction run on the locals-mlx profile (LiquidAI/LFM3-1.7B-MLX-4bit first) through the governor, chunk sizing for a small context window, and when they fall back to it (remote unavailable, per the fallback cards 3CG178O7 PN0N4290 78LZFUVJ WSPV40Y5). Search the transcripts for the owner's model and server directives before designing.

## Approval log

- 2026-11-14T21:26:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

2026-11-15T00:55:19+0100 implemented, uncommitted: session_summary/local-model.ts (new) + driver.ts + model-select.ts + index.ts session_summary case + definitions.ts (session_summary accepts local, free, paid).
Decision (agent): remote free models first, the first fit managed local model LAST; an explicitly selected local profile runs local-only; no local fallback under an explicit --min-context.
Local candidates: locals-mlx model, second, third, then local_llama; only server managed (broker + governor leases); each sized alone from its calibration record, task kind aggregate.
A model unfit for aggregate (fill 0, e.g. LFM3-1.7B-MLX-4bit measured 2026-11-15) is skipped with a stderr line; all unfit + no remote = FAILED naming each model and reason.
Uncalibrated local model: waited for only when local-only; with remote models present it is left out with one line.
Open: a single transcript turn larger than the local chunk budget fails loudly (atomic-turn invariant in chunker.ts, unchanged); driver.test.ts not run.
2026-11-15T01:01:55+0100 coordinator round: selection moved into local-model.ts resolveSessionSummaryChain behind injected seams; index.ts diff now 15+/17-.
Uncalibrated local model skipped while remote is up: the preferred one is queued for background calibration via calibration/commands.ts queueManual (no --force, idempotent) plus ensureCalibrator; one line printed.
Exhaustion message: local sentence appended at the END, only when the chain held a local model; driver.test.ts:872 toContain span unchanged (read, not run).
Real-broker test not feasible: broker/client.ts ensureBroker requires isBrokerProcess(pid) and otherwise spawns the real broker entry (dist).
2026-11-15T01:08:54+0100 refinements: background enqueue at most once per model per process and never while liveCalibrator reports a runner; only the preferred uncalibrated model is queued (deviation, one calibration at a time).
CHUNKER_CHARS_PER_TOKEN_CEILING back to 5; realistic fixture; test shows the driver re-splits a chunk the local server rejects as a context overflow.
End-to-end test: session_summary dispatched under a local profile reaches a stand-in broker process (argv __broker, real sockets) via the real index.ts wiring; passes.
Exhaustion message: first sentence reworded only when the chain held a local model; local id appended at the end; no-local text byte-identical (driver.test.ts:872 toContain).
2026-11-15T01:10:43+0100 CORRECTION: the earlier line 'Real-broker test not feasible' is superseded; the end-to-end stand-in broker test exists and passes (governor leasing not covered by the stand-in).
classifyContextOverflow now also matches llama.cpp 'exceed_context_size_error' / 'exceeds the available context size'; Locals (MLX) wording still unknown.
Known cost: a remote run with an uncalibrated preferred local model may wait up to 30 s on the calibration state lock (queueManual) once per process.
driver.test.ts not run by the worker (rule); coordinator to run it before push.
2026-11-15T01:24:29+0100 Known cost fixed (uncommitted, local-model.ts): queueLocalCalibrations no longer calls queueManual (30 s synchronous lock wait); it enqueues under withStateLock(dir, 0) (at most one 20 ms poll); a busy lock = one stderr line, nothing queued, no runner start, per-process memo cleared so a later run retries. markProfileUsed untouched (still only startCalibration calls it). Test src/session_summary/local-model-lock.test.ts passes.
2026-11-15T01:24:30+0100 CORRECTION: the 5638718b claim 'local models never hold a lease as a loser' was not true for the replaced-slot fan-out path (applyFanoutTransition can hand a slot the local model; its owner and speculative calls carried no abort signal) until the TRDD-3SNQAGIC hedge/speculative abort fix; governor queueing is not exercised by any test (the e2e uses a stand-in broker).
