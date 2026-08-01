/**
 * Tests for the free-pool auto-benchmark trigger (TRDD-f1510055).
 *
 * Pure offline — every test injects its own cache/lock/log paths via opts
 * and a fake scriptPath that points at a no-op stub so no real bench
 * ever spawns. Tests only exercise the DECISION logic; the spawn() call
 * itself just verifies the script-path argv shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { maybeTriggerFreePoolBench } from "./free-pool-auto-bench";

let dir: string;
let cachePath: string;
let lockPath: string;
let logPath: string;
let stubScript: string;
let log: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-ext-autobench-test-"));
  cachePath = join(dir, "benchmark-results.json");
  lockPath = join(dir, "free-pool-bench.lock");
  logPath = join(dir, "free-pool-bench.log");
  // The stub is a JS file that exits immediately. spawn() is real but the
  // child is a noop, so we observe spawn outcome without burning anything.
  stubScript = join(dir, "stub-benchmark.js");
  writeFileSync(stubScript, "process.exit(0)\n", "utf-8");
  log = [];
});

afterEach(() => {
  // Give the detached child a tick to exit so its inherited fd is released
  // before rmSync tries to clear the dir. The OS reaps the orphan PID; we
  // just want the log file unlocked.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* race with detached child closing fds — harmless on test cleanup */
  }
});

function commonOpts() {
  return {
    activeProfile: "remote-free-ensemble",
    cachePath,
    lockPath,
    logPath,
    scriptPath: stubScript,
    log: (m: string) => log.push(m),
    env: {} as NodeJS.ProcessEnv,
  };
}

describe("maybeTriggerFreePoolBench — skip paths", () => {
  it("skips when free_only is not active", () => {
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: false,
      freeOnlyWasOn: false,
    });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("free_only not active");
    expect(r.pid).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("skips when LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH=1", () => {
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
      env: { LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH: "1" },
    });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("disabled via env");
    expect(log.join("")).toContain("LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH=1");
  });

  it("skips when cache already has :free entries", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        results: [
          { modelId: "qwen/qwen3-coder:free", meanF1: 0.92 },
        ],
      }),
      "utf-8",
    );
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
    });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("cache already has :free entries");
  });

  it("treats cache with only non-:free entries as empty", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        results: [
          { modelId: "deepseek/deepseek-v4-pro", meanF1: 0.95 },
        ],
      }),
      "utf-8",
    );
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
    });
    expect(r.outcome).toBe("spawned");
  });

  it("skips on a reload when free_only was already ON before", () => {
    // Cache is empty so the only thing that prevents spawn is the
    // not-a-transition check.
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: true,
    });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("not a free_only transition");
  });

  it("skips when a lock file holds the current process's PID", () => {
    // current process is alive → counts as a live lock
    writeFileSync(lockPath, String(process.pid), "utf-8");
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
    });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("lock holds live pid");
    expect(log.join("")).toContain("already in progress");
  });

  it("ignores a stale lock and spawns anyway", () => {
    // PID 99999999 is virtually guaranteed not to exist
    writeFileSync(lockPath, "99999999", "utf-8");
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
    });
    expect(r.outcome).toBe("spawned");
    expect(r.pid).toBeGreaterThan(0);
  });
});

describe("maybeTriggerFreePoolBench — spawn", () => {
  it("spawns on a real OFF→ON transition with no cache", () => {
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });
    expect(r.outcome).toBe("spawned");
    expect(r.pid).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(true);
    const recordedPid = parseInt(readFileSync(lockPath, "utf-8"), 10);
    expect(recordedPid).toBe(r.pid);
    expect(log.join("")).toContain(
      "spawned auto-bench",
    );
  });

  it("spawns at startup (freeOnlyWasOn=null) when free_only is on", () => {
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
    });
    expect(r.outcome).toBe("spawned");
    expect(r.pid).toBeGreaterThan(0);
  });

  it("returns a structured TriggerResult shape on every path", () => {
    const a = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: false,
      freeOnlyWasOn: false,
    });
    expect(a).toMatchObject({
      outcome: "skipped",
      reason: expect.any(String),
      pid: null,
    });
    const b = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: null,
    });
    expect(b).toMatchObject({
      outcome: "spawned",
      reason: null,
      pid: expect.any(Number),
    });
  });
});

describe("maybeTriggerFreePoolBench — robustness", () => {
  it("handles a non-JSON cache file as empty", () => {
    writeFileSync(cachePath, "not json {", "utf-8");
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });
    expect(r.outcome).toBe("spawned");
  });

  it("handles a cache with non-array results as empty", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ results: "oops not an array" }),
      "utf-8",
    );
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });
    expect(r.outcome).toBe("spawned");
  });

  it("handles a lock file with garbage content (treated as stale)", () => {
    writeFileSync(lockPath, "not a number", "utf-8");
    const r = maybeTriggerFreePoolBench({
      ...commonOpts(),
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });
    expect(r.outcome).toBe("spawned");
  });
});
