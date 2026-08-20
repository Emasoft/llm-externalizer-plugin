---
trdd-id: S8CKVH8S
title: Incremental compaction — reuse chunk summaries when the transcript only grew
column: complete
created: 2026-08-12T14:36:16+0200
updated: 2026-08-12T15:10:00+0200
current-owner: claude-llm-externalizer
task-type: feature
approval-tier: 0
parent-trdd: T4MZ8YQR
implementation-commits: [6eb7d6a]
---

# Incremental compaction — reuse chunk summaries when the transcript only grew

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-12

**NEXT ACTION:** replace the checkpoint's exact `(transcriptBytes, transcriptMtimeMs)` identity
match with an APPEND-ONLY PREFIX check, so a grown transcript reuses existing chunk summaries and
only the new tail is summarized.

**This is the highest-value remaining item, and it is what makes free-model compaction usable in
practice.**

## Why

Measured on the OpenRouter free tier: per-chunk latency is **91–1478 s**, wildly variable, and NOT
proportional to chunk size. A full compaction of a ~9 MB transcript costs **~10–25 minutes**, and
no chunking / deadline / concurrency / fan-out setting moves that (all four are implemented; see
TRDD-T4MZ8YQR, TRDD-OU2TCWP8, TRDD-0H5N1V9W).

So the only remaining lever is **not redoing work**. Today every run redoes all of it:

```ts
interface CheckpointIdentity {
  transcriptPath: string;
  transcriptBytes: number;     // exact match required
  transcriptMtimeMs: number;   // exact match required
  pruneLevel; chunkerMaxTokens; chunkerOverlapTurns;
}
```

A live session appends to its transcript continuously, so **both fields change on every turn** and
the checkpoint is discarded. `--resume` therefore only helps a run interrupted against a *frozen*
file — never a live session, which is the actual use case.

**The property that makes the fix safe: a Claude Code transcript is APPEND-ONLY.** If the file only
grew and its consumed prefix is byte-identical, every chunk summary computed over that prefix
remains valid by construction.

## Design

1. **Identity keeps** `transcriptPath`, `pruneLevel`, `chunkerMaxTokens`, `chunkerOverlapTurns` —
   a change in any of those genuinely invalidates prior chunking.
2. **Replace the size/mtime equality** with: store the byte length consumed at checkpoint time plus
   a **hash of that consumed prefix**. On resume:
   - current size **≥** stored size **and** prefix hash matches ⇒ **REUSE** every completed chunk
     summary; chunk and summarize only the turns after the last completed chunk boundary.
   - current size **<** stored, or prefix hash differs (rewrite / rotation / different file) ⇒
     full restart, exactly as today. **Fail safe, never silently reuse against a changed prefix.**
3. **Turn atomicity is preserved:** resume from the last COMPLETED chunk boundary. A partially
   consumed trailing chunk is recomputed, never spliced.
4. **Join stays deterministic and index-ordered** — appended chunks extend the list; earlier
   indices never shift.

## Why this changes the economics

| | today | with incremental |
|---|---|---|
| first run | 10–25 min | 10–25 min (unchanged) |
| a run 5 min later | 10–25 min (full redo) | **only the new turns** — seconds to a couple of minutes |

That is what makes the janitor's cache-expiry design viable (issue #251): pre-compute on a cadence,
each tick cheap, and `/clear` + inject an always-fresh summary is instant.

## Acceptance criteria

- [ ] A grown transcript with an unchanged prefix reuses prior chunk summaries; only new turns are
      sent to a model (assert on the call count, not on wall-clock).
- [ ] A transcript whose prefix CHANGED does a full restart — no stale reuse.
- [ ] A TRUNCATED / shorter transcript does a full restart.
- [ ] Changing `--prune` / `--max_chunk_tokens` / overlap still forces a full restart.
- [ ] Join output is identical to a from-scratch run over the same final transcript.
- [ ] tsc 0 · eslint 0 · full vitest green · build clean.

## Notes

Depends on nothing outstanding; the checkpoint machinery, atomic writes and resume path already
exist — this changes the *identity predicate* and adds a tail-only chunking path.

Do NOT reach for a faster model as the fix. Measured: free-tier latency is queue/contention bound
(a `max_tokens=8` request still costs ~35 s), and local backends are unavailable — the owner uses
them for other work (2026-08-12).
