/**
 * session_summary/local-model.test.ts — the managed local fallback of session-summary (TRDD-TYHKAKCB).
 *
 * Real calibration records written with writeRecord into temp config dirs, the real built-in local profiles resolved
 * with resolveProfile, and the real driver over real transcript files. The only stand-ins are the injected seams the
 * modules are built around: the model call (callModel), the remote catalog and the calibration wait. No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinLocalProfiles, localsPlatformSupported, PROVISIONAL_LOCAL_CTX, resolveProfile, type ResolvedProfile } from "../config.js";
import { writeRecord, type CalibrationRecord } from "../calibration/record.js";
import { recordFixture } from "../calibration/test-record.js";
import { readQueue } from "../calibration/state.js";
import { spawn } from "node:child_process";
import { BROKER_ARGV, brokerStatePath, CALIBRATE_ARGV, calibratorStatePath } from "../broker/protocol.js";
import { CAP_OFF } from "../calibration/phase-a.js";
import { CHARS_PER_TOKEN_SAFETY } from "../local-input-budget.js";
import { TOKEN_ESTIMATE_SAFETY_MARGIN } from "./chunker.js";
import { mapPromptOverheadBytes, MAX_SUMMARY_COMPLETION_TOKENS, PROMPT_OVERHEAD_TOKENS, summarizeSession, type CallModelFn } from "./driver.js";
import type { EligibleModel } from "./model-select.js";
import { resetCooldownCacheForTests, resetRunUnusableForTests } from "../free-rotation.js";
import {
  CHUNKER_CHARS_PER_TOKEN_CEILING,
  LOCAL_SUMMARY_PROFILES,
  MIN_LOCAL_CHUNK_TOKENS,
  pickLocalSummaryTargets,
  planLocalSummaryModel,
  queueLocalCalibrations,
  __resetQueuedCalibrationsForTests,
  resolveSessionSummaryChain,
  resolveSessionSummaryModels,
  type LocalSummaryTarget,
} from "./local-model.js";

const LFM3_MLX = "LiquidAI/LFM3-1.7B-MLX-4bit";
const REMOTE = "vendor/remote-big:free";
const REMOTE2 = "vendor/remote-second:free";
const summaryFixture = (label: string) => `## Current Work\n${label}`;

const cleanups: Array<() => void> = [];
let prevConfigDir: string | undefined;
beforeEach(() => {
  // recordUnavailable (free-rotation.ts) persists cooldowns under the config dir on a fallback switch: keep it in /tmp.
  prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = tempDir("llm-ext-local-summary-cfg-");
  resetCooldownCacheForTests();
  __resetQueuedCalibrationsForTests();
});
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
  resetRunUnusableForTests();
  for (const c of cleanups.splice(0)) c();
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join("/tmp", prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A built-in local profile, resolved by the real resolver. */
function builtin(name: string, over: Record<string, unknown> = {}): ResolvedProfile {
  const b = builtinLocalProfiles().find((p) => p.name === name);
  if (b === undefined) throw new Error(`no built-in ${name}`);
  return resolveProfile(name, { ...b.profile, ...over } as typeof b.profile);
}

const slotCtx = (contextWindow: number): number => (contextWindow > 0 ? contextWindow : PROVISIONAL_LOCAL_CTX);

/** An ok Locals record for LFM3 with explicit sizing fields. */
function okRecord(over: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    ...recordFixture("locals", LFM3_MLX),
    window_tokens: 16384,
    fill_tokens: { fact: 8192, aggregate: 8192, bug: 8192 },
    min_output_tokens: { fact: 256, aggregate: 256, bug: 256 },
    chars_per_token: 3.5,
    ...over,
  };
}

function locTarget(ctx = PROVISIONAL_LOCAL_CTX, model = LFM3_MLX): LocalSummaryTarget {
  return { profile: builtin("locals-mlx"), model, engine: "locals", ctx };
}
const NANBEIGE_MLX = "mlx-community/Nanbeige4.2-3B-OptiQ-4bit";
/** The record measured 2026-11-15 for LFM3 MLX: unfit for every kind (fill 0). */
const unfitRecord = (model = LFM3_MLX): CalibrationRecord =>
  okRecord({ ...recordFixture("locals", model), fill_tokens: { fact: 0, aggregate: 0, bug: 0 }, min_output_tokens: { fact: 256, aggregate: 256, bug: 256 }, window_tokens: 16384, chars_per_token: 3.5 } as Partial<CalibrationRecord>);

