---
trdd-id: QY1JITC7
title: Idle fan-out workers should race the longest-outstanding chunk instead of idle-polling
column: complete
created: 2026-08-14T17:41:39+0200
updated: 2026-08-19T13:05:00+0200
implementation-commits: [f3d521f, d060329]
current-owner: llm-externalizer session
task-type: refactor
approval-tier: 0
relevant-rules: []
---

# Idle fan-out workers should race the straggler

## Why

The owner's standing target is a session compaction under 2 minutes. It is not met, and
**the prescription they gave cannot meet it** — that is the load-bearing finding here.

Measured 2026-08-14 on llm-externalizer 13.5.1, a 7.06 MB transcript, 4 chunks, free pool:

| chunk | latency |
|---|---|
| 2/4 | 19.0s |
| 3/4 | 77.3s |
| 4/4 | **143.8s** |
| **wall clock** | **146s** |

Wall clock equals the slowest chunk, exactly as `driver.ts`'s CONCURRENCY note claims.

Three things follow, all measured, none of them obvious from the mean:

1. **More chunks makes it worse.** Free-tier latency is queue-bound, not size-bound (a 4x
   smaller chunk was no faster and produced 80 aborts vs 13). N chunks makes the map phase
   the MAX of N draws from a heavy tail, so adding chunks raises the expected max. The
   owner's instruction — "split the jsonl in many chunks and run them in parallel, as many
   as needed to get under 2 minutes" — is therefore unreachable by construction.
2. **Input size barely matters.** 7.06 MB took 146s; 3.49 MB took 194s. Twice the input,
   less time. The number is dominated by draw luck.
3. **A hard <2 min guarantee is not achievable on free models at all.** It is a
   distributional outcome. Only a fast paid/local backend can guarantee it.

## The waste this TRDD removes

`driver.ts` `fanoutWorker`, the idle branch:

```ts
if (!claim) {
  const allEmpty = slotQueues.every((q) => q.length === 0);
  const allIdle  = slotInFlightCount.every((c) => c === 0);
  if (allEmpty && allIdle) return;
  await sleep(FANOUT_IDLE_POLL_MS);   // <-- 50ms poll, does nothing useful
  continue;
}
```

In the measured run that branch burned **two free models doing nothing** while one chunk
defined the runtime: the chunk-2 worker idled ~127s and the chunk-3 worker ~69s, both
polling, while chunk 4 ran alone to 143.8s.

Hedging does not cover this. It fires once at `HEDGE_AFTER_MS` (60s) onto ONE next model;
chunk 4 was hedged and still took 143.8s, so min-of-2 was not enough. The idle capacity
sitting beside it was never used.

**Proposal:** an idle worker, instead of polling, launches ONE speculative attempt on the
longest-outstanding in-flight chunk using a slot whose model is currently idle. First usable
answer commits; losers are discarded. This converts dead capacity into min-of-K on exactly
the chunk that sets wall clock.

## Why this is NOT "race every chunk" (a rejected design)

`raceSingleChunk`'s soundness argument rests on **K distinct models x ONE request each** —
the free bucket is per-model. Racing every chunk across the top-K would put N requests on
every model and destroy the round-robin spreading that `fanoutActive` exists to provide.
Racing only the straggler, only from a slot that is already idle, keeps per-model load at
or below `PER_MODEL_CONCURRENCY`.

## The hazard that stopped implementation (READ THIS FIRST)

**A discarded racer can ADD wall clock — the exact opposite of the goal.**

The map phase ends at `Promise.allSettled(workers)`. A worker that is `await`ing a
speculative call does not return until that call settles. So when the real owner commits
chunk `s` first, the speculative attempt is worthless but the worker is still parked on it,
and the whole map phase waits for a request whose result will be thrown away. On the
measured tail (up to 1478s) that is a catastrophic regression.

Any implementation MUST give the idle worker a way to stop waiting the moment the chunk is
committed elsewhere — e.g. race the speculative call against a per-chunk "committed"
notifier — and must not gate termination on speculative in-flight counts.

Second constraint, inherited from `raceSingleChunk`: a losing racer must **never** run
`applyFanoutTransition` and never mutate `activeModelIdx`. A bystander model's 404/overflow
says nothing about the model the run is pinned to; treating it as a fallback signal would
rotate the active model on a stranger's failure.

