/**
 * Direct tests for src/default-profiles-runner.ts.
 *
 * These matter because the ONE other test that touches this module
 * (default-profile-wiring.test.ts) MOCKS `populateDefaultProfile` — it proves
 * the dispatcher calls the runner, and nothing about what the runner decides.
 * The runner is where the money policy actually lives, so it needs its own
 * coverage.
 *
 * Hermetic: the only process ever spawned is a throwaway .js that exits
 * immediately. No benchmark, no network, no spend.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  populateDefaultProfile,
  describeOutcome,
  spawnDetachedDetector,
  detectProfileChangesArgs,
  requestProfileUpdate,
  backgroundUpdateRequestPathFor,
  profileUpdateRequestPending,
  takeProfileUpdateRequest,
  PROFILE_UPDATE_REQUESTED_ENV,
  PROFILE_UPDATE_RESPAWN_MS,
} from "./default-profiles-runner.js";
import { updateDynamicProfileRecord, recordBenchmarkFailure } from "./default-profiles-state.js";
import { getSettingsPath } from "./config.js";

let cfg = "";
let prevCfg: string | undefined;
/** A real, harmless script so a "spawn" under test costs a process exit. */
let noopScript = "";

beforeEach(() => {
  cfg = mkdtempSync(join("/tmp", "dpr-cfg-"));
  prevCfg = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfg;
  noopScript = join(cfg, "noop.js");
  writeFileSync(noopScript, "process.exit(0);\n");
});

afterEach(() => {
  if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
  rmSync(cfg, { recursive: true, force: true });
});

/** Defaults every case shares; each test overrides only what it is about. */
function opts(over: Partial<Parameters<typeof populateDefaultProfile>[0]> = {}) {
  return {
    profile: "free" as const,
    allowPaidModels: false,
    log: () => {},
    scriptPath: noopScript,
    env: { ...process.env } as NodeJS.ProcessEnv,
    ...over,
  };
}

  function recordedArgv(over: Parameters<typeof opts>[0]): string[] {
    const out = join(cfg, "argv.json");
    const tmp = out + ".tmp";
    const rec = join(cfg, "record.js");
    // The child writes to a TEMP name and renames it into place: rename is
    // atomic on POSIX, so the parent never observes a partially-written file
    // (the prior direct write let the poll below read mid-JSON.stringify output
    // under load and throw "Unexpected end of JSON input").
    writeFileSync(
      rec,
      `const fs=require("fs"); fs.writeFileSync(${JSON.stringify(tmp)}, JSON.stringify(process.argv.slice(2))); fs.renameSync(${JSON.stringify(tmp)}, ${JSON.stringify(out)}); process.exit(0);\n`,
    );
    const r = populateDefaultProfile(opts({ ...over, scriptPath: rec }));
    expect(r.kind).toBe("spawned");
    // The child is detached; poll briefly for the FINAL name only (never the
    // .tmp name) rather than sleeping blind.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !existsSync(out)) {
      // Busy-wait is acceptable here: the child exits in milliseconds and this
      // keeps the test synchronous alongside the sync populateDefaultProfile.
    }
    if (!existsSync(out)) throw new Error("recorder child never wrote its argv");
    return JSON.parse(readFileSync(out, "utf-8")) as string[];
  }


describe("populateDefaultProfile — the paid gate", () => {
  it("REFUSES a paid profile under allow_paid_models: false, and names the exact command instead of just failing", () => {
    const r = populateDefaultProfile(opts({ profile: "paid", allowPaidModels: false }));
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") throw new Error("unreachable");
    expect(r.remedy).toContain("--populate-default-profile paid");
    expect(r.reason).toMatch(/billable/i);
  });

  it("spawns a paid profile once allow_paid_models is true, and marks it as blocking the caller", () => {
    const r = populateDefaultProfile(opts({ profile: "paid", allowPaidModels: true }));
    expect(r.kind).toBe("spawned");
    if (r.kind !== "spawned") throw new Error("unreachable");
    // Paid population cannot be waited out inline (~15 min), so the caller must
    // be told to stop rather than proceed on a profile with no models.
    expect(r.blocksCaller).toBe(true);
  });

  it("NEVER gates `free` on allow_paid_models — a $0 benchmark has nothing to authorize", () => {
    const r = populateDefaultProfile(opts({ profile: "free", allowPaidModels: false }));
    expect(r.kind).toBe("spawned");
    if (r.kind !== "spawned") throw new Error("unreachable");
    // And it must not block: the command proceeds on FREE_POOL_SEED meanwhile.
    expect(r.blocksCaller).toBe(false);
  });
});

