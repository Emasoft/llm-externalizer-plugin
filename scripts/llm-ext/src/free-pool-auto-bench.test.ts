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
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
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

/**
 * The DEFAULT path resolution — deliberately the one thing every other test
 * here bypasses by injecting cachePath/lockPath/logPath.
 *
 * That injection is what let a real bug live: the module built its paths from
 * join(homedir(), ".llm-externalizer") at import time, so LLM_EXT_CONFIG_DIR
 * was honoured for settings.yaml but IGNORED for the bench cache, lock and
 * log. A run pointed at a scratch/CI config dir still took the lock and wrote
 * the log in the user's REAL config dir — observed in the wild spawning a
 * child that read the REAL settings.yaml and tried to benchmark paid models
 * (only the allow_paid_models master switch stopped it). getConfigDir() also
 * resolves symlinks in the deepest existing ancestor, so the constant was
 * skipping a security control too.
 *
 * These tests omit the path opts ON PURPOSE. A test that injects paths cannot
 * observe this class of bug at all.
 */
describe("maybeTriggerFreePoolBench — default paths honour LLM_EXT_CONFIG_DIR", () => {
  let prevConfigDir: string | undefined;
  let cfgDir: string;

  beforeEach(() => {
    // NOT tmpdir(): on macOS that is /var/folders/..., and getConfigDir()
    // rejects any config dir outside $HOME or /private/tmp (its own guard
    // against a planted path). /tmp realpaths to /private/tmp, so it is the
    // one scratch location a legitimate config dir may live in.
    cfgDir = mkdtempSync("/tmp/llm-ext-autobench-cfg-");
    prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
    try {
      rmSync(cfgDir, { recursive: true, force: true });
    } catch {
      /* race with the detached child closing fds — harmless on cleanup */
    }
  });

  it("writes the lock and log under LLM_EXT_CONFIG_DIR, never under $HOME", () => {
    const r = maybeTriggerFreePoolBench({
      activeProfile: "remote-free-ensemble",
      // cachePath / lockPath / logPath deliberately OMITTED — the whole point.
      scriptPath: stubScript,
      log: (m: string) => log.push(m),
      env: {} as NodeJS.ProcessEnv,
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });

    expect(r.outcome).toBe("spawned");
    expect(existsSync(join(cfgDir, "free-pool-bench.lock"))).toBe(true);

    // The announced log path must be INSIDE the configured dir. realpath is
    // required: getConfigDir() resolves /tmp -> /private/tmp on macOS, so a
    // raw compare against cfgDir would fail on a CORRECT implementation.
    const announced = log.join("");
    expect(announced).toContain(realpathSync(cfgDir));
    expect(announced).not.toContain(join(homedir(), ".llm-externalizer"));
  });

  // The lock/log assertion above cannot see a regression in the CACHE path:
  // with the cache resolved back to $HOME, a clean CI box simply finds no file,
  // reports "no :free entries", and spawns — which is what that test asserts.
  // Reading the REAL cache was the headline harm in the first place, so prove
  // it separately, from the one outcome only the configured dir can produce.
  it("reads the benchmark cache from LLM_EXT_CONFIG_DIR, not from $HOME", () => {
    writeFileSync(
      join(cfgDir, "benchmark-results.json"),
      JSON.stringify({ results: [{ modelId: "qwen/qwen3-coder:free" }] }),
      "utf-8",
    );

    const r = maybeTriggerFreePoolBench({
      activeProfile: "remote-free-ensemble",
      // cachePath deliberately OMITTED — the whole point.
      scriptPath: stubScript,
      log: (m: string) => log.push(m),
      env: {} as NodeJS.ProcessEnv,
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });

    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("cache already has :free entries");
    expect(existsSync(join(cfgDir, "free-pool-bench.lock"))).toBe(false);
  });

  // getConfigDir() THROWS on a dir outside its allowlist ($HOME or /tmp). This
  // helper is called from index.ts's module-load boot IIFE and from the middle
  // of applyNewSettings' atomic swap, neither of which wraps it — so a throw
  // here would kill boot, or leave that swap half-published. Fail-open instead.
  it("degrades to a skip when the configured dir is outside the allowlist", () => {
    process.env.LLM_EXT_CONFIG_DIR = "/etc/llm-ext-not-an-allowed-config-dir";

    const r = maybeTriggerFreePoolBench({
      activeProfile: "remote-free-ensemble",
      scriptPath: stubScript,
      log: (m: string) => log.push(m),
      env: {} as NodeJS.ProcessEnv,
      freeOnlyActive: true,
      freeOnlyWasOn: false,
    });

    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("config dir unavailable");
    expect(r.pid).toBeNull();
    expect(log.join("")).toContain("config dir unusable");
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