/** The chunker budget the plan must hand the driver for an input budget of `tokens` at `cpt` characters per token. */
function expectedChunkTokens(tokens: number, cpt: number): number {
  const bytes = Math.floor(tokens * cpt * CHARS_PER_TOKEN_SAFETY);
  return Math.floor(((bytes - mapPromptOverheadBytes()) * TOKEN_ESTIMATE_SAFETY_MARGIN) / CHUNKER_CHARS_PER_TOKEN_CEILING);
}

describe("pickLocalSummaryTargets", () => {
  it("lists locals-mlx models first (LFM3 MLX head), then local_llama, with the broker slot context", () => {
    expect(LOCAL_SUMMARY_PROFILES).toEqual(["locals-mlx", "local_llama"]);
    const { targets, notes } = pickLocalSummaryTargets([builtin("locals-mlx"), builtin("local_llama")], slotCtx);
    expect(notes).toEqual([]);
    expect(targets[0].model).toBe(LFM3_MLX);
    expect(targets.slice(0, 3).every((t) => t.engine === "locals")).toBe(true);
    expect(targets.slice(3).every((t) => t.engine === "llama")).toBe(true);
    expect(targets.length).toBe(6);
    expect(targets.every((t) => t.ctx === PROVISIONAL_LOCAL_CTX)).toBe(true);
  });
  it("passes over an unmanaged profile with a note", () => {
    const { targets, notes } = pickLocalSummaryTargets([builtin("locals-mlx", { server: undefined }), builtin("local_llama")], slotCtx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("'locals-mlx' is not managed");
    expect(targets[0].model).toBe("AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K");
  });
  it("returns no target when no candidate is managed", () => {
    const { targets, notes } = pickLocalSummaryTargets([builtin("local_llama", { server: undefined })], slotCtx);
    expect(targets).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});

describe("planLocalSummaryModel", () => {
  it("waits (await) when the head has no calibration record", () => {
    const plan = planLocalSummaryModel(tempDir("llm-ext-ls-"), locTarget());
    expect(plan.state).toBe("await");
    if (plan.state === "await") expect(plan.models).toEqual([{ engine: "locals", model: LFM3_MLX }]);
  });
  it("sizes an ok record so the driver's own window arithmetic yields the byte-derived chunk budget", () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const plan = planLocalSummaryModel(dir, locTarget());
    expect(plan.state).toBe("ready");
    if (plan.state !== "ready") return;
    // ctx 8192, cap max(256, CAP_OFF), overhead 512: input min(8192, 8192 - cap - 512) tokens.
    const inputTokens = PROVISIONAL_LOCAL_CTX - CAP_OFF - 512;
    expect(plan.model.local).toBe(true);
    expect(plan.model.id).toBe(LFM3_MLX);
    expect(plan.model.maxCompletionTokens).toBe(CAP_OFF);
    const driverWindow = plan.model.contextLength - Math.min(plan.model.maxCompletionTokens, MAX_SUMMARY_COMPLETION_TOKENS) - PROMPT_OVERHEAD_TOKENS;
    expect(driverWindow).toBe(expectedChunkTokens(inputTokens, 3.5));
    expect(driverWindow).toBeGreaterThanOrEqual(MIN_LOCAL_CHUNK_TOKENS);
  });
  it("is unusable when the map prompt leaves fewer than MIN_LOCAL_CHUNK_TOKENS for the transcript", () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const plan = planLocalSummaryModel(dir, locTarget(4096));
    expect(plan.state).toBe("unusable");
    if (plan.state === "unusable") expect(plan.reason).toContain(`below ${MIN_LOCAL_CHUNK_TOKENS}`);
  });
  it("is unusable when the context cannot hold the output cap (the calibration spec refusal)", () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const plan = planLocalSummaryModel(dir, locTarget(3000));
    expect(plan.state).toBe("unusable");
    if (plan.state === "unusable") expect(plan.reason).toContain("smallest context that works");
  });
  it("is unusable when the record is unfit for aggregate (the kind session_summary maps to)", () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, unfitRecord());
    const plan = planLocalSummaryModel(dir, locTarget());
    expect(plan.state).toBe("unusable");
    if (plan.state === "unusable") expect(plan.reason).toContain("unfit for aggregate tasks");
  });
  it("is unusable on a failed calibration record", () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, recordFixture("locals", LFM3_MLX, { step: "A", message: "engine check failed" }));
    expect(planLocalSummaryModel(dir, locTarget()).state).toBe("unusable");
  });
});

