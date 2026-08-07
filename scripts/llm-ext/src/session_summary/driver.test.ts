// Unit tests for driver.ts — the session-summary map-reduce driver.
// No network: every model call goes through an injected fake `callModel`.
// All IO is against per-test tmp fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { summarizeSession, packIntoBatches, type CallModelFn } from "./driver.js";

const FREE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const PAID_MODEL = "anthropic/claude-sonnet-5";

describe("driver: summarizeSession", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-summary-driver-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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

  it("maps every chunk then reduces multiple chunk summaries into one folded summary", async () => {
    // Force multiple chunks with a tiny maxChunkTokens so each user turn
    // lands in its own chunk, then force multiple reduce batches with a
    // tiny fold budget too.
    const lines = Array.from({ length: 5 }, (_, i) => userTurn(`u${i}`, `request number ${i} `.repeat(20)));
    const p = writeTranscript(lines);

    let mapCalls = 0;
    let foldCalls = 0;
    const callModel = vi.fn<CallModelFn>(async (prompt) => {
      if (prompt.includes("You are folding")) {
        foldCalls++;
        return `FOLDED-${foldCalls}`;
      }
      mapCalls++;
      return `CHUNK-${mapCalls}`;
    });

    const result = await summarizeSession({
      transcriptPath: p,
      checkpointPath: checkpointPath(),
      modelId: FREE_MODEL,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 1_000,
      maxChunkTokens: 30, // tiny — forces several chunks and several fold batches
      chunkOverlapTurns: 0,
      callModel,
    });

    expect(result.totalChunks).toBeGreaterThan(1);
    expect(mapCalls).toBe(result.totalChunks);
    expect(foldCalls).toBeGreaterThan(0);
    expect(result.summary).toMatch(/^FOLDED-/);
  });

  it("packIntoBatches never drops an item and respects the token budget when items fit individually", () => {
    const items = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const batches = packIntoBatches(items, 20); // ~5 tokens per item at 4B/token
    const flat = batches.flat();
    expect(flat).toEqual(items); // no loss, original order preserved
    expect(batches.length).toBeGreaterThan(1); // budget forced a split
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
      return prompt.includes("You are folding") ? "FOLDED" : `RESUMED-${resumeCalls.length}`;
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
    // Only chunks 3 and 4 (indices 2, 3) were missing, plus whatever
    // reduce folding was needed — never re-map chunks 1/2.
    const remapped = resumeCalls.filter((p) => !p.includes("You are folding"));
    expect(remapped.length).toBe(2);
    expect(result.summary).toBe("FOLDED");
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
});