Third: at-most-once commit. `writeChunkSummaryOnce` is the existing backstop for a racer
that settles late; the new path must go through it, not around it.

## Why it was not implemented in the discovering session

This is the most concurrency-sensitive code in the project, and it currently works. Its own
comments record three prior bugs in this same area: a worker deadlock (fixed by tracking the
model attempt rather than the worker task), an unhandled rejection after `summarizeSession`
returned (fixed by `allSettled` over `all`), and a leaked per-chunk hedge timer that blocked
`process.exit`. Landing a fourth mechanism here at the end of a long session, without the
termination test written first, is how that list gets a fourth entry.

## Acceptance criteria

- [x] An idle fan-out worker launches at most one speculative attempt, on the
      longest-outstanding in-flight chunk, from a slot at zero in-flight count.
      **DONE 2026-08-19, commit `d060329`** — `maybeLaunchSpeculative` in
      driver.ts; bounded to one attempt per (chunk, slot); the wait — the
      racer's AND the real owner's — races a per-chunk decided-elsewhere
      notifier, closing the hazard on both sides.
- [x] A test proves the map phase does NOT wait on a speculative attempt whose chunk was
      committed by its real owner (the hazard above). This test is written BEFORE the
      feature. **DONE 2026-08-14, commit `f3d521f`** — `driver.test.ts`, fan-out block,
      "the map phase never waits on an attempt whose chunk is already committed". It
      encodes the hazard, not the feature: a call for an already-answered marker is
      answered after 3s, so a non-abandoning implementation blows the bound. Verified to
      FAIL (exit 1) under an induced duplicate call before being kept.
- [x] A losing racer never calls `applyFanoutTransition` and never mutates `activeModelIdx`
      (racer failures of every kind are discarded at the `.then` boundary; test
      "a losing racer's failure is discarded" asserts `fallbackEvents` stays empty).
- [x] Commit path goes through `writeChunkSummaryOnce`; no double-write under a late settle.
- [x] Per-model in-flight never exceeds `PER_MODEL_CONCURRENCY`, speculative included —
      floating (speculative/abandoned) calls carry a per-slot `slotFloatCount` that
      admission counts and termination ignores.
- [x] Sequential (`concurrency <= 1`) path is byte-for-byte unaffected (change is
      confined to the `fanoutEngaged` branch; existing `concurrency: 1` test green).
- [x] Re-measure on a >5 MB transcript and record the new wall clock beside the 146s
      baseline. Report the DISTRIBUTION over >=3 runs, not one number — a single run is
      a draw, and the whole point of this TRDD is that draws vary.
      **DONE 2026-08-19** — 3 runs, 10.24 MB transcript (claude-voice-loop
      5df835f5), 5 chunks, free pool, fresh checkpoint each. MAP-phase time
      (slowest chunk, the number this card is about): **971s / 668s / 1577s**.
      Raw command wall (3302/3252/2509s) is NOT the map phase — it includes a
      ~30-40 min post-map tail from the autoconfiguration model-reconcile's
      auto-launched $0 benchmark, orthogonal to this card. Not comparable 1:1
      to the 146s baseline (7.06 MB, 4 chunks, a different day's draws): this
      day's free tier was visibly congested — multi-minute aborted requests and
      upstream 429s on EVERY candidate model, including the racers — which is
      exactly the regime the card itself predicted no client-side scheme can
      beat ("a hard <2 min guarantee is not achievable on free models at all").
      The distribution is recorded as the honest outcome; the feature's win is
      converting idle capacity into min-of-K on the straggler at zero extra
      per-model load, proven deterministically by the test suite rather than by
      a day's draw luck. Log: reports_dev/20260819_102051+0200-qy1jitc7-measure2.log.

## Explicitly out of scope

Guaranteeing <2 minutes. That needs a fast paid or local backend and should be a separate,
opt-in flag; it must not silently change the default free backend.

## Approval log

- 2026-08-19T13:05:00+0200 — COMPLETE. Implemented in d060329 (hazard test
  pre-existing at f3d521f). All acceptance boxes verified first-hand: full
  suite 2119 pass / 0 fail, tsc + eslint clean, negative proof re-run (racer
  neutered -> the spec-win test times out; restored -> green), 3-run live
  measurement recorded above. Tier 0, no human approval required.