describe("populateDefaultProfile — the argv handed to the child", () => {
  /** Spawn a recorder script that dumps its own argv, so we assert what the
   *  child ACTUALLY receives rather than that a spawn merely happened. */
  it("passes --allow-paid-models-tests for a PAID profile — without it the child dies at the opt-in check and the profile can never populate", () => {
    // REGRESSION (v13.2.0): the flag was missing, so an authorized paid
    // population failed in seconds, banked a cooldown, and retried forever.
    // Asserting outcome.kind ONLY — as the original test did — cannot see this;
    // the spawn succeeds either way. The defect lives in the argv.
    const argv = recordedArgv({ profile: "paid", allowPaidModels: true, budgetUsd: 2 });
    expect(argv).toContain("--allow-paid-models-tests");
    expect(argv).toContain("--populate-default-profile");
    expect(argv).toContain("paid");
    expect(argv).toContain("--budget-usd");
  });

  it("does NOT pass the paid opt-in for `free` — a $0 benchmark has nothing to authorize", () => {
    const argv = recordedArgv({ profile: "free", allowPaidModels: true });
    expect(argv).not.toContain("--allow-paid-models-tests");
    expect(argv).not.toContain("--budget-usd");
  });
});

describe("populateDefaultProfile — the lock", () => {
  it("treats a lock holding a LIVE pid as 'already running' and starts nothing", () => {
    const lockPath = join(cfg, "held.lock");
    writeFileSync(lockPath, String(process.pid)); // this test process is alive
    const r = populateDefaultProfile(opts({ lockPath }));
    expect(r.kind).toBe("skipped");
    if (r.kind !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/already in progress/i);
  });

  it("checks the lock BEFORE the paid gate — advising a command that is already mid-flight would get it run twice", () => {
    // This ordering is the whole point: with the gate first, a paid profile
    // whose benchmark is ALREADY RUNNING would come back "refused, run <cmd>",
    // and a user following that advice starts a second one.
    const lockPath = join(cfg, "held.lock");
    writeFileSync(lockPath, String(process.pid));
    const r = populateDefaultProfile(
      opts({ profile: "paid", allowPaidModels: false, lockPath }),
    );
    expect(r.kind).toBe("skipped");
    expect(r.kind).not.toBe("refused");
  });

  it("ignores a STALE lock (dead pid) — a crashed benchmark must not wedge a profile onto the seed pool forever", () => {
    const lockPath = join(cfg, "stale.lock");
    // PID 2^22 is above every real pid_max on macOS/Linux, so it cannot exist.
    writeFileSync(lockPath, "4194304");
    const r = populateDefaultProfile(opts({ lockPath }));
    expect(r.kind).toBe("spawned");
  });

  it("records the spawned child's pid so a concurrent caller can see the run", () => {
    const lockPath = join(cfg, "fresh.lock");
    const r = populateDefaultProfile(opts({ lockPath }));
    expect(r.kind).toBe("spawned");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toMatch(/^\d+$/);
  });
});

