/**
 * SG2 (USER 2026-09-18, "then make it a singleton for each profile then"):
 * proves the per-profile background-update SINGLETON the SG1 investigation
 * report (reports/llm-ext-release/20260918_084914+0200-sg1-singleton-
 * investigation.md) recommended and the USER then narrowed to "per profile,
 * not global". This is the SG1 stress harness
 * (scripts_dev/sg1-background-spawn-harness/, gitignored dev scratch) turned
 * into a real vitest test per SG2 requirement 6, driving the REAL
 * spawnDetachedBench/claimBenchLock primitives — never a re-implementation
 * of them — so the measured guarantee is the actual production guarantee.
 *
 * Hermetic: every spawned child is a throwaway marker/noop script that exits
 * in well under a second -- except the D2 cross-process case, which runs the
 * real compiled CLI and its real update child against pre-seeded catalogs
 * with populate switched off. No benchmark, no network, no spend. Every
 * temp dir and every spawned process is cleaned up in `finally`/`afterEach`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { backgroundUpdateLockPathFor, populateDefaultProfile, spawnDetachedDetector, type AnyProfileName } from "./default-profiles-runner.js";
import { spawnDetachedBench } from "./bench-spawn.js";
import { getDynamicProfileRecord } from "./default-profiles-state.js";
import { claimBenchLock, commitBenchLock, benchLockIsHeld, benchLockPid } from "./bench-lock.js";
import { CLI_SCRIPT } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

let cfg = "";
let prevCfg: string | undefined;
let noopScript = "";

beforeEach(() => {
  cfg = mkdtempSync(join("/tmp", "bgsingleton-cfg-"));
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

/** A marker script: records {pid, profile, mechanism, startMs} to
 *  LLM_EXT_MARKER_DIR on start, sleeps LLM_EXT_MARKER_RUN_MS, then records
 *  {doneMs} to the SAME file before exiting -- so overlap is provable from
 *  real start/done timestamps (never a process-table grep, per the
 *  shell-pitfalls self-match trap). */
function writeMarkerScript(dir: string): string {
  const p = join(dir, "marker.mjs");
  writeFileSync(
    p,
    `import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const markerDir = process.env.LLM_EXT_MARKER_DIR;
const profile = process.env.LLM_EXT_MARKER_PROFILE;
const runMs = Number(process.env.LLM_EXT_MARKER_RUN_MS ?? "200");
const f = join(markerDir, \`\${process.pid}.json\`);
writeFileSync(f, JSON.stringify({ pid: process.pid, profile, startMs: Date.now() }), "utf-8");
setTimeout(() => {
  const rec = JSON.parse(readFileSync(f, "utf-8"));
  rec.doneMs = Date.now();
  writeFileSync(f, JSON.stringify(rec), "utf-8");
  process.exit(0);
}, runMs);
`,
    "utf-8",
  );
  return p;
}

interface MarkerRecord {
  pid: number;
  profile: string;
  startMs: number;
  doneMs?: number;
}

function readMarkers(dir: string): MarkerRecord[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as MarkerRecord);
}

