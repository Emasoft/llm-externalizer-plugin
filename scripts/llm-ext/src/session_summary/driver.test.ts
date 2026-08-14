// Unit tests for driver.ts — the session-summary map-reduce driver.
// No network: every model call goes through an injected fake `callModel`.
// All IO is against per-test tmp fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  summarizeSession,
  joinChunkSummaries,
  isEchoResponse,
  DEFAULT_MAX_CHUNK_TOKENS,
  MAX_AUTO_CONCURRENCY,
  PER_MODEL_CONCURRENCY,
  MAX_SUMMARY_COMPLETION_TOKENS,
  setHedgeAfterMsForTests,
  type CallModelFn,
} from "./driver.js";
import type { EligibleModel } from "./model-select.js";
import { resetCooldownCacheForTests } from "../free-rotation.js";

const FREE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const PAID_MODEL = "anthropic/claude-sonnet-5";
const FALLBACK_MODEL = "vendor/fallback-small-context:free";

describe("driver: summarizeSession", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-summary-driver-"));
    // recordUnavailable() (free-rotation.ts) persists cooldown bookkeeping
    // to getConfigDir()/free-cooldowns.json on every fallback switch —
    // redirect it to a per-test tmp dir so these tests never touch the
    // developer's real ~/.llm-externalizer config (same pattern as
    // free-rotation.test.ts).
    prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = mkdtempSync(join("/tmp", "llm-ext-driver-cooldowns-"));
    resetCooldownCacheForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
    setHedgeAfterMsForTests(null); // never leak a shrunk hedge delay into another test file
  });

  function writeTranscript(lines: unknown[], name = "in.jsonl"): string {
    const p = join(dir, name);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }

  function userTurn(uuid: string, text: string): unknown {
    return { type: "user", uuid, parentUuid: null, timestamp: "t", message: { role: "user", content: text } };
  }

  function checkpointPath(): string {
    return join(dir, "checkpoint.json");
  }

  // ── Window budget vs the provider's completion ceiling ───────────────

  it("a model whose max_completion equals its whole context still yields a usable input budget", async () => {
    // REGRESSION, from a real catalog entry: nvidia/nemotron-3-super-120b-a12b:free
    // reports context_length == max_completion_tokens == 262144. Reserving the
    // provider's FULL completion allowance left nothing for input, so the usable
    // budget went negative and clamped to the 1_000 floor. Under fan-out (which
    // takes min() across the top-K models) that one entry poisoned the whole run:
    // a real transcript failed to chunk at all, reporting a ~4.4k-token turn as
    // too large for a "1000 token" budget. The fix reserves what we actually
    // REQUEST, not the worst case the provider permits.
    const degenerate: EligibleModel = {
      id: "vendor/degenerate-completion:free",
      contextLength: 262_144,
      maxCompletionTokens: 262_144, // == contextLength, the shape that broke it
    };
    // A turn far larger than the old 1_000-token clamp, but trivial for the real budget.
    const p = writeTranscript([userTurn("u1", "budget regression ".repeat(600))]);

    let requestedMaxOutput = -1;
    const callModel = vi.fn<CallModelFn>(async (_prompt, _modelId, maxOutputTokens) => {
      requestedMaxOutput = maxOutputTokens;
      return "SUMMARY";
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: degenerate.id,
      modelMaxContext: degenerate.contextLength,
      modelMaxCompletionTokens: degenerate.maxCompletionTokens,
      chunkOverlapTurns: 0,
      callModel,
    });

    // Before the fix this threw from chunkTurns ("exceeds the model's usable
    // budget of 1000 tokens even alone") and never reached the model.
    expect(result.totalChunks).toBeGreaterThanOrEqual(1);
    expect(callModel).toHaveBeenCalled();
    // And we must not ASK for the provider's full 262k allowance either — the
    // reservation and the request have to describe the same thing.
    expect(requestedMaxOutput).toBe(MAX_SUMMARY_COMPLETION_TOKENS);
  });

  // ── Cost safety ──────────────────────────────────────────────────────

  it("refuses a non-free modelId before touching the transcript or calling the model (cost-safety chokepoint)", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const callModel = vi.fn<CallModelFn>(async () => "should never be called");
    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: PAID_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        callModel,
      }),
    ).rejects.toThrow(/free_only cost-safety/);
    expect(callModel).not.toHaveBeenCalled();
  });

  // ── End-to-end map-reduce on a small fixture ────────────────────────

  it("summarizes a single-chunk transcript with no reduce needed (map output IS the summary)", async () => {
    const p = writeTranscript([userTurn("u1", "please add a login page"), { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }]);
    const callModel = vi.fn<CallModelFn>(async (prompt) => `SUMMARY(${prompt.length} chars)`);

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      callModel,
    });

    expect(result.totalChunks).toBe(1);
    expect(result.summary).toMatch(/^SUMMARY\(/);
    expect(result.resumedFromCheckpoint).toBe(false);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  // ── Compaction-equivalent prompt schema (map-only — no fold call) ────

  it("map prompt asks for the nine compaction sections, verbatim headings, in order, with verbatim-user-message and no-filler instructions", async () => {
    const p = writeTranscript([userTurn("u1", "please add a login page")]);
    let seenPrompt = "";
    const callModel = vi.fn<CallModelFn>(async (prompt) => {
      seenPrompt = prompt;
      return "a real summary of what happened";
    });

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      callModel,
    });

    // The nine sections, exact headings, in order.
    const sectionTitles = [
      "## Primary Request and Intent",
      "## Key Technical Concepts",
      "## Files and Code Sections",
      "## Errors and Fixes",
      "## Problem Solving",
      "## All User Messages",
      "## Pending Tasks",
      "## Current Work",
      "## Next Step",
    ];
    let lastIndex = -1;
    for (const title of sectionTitles) {
      const idx = seenPrompt.indexOf(title);
      expect(idx, `expected "${title}" in the map prompt`).toBeGreaterThan(-1);
      expect(idx, `expected "${title}" to appear after the previous section`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(seenPrompt).toMatch(/copied VERBATIM and in order/);
    expect(seenPrompt).toMatch(/OMIT any section with no content in this part/);
    expect(seenPrompt).toMatch(/never write "none", "N\/A", or filler/);
    expect(seenPrompt).toContain("Your output REPLACES the transcript for a future session that must RESUME this work");
    expect(seenPrompt).not.toContain("You are folding"); // no fold phase exists any more
  });

  it("maps every chunk then joins the per-chunk summaries deterministically, in chunk order — no second (fold) model call", async () => {
    // Force multiple chunks with a tiny maxChunkTokens so each user turn
    // lands in its own chunk.
    const lines = Array.from({ length: 5 }, (_, i) => userTurn(`u${i}`, `request number ${i} `.repeat(20)));
    const p = writeTranscript(lines);

    let mapCalls = 0;
    const callModel = vi.fn<CallModelFn>(async (prompt) => {
      expect(prompt).not.toContain("You are folding"); // every call is a MAP call
      mapCalls++;
      return `CHUNK-${mapCalls}`;
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30, // tiny — forces several chunks
      chunkOverlapTurns: 0,
      callModel,
    });

    expect(result.totalChunks).toBeGreaterThan(1);
    expect(mapCalls).toBe(result.totalChunks);
    // "No facts lost in the merge" is provable by construction: the joined
    // output IS the deterministic concatenation of every per-chunk summary,
    // in order — assert it directly against the exported join function.
    const expectedPieces = Array.from({ length: result.totalChunks }, (_, i) => `CHUNK-${i + 1}`);
    expect(result.summary).toBe(joinChunkSummaries(expectedPieces));
    for (const piece of expectedPieces) {
      expect(result.summary).toContain(piece); // every chunk's summary survives, verbatim
    }
  });

  // ── Checkpoint / resume ──────────────────────────────────────────────

  it("checkpoints after every successful map chunk, so a mid-run failure preserves prior chunk summaries", async () => {
    const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `distinct request ${i} `.repeat(20)));
    const p = writeTranscript(lines);

    let calls = 0;
    const callModel = vi.fn<CallModelFn>(async () => {
      calls++;
      if (calls === 3) throw new Error("simulated transient provider bug");
      return `CHUNK-${calls}`;
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        maxRetriesPerChunk: 0, // fail on first non-availability error, no retry noise
        callModel,
      }),
    ).rejects.toThrow(/chunk 2 failed after 1 attempt/);

    const saved = JSON.parse(readFileSync(checkpointPath(), "utf-8")) as { mapSummaries: (string | null)[] };
    expect(saved.mapSummaries[0]).toBe("CHUNK-1");
    expect(saved.mapSummaries[1]).toBe("CHUNK-2");
    expect(saved.mapSummaries[2]).toBeNull(); // the failed one never got recorded
  });

  it("resumes an interrupted run: already-checkpointed chunks are not re-sent to the model", async () => {
    const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `distinct request ${i} `.repeat(20)));
    const p = writeTranscript(lines);
    const cp = checkpointPath();

    let calls = 0;
    const failThenSucceed = vi.fn<CallModelFn>(async () => {
      calls++;
      if (calls === 3) throw new Error("simulated transient provider bug");
      return `CHUNK-${calls}`;
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        maxRetriesPerChunk: 0,
        callModel: failThenSucceed,
      }),
    ).rejects.toThrow();

    // Resume with a model that always succeeds; the two already-completed
    // chunks must NOT be re-sent — only the remaining ones.
    const resumeCalls: string[] = [];
    const resumeModel = vi.fn<CallModelFn>(async (prompt) => {
      resumeCalls.push(prompt);
      return `RESUMED-${resumeCalls.length}`;
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel: resumeModel,
    });

    expect(result.resumedFromCheckpoint).toBe(true);
    // Only chunks 3 and 4 (indices 2, 3) were missing — never re-map 1/2.
    expect(resumeCalls.length).toBe(2);
    expect(result.summary).toBe(joinChunkSummaries(["CHUNK-1", "CHUNK-2", "RESUMED-1", "RESUMED-2"]));
  });

  it("mtime is NOT part of checkpoint identity — a touched mtime with unchanged content still resumes", async () => {
    // Superseded by TRDD-S8CKVH8S: `transcriptMtimeMs` was dropped from the
    // identity entirely (see the module header's INCREMENTAL COMPACTION
    // note) — a live session's mtime changes on every append, so pinning it
    // made `--resume` useless for exactly the case it exists for. Only the
    // byte content (via the prefix hash) matters now.
    const p = writeTranscript([userTurn("u1", "hello")]);
    const cp = checkpointPath();

    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");
    await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      callModel,
    });

    // Touch the transcript's mtime without changing its content/size.
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      callModel,
    });
    expect(result.resumedFromCheckpoint).toBe(true);
    expect(result.summary).toBe(joinChunkSummaries(["SUMMARY"]));
    expect(callModel).toHaveBeenCalledTimes(1); // no re-send — the completed chunk was reused
  });

  it("a transcript whose prefix CHANGED (same length, rewritten content) does a full restart — no stale reuse", async () => {
    const p = writeTranscript([userTurn("u1", "hello world one")]);
    const cp = checkpointPath();

    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY-A");
    await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      callModel,
    });

    // Rewrite the file with DIFFERENT content of the SAME byte length as the
    // original — a same-size mutation the old size-only check could never
    // have caught, which is exactly why the prefix is hashed, not just sized.
    const original = readFileSync(p, "utf-8");
    const rewritten = original.replace("hello world one", "HELLO WORLD ONE");
    expect(rewritten.length).toBe(original.length);
    writeFileSync(p, rewritten);

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        callModel,
      }),
    ).rejects.toThrow(/prefix hash mismatch/);
  });

  it("a TRUNCATED (shorter) transcript does a full restart — refuses to resume", async () => {
    const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `distinct request ${i} `.repeat(20)));
    const p = writeTranscript(lines);
    const cp = checkpointPath();

    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");
    await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      callModel,
    });

    // Truncate the transcript to shorter than what the checkpoint consumed.
    const full = readFileSync(p, "utf-8");
    writeFileSync(p, full.slice(0, Math.floor(full.length / 2)));

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        callModel,
      }),
    ).rejects.toThrow(/smaller than the/);
  });

  it("incremental compaction: a GROWN transcript with an unchanged prefix reuses prior chunk summaries — only new turns hit the model", async () => {
    // Small chunk budget so each turn becomes (roughly) its own chunk,
    // giving a clean boundary to assert reuse against.
    const initialLines = Array.from({ length: 3 }, (_, i) => userTurn(`u${i}`, `distinct request alpha ${i} `.repeat(20)));
    const p = writeTranscript(initialLines);
    const cp = checkpointPath();

    let firstRunCalls = 0;
    const firstRunModel = vi.fn<CallModelFn>(async () => {
      firstRunCalls++;
      return `CHUNK-${firstRunCalls}`;
    });

    const first = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel: firstRunModel,
    });
    expect(first.totalChunks).toBeGreaterThan(1);
    const firstTotalChunks = first.totalChunks;

    // APPEND new turns to the SAME file — never rewrite the existing bytes.
    const appendLines = Array.from({ length: 3 }, (_, i) =>
      userTurn(`v${i}`, `distinct request beta ${i} `.repeat(20)),
    );
    const appended = appendLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(p, readFileSync(p, "utf-8") + appended);

    const secondRunCalls: string[] = [];
    const secondRunModel = vi.fn<CallModelFn>(async (prompt) => {
      secondRunCalls.push(prompt);
      return `NEWCHUNK-${secondRunCalls.length}`;
    });

    const second = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel: secondRunModel,
    });

    expect(second.resumedFromCheckpoint).toBe(true);
    expect(second.totalChunks).toBeGreaterThan(firstTotalChunks);
    // Only the invalidated last-old-chunk plus the genuinely new chunks were
    // sent to the model — every earlier chunk summary was reused verbatim.
    expect(secondRunModel).toHaveBeenCalledTimes(second.totalChunks - (firstTotalChunks - 1));

    const savedAfter = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
    for (let i = 0; i < firstTotalChunks - 1; i++) {
      expect(savedAfter.mapSummaries[i]).toBe(`CHUNK-${i + 1}`); // reused, byte-for-byte, from the first run
    }
  });

  it("incremental compaction: changing maxChunkTokens on resume still forces a full restart (params stay exact-match)", async () => {
    const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `distinct request ${i} `.repeat(20)));
    const p = writeTranscript(lines);
    const cp = checkpointPath();

    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");
    await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel,
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 60, // changed
        chunkOverlapTurns: 0,
        callModel,
      }),
    ).rejects.toThrow(/chunk token budget/);
  });

  it("incremental compaction: the joined output over a grown transcript is byte-identical to a from-scratch run over the same final transcript", async () => {
    const initialLines = Array.from({ length: 3 }, (_, i) => userTurn(`u${i}`, `distinct request alpha ${i} `.repeat(20)));
    const p = writeTranscript(initialLines);
    const cp = checkpointPath();

    // Deterministic, CONTENT-derived summaries (never call-order or raw
    // prompt-length derived): the chunk-prompt header interpolates "part N
    // of TOTAL", and TOTAL legitimately differs between the incremental run
    // (grows mid-run) and a from-scratch run over the final transcript — so
    // asserting on the raw prompt text/length would fail on that harmless
    // framing difference even though the actual transcript content per
    // chunk is identical. Extracting just the turn markers sidesteps that.
    const deterministicModel = vi.fn<CallModelFn>(async (prompt) => {
      const markers = Array.from(prompt.matchAll(/distinct request (alpha|beta) \d+/g)).map((m) => m[0]);
      return `SUM(${markers.join(",")})`;
    });

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel: deterministicModel,
    });

    const appendLines = Array.from({ length: 3 }, (_, i) =>
      userTurn(`v${i}`, `distinct request beta ${i} `.repeat(20)),
    );
    const appended = appendLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(p, readFileSync(p, "utf-8") + appended);

    const incremental = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel: deterministicModel,
    });

    // From-scratch run over the SAME final transcript, fresh checkpoint.
    const freshCp = join(dir, "checkpoint-fresh.json");
    const fromScratch = await summarizeSession({
      transcriptPath: p,
      checkpointPath: freshCp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30,
      chunkOverlapTurns: 0,
      callModel: deterministicModel,
    });

    expect(incremental.summary).toBe(fromScratch.summary);
  });

  it("fails fast on resume when the prune level changed", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const cp = checkpointPath();
    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 65_536,
      pruneLevel: "aggressive",
      callModel,
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        pruneLevel: "moderate",
        callModel,
      }),
    ).rejects.toThrow(/prune level/);
  });

  it("raises an actionable, rate-limit-shaped error without retrying, naming the checkpoint path", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const cp = checkpointPath();
    let calls = 0;
    const callModel = vi.fn<CallModelFn>(async () => {
      calls++;
      throw new Error("HTTP 429: rate limit exceeded, try again later");
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        maxRetriesPerChunk: 5, // even with retries budgeted, a rate limit must not consume them
        callModel,
      }),
    ).rejects.toThrow(new RegExp(`Checkpoint saved at ${cp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(calls).toBe(1); // no retry loop burned on a rate-limit-shaped error
  });

  it("corrupt checkpoint JSON fails fast instead of silently starting fresh", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const cp = checkpointPath();
    writeFileSync(cp, "{ not valid json");
    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        callModel,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  // ── Model fallback (delisted / no-longer-free / daily-cap / no-text) ──

  it("falls back to the next model on a delisted (404) error and re-chunks the remaining unsent work to the new model's smaller context", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => userTurn(`u${i}`, `distinct fallback-test request ${i} `.repeat(30)));
    const p = writeTranscript(lines);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 3_000, maxCompletionTokens: 500 };

    let calls = 0;
    const usedModelIds: string[] = [];
    const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
      calls++;
      usedModelIds.push(modelId);
      if (calls === 1) {
        // The primary model's single (huge-budget) chunk fails as delisted
        // on the very first attempt — before any work is checkpointed.
        throw new Error("404 No endpoints found for this model — it has been delisted");
      }
      return `CHUNK(${modelId})`;
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 100_000, // huge budget -> the whole transcript is ONE chunk
      modelMaxCompletionTokens: 1_000,
      fallbackModels: [fallback], // tiny budget -> forces several chunks on re-chunk
      chunkOverlapTurns: 0,
      callModel,
    });

    expect(result.fallbackEvents).toHaveLength(1);
    expect(result.fallbackEvents[0]).toMatchObject({ fromModel: FREE_MODEL, toModel: FALLBACK_MODEL, reason: "gone" });
    expect(result.modelId).toBe(FALLBACK_MODEL);
    // THE TRAP this proves is NOT happening: without re-chunking, the
    // single oversized chunk would be re-sent to the smaller-context
    // fallback model unchanged and every call would fail. Instead the
    // remaining work is re-packed to the fallback's own (much smaller)
    // budget, producing more than the original single chunk.
    expect(result.totalChunks).toBeGreaterThan(1);
    // Every call after the first (failed, delisted) one must target the
    // fallback model — the delisted primary is never retried in this run.
    expect(usedModelIds.slice(1).every((id) => id === FALLBACK_MODEL)).toBe(true);
  });

  it("falls back to the next model when the primary returns an empty/no-text response (runtime evidence, not metadata), re-chunking to the new model's smaller context", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => userTurn(`u${i}`, `distinct notext-test request ${i} `.repeat(30)));
    const p = writeTranscript(lines);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 3_000, maxCompletionTokens: 500 };

    let calls = 0;
    const usedModelIds: string[] = [];
    const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
      calls++;
      usedModelIds.push(modelId);
      if (calls === 1) return "   "; // whitespace-only — a model that emits no usable text
      return `CHUNK(${modelId})`;
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 100_000,
      modelMaxCompletionTokens: 1_000,
      fallbackModels: [fallback],
      chunkOverlapTurns: 0,
      callModel,
    });

    expect(result.fallbackEvents).toHaveLength(1);
    expect(result.fallbackEvents[0].reason).toBe("no-text");
    expect(result.modelId).toBe(FALLBACK_MODEL);
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(usedModelIds.slice(1).every((id) => id === FALLBACK_MODEL)).toBe(true);
  });

  it("does NOT fall back on an ordinary transient (429) error even when a fallback candidate exists — a blip is not grounds to abandon a model", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 3_000, maxCompletionTokens: 500 };
    let calls = 0;
    const callModel = vi.fn<CallModelFn>(async () => {
      calls++;
      throw new Error("HTTP 429: rate limit exceeded, try again later");
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        fallbackModels: [fallback],
        callModel,
      }),
    ).rejects.toThrow(/rate limit/);
    expect(calls).toBe(1); // no retry, and no silent switch to the fallback candidate
  });

  it("exhausts every candidate and surfaces an actionable error naming all tried models when none survive", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 3_000, maxCompletionTokens: 500 };
    const callModel = vi.fn<CallModelFn>(async () => {
      throw new Error("404 No endpoints found — delisted");
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        fallbackModels: [fallback],
        callModel,
      }),
    ).rejects.toThrow(/every candidate free model is unavailable/);
  });

  // ── Context-overflow re-split (Phase B item 1) ────────────────────────

  /** Simulates a provider whose REAL context window is much smaller than the
   *  huge `modelMaxContext` these tests pass — any request whose prompt
   *  exceeds `thresholdChars` is rejected as overflow, converging regardless
   *  of how many halvings the driver needs (deterministic, no call-count
   *  guessing about the chunker's internal packing). */
  function makeOverflowingCallModel(
    thresholdChars: number,
    usedModelIds: string[],
    onMapPrompt?: (prompt: string) => void,
  ): CallModelFn {
    let mapCalls = 0;
    return async (prompt, modelId) => {
      usedModelIds.push(modelId);
      if (prompt.length > thresholdChars) {
        throw new Error(
          "400 This model's maximum context length is 4096 tokens. However, your messages " +
            "resulted in more tokens. Please reduce the length of the messages.",
        );
      }
      onMapPrompt?.(prompt);
      mapCalls++;
      return `CHUNK-${mapCalls}`;
    };
  }

  it("re-splits a chunk that overflows the model's real context window and completes the run, without switching models", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => userTurn(`u${i}`, `overflow-test request ${i} `.repeat(80)));
    const p = writeTranscript(lines);
    const cp = checkpointPath();

    const usedModelIds: string[] = [];
    const callModel = makeOverflowingCallModel(6_000, usedModelIds);

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000, // huge -> our own estimate packs the whole transcript as ONE chunk
      modelMaxCompletionTokens: 1_000,
      chunkOverlapTurns: 0,
      callModel,
    });

    expect(result.totalChunks).toBeGreaterThan(1); // the re-split actually produced more than one unit
    // Never swapped models — an overflow is a sizing problem, not an
    // availability problem, so fallbackEvents must stay empty.
    expect(result.fallbackEvents).toHaveLength(0);
    expect(result.modelId).toBe(FREE_MODEL);
    expect(usedModelIds.every((id) => id === FREE_MODEL)).toBe(true);
    // No fold call exists — the final summary is the deterministic join of
    // every checkpointed per-chunk summary, in order.
    const saved = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
    expect(result.summary).toBe(joinChunkSummaries(saved.mapSummaries as string[]));
  });

  it("does NOT treat a rate-limit (429) error as a context overflow — no re-split, no retry, fails fast as before", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    let calls = 0;
    const callModel = vi.fn<CallModelFn>(async () => {
      calls++;
      throw new Error("HTTP 429: rate limit exceeded, try again later");
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        callModel,
      }),
    ).rejects.toThrow(/rate limit/);
    expect(calls).toBe(1); // no retry burned re-splitting a rate limit
  });

  it("no chunk is lost or duplicated when an overflow forces a re-split (map summaries cover every original turn)", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => userTurn(`u${i}`, `distinct overflow content marker-${i} `.repeat(60)));
    const p = writeTranscript(lines);

    const usedModelIds: string[] = [];
    const seenPrompts: string[] = [];
    const callModel = makeOverflowingCallModel(6_000, usedModelIds, (prompt) => seenPrompts.push(prompt));

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      chunkOverlapTurns: 0,
      callModel,
    });

    // Every marker-N must appear in exactly one of the map prompts actually
    // sent to the model — proving the re-split neither dropped nor
    // duplicated content across the boundary it introduced.
    for (let i = 0; i < lines.length; i++) {
      const occurrences = seenPrompts.filter((p) => p.includes(`marker-${i} `)).length;
      expect(occurrences).toBe(1);
    }
  });

  it("resume still skips already-done chunks after a run was interrupted mid-map following an overflow re-split", async () => {
    // Same accepted resume contract the module header already documents for
    // a mid-run MODEL FALLBACK: chunk sizing is part of the checkpoint
    // identity, so resuming after an in-run budget adaptation (fallback OR
    // overflow re-split) requires the caller to pin the SAME --max-chunk-tokens
    // the adapted run converged to — exactly like "Fixed regardless of a
    // fallback switch when given explicitly" already works today. What THIS
    // test proves is the part in scope for Phase B: once that budget is
    // pinned, already-checkpointed chunks are never re-sent.
    const lines = Array.from({ length: 6 }, (_, i) => userTurn(`u${i}`, `resume overflow request ${i} `.repeat(80)));
    const p = writeTranscript(lines);
    const cp = checkpointPath();

    const usedModelIds: string[] = [];
    let mapCalls = 0;
    const firstRunModel: CallModelFn = async (prompt, modelId) => {
      usedModelIds.push(modelId);
      if (prompt.length > 6_000) {
        throw new Error(
          "400 This model's maximum context length is 4096 tokens. However, your messages " +
            "resulted in more tokens. Please reduce the length of the messages.",
        );
      }
      mapCalls++;
      if (mapCalls === 2) throw new Error("simulated crash: genuine non-availability bug");
      return `CHUNK-${mapCalls}`;
    };

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        chunkOverlapTurns: 0,
        maxRetriesPerChunk: 0,
        callModel: firstRunModel,
      }),
    ).rejects.toThrow();

    const savedCheckpoint = JSON.parse(readFileSync(cp, "utf-8")) as {
      identity: { chunkerMaxTokens: number };
      mapSummaries: (string | null)[];
    };
    const completedCount = savedCheckpoint.mapSummaries.filter((s) => s !== null).length;
    expect(completedCount).toBeGreaterThan(0); // the overflow re-split did produce checkpointed progress

    const resumeCalls: string[] = [];
    const resumeModel = vi.fn<CallModelFn>(async (prompt) => {
      resumeCalls.push(prompt);
      return `RESUMED-${resumeCalls.length}`;
    });

    const resumed = await summarizeSession({
      transcriptPath: p,
      checkpointPath: cp,
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      chunkOverlapTurns: 0,
      maxChunkTokens: savedCheckpoint.identity.chunkerMaxTokens, // pin the converged budget, same as a fallback resume
      callModel: resumeModel,
    });

    expect(resumed.resumedFromCheckpoint).toBe(true);
    // Only the NOT-yet-done map chunks were sent — the already-checkpointed
    // ones are never re-sent.
    expect(resumeCalls.length).toBe(resumed.totalChunks - completedCount);
    // No fold call exists — the final summary is the deterministic join of
    // every checkpointed per-chunk summary (pre-resume + resumed), in order.
    const finalCheckpoint = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
    expect(resumed.summary).toBe(joinChunkSummaries(finalCheckpoint.mapSummaries as string[]));
  });

  it("fails loudly instead of looping forever when a chunk still overflows at the minimum re-split floor", async () => {
    const p = writeTranscript([userTurn("u1", "a single line that never shrinks no matter how many times we halve the budget")]);
    const callModel = vi.fn<CallModelFn>(async () => {
      throw new Error("400 maximum context length is 100 tokens, please reduce the length of the messages");
    });

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 500, // already at the re-split floor — no shrink is possible
        chunkOverlapTurns: 0,
        callModel,
      }),
    ).rejects.toThrow(/re-split floor/);
  });

  // ── Chunk-size quality cap (Fix 1) ────────────────────────────────────

  it("caps the default chunk budget at DEFAULT_MAX_CHUNK_TOKENS even when the model's window is far larger", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000, // window budget alone would be ~934,000 tokens
      modelMaxCompletionTokens: 64_000,
      callModel,
    });

    const saved = JSON.parse(readFileSync(checkpointPath(), "utf-8")) as {
      identity: { chunkerMaxTokens: number };
    };
    expect(saved.identity.chunkerMaxTokens).toBe(DEFAULT_MAX_CHUNK_TOKENS);
  });

  it("honors an explicit --max_chunk_tokens even when it exceeds the default cap (a deliberate caller choice)", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 64_000,
      maxChunkTokens: DEFAULT_MAX_CHUNK_TOKENS + 10_000, // explicit, larger than the default cap
      callModel,
    });

    const saved = JSON.parse(readFileSync(checkpointPath(), "utf-8")) as {
      identity: { chunkerMaxTokens: number };
    };
    expect(saved.identity.chunkerMaxTokens).toBe(DEFAULT_MAX_CHUNK_TOKENS + 10_000);
  });

  it("still uses the (smaller) window-derived budget when the model's own window is below the default cap", async () => {
    const p = writeTranscript([userTurn("u1", "hello")]);
    const callModel = vi.fn<CallModelFn>(async () => "SUMMARY");

    await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 10_000, // window budget << DEFAULT_MAX_CHUNK_TOKENS
      modelMaxCompletionTokens: 1_000,
      callModel,
    });

    const saved = JSON.parse(readFileSync(checkpointPath(), "utf-8")) as {
      identity: { chunkerMaxTokens: number };
    };
    expect(saved.identity.chunkerMaxTokens).toBeLessThan(DEFAULT_MAX_CHUNK_TOKENS);
    expect(saved.identity.chunkerMaxTokens).toBe(10_000 - 1_000 - 2_000); // PROMPT_OVERHEAD_TOKENS
  });

  // ── Echo rejection (Fix 2) ─────────────────────────────────────────────

  describe("isEchoResponse", () => {
    it("rejects a response that is, in full, a verbatim substring of its source", () => {
      const source =
        "the user asked to add a login page and the assistant implemented auth.ts with a new handler";
      const response = "the assistant implemented auth.ts with a new handler"; // lifted verbatim, > 40 chars
      expect(isEchoResponse(response, source)).toBe(true);
    });

    it("does NOT reject a genuine short summary that merely quotes a fragment of the source", () => {
      const source =
        "the user asked to add a login page and the assistant implemented auth.ts with a new handler";
      const response =
        "User requested a login page; assistant added a new handler in auth.ts to implement it.";
      expect(isEchoResponse(response, source)).toBe(false);
    });

    it("does NOT reject a short response below the minimum length floor, even if it matches", () => {
      expect(isEchoResponse("done.", "the work is done.")).toBe(false);
    });

    it("is whitespace/case insensitive (normalizes before comparing)", () => {
      const source = "Files Changed:\n  - auth.ts\n  - login.tsx\nCommands run: npm test";
      const response = "files changed:   - auth.ts - login.tsx commands run: npm test";
      expect(isEchoResponse(response, source)).toBe(true);
    });

    it("does NOT reject a compaction-style summary that quotes a user message verbatim in section 6 alongside other sections", () => {
      // The compaction schema's section 6 requires VERBATIM user-message
      // quotes, which legitimately reproduce long stretches of the source.
      // The guard must still see this as a real summary (extra section
      // headers and other sections' prose make the WHOLE response longer
      // than, and never a substring of, the raw transcript body) — not an
      // echo of it.
      const source =
        "[user]\nplease add a login page and wire it to the existing auth.ts handler, then run the tests";
      const response =
        "6. All user messages\n" +
        '- "please add a login page and wire it to the existing auth.ts handler, then run the tests"\n\n' +
        "3. Files and Code Sections\n- auth.ts: added the login handler\n\n" +
        "8. Current Work\n- wiring the new handler into auth.ts";
      expect(isEchoResponse(response, source)).toBe(false);
    });
  });

  it("demotes a model whose response is an echo of its input and falls back to the next candidate", async () => {
    const bigTurnText = `distinct echo-test request marker-XYZ ${"filler ".repeat(40)}`;
    const p = writeTranscript([userTurn("u1", bigTurnText)]);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 3_000, maxCompletionTokens: 500 };

    let calls = 0;
    const usedModelIds: string[] = [];
    const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
      calls++;
      usedModelIds.push(modelId);
      if (calls === 1) {
        // Echo the raw transcript content back verbatim instead of summarizing it.
        return bigTurnText;
      }
      return `REAL-SUMMARY(${modelId})`;
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      fallbackModels: [fallback],
      chunkOverlapTurns: 0,
      callModel,
    });

    expect(result.fallbackEvents).toHaveLength(1);
    expect(result.fallbackEvents[0].reason).toBe("echo");
    expect(result.modelId).toBe(FALLBACK_MODEL);
    expect(result.summary).toBe(`REAL-SUMMARY(${FALLBACK_MODEL})`);
    expect(usedModelIds[0]).toBe(FREE_MODEL);
  });

  // ── Fail loudly when every candidate echoes (Fix 3) ─────────────────────

  it("exits with a real error (never a false success) when every candidate model only echoes its input", async () => {
    const bigTurnText = `distinct all-echo request marker-ABC ${"filler ".repeat(40)}`;
    const p = writeTranscript([userTurn("u1", bigTurnText)]);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 3_000, maxCompletionTokens: 500 };

    // Every candidate — primary and fallback — just echoes its input back.
    const callModel = vi.fn<CallModelFn>(async () => bigTurnText);

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        chunkOverlapTurns: 0,
        callModel,
      }),
    ).rejects.toThrow(/every candidate free model is unavailable/);
  });

  // ── Concurrency (owner-specified, 2026-08-12) ─────────────────────────
  //
  // These use REAL timers (not vi.useFakeTimers): the transcript reader
  // (transcript.ts) streams the file via a real `fs.createReadStream` +
  // `readline`, which needs real event-loop I/O ticks to emit its
  // 'line'/'close' events — sinon/vitest fake timers intercept only
  // setTimeout/setInterval scheduling, not that I/O, so faking time here
  // just stalls before the first model call ever fires. STAGGER_INTERVAL_MS
  // is 250ms (see its own header — deliberately small, not the original 3s
  // estimate), so real waits stay well under a second even across a few
  // staggered workers.

  /** Poll `predicate` on a real 10ms cadence until it's true or `timeoutMs`
   *  elapses (then throw) — the standard "wait for async state to settle"
   *  primitive for these real-timer concurrency tests. */
  async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  describe("concurrency", () => {
    it("concurrency 'auto' sizes the pool to the chunk count so the map phase runs in ONE wave", async () => {
      // The whole point of auto: wall-clock is `slowest chunk` only when every
      // chunk is in flight together. A fixed default below the chunk count
      // silently splits the run into waves and multiplies wall-clock.
      const lines = Array.from({ length: 5 }, (_, i) => userTurn(`u${i}`, `auto wave request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      let inFlight = 0;
      let maxInFlight = 0;
      const releases: Array<() => void> = [];
      const callModel = vi.fn<CallModelFn>(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => releases.push(res));
        inFlight--;
        return "SUMMARY";
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30, // tiny — forces 5 chunks, one per turn
        chunkOverlapTurns: 0,
        concurrency: "auto",
        callModel,
      });

      // 5 chunks, well under MAX_AUTO_CONCURRENCY (28) — so all five must be
      // in flight at once, i.e. a single wave.
      // 5 launches x STAGGER_INTERVAL_MS (250ms) is ~1.25s — give it real headroom
      // rather than riding waitUntil's 2s default.
      await waitUntil(() => callModel.mock.calls.length >= 5, 30_000);
      expect(maxInFlight).toBe(5);

      releases.forEach((r) => r());
      await resultPromise;
    });

    it("concurrency 'auto' never exceeds MAX_AUTO_CONCURRENCY even with more chunks than the cap", async () => {
      // Auto must size DOWN to the measured-safe ceiling, not to the chunk
      // count — otherwise a big transcript would fire a burst past the 429 cliff.
      const lines = Array.from({ length: 34 }, (_, i) => userTurn(`u${i}`, `cap request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      let inFlight = 0;
      let maxInFlight = 0;
      const releases: Array<() => void> = [];
      const callModel = vi.fn<CallModelFn>(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => releases.push(res));
        inFlight--;
        return "SUMMARY";
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30, // tiny — one chunk per turn => 34 chunks
        chunkOverlapTurns: 0,
        concurrency: "auto",
        callModel,
      });

      // Budget for the real launch stagger: 28 workers x STAGGER_INTERVAL_MS
      // (250ms) is ~7s, well past waitUntil's 2s default.
      await waitUntil(() => callModel.mock.calls.length >= MAX_AUTO_CONCURRENCY, 30_000);
      expect(maxInFlight).toBe(MAX_AUTO_CONCURRENCY);
      expect(maxInFlight).toBeLessThan(34); // proves it capped rather than fanning out to every chunk

      // Drain: each release frees a worker to pull the next queued chunk, so
      // keep releasing until the run itself finishes. Polling on `done` rather
      // than on a call count avoids racing the workers' own scheduling.
      let done = false;
      const settled = resultPromise.then((r) => { done = true; return r; });
      while (!done) {
        releases.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 20));
      }
      await settled;
    });

    it("never runs more than `concurrency` chunk requests in flight at once", async () => {
      const lines = Array.from({ length: 5 }, (_, i) => userTurn(`u${i}`, `cap test request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      let inFlight = 0;
      let maxInFlight = 0;
      const releases: Array<() => void> = [];
      const callModel = vi.fn<CallModelFn>(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => releases.push(res));
        inFlight--;
        return "SUMMARY";
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30, // tiny — forces 5 chunks, one per turn
        chunkOverlapTurns: 0,
        concurrency: 2,
        callModel,
      });

      // Both workers should be blocked on their release-gate once the
      // second worker's launch stagger clears — the first never waits.
      await waitUntil(() => callModel.mock.calls.length >= 2);
      expect(maxInFlight).toBe(2);

      // Release chunks one wave at a time; the cap must hold for every
      // wave, however many of the 5 chunks remain.
      let guard = 0;
      while (callModel.mock.calls.length < 5 && guard++ < 50) {
        const pending = callModel.mock.calls.length;
        releases.splice(0, releases.length).forEach((r) => r());
        await waitUntil(() => callModel.mock.calls.length > pending || releases.length > 0, 1_000).catch(() => {});
      }
      releases.splice(0, releases.length).forEach((r) => r());

      await resultPromise;
      expect(callModel).toHaveBeenCalledTimes(5);
      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(maxInFlight).toBeGreaterThan(1); // proves real overlap happened, not accidental serialization
    }, 10_000);

    it("joins chunk summaries in CHUNK ORDER even when their model calls complete out of order", async () => {
      const lines = Array.from({ length: 3 }, (_, i) => userTurn(`u${i}`, `order test request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      // Keyed by which chunk index's prompt this call carries (via the
      // distinct marker text), so we can release them in a DELIBERATELY
      // reversed order (2, then 1, then 0) and still expect the final join
      // in ascending order.
      const releaseByMarker = new Map<string, () => void>();
      const callModel = vi.fn<CallModelFn>(async (prompt) => {
        const marker = /order test request (\d+) /.exec(prompt)?.[1] ?? "?";
        await new Promise<void>((res) => releaseByMarker.set(marker, res));
        return `SUMMARY-${marker}`;
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: 3,
        callModel,
      });

      await waitUntil(() => releaseByMarker.size >= 3);

      // Resolve deliberately out of index order.
      for (const marker of ["2", "1", "0"]) {
        releaseByMarker.get(marker)?.();
      }

      const result = await resultPromise;
      expect(result.summary).toBe(joinChunkSummaries(["SUMMARY-0", "SUMMARY-1", "SUMMARY-2"]));
    }, 10_000);

    it("checkpoints a chunk's summary as soon as IT completes, not at the end of a wave", async () => {
      const lines = Array.from({ length: 3 }, (_, i) => userTurn(`u${i}`, `checkpoint order request ${i} `.repeat(30)));
      const p = writeTranscript(lines);
      const cp = checkpointPath();

      const releaseByMarker = new Map<string, () => void>();
      const callModel = vi.fn<CallModelFn>(async (prompt) => {
        const marker = /checkpoint order request (\d+) /.exec(prompt)?.[1] ?? "?";
        await new Promise<void>((res) => releaseByMarker.set(marker, res));
        return `SUMMARY-${marker}`;
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: 3,
        callModel,
      });

      await waitUntil(() => releaseByMarker.size >= 3);

      // Complete only chunk 1 (the middle one) — before the other two
      // finish — and verify its summary is already on disk, with the
      // others still null.
      releaseByMarker.get("1")?.();
      await waitUntil(() => {
        try {
          const cur = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
          return cur.mapSummaries[1] === "SUMMARY-1";
        } catch {
          return false;
        }
      });

      const midRun = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
      expect(midRun.mapSummaries[1]).toBe("SUMMARY-1");
      expect(midRun.mapSummaries[0]).toBeNull();
      expect(midRun.mapSummaries[2]).toBeNull();

      releaseByMarker.get("0")?.();
      releaseByMarker.get("2")?.();

      await resultPromise;
    }, 10_000);

    it("a chunk that hits a transient (429) blip backs off and retries instead of aborting its siblings", async () => {
      const lines = Array.from({ length: 3 }, (_, i) => userTurn(`u${i}`, `blip test request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      let calls = 0;
      let blippedOnce = false;
      const callModel = vi.fn<CallModelFn>(async (prompt) => {
        calls++;
        // The FIRST call (chunk 0's first attempt) hits one transient blip;
        // every other call — including chunk 0's retry — succeeds
        // immediately. Chunks 1 and 2 must not be blocked by chunk 0's
        // backoff.
        if (prompt.includes("blip test request 0 ") && !blippedOnce) {
          blippedOnce = true;
          throw new Error("HTTP 429: rate limit exceeded, try again later");
        }
        return "SUMMARY";
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: 3,
        maxRetriesPerChunk: 2,
        callModel,
      });

      // Real 5s TRANSIENT_BACKOFF_MS elapses for real here — no assertion
      // against wall clock, just that the run finished at all (siblings
      // were never blocked by it) instead of throwing.
      expect(result.totalChunks).toBe(3);
      expect(calls).toBeGreaterThan(3); // chunk 0 needed an extra attempt
    }, 15_000);

    it("SEVERAL chunks failing at once (model delisted) transition and finish — no deadlock", async () => {
      // REGRESSION: a model going away fails EVERY in-flight chunk at once, so
      // several workers reach `becomeLeaderAndTransition` together. The first
      // becomes leader and drains the others; the others park on the pause
      // gate. If the leader drains whole WORKER TASKS (which are themselves
      // parked on that gate) instead of their settled model ATTEMPTS, the two
      // wait on each other and the run hangs forever. `fanout: false` pins this
      // to the single-active-model concurrent branch, which is where the leader
      // /follower gate lives.
      const lines = Array.from({ length: 4 }, (_, i) =>
        userTurn(`u${i}`, `concurrent fallback request ${i} `.repeat(30)),
      );
      const p = writeTranscript(lines);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };

      const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
        const marker = /concurrent fallback request (\d+) /.exec(prompt)?.[1] ?? "?";
        if (modelId === FREE_MODEL) {
          // Slow enough that every staggered worker is IN FLIGHT before the
          // first failure lands — that is the whole point: the failures must
          // arrive together, the way a delisted model really behaves.
          await new Promise((r) => setTimeout(r, 1_500));
          throw new Error("404 No endpoints found for this model — it has been delisted");
        }
        return `SUMMARY-${marker}`;
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: 4,
        fanout: false,
        callModel,
      });

      expect(result.totalChunks).toBe(4);
      expect(result.summary).toBe(
        joinChunkSummaries(["SUMMARY-0", "SUMMARY-1", "SUMMARY-2", "SUMMARY-3"]),
      );
      // Exactly one model switch was recorded, however many chunks discovered
      // the delisting simultaneously.
      expect(result.fallbackEvents.length).toBe(1);
    }, 20_000);

    it("--concurrency 1 reproduces sequential behavior exactly (in-order calls, no stagger wait)", async () => {
      const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `sequential-equivalence request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      const callOrder: string[] = [];
      const callModel = vi.fn<CallModelFn>(async (prompt) => {
        const marker = /sequential-equivalence request (\d+) /.exec(prompt)?.[1] ?? "?";
        callOrder.push(marker);
        return `SUMMARY-${marker}`;
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: 1,
        callModel,
      });

      // No stagger, no overlap possible, strict index order — real timers,
      // no vi.advanceTimersByTimeAsync needed, exactly like the pre-existing
      // (concurrency-omitted) sequential tests above.
      expect(callOrder).toEqual(["0", "1", "2", "3"]);
      expect(result.summary).toBe(joinChunkSummaries(["SUMMARY-0", "SUMMARY-1", "SUMMARY-2", "SUMMARY-3"]));
    });
  });

  // ── Fan-out (owner-specified, 2026-08-12; TRDD-OU2TCWP8) ──────────────
  //
  // Real timers throughout, same reasoning as the concurrency block above.

  describe("fan-out", () => {
    it("distributes chunk indices round-robin across the eligible models", async () => {
      const lines = Array.from({ length: 6 }, (_, i) => userTurn(`u${i}`, `fanout distribute request ${i} `.repeat(30)));
      const p = writeTranscript(lines);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };

      const modelByChunk = new Map<string, string>();
      const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
        const marker = /fanout distribute request (\d+) /.exec(prompt)?.[1] ?? "?";
        modelByChunk.set(marker, modelId);
        return `SUMMARY-${marker}`;
      });

      await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30, // tiny — one chunk per turn => 6 chunks
        chunkOverlapTurns: 0,
        concurrency: "auto",
        callModel,
      });

      // K=2 (FREE_MODEL, FALLBACK_MODEL) — round-robin by chunk index.
      expect(modelByChunk.get("0")).toBe(FREE_MODEL);
      expect(modelByChunk.get("1")).toBe(FALLBACK_MODEL);
      expect(modelByChunk.get("2")).toBe(FREE_MODEL);
      expect(modelByChunk.get("3")).toBe(FALLBACK_MODEL);
      expect(modelByChunk.get("4")).toBe(FREE_MODEL);
      expect(modelByChunk.get("5")).toBe(FALLBACK_MODEL);
      // Both models were actually used — the whole point of fan-out.
      expect(new Set(modelByChunk.values())).toEqual(new Set([FREE_MODEL, FALLBACK_MODEL]));
    }, 10_000);

    it("never exceeds PER_MODEL_CONCURRENCY in flight against any single model", async () => {
      // 44 turns split round-robin over 2 slots = 22 pending chunks per
      // model — comfortably past PER_MODEL_CONCURRENCY (20), so the cap
      // must actually bind rather than never being exercised.
      const lines = Array.from({ length: 44 }, (_, i) => userTurn(`u${i}`, `cap fanout request ${i} `.repeat(30)));
      const p = writeTranscript(lines);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };

      const inFlightByModel = new Map<string, number>();
      const maxInFlightByModel = new Map<string, number>();
      const releases: Array<() => void> = [];
      const callModel = vi.fn<CallModelFn>(async (_prompt, modelId) => {
        const cur = (inFlightByModel.get(modelId) ?? 0) + 1;
        inFlightByModel.set(modelId, cur);
        maxInFlightByModel.set(modelId, Math.max(maxInFlightByModel.get(modelId) ?? 0, cur));
        await new Promise<void>((res) => releases.push(res));
        inFlightByModel.set(modelId, cur - 1);
        return "SUMMARY";
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: "auto", // K * PER_MODEL_CONCURRENCY = 2 * 20 = 40 workers
        callModel,
      });

      // Budget for the real launch stagger: 40 workers x STAGGER_INTERVAL_MS
      // (250ms) is up to ~10s.
      await waitUntil(() => callModel.mock.calls.length >= 40, 30_000);
      expect(maxInFlightByModel.get(FREE_MODEL)).toBeLessThanOrEqual(PER_MODEL_CONCURRENCY);
      expect(maxInFlightByModel.get(FALLBACK_MODEL)).toBeLessThanOrEqual(PER_MODEL_CONCURRENCY);
      // Proves real overlap happened per model, not accidental serialization.
      expect(maxInFlightByModel.get(FREE_MODEL)).toBeGreaterThan(1);
      expect(maxInFlightByModel.get(FALLBACK_MODEL)).toBeGreaterThan(1);

      let done = false;
      const settled = resultPromise.then((r) => { done = true; return r; });
      while (!done) {
        releases.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 20));
      }
      await settled;
    }, 30_000);

    it("one model failing does NOT discard sibling results from healthy models", async () => {
      const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `sibling fanout request ${i} `.repeat(30)));
      const p = writeTranscript(lines);
      // Exactly K=2 models total (no THIRD candidate to replace a dead
      // slot) — FREE_MODEL's slot dies outright, and its chunks (0 and 2)
      // must be redistributed to the surviving FALLBACK_MODEL slot rather
      // than lost, while chunks 1 and 3 (already on FALLBACK_MODEL) are
      // never touched by FREE_MODEL's failure.
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };

      const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
        const marker = /sibling fanout request (\d+) /.exec(prompt)?.[1] ?? "?";
        if (modelId === FREE_MODEL) {
          throw new Error("404 No endpoints found for this model — it has been delisted");
        }
        return `SUMMARY-${marker}`;
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: "auto",
        callModel,
      });

      // Every chunk landed, in original index order, all on the surviving
      // model — nothing from the healthy slot was discarded or re-run, and
      // the dead slot's own chunks were rescued rather than lost.
      expect(result.totalChunks).toBe(4);
      expect(result.summary).toBe(
        joinChunkSummaries(["SUMMARY-0", "SUMMARY-1", "SUMMARY-2", "SUMMARY-3"]),
      );
      expect(callModel.mock.calls.filter((c) => c[1] === FALLBACK_MODEL).length).toBeGreaterThanOrEqual(4);
    }, 10_000);

    it("a single eligible model degrades to identical (non-fan-out) sizing, never PER_MODEL_CONCURRENCY", async () => {
      // Mirrors the plain "concurrency 'auto' never exceeds MAX_AUTO_CONCURRENCY"
      // test above — proves fan-out's own auto formula (K * PER_MODEL_CONCURRENCY)
      // was NOT applied when there is only one eligible model (no fallbackModels).
      const lines = Array.from({ length: 34 }, (_, i) => userTurn(`u${i}`, `single-model fanout request ${i} `.repeat(30)));
      const p = writeTranscript(lines);

      let inFlight = 0;
      let maxInFlight = 0;
      const releases: Array<() => void> = [];
      const callModel = vi.fn<CallModelFn>(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => releases.push(res));
        inFlight--;
        return "SUMMARY";
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: "auto",
        callModel,
      });

      await waitUntil(() => callModel.mock.calls.length >= MAX_AUTO_CONCURRENCY, 30_000);
      expect(maxInFlight).toBe(MAX_AUTO_CONCURRENCY); // 28, not PER_MODEL_CONCURRENCY's 20
      expect(maxInFlight).toBeLessThan(34);

      let done = false;
      const settled = resultPromise.then((r) => { done = true; return r; });
      while (!done) {
        releases.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 20));
      }
      await settled;
    }, 30_000);

    it("concurrency: 1 disables fan-out even when multiple free models are eligible", async () => {
      const lines = Array.from({ length: 4 }, (_, i) => userTurn(`u${i}`, `no-fanout-at-1 request ${i} `.repeat(30)));
      const p = writeTranscript(lines);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };

      const usedModelIds: string[] = [];
      const callOrder: string[] = [];
      const callModel = vi.fn<CallModelFn>(async (prompt, modelId) => {
        const marker = /no-fanout-at-1 request (\d+) /.exec(prompt)?.[1] ?? "?";
        usedModelIds.push(modelId);
        callOrder.push(marker);
        return `SUMMARY-${marker}`;
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: 1,
        callModel,
      });

      // Every call went to the PRIMARY model only — fan-out's round-robin
      // across models never engaged — and calls happened in strict index
      // order, the sequential path's own signature.
      expect(new Set(usedModelIds)).toEqual(new Set([FREE_MODEL]));
      expect(callOrder).toEqual(["0", "1", "2", "3"]);
      expect(result.modelId).toBe(FREE_MODEL);
    });

    it("the map phase never waits on an attempt whose chunk is already committed", async () => {
      // GUARD FOR TRDD-QY1JITC7, written BEFORE the feature it guards.
      //
      // The proposal there is that an idle fan-out worker, instead of
      // idle-polling at `FANOUT_IDLE_POLL_MS`, launches a speculative attempt
      // on the longest-outstanding chunk so dead capacity becomes min-of-K on
      // the straggler that sets wall clock.
      //
      // The hazard that stopped it being written that day: the map phase ends
      // at `Promise.allSettled(workers)`, so a worker parked on a speculative
      // call does not return until that call settles. If the real owner commits
      // the chunk first, the speculative result is worthless — but the whole
      // phase is still waiting on it. On the measured free-tier tail (up to
      // 1478s) that turns a latency OPTIMISATION into a catastrophic
      // regression, which is the exact opposite of the point.
      //
      // HOW THIS TEST BITES. Any call for a marker that has ALREADY been
      // answered is, by construction, work whose result cannot be needed — it
      // is precisely the shape of a discarded racer. Such a call is answered
      // very slowly here. Today nothing issues one, so the run finishes on the
      // slow chunk alone and the bound passes with room to spare. Add
      // speculative racing WITHOUT a way to abandon the wait and this call
      // starts happening, the phase parks on it, and the bound fails loudly.
      //
      // Real timers (the whole block uses them) and a deliberately wide bound,
      // because the assertion is "does not wait for an extra ~3s", not
      // "completes in exactly N ms" — a tight bound here would be flaky on a
      // loaded CI box and would get deleted rather than debugged.
      const lines = Array.from({ length: 4 }, (_, i) =>
        userTurn(`u${i}`, `abandon-wait request ${i} `.repeat(30)),
      );
      const p = writeTranscript(lines);
      const fallback: EligibleModel = {
        id: FALLBACK_MODEL,
        contextLength: 1_000_000,
        maxCompletionTokens: 1_000,
      };

      const answered = new Set<string>();
      const UNNEEDED_CALL_MS = 3_000; // dwarfs the slow chunk, so parking on it is unmistakable
      const SLOW_CHUNK_MS = 300;

      const callModel = vi.fn<CallModelFn>(async (prompt) => {
        const marker = /abandon-wait request (\d+) /.exec(prompt)?.[1] ?? "?";
        if (answered.has(marker)) {
          // Nobody can still need this answer. A correct implementation either
          // never makes this call, or stops waiting on it the moment the chunk
          // commits. Either way the run must not absorb this delay.
          await new Promise((r) => setTimeout(r, UNNEEDED_CALL_MS));
          return `STALE-${marker}`;
        }
        if (marker === "3") await new Promise((r) => setTimeout(r, SLOW_CHUNK_MS));
        answered.add(marker);
        return `SUMMARY-${marker}`;
      });

      const startedAt = Date.now();
      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30,
        chunkOverlapTurns: 0,
        concurrency: "auto",
        callModel,
      });
      const elapsedMs = Date.now() - startedAt;

      // Correctness first: a race that drops the wrong answer is worse than a
      // slow one, so pin the joined text before pinning the timing.
      expect(result.totalChunks).toBe(4);
      expect(result.summary).toBe(
        joinChunkSummaries(["SUMMARY-0", "SUMMARY-1", "SUMMARY-2", "SUMMARY-3"]),
      );
      expect(result.summary).not.toContain("STALE-");

      // The bound: the slow chunk plus generous slack, but far below what
      // parking on one unneeded call would cost.
      expect(elapsedMs).toBeLessThan(SLOW_CHUNK_MS + UNNEEDED_CALL_MS / 2);
    }, 20_000);
  });

  // ── Hedging (owner-specified, 2026-08-12) ─────────────────────────────
  //
  // Real timers throughout, same reasoning as the concurrency block above.
  // `setHedgeAfterMsForTests` shrinks `HEDGE_AFTER_MS` (60s in production)
  // to a few milliseconds so these tests don't wait a real minute for the
  // hedge trigger to fire.

  describe("hedging", () => {
    it("a slow chunk gets hedged after HEDGE_AFTER_MS and the FIRST responder's text is the one joined", async () => {
      const p = writeTranscript([userTurn("u1", "hedge win test turn ".repeat(20))]);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 500_000, maxCompletionTokens: 1_000 };

      setHedgeAfterMsForTests(30);

      // The PRIMARY model call never resolves — a permanent straggler — so
      // the only way this run can ever finish is via the hedge.
      const callModel = vi.fn<CallModelFn>(async (_prompt, modelId) => {
        if (modelId === FREE_MODEL) return new Promise<string>(() => {});
        return "HEDGE-SUMMARY";
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        chunkOverlapTurns: 0,
        concurrency: 2,
        callModel,
      });

      expect(result.summary).toBe("HEDGE-SUMMARY");
      // A hedge win never touches the run's active model or fallback log —
      // it is a latency bet on one chunk, not a model-availability decision.
      expect(result.modelId).toBe(FREE_MODEL);
      expect(result.fallbackEvents).toEqual([]);
      expect(callModel).toHaveBeenCalledTimes(2);
      expect(callModel.mock.calls.map((c) => c[1]).sort()).toEqual([FALLBACK_MODEL, FREE_MODEL].sort());
    }, 10_000);

    it("the loser's late response does not overwrite the winner nor double-write a checkpoint", async () => {
      const p = writeTranscript([userTurn("u1", "hedge loser test turn ".repeat(20))]);
      const cp = checkpointPath();
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 500_000, maxCompletionTokens: 1_000 };

      setHedgeAfterMsForTests(30);

      let resolvePrimary!: (v: string) => void;
      let resolveHedge!: (v: string) => void;
      const callModel = vi.fn<CallModelFn>(async (_prompt, modelId) => {
        if (modelId === FREE_MODEL) {
          return new Promise<string>((res) => {
            resolvePrimary = res;
          });
        }
        return new Promise<string>((res) => {
          resolveHedge = res;
        });
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        chunkOverlapTurns: 0,
        concurrency: 2,
        callModel,
      });

      await waitUntil(() => callModel.mock.calls.length >= 2, 5_000);
      resolveHedge("HEDGE-WINS");
      const result = await resultPromise;
      expect(result.summary).toBe("HEDGE-WINS");

      const savedAfterWin = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
      expect(savedAfterWin.mapSummaries[0]).toBe("HEDGE-WINS");

      // The abandoned primary resolves AFTER the run has already finished
      // and returned. Its text must never overwrite the checkpoint — the
      // "a chunk index is written at most once" invariant holds regardless
      // of completion order.
      resolvePrimary("PRIMARY-TOO-LATE");
      await new Promise((r) => setTimeout(r, 100));
      const savedAfterLatePrimary = JSON.parse(readFileSync(cp, "utf-8")) as { mapSummaries: (string | null)[] };
      expect(savedAfterLatePrimary.mapSummaries[0]).toBe("HEDGE-WINS");
    }, 10_000);

    it("concurrency <= 1 never hedges, even with hedge: true and fallback models available", async () => {
      const p = writeTranscript([userTurn("u1", "sequential hedge test turn ".repeat(20))]);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 500_000, maxCompletionTokens: 1_000 };

      // A trigger this small would fire almost instantly if hedging were
      // (incorrectly) active on the sequential path — the primary call
      // below deliberately takes longer than this to resolve.
      setHedgeAfterMsForTests(1);

      const callModel = vi.fn<CallModelFn>(async (_prompt, modelId) => {
        await new Promise((r) => setTimeout(r, 50));
        return modelId === FREE_MODEL ? "PRIMARY-SUMMARY" : "SHOULD-NEVER-BE-CALLED";
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        chunkOverlapTurns: 0,
        concurrency: 1,
        hedge: true,
        callModel,
      });

      expect(result.summary).toBe("PRIMARY-SUMMARY");
      expect(callModel).toHaveBeenCalledTimes(1);
      expect(callModel.mock.calls[0][1]).toBe(FREE_MODEL);
    }, 10_000);

    it("hedging never exceeds the concurrency cap", async () => {
      const lines = Array.from({ length: 2 }, (_, i) => userTurn(`u${i}`, `hedge cap request ${i} `.repeat(30)));
      const p = writeTranscript(lines);
      const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 500_000, maxCompletionTokens: 1_000 };

      // Bigger than STAGGER_INTERVAL_MS (250ms): worker 1's launch is
      // staggered by one interval, so a SHORT hedge trigger would fire for
      // chunk 0 while worker 1 hasn't registered yet — a real spare slot at
      // that instant, correctly hedged, but not what THIS test means to
      // exercise. A trigger comfortably past the full stagger window
      // guarantees both chunks are already occupying the pool by the time
      // either one's hedge trigger fires.
      setHedgeAfterMsForTests(400);

      let inFlightCalls = 0;
      let maxInFlightCalls = 0;
      const releases: Array<() => void> = [];
      const callModel = vi.fn<CallModelFn>(async () => {
        inFlightCalls++;
        maxInFlightCalls = Math.max(maxInFlightCalls, inFlightCalls);
        await new Promise<void>((res) => releases.push(res));
        inFlightCalls--;
        return "SUMMARY";
      });

      const resultPromise = summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 1_000,
        fallbackModels: [fallback],
        maxChunkTokens: 30, // one chunk per turn => 2 chunks
        chunkOverlapTurns: 0,
        concurrency: 2,
        callModel,
      });

      // Both chunks' primaries occupy the pool's only 2 slots. Once both
      // hedge-trigger windows have elapsed there is never a spare slot, so
      // no hedge call may land and the cap must never be exceeded even
      // though both chunks are permanent stragglers.
      await waitUntil(() => callModel.mock.calls.length >= 2, 5_000);
      await new Promise((r) => setTimeout(r, 800)); // outlive both 400ms trigger windows with margin
      expect(callModel.mock.calls.length).toBe(2); // no hedge call landed — cap left no spare slot
      expect(maxInFlightCalls).toBeLessThanOrEqual(2);

      releases.splice(0).forEach((r) => r());
      await resultPromise;
      expect(maxInFlightCalls).toBeLessThanOrEqual(2);
    }, 10_000);
  });

  // ── Single-chunk RACE ────────────────────────────────────────────────
  //
  // A one-chunk run used to get no mitigation at all: auto-concurrency
  // resolves to 1 (so the sequential branch runs, which does not hedge) and
  // fan-out needs more than one chunk to engage. Against a free tier whose
  // measured latency spans 91s-1478s that is the worst possible exposure, and
  // a real run of this shape took 340.8s. The fix races the SAME chunk across
  // the top-K models and takes the first usable answer.
  describe("single-chunk race", () => {
    const SECOND_MODEL: EligibleModel = {
      id: "vendor/second-racer:free",
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
    };

    it("takes the FIRST model to answer and does not wait for the slow one", async () => {
      const p = writeTranscript([userTurn("u1", "race me")]);
      let releaseSlow: (() => void) | null = null;
      const callModel = vi.fn<CallModelFn>(async (_prompt, modelId) => {
        if (modelId === FREE_MODEL) {
          // The primary is the straggler — the exact case that cost 340.8s.
          await new Promise<void>((r) => { releaseSlow = () => r(); });
          return "SLOW SUMMARY";
        }
        return "FAST SUMMARY";
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        fallbackModels: [SECOND_MODEL],
        concurrency: "auto",
        callModel,
      });

      // Resolved WITHOUT the slow model ever settling — that is the whole point.
      expect(releaseSlow).not.toBeNull();
      expect(result.summary).toContain("FAST SUMMARY");
      expect(result.summary).not.toContain("SLOW SUMMARY");
      // Both were dispatched: one chunk, two concurrent calls.
      expect(callModel.mock.calls.length).toBe(2);
      releaseSlow!(); // let the loser finish so the test leaves nothing pending
    }, 15_000);

    it("a LATE-settling loser never overwrites the winner's committed summary", async () => {
      const p = writeTranscript([userTurn("u1", "late loser")]);
      let releaseSlow: (() => void) | null = null;
      const callModel = vi.fn<CallModelFn>(async (_prompt, modelId) => {
        if (modelId === FREE_MODEL) {
          await new Promise<void>((r) => { releaseSlow = () => r(); });
          return "LOSER SUMMARY";
        }
        return "WINNER SUMMARY";
      });

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        fallbackModels: [SECOND_MODEL],
        concurrency: "auto",
        callModel,
      });
      expect(result.summary).toContain("WINNER SUMMARY");

      // Settle the loser AFTER the winner already committed, then prove the
      // checkpoint on disk still holds the winner: a chunk index is written at
      // most once, whichever order the racers land in.
      releaseSlow!();
      await new Promise((r) => setTimeout(r, 50));
      const persisted = JSON.parse(readFileSync(checkpointPath(), "utf-8"));
      expect(persisted.mapSummaries[0]).toContain("WINNER SUMMARY");
      expect(persisted.mapSummaries[0]).not.toContain("LOSER SUMMARY");
    }, 15_000);

    it("does not race when there is only one eligible model — nothing to race against", async () => {
      const p = writeTranscript([userTurn("u1", "solo")]);
      const callModel = vi.fn<CallModelFn>(async () => "SOLO SUMMARY");

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        concurrency: "auto",
        callModel,
      });

      expect(result.summary).toContain("SOLO SUMMARY");
      expect(callModel.mock.calls.length).toBe(1); // exactly one call, no duplicate work
    });

    it("leaves an explicit concurrency:1 caller byte-identical — the library default never races", async () => {
      const p = writeTranscript([userTurn("u1", "sequential please")]);
      const callModel = vi.fn<CallModelFn>(async () => "SEQUENTIAL SUMMARY");

      const result = await summarizeSession({
        transcriptPath: p,
        checkpointPath: checkpointPath(),
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        fallbackModels: [SECOND_MODEL], // available, but must NOT be raced
        concurrency: 1,
        callModel,
      });

      expect(result.summary).toContain("SEQUENTIAL SUMMARY");
      expect(callModel.mock.calls.length).toBe(1);
      expect(callModel.mock.calls.every((c) => c[1] === FREE_MODEL)).toBe(true);
    });
  });
});