describe("resolveSessionSummaryModels", () => {
  const remoteModels: EligibleModel[] = [{ id: REMOTE, contextLength: 1_000_000, maxCompletionTokens: 32_000 }];
  function run(o: { dir: string; local: LocalSummaryTarget | null | LocalSummaryTarget[]; localOnly?: boolean; remote?: () => Promise<EligibleModel[]>; onWait?: () => void }) {
    const lines: string[] = [];
    let waited = 0;
    const p = resolveSessionSummaryModels({
      localOnly: o.localOnly ?? false,
      locals: o.local === null ? [] : Array.isArray(o.local) ? o.local : [o.local],
      remote: o.remote ?? (async () => remoteModels),
      dir: o.dir,
      waitForCalibration: async () => {
        waited++;
        o.onWait?.();
      },
      write: (l) => lines.push(l),
    });
    return { p, lines, waited: () => waited };
  }

  it("remote first, the calibrated local model last", async () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const r = run({ dir, local: locTarget() });
    const models = await r.p;
    expect(models.map((m) => m.id)).toEqual([REMOTE, LFM3_MLX]);
    expect(models[1].local).toBe(true);
    expect(r.lines).toEqual([]);
  });
  it("never waits for a calibration while remote models exist: the local fallback is left out with one line", async () => {
    const r = run({ dir: tempDir("llm-ext-ls-"), local: locTarget() });
    expect((await r.p).map((m) => m.id)).toEqual([REMOTE]);
    expect(r.waited()).toBe(0);
    expect(r.lines.join("")).toContain("has no calibration record yet");
  });
  it("remote failure: the local model is the whole chain, and says so", async () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const r = run({ dir, local: locTarget(), remote: async () => { throw new Error("OpenRouter model catalog fetch failed: 503"); } });
    expect((await r.p).map((m) => m.id)).toEqual([LFM3_MLX]);
    expect(r.lines.join("")).toContain("no remote free model is available (OpenRouter model catalog fetch failed: 503)");
    expect(r.lines.join("")).toContain("through the local broker");
  });
  it("remote failure with no local profile fails fast and keeps the remote cause", async () => {
    const r = run({ dir: tempDir("llm-ext-ls-"), local: null, remote: async () => { throw new Error("catalog down"); } });
    await expect(r.p).rejects.toThrow(/catalog down.*no managed local profile/);
  });
  it("remote failure with an unusable local model fails naming both causes", async () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const r = run({ dir, local: locTarget(3000), remote: async () => { throw new Error("catalog down"); } });
    await expect(r.p).rejects.toThrow(/catalog down.*every local model is unusable.*task kind aggregate.*smallest context that works/);
  });
  it("local-only waits for the calibration, then sizes from the record it produced", async () => {
    const dir = tempDir("llm-ext-ls-");
    const r = run({ dir, local: locTarget(), localOnly: true, remote: async () => { throw new Error("remote must not be asked"); }, onWait: () => writeRecord(dir, okRecord()) });
    const models = await r.p;
    expect(r.waited()).toBe(1);
    expect(models.map((m) => m.id)).toEqual([LFM3_MLX]);
  });
  it("skips a local model unfit for aggregate and falls back to the next fit one, never sending to the unfit one", async () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, unfitRecord());
    writeRecord(dir, okRecord({ ...recordFixture("locals", NANBEIGE_MLX), window_tokens: 16384, fill_tokens: { fact: 8192, aggregate: 8192, bug: 8192 }, min_output_tokens: { fact: 256, aggregate: 256, bug: 256 }, chars_per_token: 3.5 } as Partial<CalibrationRecord>));
    const r = run({ dir, local: [locTarget(), locTarget(PROVISIONAL_LOCAL_CTX, NANBEIGE_MLX)] });
    expect((await r.p).map((m) => m.id)).toEqual([REMOTE, NANBEIGE_MLX]);
    expect(r.lines.join("")).toContain(`local fallback skipped: ${LFM3_MLX}`);
  });
  it("every local model unfit, remote available: no local fallback, one line, the remote chain only", async () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, unfitRecord());
    const r = run({ dir, local: locTarget() });
    expect((await r.p).map((m) => m.id)).toEqual([REMOTE]);
    expect(r.lines.join("")).toContain("no local model is fit for session-summary (task kind aggregate)");
  });
  it("every local model unfit, local-only: a clear error naming the model and the kind, nothing sent", async () => {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, unfitRecord());
    const r = run({ dir, local: locTarget(), localOnly: true });
    await expect(r.p).rejects.toThrow(/every local model is unusable for session-summary \(task kind aggregate\).*LFM3-1\.7B-MLX-4bit.*unfit for aggregate/);
    expect(r.waited()).toBe(0);
  });
  it("local-only with no managed target fails fast", async () => {
    const r = run({ dir: tempDir("llm-ext-ls-"), local: null, localOnly: true });
    await expect(r.p).rejects.toThrow(/selected profile is local.*no managed local profile/);
  });
});

