---
trdd-id: QY1JITC7
title: Idle fan-out workers should race the longest-outstanding chunk instead of idle-polling
column: backburner
created: 2026-08-14T17:41:39+0200
updated: 2026-08-14T17:48:00+0200
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

- [ ] An idle fan-out worker launches at most one speculative attempt, on the
      longest-outstanding in-flight chunk, from a slot at zero in-flight count.
- [x] A test proves the map phase does NOT wait on a speculative attempt whose chunk was
      committed by its real owner (the hazard above). This test is written BEFORE the
      feature. **DONE 2026-08-14, commit `f3d521f`** — `driver.test.ts`, fan-out block,
      "the map phase never waits on an attempt whose chunk is already committed". It
      encodes the hazard, not the feature: a call for an already-answered marker is
      answered after 3s, so a non-abandoning implementation blows the bound. Verified to
      FAIL (exit 1) under an induced duplicate call before being kept.
- [ ] A losing racer never calls `applyFanoutTransition` and never mutates `activeModelIdx`.
- [ ] Commit path goes through `writeChunkSummaryOnce`; no double-write under a late settle.
- [ ] Per-model in-flight never exceeds `PER_MODEL_CONCURRENCY`, speculative included.
- [ ] Sequential (`concurrency <= 1`) path is byte-for-byte unaffected.
- [ ] Re-measure on a >5 MB transcript and record the new wall clock beside the 146s
      baseline. Report the DISTRIBUTION over >=3 runs, not one number — a single run is
      a draw, and the whole point of this TRDD is that draws vary.

## Explicitly out of scope

Guaranteeing <2 minutes. That needs a fast paid or local backend and should be a separate,
opt-in flag; it must not silently change the default free backend.