describe("populateDefaultProfile — the opt-out", () => {
  it("honours LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION=1 and starts nothing", () => {
    const r = populateDefaultProfile(
      opts({ env: { LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1" } as NodeJS.ProcessEnv }),
    );
    expect(r.kind).toBe("skipped");
    if (r.kind !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/disabled/i);
  });

  it("fails OPEN on an unopenable log path — a population that cannot start must never fail the user's actual command", () => {
    // The parent is a regular FILE, so neither mkdir nor open can succeed. A
    // merely MISSING directory is not unopenable any more — the runner creates
    // it, which is what makes a first run work — so testing with one would
    // assert the opposite of the intended behaviour.
    const notADir = join(cfg, "blocker");
    writeFileSync(notADir, "not a directory\n");
    const r = populateDefaultProfile(opts({ logPath: join(notADir, "x.log") }));
    expect(r.kind).toBe("skipped"); // never a throw
  });

  it("creates a MISSING log directory instead of skipping — a first run, before the config dir exists, must still populate", () => {
    const r = populateDefaultProfile(opts({ logPath: join(cfg, "brand-new-dir", "x.log") }));
    expect(r.kind).toBe("spawned");
    expect(existsSync(join(cfg, "brand-new-dir", "x.log"))).toBe(true);
  });

  it("fails OPEN when the config dir is outside the allowlist — getConfigDir throws, and the caller would swallow that into silence", () => {
    // Reachable for real: the only caller is maintainOneDynamicProfile, reached
    // from maintainDynamicProfiles on every tool dispatch. That caller wraps each
    // profile in a try/catch, so a throw here does not fail the user's command —
    // it silently disables population for that profile and reports a generic
    // "maintenance failed" line. The `skipped` outcome asserted below is what
    // keeps the actual reason (an unusable config dir) legible.
    // (Until P6c-a the caller was maybeEnsureDefaultProfileReady, which had NO
    // try/catch, so the same throw killed the tool call outright.)
    process.env.LLM_EXT_CONFIG_DIR = "/etc/llm-ext-not-allowed";
    const r = populateDefaultProfile({
      profile: "free" as const,
      allowPaidModels: false,
      log: () => {},
      scriptPath: noopScript,
      env: { ...process.env } as NodeJS.ProcessEnv,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/config dir unusable/);
  });
});

describe("describeOutcome — says something only when the user must act", () => {
  it("stays SILENT for a spawned `free` population — the user asked a question, not for a status report", () => {
    const r = populateDefaultProfile(opts({ profile: "free" }));
    expect(describeOutcome(r)).toBeNull();
  });

  it("tells the user to re-run when a PAID population blocks the current command", () => {
    const r = populateDefaultProfile(opts({ profile: "paid", allowPaidModels: true }));
    const msg = describeOutcome(r);
    expect(msg).not.toBeNull();
    // P6c-a2a S4: this was `/paid/`, which cannot fail for what the title
    // claims — describeOutcome's REFUSAL branch also contains "paid"
    // (allow_paid_models), and so would a message naming the wrong profile
    // entirely. Pin the profile NAME as the message renders it, and the "re-run"
    // instruction that distinguishes the blocking branch from the refusal one.
    expect(msg).toContain("'paid' is being benchmarked now");
    expect(msg).toMatch(/Re-run this command/);
    expect(msg).not.toMatch(/allow_paid_models/); // i.e. not the refusal branch
  });

  it("surfaces both the reason and the remedy on a refusal — a refusal with no way forward is a dead end", () => {
    const r = populateDefaultProfile(opts({ profile: "paid", allowPaidModels: false }));
    const msg = describeOutcome(r);
    expect(msg).toContain("--populate-default-profile paid");
    expect(msg).toMatch(/allow_paid_models/);
  });

  it("stays silent when nothing happened", () => {
    const r = populateDefaultProfile(
      opts({ env: { LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1" } as NodeJS.ProcessEnv }),
    );
    expect(describeOutcome(r)).toBeNull();
  });
});

describe("populateDefaultProfile — the dynamic 'paid' daily spend cap (design §2.5, P5)", () => {
  it("REFUSES the dynamic 'paid' profile when the daily spend cap is already exhausted, even with allow_paid_models: true", async () => {
    const { bookDailySpend, DEFAULT_PAID_DAILY_CAP_USD } = await import("./benchmark/daily-spend.js");
    bookDailySpend(DEFAULT_PAID_DAILY_CAP_USD, Date.now());
    const r = populateDefaultProfile(opts({ profile: "paid", allowPaidModels: true }));
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") throw new Error("unreachable");
    expect(r.reason).toMatch(/daily.*spend cap/i);
  });

  it("passes --budget-usd = min(PAID_RUN_CAP_USD, dailyRemainingUsd()) for the dynamic 'paid' profile", () => {
      const argv = recordedArgv({ profile: "paid", allowPaidModels: true, budgetUsd: 999 });
    const budgetIdx = argv.indexOf("--budget-usd");
    expect(budgetIdx).toBeGreaterThanOrEqual(0);
    // Nothing was spent today and the caller asked for 999 — the run cap
    // (PAID_RUN_CAP_USD, DEFAULT_BUDGET_USD) must still win, never the caller's
    // larger number and never an unbounded pass-through.
    expect(Number(argv[budgetIdx + 1])).toBeLessThanOrEqual(2);
  });

  // D0 (TRDD-AL8GIZYA, plan item 2e): proves the CUSTOM `paid_benchmark_daily_cap_usd`
  // setting — not just the DEFAULT_PAID_DAILY_CAP_USD used above — actually governs
  // both the refusal boundary and the child's --budget-usd. The real gate is
  // `populateDefaultProfile` (this file's function under test), which reads
  // `dailyRemainingUsd(loadSettings())` -> `paidDailyCapUsd()`; the real CHARGE
  // mechanism a completed benchmark run books against that same cap is
  // `bookDailySpend` (benchmark/daily-spend.ts), wired as runPopulatePaidDefaultProfile's
  // SpendLedger `onBook` (benchmark/index.ts).
  it("a custom paid_benchmark_daily_cap_usd (settings.yaml), not the built-in default, bounds the paid populate run", async () => {
    const { bookDailySpend } = await import("./benchmark/daily-spend.js");
    // A custom cap far below DEFAULT_PAID_DAILY_CAP_USD (0.5): if the runner were
    // still reading the built-in default instead of this setting, spending $0.30
    // here would NOT exhaust it and the run below would wrongly be allowed to spawn.
    writeFileSync(getSettingsPath(), "paid_benchmark_daily_cap_usd: 0.3\n", "utf-8");
    bookDailySpend(0.3, Date.now());
    const refused = populateDefaultProfile(opts({ profile: "paid", allowPaidModels: true }));
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.reason).toMatch(/daily.*spend cap/i);
  });
});

describe("spawnDetachedDetector / detectProfileChangesArgs (C2b, TRDD-OE27RD7I §2)", () => {
  it("detectProfileChangesArgs names the exact flag+profile argv, once", () => {
    expect(detectProfileChangesArgs("free")).toEqual(["--detect-profile-changes", "free"]);
    expect(detectProfileChangesArgs("paid")).toEqual(["--detect-profile-changes", "paid"]);
  });

  it("spawns via the detached-spawn primitive with the detector argv, and reports a pid", async () => {
    const r = spawnDetachedDetector({ profile: "free", log: () => {}, scriptPath: noopScript, env: { ...process.env } });
    expect(r.ok).toBe(true);
    // Give the detached child a moment to exit before the config dir is torn
    // down in afterEach — matches this file's other spawn assertions.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // SG2 (USER 2026-09-18, "then make it a singleton for each profile then"):
  // this used to assert the OPPOSITE — a detector on its own lock could run
  // "while a benchmark sweep for the same profile is in flight". The USER's
  // explicit decision, after seeing that trade-off, reversed it: ONE lock
  // per profile, singleton across every mechanism including the detector.
  it("shares populateDefaultProfile's lock — a detector run for the SAME profile must be REFUSED while a benchmark is in flight", () => {
    const slowScript = join(cfg, "slow.js");
    writeFileSync(slowScript, "setTimeout(() => process.exit(0), 5000);\n");
    const populateResult = populateDefaultProfile(opts({ profile: "free", scriptPath: slowScript }));
    expect(populateResult.kind).toBe("spawned");
    const detectResult = spawnDetachedDetector({
      profile: "free",
      log: () => {},
      scriptPath: noopScript,
      env: { ...process.env },
    });
    expect(detectResult.ok).toBe(false);
  });

  it("a DIFFERENT profile's detector is unaffected — the singleton is per-profile, not global", () => {
    const slowScript = join(cfg, "slow.js");
    writeFileSync(slowScript, "setTimeout(() => process.exit(0), 5000);\n");
    const populateResult = populateDefaultProfile(opts({ profile: "free", scriptPath: slowScript }));
    expect(populateResult.kind).toBe("spawned");
    const detectResult = spawnDetachedDetector({
      profile: "paid",
      log: () => {},
      scriptPath: noopScript,
      env: { ...process.env },
    });
    expect(detectResult.ok).toBe(true);
  });
});

// ── D2: requestProfileUpdate — the background update a command asks for ──────

/** A child that records its argv and the "update requested" flag, then holds
 *  its lock for `holdMs` (the lock is released by its pid dying). */
function recorder(holdMs: number): { script: string; records: () => Array<{ argv: string[]; requested: string | null }> } {
  const dir = mkdtempSync(join(cfg, "rec-"));
  const script = join(dir, "rec.js");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(${JSON.stringify(dir)}, process.pid + ".json"),
  JSON.stringify({ argv: process.argv.slice(2), requested: process.env.${PROFILE_UPDATE_REQUESTED_ENV} ?? null }));
setTimeout(() => process.exit(0), ${holdMs});
`,
  );
  return {
    script,
    records: () =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as { argv: string[]; requested: string | null }),
  };
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe("requestProfileUpdate (D2 items 2 and 8)", () => {
  const request = (over: { scriptPath: string; nowMs?: number; env?: NodeJS.ProcessEnv }) =>
    requestProfileUpdate({ profile: "free", log: () => {}, env: { ...process.env }, ...over });

  it("lock free, never updated: ONE detector child in update-requested mode, however many commands ask at once", async () => {
    const rec = recorder(1_500);
    const states = Array.from({ length: 10 }, () => request({ scriptPath: rec.script }).state);
    expect(states[0]).toBe("started");
    expect(states.slice(1).every((s) => s === "running")).toBe(true);
    await waitUntil(() => rec.records().length > 0, 5_000);
    await new Promise((r) => setTimeout(r, 200));
    const records = rec.records();
    expect(records).toHaveLength(1);
    expect(records[0].argv).toEqual(["--detect-profile-changes", "free"]);
    expect(records[0].requested).toBe("1");
  });

  it("lock held by another run: starts nothing and leaves the 'update requested' marker for the holder", () => {
    const slowScript = join(cfg, "slow.js");
    writeFileSync(slowScript, "setTimeout(() => process.exit(0), 5000);\n");
    expect(populateDefaultProfile(opts({ profile: "free", scriptPath: slowScript })).kind).toBe("spawned");
    const rec = recorder(0);
    expect(request({ scriptPath: rec.script }).state).toBe("running");
    expect(profileUpdateRequestPending("free")).toBe(true);
  });

  it(`an update finished less than ${PROFILE_UPDATE_RESPAWN_MS / 60_000} min ago, or a failure backoff: 'recent', nothing spawned`, async () => {
    const now = Date.now();
    const rec = recorder(0);
    updateDynamicProfileRecord("free", () => ({ lastBenchmarkAt: now - 60_000, poolFingerprint: "", modelIds: [], failCount: 0 }));
    expect(request({ scriptPath: rec.script, nowMs: now }).state).toBe("recent");
    updateDynamicProfileRecord("free", () => ({
      lastBenchmarkAt: now - 3_600_000,
      lastMaintainedAt: now - 1_000,
      poolFingerprint: "",
      modelIds: [],
      failCount: 0,
    }));
    expect(request({ scriptPath: rec.script, nowMs: now }).state).toBe("recent");
    updateDynamicProfileRecord("free", () => ({ lastBenchmarkAt: now - 3_600_000, poolFingerprint: "", modelIds: [], failCount: 0 }));
    recordBenchmarkFailure("free", now - 1_000);
    expect(request({ scriptPath: rec.script, nowMs: now }).state).toBe("recent");
    await new Promise((r) => setTimeout(r, 200));
    expect(rec.records()).toHaveLength(0);
  });

  it("the window is measured from when the update FINISHED: past it, a new update starts", async () => {
    const now = Date.now();
    const rec = recorder(0);
    updateDynamicProfileRecord("free", () => ({
      lastBenchmarkAt: now - PROFILE_UPDATE_RESPAWN_MS - 1,
      poolFingerprint: "",
      modelIds: [],
      failCount: 0,
    }));
    expect(request({ scriptPath: rec.script, nowMs: now }).state).toBe("started");
    await waitUntil(() => rec.records().length > 0, 5_000);
    expect(rec.records()[0].requested).toBe("1");
  });

  it("a PENDING marker is never throttled; one an update already served is not pending", async () => {
    const now = Date.now();
    const rec = recorder(0);
    updateDynamicProfileRecord("free", () => ({ lastBenchmarkAt: now - 60_000, poolFingerprint: "", modelIds: [], failCount: 0 }));
    // Requested AFTER the last update finished: still owed.
    writeFileSync(backgroundUpdateRequestPathFor("free"), String(now - 30_000), "utf-8");
    expect(profileUpdateRequestPending("free")).toBe(true);
    expect(request({ scriptPath: rec.script, nowMs: now }).state).toBe("started");
    await waitUntil(() => rec.records().length > 0, 5_000);
    // Requested BEFORE the last update finished: that update served it.
    writeFileSync(backgroundUpdateRequestPathFor("free"), String(now - 120_000), "utf-8");
    expect(profileUpdateRequestPending("free")).toBe(false);
  });

  it("a pending marker waits out an active FAILURE backoff (kept on disk), and is honoured once it ends", async () => {
    const now = Date.now();
    const rec = recorder(0);
    updateDynamicProfileRecord("free", () => ({ lastBenchmarkAt: now - 3_600_000, poolFingerprint: "", modelIds: [], failCount: 0 }));
    recordBenchmarkFailure("free", now - 1_000); // backoff: 15 min from now - 1 s
    writeFileSync(backgroundUpdateRequestPathFor("free"), String(now - 500), "utf-8");
    expect(request({ scriptPath: rec.script, nowMs: now }).state, "a benchmark that just failed is not re-run").toBe("recent");
    expect(takeProfileUpdateRequest("free", now), "the holder defers it too").toBe(false);
    expect(profileUpdateRequestPending("free"), "and the request is not lost").toBe(true);
    const afterBackoff = now + 16 * 60_000;
    expect(takeProfileUpdateRequest("free", afterBackoff)).toBe(true);
    expect(profileUpdateRequestPending("free")).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(rec.records()).toHaveLength(0);
  });

  it("LLM_EXT_DISABLE_AUTO_RECONCILE=1: 'unavailable' (the child would refuse), nothing spawned", async () => {
    const rec = recorder(0);
    const r = request({ scriptPath: rec.script, env: { ...process.env, LLM_EXT_DISABLE_AUTO_RECONCILE: "1" } });
    expect(r.state).toBe("unavailable");
    await new Promise((r2) => setTimeout(r2, 200));
    expect(rec.records()).toHaveLength(0);
  });

  it("a PLAIN detector spawn never inherits the flag from its parent's environment", async () => {
    const rec = recorder(0);
    const r = spawnDetachedDetector({
      profile: "paid",
      log: () => {},
      scriptPath: rec.script,
      env: { ...process.env, [PROFILE_UPDATE_REQUESTED_ENV]: "1" },
    });
    expect(r.ok).toBe(true);
    await waitUntil(() => rec.records().length > 0, 5_000);
    expect(rec.records()[0].requested).toBeNull();
  });
});