/**
 * Transcript-like text (coordinator 2026-11-15: a realistic fixture, not one repeated long word): prose, commands,
 * paths, code and an error line, rotated so no two turns are identical. `sentences` lines per turn.
 */
const REALISTIC_LINES = [
  "Please fix the failing build in scripts/llm-ext and keep the change small.",
  "Ran `npx tsc --noEmit -p scripts/llm-ext` and it reported two errors in src/index.ts.",
  "The error was: TS2339: Property 'requestOptions' does not exist on type 'LocalSummaryProfile'.",
  "const budget = Math.min(fill, windowTokens - outputCap - SLOT_OVERHEAD);",
  "I read local-input-budget.ts lines 140-170 to see how the calibrated window is computed.",
  "Next step: rerun the unit tests for the new file only, then report back to the coordinator.",
  "git diff --stat shows 6 files changed, 88 insertions(+), 28 deletions(-).",
  "The broker queues jobs while the governor lease is held; nothing fails, requests wait.",
];
function realisticText(turn: number, sentences: number): string {
  return Array.from({ length: sentences }, (_, k) => REALISTIC_LINES[(turn + k) % REALISTIC_LINES.length]).join("\n");
}

describe("driver with the local model last (TRDD-TYHKAKCB)", () => {
  function transcript(dir: string, turns: number, words: number): string {
    const p = join(dir, "in.jsonl");
    const lines = Array.from({ length: turns }, (_, i) =>
      JSON.stringify({ type: "user", uuid: `u${i}`, parentUuid: null, timestamp: "t", message: { role: "user", content: `turn ${i}: ${realisticText(i, words)}` } }),
    );
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }
  async function localModel(): Promise<EligibleModel> {
    const dir = tempDir("llm-ext-ls-");
    writeRecord(dir, okRecord());
    const plan = planLocalSummaryModel(dir, locTarget());
    if (plan.state !== "ready") throw new Error("fixture plan not ready");
    return plan.model;
  }

  it("refuses a remote model placed after the local one", async () => {
    const dir = tempDir("llm-ext-ls-drv-");
    const local = await localModel();
    await expect(
      summarizeSession({
        transcriptPath: transcript(dir, 2, 10),
        checkpointPath: join(dir, "cp.json"),
        modelId: local.id,
        modelMaxContext: local.contextLength,
        modelMaxCompletionTokens: local.maxCompletionTokens,
        modelLocal: true,
        fallbackModels: [{ id: REMOTE, contextLength: 1_000_000, maxCompletionTokens: 32_000 }],
        callModel: async () => summaryFixture("x"),
      }),
    ).rejects.toThrow(/follows a local one/);
  });

  it("a local-only chain passes the cost gate and every prompt fits the calibrated byte budget", async () => {
    const dir = tempDir("llm-ext-ls-drv-");
    const local = { ...(await localModel()) };
    const budgetBytes = Math.floor((PROVISIONAL_LOCAL_CTX - CAP_OFF - 512) * 3.5 * CHARS_PER_TOKEN_SAFETY);
    const sizes: number[] = [];
    const callModel: CallModelFn = async (prompt, modelId, maxOut) => {
      expect(modelId).toBe(LFM3_MLX);
      expect(maxOut).toBe(CAP_OFF);
      sizes.push(Buffer.byteLength(prompt, "utf8"));
      return summaryFixture("ok");
    };
    const result = await summarizeSession({
      transcriptPath: transcript(dir, 30, 10),
      checkpointPath: join(dir, "cp.json"),
      modelId: local.id,
      modelMaxContext: local.contextLength,
      modelMaxCompletionTokens: local.maxCompletionTokens,
      modelLocal: true,
      chunkOverlapTurns: 0,
      concurrency: "auto",
      callModel,
    });
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(sizes.length).toBe(result.totalChunks);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(budgetBytes);
  });

  it("fan-out over remote models never sends to the local model nor shrinks remote chunks to its window", async () => {
    const dir = tempDir("llm-ext-ls-drv-");
    const local = await localModel();
    const called = new Set<string>();
    const result = await summarizeSession({
      transcriptPath: transcript(dir, 30, 10),
      checkpointPath: join(dir, "cp.json"),
      modelId: REMOTE,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 32_000,
      fallbackModels: [{ id: REMOTE2, contextLength: 1_000_000, maxCompletionTokens: 32_000 }, local],
      chunkOverlapTurns: 0,
      concurrency: "auto",
      callModel: async (_p, modelId) => {
        called.add(modelId);
        return summaryFixture("ok");
      },
    });
    expect(called.has(LFM3_MLX)).toBe(false);
    // ~30 x 60 words fits one 25k-token remote chunk; the local window would need several.
    expect(result.totalChunks).toBe(1);
  });

  it("switches to the local model when the remote one is delisted, re-chunking to the local window", async () => {
    const dir = tempDir("llm-ext-ls-drv-");
    const local = await localModel();
    const budgetBytes = Math.floor((PROVISIONAL_LOCAL_CTX - CAP_OFF - 512) * 3.5 * CHARS_PER_TOKEN_SAFETY);
    const localSizes: number[] = [];
    const result = await summarizeSession({
      transcriptPath: transcript(dir, 30, 10),
      checkpointPath: join(dir, "cp.json"),
      modelId: REMOTE,
      modelMaxContext: 1_000_000,
      modelMaxCompletionTokens: 32_000,
      fallbackModels: [local],
      chunkOverlapTurns: 0,
      callModel: async (prompt, modelId) => {
        if (modelId === REMOTE) throw new Error("404 No endpoints found for this model — it has been delisted");
        localSizes.push(Buffer.byteLength(prompt, "utf8"));
        return summaryFixture("ok");
      },
    });
    expect(result.modelId).toBe(LFM3_MLX);
    expect(result.fallbackEvents.map((e) => [e.fromModel, e.toModel])).toEqual([[REMOTE, LFM3_MLX]]);
    expect(result.totalChunks).toBeGreaterThan(1);
    for (const s of localSizes) expect(s).toBeLessThanOrEqual(budgetBytes);
  });

  it("re-splits a chunk the local server rejects as a context overflow (the guard behind the 5 chars/token ceiling)", async () => {
    const dir = tempDir("llm-ext-ls-drv-");
    const sized = await localModel();
    // A local model whose declared window is TWICE what the server really takes, so the first chunks overflow it:
    // the shape a text denser than 5 characters per token produces.
    const window = sized.contextLength - Math.min(sized.maxCompletionTokens, MAX_SUMMARY_COMPLETION_TOKENS) - PROMPT_OVERHEAD_TOKENS;
    const inflated: EligibleModel = { ...sized, contextLength: sized.contextLength + window };
    const budgetBytes = Math.floor((PROVISIONAL_LOCAL_CTX - CAP_OFF - 512) * 3.5 * CHARS_PER_TOKEN_SAFETY);
    let overflows = 0;
    const accepted: number[] = [];
    const result = await summarizeSession({
      transcriptPath: transcript(dir, 30, 10),
      checkpointPath: join(dir, "cp.json"),
      modelId: inflated.id,
      modelMaxContext: inflated.contextLength,
      modelMaxCompletionTokens: inflated.maxCompletionTokens,
      modelLocal: true,
      chunkOverlapTurns: 0,
      callModel: async (prompt) => {
        const bytes = Buffer.byteLength(prompt, "utf8");
        if (bytes > budgetBytes) {
          overflows++;
          // llama-server's own rejection of an over-window request (type exceed_context_size_error), with NO generic
          // "maximum context length" phrase, so the test shows that wording itself is classified as an overflow.
          throw new Error(`API error 400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":${PROVISIONAL_LOCAL_CTX + 1},"n_ctx":${PROVISIONAL_LOCAL_CTX}}}`);
        }
        accepted.push(bytes);
        return summaryFixture("ok");
      },
    });
    expect(overflows).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(accepted.length).toBe(result.totalChunks);
    for (const b of accepted) expect(b).toBeLessThanOrEqual(budgetBytes);
  });
});

