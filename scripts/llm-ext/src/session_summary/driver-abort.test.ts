// TRDD-3SNQAGIC follow-ups: the multi-chunk hedge loser and the fan-out speculative racers are ABORTED once their
// chunk is decided, and an aborted loser is no verdict (no retry, no cooldown, no run-unusable mark, no fallback).
// Real timers, real temp files; the only fake is the injected `callModel` (the network boundary), never driver code.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { summarizeSession, setHedgeAfterMsForTests, type CallModelFn } from "./driver.js";
import type { EligibleModel } from "./model-select.js";
import { getCooldownStore, isRunUnusable, resetCooldownCacheForTests, resetRunUnusableForTests } from "../free-rotation.js";

const FREE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const FALLBACK_MODEL = "vendor/fallback-small-context:free";
const summaryFixture = (label: string) => `## Current Work\n${label}`;

/** A model call that never answers on its own: it settles only when its request is aborted. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
  });
}

/** Let an aborted loser's rejection travel through callWithRetry's catch before asserting "no verdict". */
const settleLosers = () => new Promise((r) => setTimeout(r, 100));

function expectNoVerdict(modelId: string): void {
  expect(isRunUnusable(modelId)).toBe(false);
  expect(getCooldownStore().models[modelId]).toBeUndefined();
}

describe("driver: losers of the hedge and of the speculative race are aborted (TRDD-3SNQAGIC)", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "llm-ext-driver-abort-"));
    prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = mkdtempSync(join("/tmp", "llm-ext-driver-abort-cfg-"));
    resetCooldownCacheForTests();
  });
  afterEach(() => {
    rmSync(process.env.LLM_EXT_CONFIG_DIR!, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
    setHedgeAfterMsForTests(null);
    resetRunUnusableForTests();
  });

  function writeTranscript(lines: unknown[]): string {
    const p = join(dir, "in.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }
  const userTurn = (uuid: string, text: string): unknown => ({ type: "user", uuid, parentUuid: null, timestamp: "t", message: { role: "user", content: text } });
  const checkpointPath = () => join(dir, "checkpoint.json");

  it("a winning hedge aborts the primary, and the aborted primary is no verdict", async () => {
    const p = writeTranscript([userTurn("u1", "hedge abort primary turn ".repeat(20))]);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 500_000, maxCompletionTokens: 1_000 };
    setHedgeAfterMsForTests(30);
    let primarySignal: AbortSignal | undefined;
    const callModel = vi.fn<CallModelFn>(async (_prompt, modelId, _max, signal) => {
      if (modelId === FREE_MODEL) {
        primarySignal = signal;
        return hangUntilAborted(signal);
      }
      return summaryFixture("HEDGE-WINS");
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
    await settleLosers();

    expect(result.summary).toBe(summaryFixture("HEDGE-WINS"));
    expect(primarySignal?.aborted).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(2); // the aborted primary was not re-sent
    expect(result.fallbackEvents).toEqual([]);
    expect(result.modelId).toBe(FREE_MODEL);
    expectNoVerdict(FREE_MODEL);
  }, 10_000);

  it("a primary that wins after the hedge launched aborts the hedge, and the aborted hedge is no verdict", async () => {
    const p = writeTranscript([userTurn("u1", "hedge abort hedge turn ".repeat(20))]);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 500_000, maxCompletionTokens: 1_000 };
    setHedgeAfterMsForTests(30);
    let hedgeSignal: AbortSignal | undefined;
    const callModel = vi.fn<CallModelFn>(async (_prompt, modelId, _max, signal) => {
      if (modelId === FREE_MODEL) {
        await new Promise((r) => setTimeout(r, 300)); // past the 30 ms hedge point, so the hedge is in flight
        return summaryFixture("PRIMARY-WINS");
      }
      hedgeSignal = signal;
      return hangUntilAborted(signal);
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
    await settleLosers();

    expect(result.summary).toBe(summaryFixture("PRIMARY-WINS"));
    expect(hedgeSignal).toBeDefined(); // the hedge really launched
    expect(hedgeSignal!.aborted).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.fallbackEvents).toEqual([]);
    expectNoVerdict(FALLBACK_MODEL);
  }, 10_000);

  it("a speculative racer's commit aborts the chunk owner's call, and the aborted owner is no verdict", async () => {
    const lines = Array.from({ length: 2 }, (_, i) => userTurn(`u${i}`, `spec abort owner request ${i} `.repeat(30)));
    const p = writeTranscript(lines);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };
    let ownerSignal: AbortSignal | undefined;
    const callModel = vi.fn<CallModelFn>(async (prompt, modelId, _max, signal) => {
      const marker = /spec abort owner request (\d+) /.exec(prompt)?.[1] ?? "?";
      if (marker === "1" && modelId === FALLBACK_MODEL) {
        ownerSignal = signal;
        return hangUntilAborted(signal);
      }
      return summaryFixture(`SUMMARY-${marker}-${modelId === FREE_MODEL ? "free" : "fb"}`);
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
    await settleLosers();

    expect(result.totalChunks).toBe(2);
    expect(ownerSignal).toBeDefined();
    expect(ownerSignal!.aborted).toBe(true);
    // The owner's chunk-1 call was sent once and never re-sent after the abort.
    expect(callModel.mock.calls.filter(([pr, m]) => m === FALLBACK_MODEL && /request 1 /.test(pr))).toHaveLength(1);
    expect(result.fallbackEvents).toEqual([]);
    expectNoVerdict(FALLBACK_MODEL);
  }, 15_000);

  it("the owner's commit aborts a still-running speculative racer, and the aborted racer is no verdict", async () => {
    const lines = Array.from({ length: 2 }, (_, i) => userTurn(`u${i}`, `spec abort racer request ${i} `.repeat(30)));
    const p = writeTranscript(lines);
    const fallback: EligibleModel = { id: FALLBACK_MODEL, contextLength: 1_000_000, maxCompletionTokens: 1_000 };
    let racerSignal: AbortSignal | undefined;
    const callModel = vi.fn<CallModelFn>(async (prompt, modelId, _max, signal) => {
      const marker = /spec abort racer request (\d+) /.exec(prompt)?.[1] ?? "?";
      if (marker === "1" && modelId === FALLBACK_MODEL) {
        await new Promise((r) => setTimeout(r, 600)); // slow enough that the idle FREE slot races it
        return summaryFixture("SUMMARY-1-owner");
      }
      if (marker === "1" && modelId === FREE_MODEL) {
        racerSignal = signal;
        return hangUntilAborted(signal);
      }
      return summaryFixture(`SUMMARY-${marker}-owner`);
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
    await settleLosers();

    expect(result.summary).toContain("SUMMARY-1-owner");
    expect(racerSignal).toBeDefined(); // the speculative racer really launched
    expect(racerSignal!.aborted).toBe(true);
    expect(callModel.mock.calls.filter(([pr, m]) => m === FREE_MODEL && /request 1 /.test(pr))).toHaveLength(1);
    expect(result.fallbackEvents).toEqual([]);
    expectNoVerdict(FREE_MODEL);
  }, 15_000);
});
