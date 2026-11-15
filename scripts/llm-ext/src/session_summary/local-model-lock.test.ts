// TRDD-TYHKAKCB known cost: queueing a background calibration from a REMOTE session-summary run must never stall on
// the calibration state lock (it used to wait up to 30 s, synchronously, inside queueManual). A busy lock skips the
// enqueue with one line and lets a later run retry. Real temp config dirs, the lock held exactly as another process
// holds it (calibration/state.lock with a fresh mtime), no mocks.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinLocalProfiles, PROVISIONAL_LOCAL_CTX, resolveProfile } from "../config.js";
import { readQueue } from "../calibration/state.js";
import { queueLocalCalibrations, __resetQueuedCalibrationsForTests, type LocalSummaryTarget } from "./local-model.js";

const LFM3_MLX = "LiquidAI/LFM3-1.7B-MLX-4bit";

describe("queueLocalCalibrations never blocks on a busy calibration state lock (TRDD-TYHKAKCB)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "llm-ext-lq-lock-"));
    __resetQueuedCalibrationsForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profiles = () => Object.fromEntries(builtinLocalProfiles().map((b) => [b.name, b.profile]));
  function target(): LocalSummaryTarget {
    const b = builtinLocalProfiles().find((p) => p.name === "locals-mlx");
    if (b === undefined) throw new Error("no built-in locals-mlx");
    return { profile: resolveProfile("locals-mlx", b.profile), model: LFM3_MLX, engine: "locals", ctx: PROVISIONAL_LOCAL_CTX };
  }
  /** Hold the lock the way another process does: the lock directory with an owner token, freshly modified. */
  function holdStateLock(): string {
    const lock = join(dir, "calibration", "state.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "another-process-token");
    return lock;
  }

  it("skips at once with one line when the lock is held, queues nothing, starts no runner, and retries on a later run", async () => {
    const lock = holdStateLock();
    const lines: string[] = [];
    let runs = 0;
    const o = { dir, profiles: profiles(), targets: [target()], startRunner: async () => void runs++, write: (l: string) => void lines.push(l) };

    const t0 = Date.now();
    expect(await queueLocalCalibrations(o)).toEqual([]);
    const waited = Date.now() - t0;
    // queueManual waited up to 30 s here; the non-blocking enqueue gives up after at most one 20 ms poll.
    expect(waited).toBeLessThan(1_000);
    expect(readQueue(dir)).toEqual([]);
    expect(runs).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the calibration state lock is busy");
    expect(lines[0]).toContain(LFM3_MLX);
    // The other process's lock is untouched (never taken over, never removed).
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("another-process-token");

    // The lock is released: the same process tries again (the skip did not mark the model as done) and queues it.
    rmSync(lock, { recursive: true, force: true });
    lines.length = 0;
    expect(await queueLocalCalibrations(o)).toEqual([LFM3_MLX]);
    expect(readQueue(dir).map((q) => [q.engine, q.model, q.reason, q.force ?? false])).toEqual([["locals", LFM3_MLX, "manual", false]]);
    expect(runs).toBe(1);
    expect(lines.join("")).toContain(`queued '${LFM3_MLX}'`);
  });

  it("keeps queueManual's engineOf refusal: a model no managed profile names is one line, never queued", async () => {
    const lines: string[] = [];
    let runs = 0;
    const unnamed = { ...target(), model: "org/not-in-any-profile" };
    expect(await queueLocalCalibrations({ dir, profiles: profiles(), targets: [unnamed], startRunner: async () => void runs++, write: (l: string) => void lines.push(l) })).toEqual([]);
    expect(readQueue(dir)).toEqual([]);
    expect(runs).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not queue org/not-in-any-profile");
    expect(lines[0]).toContain("no managed local profile");
  });
});