describe("queueLocalCalibrations (background calibration of a skipped uncalibrated model)", () => {
  const profiles = () => Object.fromEntries(builtinLocalProfiles().map((b) => [b.name, b.profile]));
  it("queues an uncalibrated model once, starts the runner once, and never re-queues it", async () => {
    const dir = tempDir("llm-ext-lq-");
    const lines: string[] = [];
    let runs = 0;
    const o = { dir, profiles: profiles(), targets: [locTarget()], startRunner: async () => void runs++, write: (l: string) => void lines.push(l) };
    expect(await queueLocalCalibrations(o)).toEqual([LFM3_MLX]);
    expect(readQueue(dir).map((q) => [q.engine, q.model, q.force ?? false])).toEqual([["locals", LFM3_MLX, false]]);
    expect(runs).toBe(1);
    expect(lines.join("")).toContain(`queued '${LFM3_MLX}'`);
    // Second time: already queued, nothing queued, no runner start, no line.
    lines.length = 0;
    expect(await queueLocalCalibrations(o)).toEqual([]);
    expect(readQueue(dir)).toHaveLength(1);
    expect(runs).toBe(1);
    expect(lines).toEqual([]);
  });
  it("at most once per model per process: a model taken off the queue is not queued again by this process", async () => {
    const dir = tempDir("llm-ext-lq-");
    let runs = 0;
    const o = { dir, profiles: profiles(), targets: [locTarget()], startRunner: async () => void runs++, write: () => undefined };
    expect(await queueLocalCalibrations(o)).toEqual([LFM3_MLX]);
    // The runner took it off the queue (no record yet): this process still does not queue it again.
    writeFileSync(join(dir, "calibration", "queue.json"), JSON.stringify({ version: 1, items: [] }));
    expect(await queueLocalCalibrations(o)).toEqual([]);
    expect(readQueue(dir)).toEqual([]);
    expect(runs).toBe(1);
  });
  it("never queues while a calibration runner is active (the calibration-status check), and says so", async () => {
    const dir = tempDir("llm-ext-lq-");
    // A real process whose argv carries __calibrate, named by the runner state file: what liveCalibrator accepts.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", CALIBRATE_ARGV], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    writeFileSync(calibratorStatePath(dir), JSON.stringify({ pid: child.pid, version: "test", startedAt: new Date().toISOString() }));
    const lines: string[] = [];
    let runs = 0;
    expect(await queueLocalCalibrations({ dir, profiles: profiles(), targets: [locTarget()], startRunner: async () => void runs++, write: (l) => void lines.push(l) })).toEqual([]);
    expect(readQueue(dir)).toEqual([]);
    expect(runs).toBe(0);
    expect(lines.join("")).toContain(`a calibration runner is active (pid ${child.pid})`);
  });
  it("never queues a model that already has a record (ok or unfit), and never --force", async () => {
    const dir = tempDir("llm-ext-lq-");
    writeRecord(dir, unfitRecord());
    let runs = 0;
    expect(await queueLocalCalibrations({ dir, profiles: profiles(), targets: [locTarget()], startRunner: async () => void runs++, write: () => undefined })).toEqual([]);
    expect(readQueue(dir)).toEqual([]);
    expect(runs).toBe(0);
  });
  it("a runner that cannot start is one line, not a failure of the remote run", async () => {
    const dir = tempDir("llm-ext-lq-");
    const lines: string[] = [];
    await queueLocalCalibrations({ dir, profiles: profiles(), targets: [locTarget()], startRunner: async () => { throw new Error("spawn refused"); }, write: (l) => void lines.push(l) });
    expect(lines.join("")).toContain("calibration runner could not be started: spawn refused");
  });
});