async function waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    // Throw on timeout: a silent return let callers continue on a condition that never held.
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("SG2: per-profile background-update singleton", () => {
  it(
    "N=200 concurrent spawnDetachedDetector/populateDefaultProfile attempts across free/paid/local -- at least one marker child per profile, never two alive at once for the same profile, at most 3 overall; detect and populate share the SAME lock",
    async () => {
      const markerDir = mkdtempSync(join(cfg, "markers-"));
      const markerScript = writeMarkerScript(cfg);
      const profiles: AnyProfileName[] = ["free", "paid", "local"];
      const mechanisms = ["detect", "populate"] as const;
      const TOTAL_ATTEMPTS = 200;
      const RUN_MS = 250;

      // Every attempt claims the SAME per-profile lock regardless of
      // mechanism -- backgroundUpdateLockPathFor is the ONE thing SG2 made
      // detect and populate agree on. Spread TOTAL_ATTEMPTS across the 6
      // (profile, mechanism) combos, fired with no artificial stagger.
      const attempts: Array<{ profile: AnyProfileName; mechanism: (typeof mechanisms)[number] }> = [];
      for (let i = 0; i < TOTAL_ATTEMPTS; i++) {
        attempts.push({
          profile: profiles[i % profiles.length],
          mechanism: mechanisms[i % mechanisms.length],
        });
      }

      // Drive the PRODUCTION entry points (not spawnDetachedBench with a
      // hand-built lock path): "detect" -> spawnDetachedDetector, "populate" ->
      // populateDefaultProfile; each resolves the per-profile lock itself.
      const childEnv = { ...process.env, LLM_EXT_MARKER_DIR: markerDir, LLM_EXT_MARKER_RUN_MS: String(RUN_MS) };
      const results = attempts.map(({ profile, mechanism }) => {
        const env = { ...childEnv, LLM_EXT_MARKER_PROFILE: profile };
        if (mechanism === "detect") return spawnDetachedDetector({ profile, log: () => {}, scriptPath: markerScript, env }).ok;
        return populateDefaultProfile({ profile, allowPaidModels: true, log: () => {}, scriptPath: markerScript, env }).kind === "spawned";
      });
      const spawnedCount = results.filter(Boolean).length;
      // At least one spawn must win per profile (the first attempt claims the lock). A second legitimate
      // spawn may follow once the first child finishes and releases, so the count is NOT pinned to one;
      // the no-overlap check below is the real singleton invariant. Without this lower bound, a run where
      // every attempt is refused (spawnedCount 0) would pass every upper-bound assertion vacuously.
      const spawnedPerProfile = Object.fromEntries(
        profiles.map((p) => [p, results.filter((ok, i) => ok && attempts[i].profile === p).length]),
      );
      for (const p of profiles) {
        expect(
          spawnedPerProfile[p],
          `expected at least one successful spawn for profile ${p} but got ${JSON.stringify(spawnedPerProfile)} -- the spawn attempts were refused`,
        ).toBeGreaterThanOrEqual(1);
      }
      // Real production behaviour proven in SG1's own measurement: a launch
      // spread wider than RUN_MS lets a SECOND attempt win after the first
      // released -- never MORE than one alive at once, which is what the
      // overlap check below actually proves. At least one per profile must
      // have won (nothing refuses ALL 200/3 attempts).
      expect(spawnedCount).toBeGreaterThanOrEqual(profiles.length);
      expect(spawnedCount).toBeLessThanOrEqual(TOTAL_ATTEMPTS);


      // Non-vacuous: `every` alone is true while no marker exists yet, so wait for
      // ALL spawned markers to exist AND be done before asserting the count.
      let lastReadError: unknown;
      await waitUntil(() => {
        // A child rewrites its marker in place; a half-written file is "not done yet", not an error.
        let m: MarkerRecord[];
        try {
          m = readMarkers(markerDir);
        } catch (e) {
          lastReadError = e;
          return false;
        }
        return m.length === spawnedCount && m.every((r) => r.doneMs !== undefined);
      }, RUN_MS + 5_000, `${spawnedCount} finished markers (last marker read error: ${lastReadError === undefined ? "none" : String(lastReadError)})`);
      const markers = readMarkers(markerDir);
      expect(
        markers.length,
        `timed out waiting for ${spawnedCount} markers; last marker read error: ${lastReadError === undefined ? "none" : String(lastReadError)}`,
      ).toBe(spawnedCount);
      expect(
        markers.filter((m) => m.doneMs === undefined).map((m) => m.pid),
        `markers never finished; last marker read error: ${lastReadError === undefined ? "none" : String(lastReadError)}`,
      ).toEqual([]);
      // Per-profile overlap check (interval overlap on [startMs, doneMs],
      // immune to the process-table self-match trap grep-based counting
      // hits): group by profile, sort by start, assert no two intervals for
      // the SAME profile overlap.
      for (const profile of profiles) {
        const forProfile = markers.filter((m) => m.profile === profile).sort((a, b) => a.startMs - b.startMs);
        for (let i = 1; i < forProfile.length; i++) {
          expect(
            forProfile[i].startMs,
            `profile '${profile}': marker ${forProfile[i].pid} started before marker ${forProfile[i - 1].pid} finished -- two processes alive at once under the SAME lock`,
          ).toBeGreaterThanOrEqual(forProfile[i - 1].doneMs!);
        }
      }

      // At most 3 profiles' worth of concurrency ceiling: compute the
      // maximum number of markers simultaneously alive across ALL profiles
      // via the same interval-overlap sweep (never a process-table grep).
      const events = markers.flatMap((m) => [
        { t: m.startMs, delta: 1 },
        { t: m.doneMs!, delta: -1 },
      ]);
      events.sort((a, b) => a.t - b.t || a.delta - b.delta);
      let concurrent = 0;
      let maxConcurrent = 0;
      for (const e of events) {
        concurrent += e.delta;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
      }
      expect(maxConcurrent).toBeLessThanOrEqual(profiles.length);
    },
    60_000,
  );

  it("a detector that finds a change hands its OWN lock to the populate child -- never a second detached process", async () => {
    // Simulate the detector child's own position: it was spawned under
    // backgroundUpdateLockPathFor("free") and, via spawnDetachedBench's
    // commitBenchLock, the lock is now stamped with ITS pid -- which, for
    // this test, is simply this process's own pid (claimBenchLock direct,
    // matching what commitBenchLock would have done to a real spawned
    // child).
    const lockPath = backgroundUpdateLockPathFor("free");
    const claim = claimBenchLock(lockPath, Date.now(), () => {});
    expect(claim.ok).toBe(true);
    commitBenchLock(lockPath, process.pid);
    expect(benchLockPid(lockPath)).toBe(process.pid);

    // Without alreadyHeldByCaller this would be wrongly refused as "already
    // in progress" against ITSELF -- default-profiles-runner.test.ts's
    // "shares populateDefaultProfile's lock" case covers that refusal
    // directly; this test is the other half: WITH the flag it must proceed.
    const outcome = populateDefaultProfile({
      profile: "free",
      allowPaidModels: false,
      log: () => {},
      scriptPath: noopScript,
      env: { ...process.env },
      alreadyHeldByCaller: true,
    });
    expect(outcome.kind).toBe("spawned");

    // The handoff: the lock is now stamped with the NEW child's pid, never
    // ours again and never a SECOND lock file anywhere in the config dir --
    // exactly one lock file exists for 'free', proving no parallel second
    // claim/spawn was attempted.
    expect(benchLockPid(lockPath)).not.toBe(process.pid);
    const lockFiles = readdirSync(cfg).filter((f) => f.includes("background-update-") && f.endsWith(".lock"));
    expect(lockFiles).toEqual(["background-update-free.lock"]);

    await new Promise((r) => setTimeout(r, 100));
  });

  // D2 (USER 2026-09-18): this case used to drive N in-process "empty-pool
  // waiters" (runDynamicProfileUpdateAndWait, deleted with D2). Commands no
  // longer wait; the singleton is now about the update they REQUEST: N real
  // CLI processes on one empty profile start exactly ONE update-requested
  // child. The real compiled CLI and benchmark child run (dist/, rebuilt by
  // `npm run build`); both catalogs are pre-seeded fresh and the populate
  // step is switched off, so the child makes no network call and spends
  // nothing.
  it(
    "N concurrent CLI commands (separate processes) on one EMPTY dynamic profile: each answers retry-later, exactly ONE background update is started",
    async () => {
      writeFileSync(
        join(cfg, "settings.yaml"),
        [
          "profiles:",
          "  # <-- do not touch, generated by llm-ext -->",
          "  free:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    free_only: true",
          "    free_models: []",
          "    model: placeholder/unpopulated-default-profile",
          "    api_key: $OPENROUTER_API_KEY",
          "",
        ].join("\n"),
        "utf-8",
      );
      const now = Date.now();
      writeFileSync(join(cfg, "catalog-cache.json"), JSON.stringify({ fetchedAtMs: now, models: [] }), "utf-8");
      writeFileSync(join(cfg, "bai-models-cache.json"), JSON.stringify({ fetchedAtMs: now, models: [] }), "utf-8");
      const folder = mkdtempSync(join("/tmp", "bgsingleton-folder-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LLM_EXT_CONFIG_DIR: cfg,
        OPENROUTER_API_KEY: "test-openrouter-key-not-a-real-one",
        LLM_EXT_INSTALL_RULE: "0",
        LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1",
      };
      delete env.BAI_API_KEY;
      delete env.LLM_EXT_DISABLE_AUTO_RECONCILE;
      delete env.LLM_EXT_AUTO_BENCH_REASON; // the child's log line must carry OUR reason
      try {
        const N = 4;
        const runs = await Promise.all(
          Array.from({ length: N }, () =>
            execFileAsync("node", [CLI_SCRIPT, "scan", "folder", folder, "--quiet"], { env, timeout: 60_000 }).then(
              () => ({ code: 0, err: "" }),
              (e: { code?: number; stderr?: string }) => ({ code: e.code ?? -1, err: e.stderr ?? "" }),
            ),
          ),
        );
        for (const r of runs) {
          expect(r.code, r.err).not.toBe(0);
          expect(r.err).toContain("no model of the 'free' profile is working right now");
        }
        // Let the background update (and any end-of-dispatch detector) finish.
        const lockPath = backgroundUpdateLockPathFor("free");
        await new Promise((r) => setTimeout(r, 300));
        await waitUntil(() => !benchLockIsHeld(lockPath), 30_000, "lock to be released");
        const logPath = join(cfg, "detect-profile-free.log");
        const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
        const started = log.split("\n").filter((l) => l.includes("reason: default-profile-update-requested:free"));
        expect(started, `detect log:\n${log}`).toHaveLength(1);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("CE9B7S8N acceptance: a sweep child SIGKILLed before it books a result does NOT block the next sweep for the 6 h floor", async () => {
    // The AC from the card, driven through the REAL primitives (never a
    // re-implementation): spawn a real populate child via
    // populateDefaultProfile -> spawnDetachedBench, give it the lock, kill it
    // hard (SIGKILL — no exit hook can fire) before it can bank anything,
    // then verify the DYNAMIC record carries no completion evidence and the
    // bench lock self-heals — i.e. the next maintainer pass is FREE to
    // respawn immediately. Under the retired spawn-time lastSweepAt stamp
    // this next pass would have been blocked for the full 6 h floor.
    const lockPath = backgroundUpdateLockPathFor("free");
    const logPath = join(cfg, "default-profile-free.log");
    const slowChild = join(cfg, "slow-child.mjs");
    // The child claims nothing, books nothing: it just sleeps long enough
    // that the parent can kill it mid-flight. It holds the handed-down lock
    // exactly the way a real benchmark child would.
    writeFileSync(
      slowChild,
      `setTimeout(() => process.exit(0), 60_000);\n`,
      "utf-8",
    );

    const spawned = spawnDetachedBench({
      lockPath,
      logPath,
      scriptPath: slowChild,
      args: [],
      env: { ...process.env },
      reason: "ce9b7s8n-acceptance:free",
      log: () => {},
    });
    expect(spawned.ok).toBe(true);
    const pid = (spawned as { ok: true; pid: number }).pid;
    expect(pid).not.toBeNull();

    await waitUntil(() => benchLockIsHeld(lockPath), 10_000, "spawned child to hold the lock");
    // The lock is live and held by the child (the double-spawn guard works).
    expect(benchLockPid(lockPath)).toBe(pid);

    // Kill it HARD: SIGKILL leaves no 'exit' handler, no booked result, no
    // cooldownUntil — the exact state a killed benchmark child leaves.
    process.kill(pid, "SIGKILL");

    await waitUntil(() => !benchLockIsHeld(lockPath), 10_000, "spawned child to release the lock");
    // (1) SIGKILL-safe liveness: the lock is already free (dead-pid axis),
    // so a concurrent double-spawn is still prevented only while alive.
    expect(benchLockIsHeld(lockPath)).toBe(false);
    // (2) No completion evidence exists: the dynamic record has neither a
    // success stamp (lastBenchmarkAt) nor a failure cooldown — a maintainer
    // pass consulting the floor (dynamic-maintainer.ts: lastSweepFinishedAt
    // = record?.lastBenchmarkAt ?? 0) computes 0 and does NOT wait out
    // MIN_SWEEP_INTERVAL_MS. Under the old spawn-time stamp this assertion
    // could not hold: lastSweepAt was stamped at spawn, freezing the floor.
    expect(getDynamicProfileRecord("free")).toBeUndefined();
  });


  it("a stale lock (dead pid) on the merged per-profile lock is recovered, not wedged", () => {
    const lockPath = backgroundUpdateLockPathFor("paid");
    // A pid essentially guaranteed not to exist on this machine, fresh
    // mtime -- proves the dead-pid axis alone (not the TTL axis) still
    // frees the MERGED lock, exactly as bench-lock.ts's own header
    // documents for any lock it guards.
    writeFileSync(lockPath, "999999", "utf-8");
    expect(benchLockIsHeld(lockPath)).toBe(false);

    const outcome = populateDefaultProfile({
      profile: "paid",
      allowPaidModels: true,
      log: () => {},
      scriptPath: noopScript,
      env: { ...process.env },
    });
    expect(outcome.kind).toBe("spawned");
    expect(benchLockPid(lockPath)).not.toBe(999999);
  });
});
