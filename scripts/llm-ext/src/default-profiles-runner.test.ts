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
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { populateDefaultProfile, describeOutcome } from "./default-profiles-runner.js";

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

describe("populateDefaultProfile — the paid gate", () => {
  it("REFUSES a paid profile under allow_paid_models: false, and names the exact command instead of just failing", () => {
    const r = populateDefaultProfile(opts({ profile: "ensemble", allowPaidModels: false }));
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") throw new Error("unreachable");
    expect(r.remedy).toContain("--populate-default-profile ensemble");
    expect(r.reason).toMatch(/billable/i);
  });

  it("REFUSES mass-scout too — both paid profiles are gated, not just ensemble", () => {
    const r = populateDefaultProfile(opts({ profile: "mass-scout", allowPaidModels: false }));
    expect(r.kind).toBe("refused");
  });

  it("spawns a paid profile once allow_paid_models is true, and marks it as blocking the caller", () => {
    const r = populateDefaultProfile(opts({ profile: "ensemble", allowPaidModels: true }));
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
      opts({ profile: "ensemble", allowPaidModels: false, lockPath }),
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
    const r = populateDefaultProfile(opts({ logPath: join(cfg, "no-such-dir", "x.log") }));
    expect(r.kind).toBe("skipped"); // never a throw
  });
});

describe("describeOutcome — says something only when the user must act", () => {
  it("stays SILENT for a spawned `free` population — the user asked a question, not for a status report", () => {
    const r = populateDefaultProfile(opts({ profile: "free" }));
    expect(describeOutcome(r)).toBeNull();
  });

  it("tells the user to re-run when a PAID population blocks the current command", () => {
    const r = populateDefaultProfile(opts({ profile: "ensemble", allowPaidModels: true }));
    const msg = describeOutcome(r);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/ensemble/);
  });

  it("surfaces both the reason and the remedy on a refusal — a refusal with no way forward is a dead end", () => {
    const r = populateDefaultProfile(opts({ profile: "ensemble", allowPaidModels: false }));
    const msg = describeOutcome(r);
    expect(msg).toContain("--populate-default-profile ensemble");
    expect(msg).toMatch(/allow_paid_models/);
  });

  it("stays silent when nothing happened", () => {
    const r = populateDefaultProfile(
      opts({ env: { LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1" } as NodeJS.ProcessEnv }),
    );
    expect(describeOutcome(r)).toBeNull();
  });
});