describe("resolveSessionSummaryChain (the index.ts seam)", () => {
  const settingsProfiles = () => Object.fromEntries(builtinLocalProfiles().map((b) => [b.name, b.profile]));
  const remoteModels: EligibleModel[] = [{ id: REMOTE, contextLength: 1_000_000, maxCompletionTokens: 32_000 }];
  function seams(dir: string, over: Partial<Parameters<typeof resolveSessionSummaryChain<string>>[0]> = {}) {
    const lines: string[] = [];
    const counters = { runner: 0, wait: 0 };
    const s = {
      active: null,
      profiles: settingsProfiles(),
      dir,
      slotCtx,
      selectRemote: async () => remoteModels,
      depsFor: (p: ResolvedProfile) => `deps:${p.name}`,
      startCalibrationRunner: async () => void counters.runner++,
      waitForCalibration: async () => void counters.wait++,
      write: (l: string) => void lines.push(l),
      ...over,
    };
    return { s, lines, counters };
  }
  it("remote first, local last, with the deps of the local profile that serves it", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s } = seams(dir);
    const r = await resolveSessionSummaryChain(s);
    expect(r.models.map((m) => m.id)).toEqual([REMOTE, LFM3_MLX]);
    expect(r.local).toEqual({ modelId: LFM3_MLX, deps: "deps:locals-mlx" });
  });
  it("uncalibrated locals with remote up: no local fallback, the head is queued in the background, no wait", async () => {
    const dir = tempDir("llm-ext-chain-");
    const { s, lines, counters } = seams(dir);
    const r = await resolveSessionSummaryChain(s);
    expect(r.models.map((m) => m.id)).toEqual([REMOTE]);
    expect(r.local).toBeNull();
    expect(counters.wait).toBe(0);
    expect(counters.runner).toBe(1);
    // Only the preferred uncalibrated model (the locals-mlx head) is queued, one calibration at a time.
    expect(readQueue(dir).map((q) => q.model)).toEqual([LFM3_MLX]);
    expect(lines.join("")).toContain("in the background");
  });
  it("an explicit min_context gives no local fallback and queues nothing", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s, counters } = seams(dir, { minContext: 500_000 });
    const r = await resolveSessionSummaryChain(s);
    expect(r.models.map((m) => m.id)).toEqual([REMOTE]);
    expect(counters.runner).toBe(0);
  });
  it("a remote list with no completion ceiling falls to the local model", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s, lines } = seams(dir, { selectRemote: async () => [{ id: REMOTE, contextLength: 1_000_000, maxCompletionTokens: 0 }] });
    const r = await resolveSessionSummaryChain(s);
    expect(r.models.map((m) => m.id)).toEqual([LFM3_MLX]);
    expect(lines.join("")).toContain("no max_completion_tokens");
  });
  it("a selected local profile runs local-only and never asks the remote catalog", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s } = seams(dir, { active: builtin("locals-mlx"), selectRemote: async () => { throw new Error("remote must not be asked"); } });
    const r = await resolveSessionSummaryChain(s);
    expect(r.models.map((m) => m.id)).toEqual([LFM3_MLX]);
    expect(r.local?.deps).toBe("deps:locals-mlx");
  });

  const NOT_USED = "are not used";
  const remoteProfile = (name: string, over: Record<string, unknown> = {}): ResolvedProfile =>
    resolveProfile(name, { mode: "remote", api: "openrouter-remote", model: "vendor/paid-model", api_key: "sk-or-test-direct", ...over } as Parameters<typeof resolveProfile>[1]); // ubs:ignore (test fixture, not a key)
  it("an active paid (non-local, non-free-only) profile: one stderr line says its models are not used, the chain stays free-only", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s, lines } = seams(dir, { active: remoteProfile("my-paid") });
    expect(s.active?.freeOnly).toBe(false);
    const r = await resolveSessionSummaryChain(s);
    expect(lines.filter((l) => l.includes(NOT_USED))).toEqual([
      "[llm-externalizer] session-summary: runs on free OpenRouter models and managed local models only; the models of profile 'my-paid' are not used\n",
    ]);
    expect(r.models.map((m) => m.id)).toEqual([REMOTE, LFM3_MLX]);
  });
  it("an active free-only profile prints no 'not used' line", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s, lines } = seams(dir, { active: remoteProfile("my-free", { free_only: true, free_models: ["vendor/free-one:free"] }) });
    expect(s.active?.freeOnly).toBe(true);
    await resolveSessionSummaryChain(s);
    expect(lines.join("")).not.toContain(NOT_USED);
  });
  it("an active local profile prints no 'not used' line", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s, lines } = seams(dir, { active: builtin("locals-mlx") });
    expect(s.active?.isLocal).toBe(true);
    await resolveSessionSummaryChain(s);
    expect(lines.join("")).not.toContain(NOT_USED);
  });
  it("no active profile prints no 'not used' line", async () => {
    const dir = tempDir("llm-ext-chain-");
    writeRecord(dir, okRecord());
    const { s, lines } = seams(dir);
    expect(s.active).toBeNull();
    await resolveSessionSummaryChain(s);
    expect(lines.join("")).not.toContain(NOT_USED);
  });

});

