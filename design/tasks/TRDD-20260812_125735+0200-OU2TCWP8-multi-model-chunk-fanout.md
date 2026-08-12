---
trdd-id: OU2TCWP8
title: Dispatch session-summary chunks across several free models in parallel
column: dev
created: 2026-08-12T12:57:35+0200
updated: 2026-08-12T12:57:35+0200
current-owner: claude-llm-externalizer
task-type: feature
approval-tier: 0
parent-trdd: T4MZ8YQR
implementation-commits: []
---

# Dispatch session-summary chunks across several free models in parallel

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-12

**NEXT ACTION:** implement per-chunk model assignment (round-robin across the top-K eligible
free models) with a per-model in-flight cap, so total parallelism scales with K.

**This is the ONLY remaining item between today's build and the owner's 2–3 minute target for a
666k-token context.**

## The measurement that makes this possible

The OpenRouter free-tier rate bucket is **PER-MODEL, not per-account** — measured, not assumed:

| burst | result |
|---|---|
| 64 concurrent on ONE model | 62/64, **2× 429** (`x-ratelimit-limit: 20`) |
| 64 concurrent split 32+32 across TWO models | **0 × 429** |

So effective parallelism scales with the number of free models used.

## Why it is required (the deadlock it breaks)

Per-stream throughput is fixed and is the real constraint. Measured chunk times at a 25k budget:
**90.6 / 173.0 / 310.6 / 399.7 s**. Wall-clock under concurrency is the SLOWEST chunk, so hitting
~180 s needs each chunk to emit less — i.e. a smaller chunk budget (~8k).

But a smaller budget means MORE chunks (666k ⇒ ~83), and 83 concurrent against ONE model is far
past its ~32 cliff. **Small chunks and single-wave are mutually exclusive on one model.** Spreading
across 4 models is ~21 each — inside every bucket — and dissolves the conflict.

| | chunk size | chunks | fits? | wall-clock |
|---|---|---|---|---|
| today (1 model) | 25k | 27 | yes | ~3.5–6.5 min |
| fan-out (4 models) | 8k | 83 | yes (~21/model) | **~2–2.5 min** |

## Design

1. **Per-chunk model assignment.** Round-robin the first K eligible free models over chunk
   indices. K derived from the eligible list, bounded by `MAX_FANOUT_MODELS`.
2. **Per-model in-flight cap** (`PER_MODEL_CONCURRENCY`, ~20 — below the measured 32 edge for the
   same reason `MAX_AUTO_CONCURRENCY` is 28, not 32).
3. **Auto concurrency becomes** `min(chunkCount, K × PER_MODEL_CONCURRENCY)`.
4. **Chunk budget must use the MINIMUM context window across the K models actually used** — not
   the primary's. Sizing to the largest would overflow the smallest.
5. **Failure isolation.** A model failure demotes THAT model and re-dispatches its chunks to
   healthy ones; it must NOT drain the whole pool.

## The hard part — do not skip

The existing concurrent loop assumes ONE active model: `applyTransition` mutates the shared
`chunks` array and the `mapSummaries` tail, and a failing worker becomes a leader that drains every
sibling behind a pause gate before re-chunking. **That whole-pool drain is exactly wrong when each
chunk has its own model** — one model going bad must not re-chunk work already succeeding on
another.

So the transition machinery has to become per-model: a demotion re-chunks only the chunks assigned
to the demoted model, and only if the replacement model's context differs.

## Acceptance criteria

- [ ] Chunks distribute across K models; no model exceeds `PER_MODEL_CONCURRENCY` in flight.
- [ ] Chunk budget uses the min context across models actually used.
- [ ] One model failing demotes only its own chunks; siblings on healthy models keep their results.
- [ ] Join order still keyed by chunk INDEX, never completion order.
- [ ] `--concurrency 1` still byte-for-byte sequential; single-model behaviour unchanged when K=1.
- [ ] tsc 0 · eslint 0 · full vitest green · build clean.
- [ ] Measured wall-clock on a real transcript, reported — not projected.

## Notes

Depends on and follows: TRDD-0H5N1V9W (deadline covers body read), and T4MZ8YQR's concurrency,
auto-sizing and hedging work (`af60ab4`, `a0cefce`, `ab00cb4`, `dd7023c`).

Lesson already paid for once, recorded so it is not repeated here: a DEADLINE is a backstop and
belongs above the working distribution; cutting the tail is HEDGING's job. Shipping a 120s deadline
against a 90–400s distribution aborted 3 chunks in 4 and tripped the circuit breaker.
