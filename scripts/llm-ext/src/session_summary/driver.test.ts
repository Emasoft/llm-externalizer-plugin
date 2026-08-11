// Unit tests for driver.ts — the session-summary map-reduce driver.
// No network: every model call goes through an injected fake `callModel`.
// All IO is against per-test tmp fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { summarizeSession, joinChunkSummaries, isEchoResponse, DEFAULT_MAX_CHUNK_TOKENS, type CallModelFn } from "./driver.js";
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

  it("fails fast on resume when the checkpoint's transcript identity does not match (different mtime)", async () => {
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

    // Touch the transcript's mtime without changing its content/size — the
    // identity check must still catch it and refuse to resume against it.
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);

    await expect(
      summarizeSession({
        transcriptPath: p,
        checkpointPath: cp,
        modelId: FREE_MODEL,
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        callModel,
      }),
    ).rejects.toThrow(/does not match this run/);
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
});