/**
 * End to end through index.ts (coordinator decision 4): `session_summary` dispatched under a selected managed local
 * profile, with the REAL index.ts wiring (resolveSessionSummaryChain, ssLocal.deps = makeProviderDeps over the local
 * profile), the real provider layer and the real broker client, against a stand-in broker: a separate node process
 * whose argv carries __broker (what broker/client.ts isBrokerProcess checks) serving /v1/health and /v1/jobs on
 * 127.0.0.1 with real sockets, named by broker-local.json. No module of ours is mocked.
 */
describe("session_summary reaches the local broker (index.ts wiring)", () => {
  const BROKER_SCRIPT = `
const http = require("http"); const log = []; let n = 0;
const s = http.createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
  const json = (code, v) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(v)); };
  if (q.url === "/v1/health") return json(200, { version: process.env.V, draining: false });
  if (q.url === "/log") return json(200, log);
  if (q.method === "POST" && q.url === "/v1/jobs") { const id = "j" + ++n; log.push({ id, token: q.headers["x-llm-ext-broker-token"], engine: q.headers["x-llm-ext-engine"], body: JSON.parse(b) }); return json(202, { job: id }); }
  if (q.method === "GET" && q.url.startsWith("/v1/jobs/")) {
    const reply = { id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "## Current Work\\nSummarized by the local broker." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    const t = Date.now();
    return json(200, { state: "done", status: 200, contentType: "application/json", body: JSON.stringify(reply), submittedAt: t, dispatchedAt: t, finishedAt: t });
  }
  r.writeHead(404); r.end();
}); });
s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;

  it("a local-only session summary is sent to the broker's /v1/jobs with the local model, and its answer is the summary", async () => {
    const root = mkdtempSync(join("/tmp", "llm-ext-ss-broker-"));
    const dirs = { LLM_EXT_CONFIG_DIR: join(root, "cfg"), HOME: join(root, "home"), LLM_EXT_OUTPUT_DIR: join(root, "out") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const useLocals = localsPlatformSupported();
    const name = useLocals ? "locals-mlx" : "local_llama";
    const b = builtinLocalProfiles().find((p) => p.name === name)!;
    const engine = useLocals ? "locals" : "llama";
    const model = (b.profile as unknown as { model: string }).model;
    writeFileSync(
      join(dirs.LLM_EXT_CONFIG_DIR, "settings.yaml"),
      [`active: ${name}`, "profiles:", `  ${name}:`, "    profile-type: local", "    mode: local", `    api: ${useLocals ? "locals-local" : "llamacpp-local"}`, `    url: ${(b.profile as unknown as { url: string }).url}`, "    server: managed", `    model: ${model}`, ""].join("\n"),
    );
    writeRecord(dirs.LLM_EXT_CONFIG_DIR, okRecord({ ...recordFixture(engine, model), window_tokens: 16384, fill_tokens: { fact: 8192, aggregate: 8192, bug: 8192 }, min_output_tokens: { fact: 256, aggregate: 256, bug: 256 }, chars_per_token: 3.5 } as Partial<CalibrationRecord>));
    const VERSION = "tyhkakcb-test";
    const child = spawn(process.execPath, ["-e", BROKER_SCRIPT, BROKER_ARGV], { env: { ...process.env, V: VERSION }, stdio: ["ignore", "pipe", "inherit"] });
    const prevEnv = { ...process.env };
    cleanups.push(() => {
      child.kill("SIGKILL");
      for (const k of [...Object.keys(dirs), "LLM_EXT_INSTALL_RULE"]) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      rmSync(root, { recursive: true, force: true });
    });
    const port = await new Promise<number>((res, rej) => {
      child.stdout!.once("data", (d: Buffer) => res(Number(String(d).trim())));
      child.once("exit", (c) => rej(new Error(`stand-in broker exited ${c}`)));
    });
    writeFileSync(brokerStatePath(dirs.LLM_EXT_CONFIG_DIR), JSON.stringify({ pid: child.pid, port, token: "tok", version: VERSION, startedAt: new Date().toISOString() }));
    const transcriptPath = join(root, "session.jsonl");
    writeFileSync(transcriptPath, [0, 1, 2].map((i) => JSON.stringify({ type: "user", uuid: `u${i}`, parentUuid: null, timestamp: "t", message: { role: "user", content: realisticText(i, 3) } })).join("\n") + "\n");

    Object.assign(process.env, dirs, { LLM_EXT_INSTALL_RULE: "0" });
    vi.resetModules();
    const idx = await import("../index.js");
    // The same module instance index.ts uses after resetModules: the CLI sets this version at start (cli/main.ts).
    (await import("../broker/client.js")).setBrokerClientVersion(VERSION);
    await idx.boot();
    const res = await idx.dispatchCallTool("session_summary", { transcript: transcriptPath, stdout: true, concurrency: 1 });
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
    expect(text).toContain("Summarized by the local broker.");
    expect(res.isError).not.toBe(true);
    const log = (await (await fetch(`http://127.0.0.1:${port}/log`)).json()) as Array<{ token: string; engine: string; body: { model: string } }>;
    expect(log.length).toBeGreaterThan(0);
    for (const job of log) {
      expect(job.token).toBe("tok");
      expect(job.engine).toBe(engine);
      expect(job.body.model.startsWith(model.split(":")[0]) || job.body.model === model).toBe(true);
    }
  }, 60_000);
});
