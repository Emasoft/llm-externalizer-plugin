// dynamic-maintainer.ts — the free/paid maintainer + §3.3 gate (P6b item 1,
// TRDD-90DM5YHO; P6b-fix B1/B3/S1/S2/S4/S6/S8). Real filesystem I/O against a
// per-test isolated config dir (LLM_EXT_CONFIG_DIR), no mocking of the code
// under test. Two seams are stubbed and only two: the catalog fetcher (a
// declared DI parameter) and populateDefaultProfile (the SPAWN seam — the same
// seam default-profile-wiring.test.ts already mocks, so a test can never shell
// out to a real 15-minute benchmark child, and so "did it spawn, how often,
// for which profile" is assertable at all). decideDynamicProfile's own pure
// decision logic is default-profiles.test.ts's job, not re-tested here.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "./test-tmp-root.js";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultProfileLogPath } from "./default-profiles-runner.js";
import type { PopulationOutcome } from "./default-profiles-runner.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { populateDefaultProfileMock } = vi.hoisted(() => ({
  populateDefaultProfileMock: vi.fn(),
}));

vi.mock("./default-profiles-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./default-profiles-runner")>();
  return { ...actual, populateDefaultProfile: populateDefaultProfileMock };
});

// 3c (review of 51a100c): a THIRD seam, but a transparent one — every call
// still runs the REAL enqueueCandidates; this only records, per call, what
// settings.yaml held on disk at that exact instant, so the "providers[] patch
// written BEFORE the routed id is enqueued" ordering test below can assert on
// it without needing its own copy of the maintainer's write logic. No other
// test reads `enqueueCandidatesCalls`, so this changes nothing about what any
// existing assertion observes.
const { enqueueCandidatesCalls } = vi.hoisted(() => ({
  enqueueCandidatesCalls: [] as Array<{ profile: string; ids: string[]; settingsAtCallTime: string }>,
}));
vi.mock("./dynamic-candidates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dynamic-candidates")>();
  return {
    ...actual,
    enqueueCandidates: (profile: string, ids: readonly string[], nowMs?: number) => {
      let settingsAtCallTime = "";

      // JDFJLPSS: test seam, fires after the maintainer's record snapshot and before its sweep-spawn decision.
      enqueueHook.fn?.();

      try {
        settingsAtCallTime = readFileSync(settingsPath, "utf-8");
      } catch {
        /* no settings.yaml yet in this test — recorded as "" */
      }
      enqueueCandidatesCalls.push({ profile, ids: [...ids], settingsAtCallTime });
      return actual.enqueueCandidates(profile as never, ids, nowMs);
    },
  };
});

import {
  maintainDynamicProfiles,
  dynamicProfileGate,
  freeToolUnfitRefusal,
  FREE_TOOL_UNFIT_PAID_OFF_SUFFIX,
  MIN_SWEEP_INTERVAL_MS,
  // fix-queue 56 test fixtures: the literal marker text the maintainer stamps
  // on a generated section, needed to build a MARKED fixture by hand.
  GENERATED_MARKER,
  type RawCatalogModel,
} from "./dynamic-maintainer.js";
import { readCandidates, clearCandidates } from "./dynamic-candidates.js";
import {
  recordBenchmarkFailure,
  getDynamicProfileRecord,
  updateDynamicProfileRecord,
} from "./default-profiles-state.js";
import { catalogCachePath } from "./catalog-cache.js";
import { bookDailySpend } from "./benchmark/daily-spend.js";
// P6b-fix3 S-4': the S-9 case now asserts the GATE's verdict against the
// RELOADED document, which means reading it the way index.ts does.
// P6b-fix4 B1: `validateSettings` + `resolveProfile` are how "does llm-ext accept
// its own write, and what would it actually SEND?" is asked — the two questions
// the b.ai-only brick answered wrongly and silently.
// fix-queue 56: `validateProfile` — merged into this ONE ./config.js import
// per coordinator review S-2, rather than a second, mid-file import.
import { loadSettings, validateSettings, validateProfile, type Profile } from "./config.js";

let cfgDir: string;
let prevCfgDir: string | undefined;
let settingsPath: string;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), "llmext-dynmaint-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  settingsPath = join(cfgDir, "settings.yaml");
  populateDefaultProfileMock.mockReset();
  enqueueCandidatesCalls.length = 0;
  populateDefaultProfileMock.mockImplementation(
    (opts: { profile: string }): PopulationOutcome => ({
      kind: "spawned",
      profile: opts.profile as PopulationOutcome extends { profile: infer P } ? P : never,
      pid: 4242,
      blocksCaller: opts.profile === "paid",
      logPath: join(cfgDir, `default-profile-${opts.profile}.log`),
    }),
  );
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
});

const noop = () => {};


/** JDFJLPSS: a callback the enqueue wrapper above runs, to mutate real on-disk state mid-pass. */
const enqueueHook: { fn: (() => void) | undefined } = { fn: undefined };

function writeSettings(yaml: string): void {
  writeFileSync(settingsPath, yaml, "utf-8");
}

/**
 * D3c-1b (TRDD-FDI9NYAS): seeds a recorded PASS for each id in the current
 * `cfgDir`'s security-triage-results.json — the same on-disk cache
 * `benchmarkPassedModels()` (benchmark/security-triage/index.ts) reads. Every
 * test in this file exercises the REAL `maintainDynamicProfiles` pipeline (no
 * mock of decideDynamicProfile itself, per this file's own top-of-file
 * comment), and a fresh `cfgDir` starts with an EMPTY cache -- so a test whose
 * subject is something else (b.ai routing, credential handling, the
 * regenerate-retry path) now needs its fixture catalog id to carry a recorded
 * pass, or the D3c-1b gate correctly refuses to serve it and the test's own
 * assertion (about a DIFFERENT behaviour) never gets to run.
 */
function seedBenchmarkPass(ids: readonly string[]): void {
  const cache: Record<string, unknown> = {};
  for (const id of ids) {
    cache[`${id}::2026-01-01::seed`] = {
      date: "2026-01-01",
      datasetHash: "seed",
      score: { pass: true, inconclusive: false },
      costUsd: 0,
      latencyMs: 0,
      inputDollarsPerMillion: 0,
      outputDollarsPerMillion: 0,
      qualified: true,
    };
  }
  writeFileSync(join(cfgDir, "security-triage-results.json"), JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * P6b-fix3 R-2: PIN the provider-credential state for a test whose subject is
 * NOT credentials.
 *
 * The maintainer now refuses to write a section no credential can serve, and
 * the gate now names an unset key as the cause of an empty pool — so a test
 * that reads the ambient shell asserted two different behaviours on the suite's
 * two env legs (keys set / `env -u OPENROUTER_API_KEY -u BAI_API_KEY`). Pinning
 * makes the test's own subject the only variable. The value is a LITERAL,
 * never a real key, and nothing here sends a request.
 *
 * `BAI_API_KEY` is deliberately left UNSET: these fixtures are about the
 * OpenRouter route, and a set b.ai key changes what the provisional arm builds.
 */
async function withProviderKeys<T>(fn: () => T | Promise<T>): Promise<T> {
  const prevOr = process.env.OPENROUTER_API_KEY;
  const prevBai = process.env.BAI_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
  delete process.env.BAI_API_KEY;
  try {
    return await fn();
  } finally {
    if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOr;
    if (prevBai === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = prevBai;
  }
}

/** The free section as an unpopulated placeholder: present (so the maintainer
 *  has something to merge onto) but contributing no candidates when the
 *  catalog carries no ':free' ids — which keeps a `paid` test's spawn count
 *  about `paid` alone. */
const FREE_PLACEHOLDER = [
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models: []",
  "    model: placeholder/unpopulated-default-profile",
  "    api_key: $OPENROUTER_API_KEY",
];

function paidModel(id: string, contextLength = 8000): RawCatalogModel {
  return {
    id,
    pricing: { prompt: "0.0000003", completion: "0.0000005" }, // 0.8/M total, under the 1.3 ceiling
    context_length: contextLength,
  };
}

/**
 * The "benchmark child" of the S-4 case: a genuine second PROCESS that holds
 * the sidecar's lock, announces it, and does the same read-modify-write a
 * completing child does. Plain .mjs so it needs no build step and no TS loader
 * — it is a stand-in for another process, never a copy of the code under test.
 */
const CONCURRENT_CHILD_SRC = `
import { mkdirSync, rmdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
const cfg = process.argv[2];
const statePath = join(cfg, "dynamic-profiles-state.json");
const lockDir = join(cfg, "dynamic-profiles-state.lock");
mkdirSync(lockDir);                                 // hold the lock
writeFileSync(join(cfg, "child-holds-lock"), "1");  // announce it
const state = JSON.parse(readFileSync(statePath, "utf-8"));
await new Promise((r) => setTimeout(r, 400));       // the window a lost update needs
state.profiles.paid.lastBenchmarkAt = 111;
const tmp = statePath + ".tmp.child";
writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
renameSync(tmp, statePath);
rmdirSync(lockDir);
`;

const spawnCallsFor = (profile: string): number =>
  populateDefaultProfileMock.mock.calls.filter(
    (c) => (c[0] as { profile: string } | undefined)?.profile === profile,
  ).length;

/** Row 19: the mocked populateDefaultProfile never creates the profile log, so a
 *  test that needs the spawn-attempt record creates it and sets its mtime
 *  (relative to the test's fake nowMs) itself. */
function stampProfileLog(profile: "free" | "paid", mtimeMs: number): void {
  const p = defaultProfileLogPath(profile);
  writeFileSync(p, "x");
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

describe("maintainDynamicProfiles — row 19: spawn-attempt floor on the profile log mtime", () => {
  const t0 = 1_800_000_000_000;
  // ONE setup: cooldownUntil 0, bench lock free, lastBenchmarkAt 0 — the ONLY
  // variable between cases is the log mtime (or its absence / forceSweep).
  const setup = async (mtimeMs: number | null, extra: { forceSweep?: boolean } = {}): Promise<void> => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    if (mtimeMs !== null) stampProfileLog("paid", mtimeMs);
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a")],
      nowMs: t0,
      log: noop,
      ...(extra.forceSweep ? { heldLockProfile: "paid" as const, forceSweep: true } : {}),
    });
  };

  it("a. a spawn attempt 5 min ago floors the respawn", async () => {
    await setup(t0 - 5 * 60_000);
    expect(spawnCallsFor("paid")).toBe(0);
  });

  it("b. control: an attempt 20 min ago does not floor (the setup really spawns)", async () => {
    await setup(t0 - 20 * 60_000);
    expect(spawnCallsFor("paid")).toBe(1);
  });

  it("c. no log file means no floor", async () => {
    await setup(null);
    expect(spawnCallsFor("paid")).toBe(1);
  });

  it("d. a forced (requested) sweep skips the floor", async () => {
    await setup(t0 - 60_000, { forceSweep: true });
    expect(spawnCallsFor("paid")).toBe(1);
  });

  it("e. a log mtime far in the future (clock moved back) is ignored", async () => {
    await setup(t0 + 2 * 3_600_000);
    expect(spawnCallsFor("paid")).toBe(1);
  });

  it("the update spawn gets no logPath override, so it opens the path the floor stats", async () => {
    await setup(null);
    const opts = populateDefaultProfileMock.mock.calls[0]?.[0] as { profile: string; logPath?: string };
    expect(opts.profile).toBe("paid");
    expect(opts.logPath ?? defaultProfileLogPath("paid")).toBe(defaultProfileLogPath("paid"));
    expect(opts).not.toHaveProperty("logPath");
  });
});
describe("maintainDynamicProfiles — fix-queue 56: the never-write-invalid guard must not latch", () => {
  // Reused by both cases below: a MARKED `free` section whose pool is a
  // single entry under `mode: remote-ensemble` — validateProfile's own rule
  // ("free_only + mode 'remote-ensemble' needs at least 2 ensemble members")
  // makes this ALREADY invalid, independent of anything a patch would do to
  // it. GENERATED_MARKER is `free`'s FIRST key, so the yaml library attaches
  // the comment to the `profiles` MAP (profileSectionMarkerState's own
  // documented quirk) — this is the real shape a previously-generated,
  // now-rejected section has, not a hand-authored one.
  const ALREADY_INVALID_MARKED_FREE = [
    "active: free",
    "profiles:",
    `  # ${GENERATED_MARKER}`,
    "  free:",
    "    mode: remote-ensemble",
    "    api: openrouter-remote",
    "    free_only: true",
    "    free_models: [only/one:free]",
    "    model: only/one:free",
    "    api_key: $OPENROUTER_API_KEY",
    "",
  ].join("\n");

  it("a section already invalid before any patch is backed up, regenerated, and maintenance continues (not skipped forever)", async () => {
    writeSettings(ALREADY_INVALID_MARKED_FREE);
    seedBenchmarkPass(["only/one:free"]); // D3c-1b: this test is about the regenerate-retry path, not the benchmark gate
    const before = readFileSync(settingsPath, "utf-8");
    const logs: string[] = [];
    // The `validateProfile` check runs INSIDE `withProviderKeys` too — its
    // `finally` deletes $OPENROUTER_API_KEY again as soon as the callback
    // returns, and this fixture's `free` section needs that var to resolve.
    // Checking it after the `await` (outside the callback) means checking
    // against whatever the AMBIENT shell happens to have, which is exactly
    // the kind of env-dependent flake `withProviderKeys` exists to prevent.
    const { wrote, after, afterValidation } = await withProviderKeys(async () => {
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [{ id: "only/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      });
      const after = readFileSync(settingsPath, "utf-8");
      const parsed = parseYaml(after) as { profiles: { free: Profile } };
      return { wrote, after, afterValidation: validateProfile("free", parsed.profiles.free) };
    });
    // Pre-fix: the OLD guard only ever compared the CANDIDATE to the
    // validator, never `current` on its own — with no patch decided (the
    // configured id is still in the catalog, nothing to drop or add) the
    // section was left exactly as it was: invalid, unbacked-up, and silently
    // never touched again on every future dispatch. `wrote` stayed `false`.
    expect(wrote).toBe(true);
    const invalidNotices = logs.filter((l) => l.includes("was already invalid"));
    expect(invalidNotices, `no 'already invalid' notice: ${JSON.stringify(logs)}`).toHaveLength(1);
    expect(invalidNotices[0]).toMatch(/backed it up to (\S+\.yaml)/);
    const backupPath = invalidNotices[0].match(/backed it up to (\S+\.yaml)/)![1];
    expect(existsSync(backupPath), `no backup file at ${backupPath}`).toBe(true);
    // Coordinator review S-1 (follow-up, 89bc887+): the backup now runs
    // INSIDE the writer's callback, of the section AS PARSED UNDER THE LOCK —
    // not of whatever this pass happened to read before taking it. This test
    // has no concurrent writer, so "under the lock" and "before the run" are
    // the SAME bytes; the assertion is still against `before` because that is
    // what the under-lock read equals here, not because timing doesn't matter
    // (the "coordinator review S-1" test below covers the case where they
    // differ, and asserts NO backup is taken there).
    expect(readFileSync(backupPath, "utf-8")).toBe(before);
    expect(after).not.toBe(before);
    expect(afterValidation.valid, JSON.stringify(afterValidation)).toBe(true);
  });

  it("the already-invalid notice prints once, not on every dispatch", async () => {
    writeSettings(ALREADY_INVALID_MARKED_FREE);
    const logs: string[] = [];
    const fetchCatalog = async () => [{ id: "only/one:free", pricing: { prompt: "0", completion: "0" } }];
    await withProviderKeys(() =>
      maintainDynamicProfiles({ fetchCatalog, log: (m) => logs.push(m) }),
    );
    // Second dispatch, SAME process: the file on disk is now the regenerated,
    // valid section from the first call, so `isMarkedDynamicSection` +
    // `validateProfile` see a valid `current` and the branch does not fire
    // again — this is a property of re-reading the real file, not a
    // process-lifetime cache, so it also survives across separate CLI
    // invocations rather than only within one process.
    await withProviderKeys(() =>
      maintainDynamicProfiles({ fetchCatalog, log: (m) => logs.push(m) }),
    );
    expect(logs.filter((l) => l.includes("was already invalid"))).toHaveLength(1);
  });

  it("a candidate the PATCH itself makes invalid is still skipped with one line — the already-invalid backup path does not fire", async () => {
    // `current` here is mode 'remote-ensemble' with TWO free_models — valid on
    // its own. The catalog then drops one, so the PATCH (not the starting
    // section) is what produces the one-entry pool `validateProfile` rejects.
    writeSettings(
      [
        "active: free",
        "profiles:",
        `  # ${GENERATED_MARKER}`,
        "  free:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [alive/one:free, dead/two:free]",
        "    model: alive/one:free",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const before = readFileSync(settingsPath, "utf-8");
    const logs: string[] = [];
    const wrote = await withProviderKeys(() =>
      maintainDynamicProfiles({
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      }),
    );
    expect(wrote).toBe(false);
    expect(readFileSync(settingsPath, "utf-8"), "a patch-introduced rejection must not write, or back up").toBe(
      before,
    );
    expect(logs.filter((l) => l.includes("was already invalid"))).toHaveLength(0);
    expect(logs.filter((l) => l.includes("would not validate"))).toHaveLength(1);
  });

  it("coordinator review B-1: a MARKED, populated, STRUCTURALLY VALID section is left untouched when only the credential is unresolved — falls through to the existing missing-key skip", async () => {
    // Two-entry OpenRouter-only 'free' under remote-ensemble: valid on its
    // own (>=2 free_models satisfies the rule ALREADY_INVALID_MARKED_FREE
    // above violates). The ONLY reason `validateProfile` would reject THIS
    // section is the Remote-auth rule firing on an unresolved $OPENROUTER_API_KEY
    // — exactly the shape a real dispatch has whenever the key simply is not
    // exported (a cron, a spawn without `zsh -lc`, or this test's own
    // deleted-key setup below).
    writeSettings(
      [
        "active: free",
        "profiles:",
        `  # ${GENERATED_MARKER}`,
        "  free:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [alive/one:free, alive/two:free]",
        "    model: alive/one:free",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const before = readFileSync(settingsPath, "utf-8");
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    // BOTH keys deleted in-process — never a real credential, never a
    // network call; this is what "not exported right now" looks like.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        // 'alive/two:free' drops out of the catalog, so decideDynamicProfile
        // computes a real $0-patch (drop the dead id) — without a patch the
        // existing missing-key skip (inside `if (decision.patch)`) never
        // runs at all, and this test needs it to, to prove the credential
        // failure falls all the way through to it.
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      });
      expect(wrote).toBe(false);
      expect(logs.filter((l) => l.includes("was already invalid"))).toHaveLength(0);
      expect(existsSync(join(cfgDir, "backups")), "no backup must be taken for a credential-only failure").toBe(
        false,
      );
      expect(readFileSync(settingsPath, "utf-8"), "settings.yaml must be byte-identical").toBe(before);
      const named = logs.filter((l) => l.includes("$OPENROUTER_API_KEY"));
      expect(named, `no missing-key skip line: ${JSON.stringify(logs)}`).toHaveLength(1);
      expect(named[0]).toMatch(/not populated/);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("fix-queue 73 (review of ac90fd1): a MARKED, populated, route-served 'free' section still hits the missing-key skip through 'candidate' (never 'base') when the route's own credential is unresolved too", async () => {
    // ac90fd1's fix made every `credentialUsable(profile, routesFrom)` call
    // name its routes source explicitly (no `routesFrom = profile` default),
    // because a default parameter fires on an EXPLICIT `undefined` argument
    // in JavaScript — `credentialUsable(base, candidate)` would have silently
    // read `base`'s own routes instead of `candidate`'s the moment `candidate`
    // was `undefined`. That exact substitution is UNREACHABLE through
    // `maintainDynamicProfiles` today (confirmed by re-reading the call site,
    // not just by grep): `candidate` is `undefined` only when `base` is
    // `undefined`, and every branch that calls `credentialUsable(base, ...)`
    // is itself guarded by `base &&`, so the buggy call is never made in the
    // first place — and even when `candidate` and `base` are both defined,
    // `decideDynamicProfile` never patches `providers`, so `candidate.providers`
    // is always `base.providers` (see `applyPatch`), meaning the two args
    // could never disagree anyway. So this test cannot be RED on 9fe827d for
    // an observable-behaviour reason (there is none to observe) — it instead
    // pins the REACHABLE shape of the same branch (a MARKED, route-served
    // section whose route credential is ALSO unresolved), so a future
    // refactor that reintroduces a `profile`-only default cannot silently
    // regress it without turning this red.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      writeSettings(
        [
          "profiles:",
          `  # ${GENERATED_MARKER}`,
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    free_only: true",
          "    free_models: [alive/one:free, alive/two:free]",
          "    model: alive/one:free",
          "    api_key: $OPENROUTER_API_KEY",
          "    providers:",
          "      - api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-route:free]",
          "",
        ].join("\n"),
      );
      const before = readFileSync(settingsPath, "utf-8");
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        // 'alive/two:free' drops out of the catalog, so decideDynamicProfile
        // computes a real patch (drop the dead id) — the missing-key skip is
        // nested inside `if (decision.patch)`, so a no-op catalog (nothing
        // dead, nothing new) never reaches it at all; this needs a patch to
        // exist for the branch to run.
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      });
      expect(wrote, `must not write: ${JSON.stringify(logs)}`).toBe(false);
      expect(readFileSync(settingsPath, "utf-8"), "settings.yaml must be byte-identical").toBe(before);
      // Review finding: `wrote === false` plus a log line is also the
      // observable shape of the fq56 "already invalid, backed up and
      // regenerated" branch (a few lines above this one) — these two extra
      // checks (mirroring the pre-existing B-1 test) pin that THIS branch,
      // not that one, produced the result: no backup taken, and no
      // "was already invalid" notice logged.
      expect(existsSync(join(cfgDir, "backups")), "no backup must be taken for a credential-only skip").toBe(false);
      expect(logs.filter((l) => l.includes("was already invalid"))).toHaveLength(0);
      const named = logs.filter((l) => l.includes("$OPENROUTER_API_KEY"));
      expect(named, `no missing-key skip line: ${JSON.stringify(logs)}`).toHaveLength(1);
      expect(named[0]).toMatch(/not populated/);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("coordinator review S-1: a concurrent writer that already fixed the section UNDER THE LOCK is never clobbered by the regenerate write", async () => {
    writeSettings(ALREADY_INVALID_MARKED_FREE);
    const logs: string[] = [];
    // `fetchCatalog` runs (inside maintainDynamicProfiles) AFTER `settings` is
    // loaded but BEFORE `maintainOneDynamicProfile` (and so before the
    // writer's lock) — the real timing window a concurrent process (a
    // benchmark child, another dispatch) writes in. Rewriting settingsPath
    // here to an already-VALID marked section simulates exactly that: this
    // pass's `current` (captured from the STALE `settings` snapshot) is still
    // the invalid one, but the file ON DISK is already fixed by the time the
    // writer's lock is taken.
    const FIXED_BY_CONCURRENT_WRITER = [
      "active: free",
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    free_only: true",
      "    free_models: [fixed/winner:free]",
      "    model: fixed/winner:free",
      "    api_key: $OPENROUTER_API_KEY",
      "",
    ].join("\n");
    const wrote = await withProviderKeys(() =>
      maintainDynamicProfiles({
        fetchCatalog: async () => {
          writeSettings(FIXED_BY_CONCURRENT_WRITER);
          return [{ id: "only/one:free", pricing: { prompt: "0", completion: "0" } }];
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(wrote).toBe(false);
    const fixedLines = logs.filter((l) => l.includes("already fixed it under the lock"));
    expect(fixedLines, `no 'already fixed under the lock' line: ${JSON.stringify(logs)}`).toHaveLength(1);
    expect(logs.filter((l) => l.includes("regenerated it"))).toHaveLength(0);
    // The concurrent writer's content survives byte-for-byte — the regenerate
    // write's own re-validation under the lock is what kept it.
    expect(readFileSync(settingsPath, "utf-8")).toBe(FIXED_BY_CONCURRENT_WRITER);
  });
});

describe("maintainDynamicProfiles — fix-queue 31: never throws, and a failure in ONE profile does not stop the other", () => {
  it("a REAL thrown failure while maintaining 'free' (an unwritable backups dir, not a mock) is caught, logged once, and 'paid' is still maintained", async () => {
    writeSettings(
      [
        "active: free",
        "allow_paid_models: true",
        "profiles:",
        `  # ${GENERATED_MARKER}`,
        "  free:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [only/one:free]",
        "    model: only/one:free",
        "    api_key: $OPENROUTER_API_KEY",
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    // A REAL filesystem failure, not a mock of the code under test:
    // fix-queue row 72's shared `backupSettingsFile` (benchmark/pick.ts) still
    // calls `mkdirSync(backupsDir, { recursive: true })`, which throws EEXIST
    // when a plain FILE already occupies that path —
    // measured directly (node's own fs, no llm-ext code involved) before
    // writing this test. This is the exact seam fix-queue 31 asks for: a
    // thrown failure INSIDE the per-profile try (index.ts's per-name loop in
    // `maintainDynamicProfiles`), proven with a failure that is real, not
    // simulated.
    writeFileSync(join(cfgDir, "backups"), "not a directory", "utf-8");
    const logs: string[] = [];
    // The catalog carries BOTH a `:free` id (free's own provisional pool) and
    // priced models (`paidModel`) — 'paid' only queues + spawns when the
    // catalog gives decideDynamicProfile something to fill its class with.
    const wrote = await withProviderKeys(() =>
      maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "only/one:free", pricing: { prompt: "0", completion: "0" } },
          paidModel("vendor/a"),
          paidModel("vendor/b"),
        ],
        log: (m) => logs.push(m),
      }),
    );
    // Never throws: the promise resolved (no try/catch around this `await`
    // in the test itself — an unhandled rejection would fail the test).
    expect(wrote).toBe(false);
    const failLines = logs.filter((l) => l.includes("dynamic profile maintenance for 'free' failed"));
    expect(failLines, `no per-profile failure line: ${JSON.stringify(logs)}`).toHaveLength(1);
    expect(failLines[0]).toMatch(/EEXIST/);
    // 'paid' is a SEPARATE iteration of the same per-name loop — unaffected
    // by 'free' throwing, it still gets queued and spawns its populator.
    expect(spawnCallsFor("paid")).toBe(1);
  });
});

describe("maintainDynamicProfiles", () => {
  it("LLM_EXT_DISABLE_AUTO_RECONCILE=1 skips entirely — the fetcher is never called (addendum F)", async () => {
    const prev = process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = "1";
    try {
      writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      let called = false;
      await maintainDynamicProfiles({
        fetchCatalog: async () => {
          called = true;
          return [];
        },
        log: noop,
      });
      expect(called).toBe(false);
      expect(populateDefaultProfileMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
      else process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = prev;
    }
  });

  it("drops a dead configured free model via the $0 patch, writes it through writeDynamicProfileSection, reports the write, and never spawns", async () => {
    // P6b-fix4 B1(2): `mode: remote`, which is what the SHIPPED `free` section
    // actually is (config.ts's placeholderFreeProfile). It was `remote-ensemble`,
    // and the drop below leaves a ONE-entry pool — a shape validateProfile
    // rejects ("free_only + mode 'remote-ensemble' needs at least 2 ensemble members"),
    // so the maintainer now declines to write it rather than producing a document
    // that its own reload and the next boot would reject. The fixture, not the
    // subject, carried that shape: this case is about the $0 drop.
    writeSettings(
      [
        "active: free",
        "profiles:",
        "  free:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [alive/one:free, dead/two:free]",
        "    model: alive/one:free",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    // The catalog carries ONLY the alive id — 'dead/two:free' is gone, which
    // is exactly the "model-removed" drop decideDynamicProfile.test.ts
    // already proves at the pure-function level. Returning 'alive/one:free'
    // ALSO as the sole catalogFreeQualified entry means it is subtracted
    // from itself as a would-be arrival (configured minus itself = nothing
    // new to queue), so this run cannot try to spawn a benchmark child.
    const catalog: RawCatalogModel[] = [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }];
    // P6b-fix3 R-2: the key is pinned — the subject is the $0 drop, not whether
    // a credential exists.
    const wrote = await withProviderKeys(() =>
      maintainDynamicProfiles({
        fetchCatalog: async () => catalog,
        log: noop,
      }),
    );
    // P6b-fix S3: the return value is what tells the dispatch site to reload
    // its in-memory settings, so a write that happened must be reported.
    expect(wrote).toBe(true);
    const after = readFileSync(settingsPath, "utf-8");
    expect(after).toContain("alive/one:free");
    expect(after).not.toContain("dead/two:free");
    // GENERATED_MARKER precedes the (already-existing, now-patched) key —
    // pick-comment-preservation.test.ts pins the exact rendering; here we
    // only need proof the real writer ran, not re-prove its own contract.
    expect(after).toMatch(/# .*generated by llm-ext.*\n\s*free:/);
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });

  it("P6b-fix S2: a catalog fetch failure produces ONE stderr line naming it, and still never throws", async () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    const before = readFileSync(settingsPath, "utf-8");
    const logs: string[] = [];
    await expect(
      maintainDynamicProfiles({
        fetchCatalog: async () => {
          throw new Error("network exploded");
        },
        // Stubbed to [] rather than left to the real default: the real
        // BAI_API_KEY is exported in this shell (per the project's own
        // env convention), and the unstubbed default fetcher would make a
        // LIVE network call to b.ai from a unit test.
        log: (m) => logs.push(m),
      }),
    ).resolves.toBe(false);
    const fetchLines = logs.filter((l) => l.includes("catalog fetch failed"));
    expect(fetchLines).toHaveLength(1);
    expect(fetchLines[0]).toContain("network exploded");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("P6b-fix B1: an unpopulated 'paid' with allow_paid_models: true queues the paid class and spawns the populator exactly once, with zero HTTP", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    // Nothing may reach the network: both fetchers are injected stubs, and a
    // global-fetch spy proves no OTHER path (b.ai's real fetcher, a provider
    // probe) slipped a request out.
    const fetchSpy = vi.fn(async () => {
      throw new Error("no HTTP allowed in this test");
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      await maintainDynamicProfiles({
        fetchCatalog: async () => [paidModel("vendor/a"), paidModel("vendor/b")],
        log: noop,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(spawnCallsFor("paid")).toBe(1);
    expect(spawnCallsFor("free")).toBe(0);
    expect(readCandidates((): never[] => []).paid.map((e) => e.id).sort()).toEqual(["vendor/a", "vendor/b"]);

    // And the gate refuses rather than letting the still-placeholder chain
    // reach a provider — the behaviour HEAD had at index.ts's paid population
    // branch and the dispatch rewrite dropped.
    const gate = dynamicProfileGate("paid", "chat");
    expect(gate).not.toBeNull();
    expect(gate?.message).toMatch(/not benchmarked yet and is being benchmarked now/);
    expect(gate?.message).toMatch(/~15 minutes/);
  });

  it("P6b-fix B1: an unpopulated 'paid' with allow_paid_models: false queues nothing and never spawns", async () => {
    writeSettings(
      [
        "active: free",
        "allow_paid_models: false",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a")],
      log: noop,
    });
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
    expect(readCandidates((): never[] => []).paid).toHaveLength(0);
  });

  it("P6b-fix B3(a): a second dispatch on a populated 'paid' with an UNCHANGED catalog queues nothing (the pool fingerprint is now actually recorded)", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: vendor/a",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const catalog = [paidModel("vendor/a"), paidModel("vendor/b")];
    const t0 = 1_800_000_000_000;
    await maintainDynamicProfiles({
      fetchCatalog: async () => catalog,
      nowMs: t0,
      log: noop,
    });
    // Run 1 sees no record at all, so the whole under-ceiling class is new.
    expect(readCandidates((): never[] => []).paid.map((e) => e.id)).toEqual(["vendor/b"]);
    expect(spawnCallsFor("paid")).toBe(1);
    expect(getDynamicProfileRecord("paid")?.poolFingerprint).toBeTruthy();

    // Empty the queue so "already queued" cannot be what suppresses run 2,
    // and jump PAST the 6h sweep floor so that cannot be it either. The only
    // thing left that can suppress a re-queue is the recorded fingerprint.
    clearCandidates("paid", ["vendor/b"]);
    await maintainDynamicProfiles({
      fetchCatalog: async () => catalog,
      nowMs: t0 + MIN_SWEEP_INTERVAL_MS + 3_600_000,
      log: noop,
    });
    expect(readCandidates((): never[] => []).paid).toHaveLength(0);
    expect(spawnCallsFor("paid")).toBe(1);
  });

  it("P6b-fix B3(b): a CONFIGURED model whose specs changed is re-queued (addendum I)", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: vendor/a",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const t0 = 1_800_000_000_000;
    // Run 1: the catalog holds ONLY the configured model, so there is nothing
    // to queue as an arrival and the run's only lasting effect is the recorded
    // spec fingerprint.
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a", 8000)],
      nowMs: t0,
      log: noop,
    });
    expect(readCandidates((): never[] => []).paid).toHaveLength(0);
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
    expect(getDynamicProfileRecord("paid")?.modelSpecFingerprints?.["vendor/a"]).toBeTruthy();

    // Run 2: same id, same price (so the POOL fingerprint is unchanged and the
    // arrivals path stays shut) but a different context window — only the
    // per-model spec fingerprint moved. The clock has to clear the catalog
    // disk cache's own TTL (DEFAULT_CATALOG_TTL_MS, 10 min) or run 2 would be
    // served run 1's snapshot and never see the new specs at all.
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a", 4000)],
      nowMs: t0 + 700_000,
      log: noop,
    });
    expect(readCandidates((): never[] => []).paid.map((e) => e.id)).toEqual(["vendor/a"]);
    expect(spawnCallsFor("paid")).toBe(1);
  });

  it("P6b-fix S6: a FAILING benchmark is not respawned on the next dispatch (recordBenchmarkFailure's cooldown is consulted)", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const t0 = 1_800_000_000_000;
    const run = (nowMs: number) =>
      maintainDynamicProfiles({
        fetchCatalog: async () => [paidModel("vendor/a")],
        nowMs,
        log: noop,
      });
    await run(t0);
    expect(spawnCallsFor("paid")).toBe(1);

    // The child failed, four times — the real backoff ladder, capped at 24h,
    // so the cooldown outlasts the 6h sweep floor and the next assertion can
    // only be explained by the COOLDOWN.
    for (let i = 0; i < 4; i += 1) recordBenchmarkFailure("paid", t0);
    clearCandidates("paid", ["vendor/a"]);

    await run(t0 + MIN_SWEEP_INTERVAL_MS + 3_600_000);
    expect(spawnCallsFor("paid")).toBe(1);
    // Candidates are still QUEUED — design §2.4: they wait in the queue, only
    // the spawn backs off. A test that asserted an empty queue here would be
    // pinning the wrong behaviour.
    expect(readCandidates((): never[] => []).paid.map((e) => e.id)).toEqual(["vendor/a"]);
  });

  it("CE9B7S8N: the 6 h sweep floor keys on sweep COMPLETION, not spawn — a child killed before it books a result does not block the next sweep", async () => {
    // CE9B7S8N: the floor used to key on lastSweepAt, stamped at SPAWN, so a
    // child killed before it banked a success (lastBenchmarkAt) or a booked
    // failure (cooldownUntil) froze the next sweep for the full 6 h. The
    // floor now reads the completion evidence that already lands on disk:
    // lastBenchmarkAt (the child success-stamps the dynamic record) and
    // cooldownUntil (the child books failures into the legacy record).
    // Nothing stamps spawn time any more, so an unbooked death leaves the
    // next pass free to respawn — the bench lock, not a clock, is what
    // stops a true concurrent double-spawn.
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const t0 = 1_800_000_000_000;
    const run = (nowMs: number) =>
      maintainDynamicProfiles({
        fetchCatalog: async () => [paidModel("vendor/a")],
        nowMs,
        log: noop,
      });
    await run(t0);
    expect(spawnCallsFor("paid")).toBe(1);
    // The floor no longer keys on spawn time: the record carries no
    // spawn-stamped sweep field at all (lastSweepAt is gone).
    expect(JSON.stringify(Object.keys(getDynamicProfileRecord("paid") ?? {}))).not.toContain("lastSweepAt");

    // THE ACCEPTANCE: the child is killed before booking ANYTHING — no
    // lastBenchmarkAt write, no cooldownUntil. The immediate next pass must
    // be free to spawn again; it used to wait out the full 6 h.
    // (Row 19 narrows this: only a spawn ATTEMPT inside the last 15 min floors it.)
    // The queue must be drained so run 2 sees vendor/a as a NEW arrival —
    // otherwise the "nothing new to sweep" early return, not the floor, is
    // what suppresses the spawn.

    clearCandidates("paid", ["vendor/a"]);
    // Row 19 (OE27RD7I): a child that died unbooked still left its spawn
    // attempt on the profile log mtime (bench-spawn.ts stamps it; the mocked
    // populateDefaultProfile never touches the log, so the test stamps it at
    // t0 itself). The SPAWN_ATTEMPT_FLOOR_MS (15 min) floor therefore holds
    // the respawn at t0+1s and releases it after the window.
    stampProfileLog("paid", t0);
    await run(t0 + 1000);
    expect(spawnCallsFor("paid")).toBe(1);
    clearCandidates("paid", ["vendor/a"]);
    await run(t0 + 16 * 60_000);
    expect(spawnCallsFor("paid")).toBe(2);
    // A COMPLETED sweep (child stamped lastBenchmarkAt) still floors the
    // next one for the full window — the throttle survives, keyed on
    // completion.
    updateDynamicProfileRecord("paid", (prev) => ({
      lastBenchmarkAt: t0 + 2000,
      poolFingerprint: prev?.poolFingerprint ?? "",
      modelIds: prev?.modelIds ?? [],
      failCount: prev?.failCount ?? 0,
      modelSpecFingerprints: prev?.modelSpecFingerprints,
      lastMaintainedAt: prev?.lastMaintainedAt,
    }));
    clearCandidates("paid", ["vendor/a"]);
    await run(t0 + 2000 + MIN_SWEEP_INTERVAL_MS - 1);
    expect(spawnCallsFor("paid")).toBe(2);
    clearCandidates("paid", ["vendor/a"]);
    await run(t0 + 2000 + MIN_SWEEP_INTERVAL_MS + 1);
    expect(spawnCallsFor("paid")).toBe(3);
  });


  it("JDFJLPSS: the sweep-spawn decision reads the dynamic record at decision time, not the pre-lock snapshot — a sweep that completes mid-pass floors the spawn", async () => {
    // The maintainer snapshots the record, then writes settings/record and
    // enqueues candidates before deciding to spawn. A real sweep child that
    // stamps lastBenchmarkAt and releases the bench lock in that window is
    // invisible to the snapshot; the stale value used to let a second sweep
    // spawn inside the 6 h floor. The mutation below runs inside the real
    // enqueue call, i.e. exactly between snapshot and decision.
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const t0 = 1_800_000_000_000;
    enqueueHook.fn = () => {
      updateDynamicProfileRecord("paid", (prev) => ({
        lastBenchmarkAt: t0 - 1000,
        poolFingerprint: prev?.poolFingerprint ?? "",
        modelIds: prev?.modelIds ?? [],
        failCount: prev?.failCount ?? 0,
        modelSpecFingerprints: prev?.modelSpecFingerprints,
        lastMaintainedAt: prev?.lastMaintainedAt,
      }));
    };
    try {
      await maintainDynamicProfiles({ fetchCatalog: async () => [paidModel("vendor/a")], nowMs: t0, log: noop });
    } finally {
      enqueueHook.fn = undefined;
    }
    expect(getDynamicProfileRecord("paid")?.lastBenchmarkAt, "the mid-pass completion was not written").toBe(t0 - 1000);
    expect(spawnCallsFor("paid"), "the spawn decision used the stale pre-lock snapshot").toBe(0);
  });

  it("P6b-fix S1: a REFUSED population is surfaced on stderr instead of being discarded", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    populateDefaultProfileMock.mockImplementation(
      (): PopulationOutcome => ({
        kind: "refused",
        profile: "paid",
        reason: "the daily paid-benchmark spend cap has been reached; no more billable requests today",
        remedy: "llm-ext-benchmark --populate-default-profile paid",
      }),
    );
    const logs: string[] = [];
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a")],
      log: (m) => logs.push(m),
    });
    expect(logs.join("")).toContain("daily paid-benchmark spend cap has been reached");
  });

  it("P6b-fix S1: a SKIPPED population is surfaced too — describeOutcome is silent for it by design, so the maintainer says it itself", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    populateDefaultProfileMock.mockImplementation(
      (): PopulationOutcome => ({
        kind: "skipped",
        profile: "paid",
        reason: "config dir unusable: nope",
      }),
    );
    const logs: string[] = [];
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a")],
      log: (m) => logs.push(m),
    });
    expect(logs.join("")).toContain("config dir unusable");
  });

  it("P6b-fix2 S-7: a SPAWNED population logs a neutral line — never advice to re-run the command the user ran", async () => {
    // design §2.1 maintains BOTH profiles on every dispatch, so a `--profile
    // free` command spawns the paid populator too — and describeOutcome's
    // spawned text ("Re-run this command when it finishes") was then printed to
    // a user whose command had already succeeded and had nothing to re-run.
    writeSettings(
      [
        "active: free",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: placeholder/unpopulated-default-profile",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const logs: string[] = [];
    await maintainDynamicProfiles({
      fetchCatalog: async () => [paidModel("vendor/a")],
      log: (m) => logs.push(m),
    });
    expect(spawnCallsFor("paid")).toBe(1);
    const out = logs.join("");
    expect(out).toContain("background benchmark for 'paid' started");
    expect(out, "only the GATE may tell the caller to re-run their command").not.toMatch(
      /Re-run this command/i,
    );
  });

  it("D3c-1b (TRDD-FDI9NYAS): an unpopulated 'free' whose only catalog id was never benchmarked serves NOTHING -- the id is queued and the gate refuses with the retry-later reason", async () => {
    // End-to-end pin for what default-profiles.ts's unpopulated arm relies on:
    // with no recorded pass it builds `free_models: []`, and nothing downstream
    // (the maintainer's write guard, a placeholder-shaped write, the gate's own
    // chain read) may turn that into a served id. No seedBenchmarkPass here --
    // the security-triage cache is empty on purpose. Red on HEAD: the old arm
    // wrote the catalog id straight into free_models.
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    const { free, gate } = await withProviderKeys(async () => {
      await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "never/benched:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
      });
      const settings = loadSettings();
      return {
        free: (settings as { profiles: Record<string, Profile> }).profiles.free,
        gate: dynamicProfileGate("free", "chat", { settings }),
      };
    });
    expect(free.free_models ?? []).not.toContain("never/benched:free");
    expect(
      enqueueCandidatesCalls.some((c) => c.profile === "free" && c.ids.includes("never/benched:free")),
      `never queued: ${JSON.stringify(enqueueCandidatesCalls)}`,
    ).toBe(true);
    expect(gate?.isError).toBe(true);
    expect(gate?.reason).toBe("empty-pool-refreshable");
  });

  it("D5: an unpopulated 'free' writes ONLY the OpenRouter ':free' pool — no b.ai id, no generated providers binding", async () => {
    // D5 (TRDD-90DM5YHO) replaces the deleted P6b-fix2 S-1 pin: the generated
    // b.ai prepend + binding is GONE. The b.ai route is the user's own
    // `providers` group, seeded once by the bai-reserved-seed migration step,
    // and its model rides `ensemble.reserved` — never a generated key. The
    // maintainer writes only what the OpenRouter catalog benchmarked.
    const prevKey = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-key-not-a-real-one";
    const prevOrKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    try {
      writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      seedBenchmarkPass(["vendor/qualified:free"]);
      await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
      });
      const after = readFileSync(settingsPath, "utf-8");
      const parsed = parseYaml(after) as { profiles: Record<string, Record<string, unknown>> };
      const free = parsed.profiles.free;
      expect(free.free_models).toEqual(["vendor/qualified:free"]);
      // No generated providers binding, no ensemble key: both are USER-OWNED
      // now, and the maintainer never writes either.
      expect(free.providers).toBeUndefined();
      expect(free.ensemble).toBeUndefined();
    } finally {
      if (prevKey === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevKey;
      if (prevOrKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOrKey;
    }
  });

  it("P6b-fix2 S-2: the $0 patch actually DROPS a free-forbidden tool head — applyPatch replaces tool_models, never merges", async () => {
    // P6b-fix4 B1(2): `mode: remote` for the same reason as the drop case above —
    // a ONE-entry pool under `remote-ensemble` is a section validateProfile
    // rejects, and the maintainer no longer writes one. The subject here is
    // tool_models REPLACEMENT; the pool size is incidental to it.
    writeSettings(
      [
        "active: free",
        "profiles:",
        "  free:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [alive/one:free]",
        "    model: alive/one:free",
        "    tool_models:",
        "      chat: alive/one:free",
        "      security_scan: alive/one:free",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    // P6b-fix3 R-2: the key is pinned — the subject is tool_models replacement,
    // not whether a credential exists.
    const wrote = await withProviderKeys(() =>
      maintainDynamicProfiles({
        // context_length pinned at the registry floor (tool-context-floors.ts,
        // TRDD-RZSML8AC): the catalog must say the head MEETS the floor, or the
        // $0 patch now (correctly) drops it and this S-2 replacement pin fails.
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" }, context_length: 128_000 }],
        log: noop,
      }),
    );
    expect(wrote).toBe(true);
    const parsed = parseYaml(readFileSync(settingsPath, "utf-8")) as {
      profiles: { free: { tool_models: Record<string, string> } };
    };
    // security_scan is free-forbidden, so decideDynamicProfile omits it from
    // the replacement map. A MERGE re-added it from the base on every write,
    // so the head the $0 patch condemned survived forever.
    expect(parsed.profiles.free.tool_models).toEqual({ chat: "alive/one:free" });
  });

  it("P6b-fix3 S-6': a MALFORMED free_models scalar is skipped, not spread into single characters and written", async () => {
    // `[...(profile.free_models ?? [])]` on the string "oops" yields
    // ['o','o','p','s']. The maintainer reasoned about those four as the
    // configured pool and WROTE the result — and because the section already
    // carries the generated marker, writeDynamicProfileSection takes no backup,
    // so the user's typo'd line was destroyed. The gate then saw a well-formed
    // list and PROCEEDED, putting "o" on the wire as a model id.
    await withProviderKeys(async () => {
      writeSettings(
        [
          "active: free",
          "profiles:",
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    free_only: true",
          "    free_models: oops-a-scalar",
          "    model: alive/one:free",
          "    api_key: $OPENROUTER_API_KEY",
          "",
        ].join("\n"),
      );
      const before = readFileSync(settingsPath, "utf-8");
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      });
      expect(wrote).toBe(false);
      expect(readFileSync(settingsPath, "utf-8"), "the user's malformed line must survive verbatim").toBe(
        before,
      );
      const named = logs.filter((l) => l.includes("free_models") && l.includes("not a list"));
      expect(named, `no line named the broken field: ${JSON.stringify(logs)}`).toHaveLength(1);
      // And the gate is the one that tells the user, by field name (S-6).
      const gate = dynamicProfileGate("free", "chat", { settings: loadSettings() });
      expect(gate?.message).toContain("free_models");
      expect(gate?.message).toMatch(/is not a list/);
    });
  });

  it("P6b-fix3 R-2: with the profile's provider key UNSET the maintainer writes nothing and logs the missing variable", async () => {
    // The regression: the maintainer wrote a provisional pool of OpenRouter ids
    // that no key could send. That write also made the section stop looking
    // unpopulated, which turned OFF shouldBootDespiteInvalidActiveProfile's
    // missing-key exemption, so index.ts's reload-after-write rejected the WHOLE
    // document ("⚠ settings.yaml change rejected: Remote api 'openrouter-remote'
    // requires 'api_key'") and the dispatch ran against the pre-write stub.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      seedBenchmarkPass(["alive/one:free"]); // D3c-1b: this test is about credential handling, not the benchmark gate
      const before = readFileSync(settingsPath, "utf-8");
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        // A live, qualified ':free' id, so the provisional arm DOES produce a
        // patch — the write is skipped for the credential, not for lack of a
        // decision.
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      });
      expect(wrote).toBe(false);
      expect(readFileSync(settingsPath, "utf-8"), "settings.yaml must be byte-identical").toBe(before);
      const named = logs.filter((l) => l.includes("$OPENROUTER_API_KEY"));
      expect(named, `no line named the missing variable: ${JSON.stringify(logs)}`).toHaveLength(1);
      expect(named[0]).toMatch(/not populated/);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("D5: with no usable OpenRouter key, the maintainer writes NOTHING — the b.ai-only provisional pool is gone, 'free' stays unpopulated", async () => {
    // D5 replaces the deleted P6b-fix4 B1 b.ai-only pins. With the generated
    // b.ai prepend gone, an empty OpenRouter pool means an empty pool: the
    // provisional patch carries free_models: [] (which validateProfile's
    // free_only non-empty rule makes unwritable), the write is skipped, and
    // the section stays the unpopulated placeholder — exactly the state the
    // boot's missing-key exemption understands. The b.ai route on such a
    // machine is the USER's own group + reserved slot (migration-seeded), and
    // it serves ensemble commands without any of this machinery.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      writeSettings(["profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [],
        log: (m) => logs.push(m),
      });
      expect(wrote).toBe(false);

      // The section is UNTOUCHED — still the unpopulated placeholder the boot
      // exemption recognizes, no half-written pool.
      const reloaded = loadSettings();
      expect(reloaded).not.toBeNull();
      const free = (reloaded as { profiles: Record<string, Profile> }).profiles.free;
      expect(free.model).toBe("placeholder/unpopulated-default-profile");
      expect(free.free_models).toEqual([]);
      expect(free.providers).toBeUndefined();
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("D5: a populated free section carrying a user b.ai group keeps being MAINTAINED — the group survives every $0 patch", async () => {
    // Replaces the deleted "credential skip reads the candidate's routes"
    // pin. The b.ai group is USER-owned now: the $0 patch (dead-id drop,
    // tool-head replacement) touches only GENERATED keys, so the user's
    // providers group and ensemble.reserved node survive byte-for-byte.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    // The user's bai group carries $BAI_API_KEY — its own credential must
    // resolve for the section (with the group) to validate at all.
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      writeSettings(
        [
          "profiles:",
          "  free:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    free_only: true",
          "    free_models: [alive/one:free, gone/from-catalog]",
          "    model: alive/one:free",
          "    api_key: $OPENROUTER_API_KEY",
          "    providers:",
          "      - name: bai",
          "        api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-5.3-flash]",
          "    ensemble:",
          "      reserved:",
          "        - provider: bai",
          "          model: glm-5.3-flash",
          "",
        ].join("\n"),
      );
      seedBenchmarkPass(["alive/one:free"]);
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        // 'gone/from-catalog' is absent from the catalog — the $0 patch drops it.
        fetchCatalog: async () => [
          { id: "alive/one:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: (m) => logs.push(m),
      });
      expect(wrote, `the dead id was never dropped: ${JSON.stringify(logs)}`).toBe(true);
      const free = (loadSettings() as { profiles: Record<string, Profile> }).profiles.free;
      expect(free.free_models).toEqual(["alive/one:free"]);
      // The user's own nodes survive untouched.
      expect(free.providers).toEqual([
        { name: "bai", api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["glm-5.3-flash"] },
      ]);
      expect(free.ensemble).toEqual({ reserved: [{ provider: "bai", model: "glm-5.3-flash" }] });
      expect(validateSettings(loadSettings() as never).valid).toBe(true);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("D5: with a working OpenRouter key, the provisional pool is exactly the benchmarked ':free' ids — nothing else", async () => {
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    delete process.env.BAI_API_KEY;
    try {
      writeSettings(["profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      seedBenchmarkPass(["vendor/qualified:free"]);
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: (m) => logs.push(m),
      });
      expect(wrote, `no write landed: ${JSON.stringify(logs)}`).toBe(true);
      const free = (loadSettings() as { profiles: Record<string, Profile> }).profiles.free;
      expect(free.free_models).toEqual(["vendor/qualified:free"]);
      expect(free.providers).toBeUndefined();
      expect(validateSettings(loadSettings() as never).valid).toBe(true);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("fix-queue 53 follow-up (row 53 review, S2), D5 shape: once the OpenRouter credential resolves, the populated pool gains the catalog-qualified ':free' arrivals as candidates", async () => {
    // Two passes: pass 1 has NO usable OpenRouter key, so (D5 — the b.ai-only
    // provisional pool is gone) it writes nothing and 'free' stays the
    // unpopulated placeholder. Pass 2 exports the key and the OpenRouter
    // catalog lists a new ':free' id — the pool must gain it as a QUEUED
    // candidate (arrivals are proposed for benchmark, never spliced straight
    // into free_models -- that is the populator's job). Pins that
    // `freeArrivals` reads `catalogFreeQualified`, which on pass 2 (key set,
    // catalog genuinely refetched past its 10-minute TTL) already reflects
    // the resolvable id.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      writeSettings(["profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      const pass1Wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [],
        log: noop,
      });
      expect(pass1Wrote).toBe(false); // D5: nothing to write — stays unpopulated

      process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
      // Past the 10-minute catalog-cache TTL (catalog-cache.ts), so this pass
      // genuinely re-fetches instead of replaying pass 1's cached empty list.
      await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/newarrival:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
        nowMs: Date.now() + 700_000,
      });
      const cands = readCandidates((): never[] => []);
      expect(cands.free.map((e) => e.id)).toContain("vendor/newarrival:free");
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("fix-queue 53 follow-up (row 53 review, S2): a b.ai-only machine (OpenRouter key NEVER set) never queues a catalog-listed ':free' arrival nothing can serve", async () => {
    // The actual gap `openRouterCredentialUsable`/`baiCredentialUsable` being
    // unread in the POPULATED branch left open: catalogFreeQualified is a
    // catalog LISTING (needs no auth, fix-queue 53's own premise) and stays
    // non-empty on a b.ai-only machine even with $OPENROUTER_API_KEY never
    // exported -- so `freeArrivals` used to queue a brand-new OpenRouter
    // ':free' id every pass, and nothing could ever benchmark it (dead weight
    // on the queue, a wasted spawn attempt on the next sweep). Red before the
    // fix (freeArrivals had no credential gate at all); green after gating it
    // on `openRouterCredentialUsable` the same way the unpopulated arm already
    // does.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      writeSettings(["profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      await maintainDynamicProfiles({
        fetchCatalog: async () => [],
        log: noop,
      });
      // pass 2: $OPENROUTER_API_KEY is STILL never set. The (cached, keyless)
      // catalog listing gains a new ':free' id anyway.
      await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/newarrival:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
        nowMs: Date.now() + 700_000,
      });
      const cands = readCandidates((): never[] => []);
      expect(cands.free.map((e) => e.id)).not.toContain("vendor/newarrival:free");
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("fix-queue 53 follow-up (row 53 review, S1): a machine WITH a working OpenRouter key still populates 'free' from the catalog's qualified ':free' ids when 'free' has no section yet at all", async () => {
    // Reachable: overrideActiveProfile (index.ts) only auto-creates a stub for
    // the ONE dynamic profile a dispatch actually selects (e.g. `--profile
    // paid`); maintainDynamicProfiles' own loop still reconciles BOTH 'free'
    // and 'paid' on every pass, so a `paid`-only machine that has never
    // touched `free` reaches this pass with `settings.profiles.free` truly
    // `undefined` -- not even the unpopulated placeholder.
    // `credentialUsable(undefined, undefined)` returns `false` unconditionally
    // (its own first line, config.ts), so `openRouterCredentialUsable` used to
    // come back `false` here regardless of $OPENROUTER_API_KEY -- the
    // unpopulated arm then excluded every OpenRouter ':free' id from the
    // provisional pool (fix-queue 53's own exclusion, applied for the wrong
    // reason), and 'free' populated empty on a machine that had a perfectly
    // usable key. Red before the fix (no OpenRouter fallback stub existed for
    // an absent section, unlike the b.ai stub two lines below it); green once
    // the absent case falls back to `unpopulatedFreeProfile()`'s own shape,
    // the SAME shape the writer uses to create the section a moment later.
    //
    // The observable is the CANDIDATE QUEUE, not settings.yaml: with no
    // `existing` section for the writer to merge a patch onto, this pass
    // deliberately writes nothing (the "no settings.yaml section to patch"
    // fail-open a few lines above this call in dynamic-maintainer.ts) --
    // `overrideActiveProfile` (index.ts) is what creates the placeholder on
    // the NEXT real dispatch, and that dispatch's own maintainer pass then
    // merges onto it. What this pass CAN do, and is the thing S1 is about, is
    // decide the right provisional pool and queue it -- so the populator
    // benchmarks the qualified id the moment the section exists.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    delete process.env.BAI_API_KEY;
    try {
      // No 'free:' key at all -- only 'paid', already populated, so
      // maintainDynamicProfiles' 'paid' pass is a no-op and the test's only
      // observable effect is what the 'free' pass (current === undefined) did.
      writeSettings(
        [
          "profiles:",
          "  paid:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    model: vendor/already-populated",
          "    api_key: $OPENROUTER_API_KEY",
          "",
        ].join("\n"),
      );
      await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
      });
      const cands = readCandidates((): never[] => []);
      expect(cands.free.map((e) => e.id)).toContain("vendor/qualified:free");
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("fix-queue 53 follow-up (row 53 review, S4): a section with its OWN custom api_key resolves that variable, not the preset's default -- $OPENROUTER_API_KEY can stay unset", async () => {
    // Pin against reverting `dynamicCredentialUsability`'s section-object
    // check (dynamic-maintainer.ts) back to a bare preset stub -- it must
    // check THIS profile's own `api_key` line (missingProviderKeyVar already
    // reads `profile.api_key || preset.defaultAuthEnv`; the risk pinned here
    // is `dynamicCredentialUsability` accidentally checking a fresh stub
    // instead of `settings.profiles[name]` for a section that DOES exist).
    // Red if that line is reverted to `unpopulatedFreeProfile()` (or any
    // other bare stub) unconditionally: the stub's `api_key` is always
    // `$OPENROUTER_API_KEY`, which is unset here, so the credential check
    // would come back false and the pool would stay empty.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevCustom = process.env.CUSTOM_OPENROUTER_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.CUSTOM_OPENROUTER_KEY = "test-custom-key-not-a-real-one";
    try {
      writeSettings(
        [
          "profiles:",
          "  free:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    free_only: true",
          "    free_models: []",
          "    model: placeholder/unpopulated-default-profile",
          "    api_key: $CUSTOM_OPENROUTER_KEY",
          "",
        ].join("\n"),
      );
      seedBenchmarkPass(["vendor/qualified:free"]); // D3c-1b: this test is about custom api_key resolution, not the benchmark gate
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
      });
      expect(wrote, "the custom-keyed section's own credential was not honored").toBe(true);
      const free = (loadSettings() as { profiles: Record<string, Profile> }).profiles.free;
      expect(free.free_models).toEqual(["vendor/qualified:free"]);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevCustom === undefined) delete process.env.CUSTOM_OPENROUTER_KEY;
      else process.env.CUSTOM_OPENROUTER_KEY = prevCustom;
    }
  });

  it("fix-queue 53 follow-up (row 53 review, S5): restores the 'requires api_key' assertion the b.ai-mixed-pool test (a1562eb) dropped -- a paid candidate that still cannot be written names the missing var", async () => {
    // a1562eb removed "P6b-fix4 B1: a MIXED provisional pool with only a b.ai
    // key is NOT written" (its premise no longer holds: fix-queue 53 now
    // excludes an unservable OpenRouter id from the provisional pool instead
    // of building a mixed one) -- but dropped WITH it the only assertion that
    // a write-skip's log actually quotes validateProfile's own
    // "requires 'api_key'" wording, so the user hears which variable to
    // export. Restored here against a still-reachable case: `paid`'s own
    // credential resolves (so the credential-skip branch, which has its OWN
    // hand-written wording, does NOT fire first — see dynamic-maintainer.ts's
    // "ORDER: the credential arm FIRST" comment), but the candidate carries
    // forward a `providers[]` route (applyPatch never touches `providers` for
    // `paid`) whose OWN api_key is unset -- so it is validateProfile's
    // per-binding check (config.ts, "requires 'api_key'" + the unset var
    // named in parens) that rejects it, and THAT is the wording that must
    // reach the user.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    delete process.env.BAI_API_KEY;
    try {
      writeSettings(
        [
          "profiles:",
          "  paid:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    model: vendor/dead-model",
          "    api_key: $OPENROUTER_API_KEY",
          "    providers:",
          "      - api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-5.3-flash]",
          "",
        ].join("\n"),
      );
      const before = readFileSync(settingsPath, "utf-8");
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [paidModel("vendor/replacement")],
        log: (m) => logs.push(m),
      });
      expect(wrote, `expected the write to be refused: ${JSON.stringify(logs)}`).toBe(false);
      expect(readFileSync(settingsPath, "utf-8"), "settings.yaml must be byte-identical").toBe(before);
      const named = logs.filter((l) => l.includes("would not validate"));
      expect(named, `no line named the rejection: ${JSON.stringify(logs)}`).toHaveLength(1);
      expect(named[0], "the user must hear which credential the write needed").toMatch(
        /requires 'api_key'/,
      );
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("P6b-fix4 B1(2): a patch whose merged section would NOT validate is not written, and the refusal quotes the validator", async () => {
    // The invariant, tested where it actually bites: a `remote-ensemble` free_only
    // profile whose pool shrinks to ONE entry is a section validateProfile rejects
    // ("needs at least 2 ensemble members"). Written, it makes the reload reject the
    // whole document and the next boot serve NOT CONFIGURED — so the section is
    // left alone instead, which keeps it serving what it has.
    await withProviderKeys(async () => {
      writeSettings(
        [
          "profiles:",
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    free_only: true",
          "    free_models: [alive/one:free, dead/two:free]",
          "    model: alive/one:free",
          "    api_key: $OPENROUTER_API_KEY",
          "",
        ].join("\n"),
      );
      const before = readFileSync(settingsPath, "utf-8");
      const logs: string[] = [];
      const wrote = await maintainDynamicProfiles({
        fetchCatalog: async () => [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }],
        log: (m) => logs.push(m),
      });
      expect(wrote).toBe(false);
      expect(readFileSync(settingsPath, "utf-8"), "settings.yaml must be byte-identical").toBe(before);
      const named = logs.filter((l) => l.includes("would not validate"));
      expect(named, `no line named the rejection: ${JSON.stringify(logs)}`).toHaveLength(1);
      // D5 reworded the floor sentence: reserved slots now count toward the
      // 2-member minimum, so the validator names "ensemble members", not
      // "free_models" (the refusal form is pinned in config.test.ts).
      expect(named[0], "the validator's own sentence is the actionable part").toMatch(
        /at least 2 ensemble members/,
      );
    });
  });

  it("P6b-fix2 S-5: an OFFLINE run keeps the recorded fingerprints, and the next online run with an unchanged catalog queues nothing", async () => {
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: true",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: vendor/a",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    const t0 = 1_800_000_000_000;
    const catalog = [paidModel("vendor/a"), paidModel("vendor/b")];
    await maintainDynamicProfiles({
      fetchCatalog: async () => catalog,
      nowMs: t0,
      log: noop,
    });
    const banked = getDynamicProfileRecord("paid");
    expect(banked?.poolFingerprint).toBeTruthy();
    expect(banked?.modelSpecFingerprints?.["vendor/a"]).toBeTruthy();
    clearCandidates("paid", ["vendor/b"]);

    // OFFLINE: the fetch throws and getCatalog fails OPEN. The disk cache is
    // removed first, because a STALE cache is a perfectly good catalog and
    // would hide the defect — the case that bites is a config dir with no
    // usable snapshot (never written, or cleaned), where fail-open means an
    // EMPTY list. A fingerprint of nothing is still a well-formed fingerprint:
    // banking it marked the whole paid class "changed" on the next online run
    // and re-queued it, billably, while the same write wiped addendum I's
    // per-model baseline.
    rmSync(catalogCachePath(), { force: true });
    await maintainDynamicProfiles({
      fetchCatalog: async () => {
        throw new Error("offline");
      },
      nowMs: t0 + 2 * MIN_SWEEP_INTERVAL_MS,
      log: noop,
    });
    const afterOffline = getDynamicProfileRecord("paid");
    expect(afterOffline?.poolFingerprint).toBe(banked?.poolFingerprint);
    expect(afterOffline?.modelSpecFingerprints).toEqual(banked?.modelSpecFingerprints);
    // …and the offline pass still records that it RAN.
    expect(afterOffline?.lastMaintainedAt).toBe(t0 + 2 * MIN_SWEEP_INTERVAL_MS);

    // Back online, same catalog: nothing to re-queue, nothing to spawn.
    const spawnsBefore = spawnCallsFor("paid");
    await maintainDynamicProfiles({
      fetchCatalog: async () => catalog,
      nowMs: t0 + 4 * MIN_SWEEP_INTERVAL_MS,
      log: noop,
    });
    expect(readCandidates((): never[] => []).paid).toHaveLength(0);
    expect(spawnCallsFor("paid")).toBe(spawnsBefore);
  });

  it("P6b-fix2 S-4: a benchmark child writing the sidecar concurrently loses nothing, and loses nothing of the maintainer's", async () => {
    // `dynamic-profiles-state.json` is written by the maintainer (twice per
    // dispatch) AND by a completing benchmark child. The read-modify-write took
    // no lock, so each could write back a snapshot taken before the other's
    // write: the parent erased the child's lastBenchmarkAt, or the child
    // reverted the parent's poolFingerprint — and a reverted fingerprint
    // re-queues the whole under-ceiling paid class on the next dispatch,
    // billably. tmp+rename answers a torn file, not a lost update.
    //
    // The other writer is a REAL second process doing exactly what the child
    // does (same lock dir, same read-modify-write); nothing under test is
    // stubbed. allow_paid_models is false so this run cannot spawn anything.
    writeSettings(
      [
        "active: paid",
        "allow_paid_models: false",
        "profiles:",
        ...FREE_PLACEHOLDER,
        "  paid:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: vendor/a",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cfgDir, "dynamic-profiles-state.json"),
      JSON.stringify({
        version: 1,
        profiles: { paid: { lastBenchmarkAt: 0, poolFingerprint: "SEEDED", modelIds: [], failCount: 0 } },
      }),
      "utf-8",
    );
    const childPath = join(cfgDir, "bench-child.mjs");
    writeFileSync(childPath, CONCURRENT_CHILD_SRC, "utf-8");
    const child = spawn(process.execPath, [childPath, cfgDir], { stdio: "inherit" });
    const childExit = new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));

    await maintainDynamicProfiles({
      // The fetcher runs BEFORE the record write, so waiting here puts the
      // maintainer's write inside the window where the child holds the lock —
      // a real race, not a simulated one.
      fetchCatalog: async () => {
        const marker = join(cfgDir, "child-holds-lock");
        for (let i = 0; i < 300 && !existsSync(marker); i += 1) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(existsSync(marker), "the child never acquired the lock").toBe(true);
        return [paidModel("vendor/a")];
      },
      log: noop,
    });

    expect(await childExit).toBe(0);
    const after = getDynamicProfileRecord("paid");
    expect(after?.lastBenchmarkAt, "the child's benchmark clock was lost").toBe(111);
    expect(after?.poolFingerprint, "the maintainer's fingerprint was reverted by the child").not.toBe("SEEDED");
    expect(after?.poolFingerprint).toBeTruthy();
  });

  it("P6b-fix2 S-9: a section another process wrote between the maintainer's load and its write is NOT clobbered", async () => {
    writeSettings(
      [
        "active: free",
        "profiles:",
        "  free:",
        // P6b-fix4 B1(2): `mode: remote` (the shipped shape). Under
        // `remote-ensemble` the child's ONE-entry pool below is a section
        // validateProfile rejects, which made the fixture encode a document the
        // reload would refuse — a different defect from the one this case is about.
        "    mode: remote",
        "    api: openrouter-remote",
        "    free_only: true",
        "    free_models: [alive/one:free, dead/two:free]",
        "    model: alive/one:free",
        "    api_key: $OPENROUTER_API_KEY",
        "",
      ].join("\n"),
    );
    // The maintainer calls loadSettings() BEFORE it fetches the catalog, and
    // takes the writer's lock long after — so the fetcher is the real race
    // window, not a simulated one. A benchmark child finishing here used to
    // have its whole result replaced by the parent's stale base + $0 patch.
    const CHILD_SETTINGS = [
      "active: free",
      "profiles:",
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    free_only: true",
      "    free_models: [benchmarked/winner:free]",
      "    model: benchmarked/winner:free",
      "    api_key: $OPENROUTER_API_KEY",
      "",
    ].join("\n");
    // P6b-fix3 R-2: pinned — the subject is the concurrent write, and the
    // maintainer now refuses to write at all with no credential.
    const before = readFileSync(settingsPath, "utf-8");
    const maintainerWrote = await withProviderKeys(() =>
      maintainDynamicProfiles({
        fetchCatalog: async () => {
          writeSettings(CHILD_SETTINGS);
          return [{ id: "alive/one:free", pricing: { prompt: "0", completion: "0" } }];
        },
        log: noop,
      }),
    );
    const after = readFileSync(settingsPath, "utf-8");
    expect(after, "the child's freshly benchmarked pool must survive").toContain("benchmarked/winner:free");
    expect(after).not.toContain("alive/one:free");
    // P6b-fix4 Q2: the return is "THIS pass wrote", and this pass deliberately
    // did not — it abstained so the child's result would survive. fix3 OR-ed a
    // closure flag in here to make it read `true`, which worked for this one path
    // and silently reported "nothing changed" on the four other ways the
    // maintainer can return. The reload is now decided by the DISPATCH SITE,
    // which hashes settings.yaml around this call: the document below differs
    // from the one this pass started with, which is what that hash sees.
    // dispatch-reload.test.ts drives that end to end through index.ts's own
    // dispatch, rather than re-asserting it against a fresh loadSettings() here.
    expect(maintainerWrote, "this pass abstained, so it must not claim a write").toBe(false);
    expect(after, "the on-disk document must differ from the one the pass began with").not.toBe(before);
  });
});

describe("dynamicProfileGate", () => {
  it("passes through a non-dynamic effective profile untouched", () => {
    expect(dynamicProfileGate("prof-a", "mass_scout")).toBeNull();
  });

  it("addendum H: 'free' + high_quality_scan refuse with the exact text, paid-off suffix included when allow_paid_models is false", () => {
    const settings = {
      allow_paid_models: false,
      profiles: { free: { mode: "remote", api: "openrouter-remote", model: "x", free_models: ["a:free"] } },
    } as never;
    // PT-05 (D34): mass_scout left this list; it takes a scouting-type profile, so a free profile has nothing to refuse.
    for (const tool of ["high_quality_scan"]) {
      const gate = dynamicProfileGate("free", tool, { settings });
      expect(gate).not.toBeNull();
      expect(gate?.message).toBe(freeToolUnfitRefusal(tool, false));
      expect(gate?.message).toContain(FREE_TOOL_UNFIT_PAID_OFF_SUFFIX);
    }
  });

  it("P6b-fix2 B-2: every tool that drives the LLM on the profile's head is refused, naming the actual tool", () => {
    const settings = {
      allow_paid_models: true,
      profiles: { free: { mode: "remote", api: "openrouter-remote", model: "x", free_models: ["a:free"] } },
    } as never;
    for (const tool of ["security_scan"]) {
      const gate = dynamicProfileGate("free", tool, { settings });
      expect(gate, `${tool} must be refused under free`).not.toBeNull();
      expect(gate?.message).toBe(freeToolUnfitRefusal(tool, true));
      expect(gate?.message).toContain(tool);
    }
  });

  it("PT-05 (D34): the scouting-type mass-scout tools are not refused by the free gate (the profile-type check owns them)", () => {
    // WHY: they take their model from a scouting profile, never the free head, so the free-mode refusal no longer applies.
    const settings = {
      allow_paid_models: true,
      profiles: { free: { mode: "remote", api: "openrouter-remote", model: "x", free_models: ["a:free"] } },
    } as never;
    for (const tool of ["mass_scout", "mass_scout_chain", "mass_scout_propose_fieldset"]) {
      expect(dynamicProfileGate("free", tool, { settings }), `${tool} must pass the free gate`).toBeNull();
    }
  });

  it("P6b-fix2 B-2: a mass-scout tool that never consults the profile's head is NOT refused", () => {
    // P6b-fix's predicate was `startsWith("mass_scout") || MASS_SCOUT_TOOL_NAMES.has(tool)`,
    // i.e. MCP-MODULE MEMBERSHIP — so on a DEFAULT install (profile `free`)
    // every one of these hard-refused with "no free model is fit for it",
    // including a COST ESTIMATOR and three model-qualification tools that make
    // no LLM call at all, and index.ts's own ':free' substitution for exactly
    // these tools became dead code. They read local SQLite, write reports, or
    // pick their own candidate models; none of them reads a free model head.
    const settings = {
      allow_paid_models: true,
      profiles: { free: { mode: "remote", api: "openrouter-remote", model: "x", free_models: ["a:free"] } },
    } as never;
    for (const tool of [
      "mass_scout_jobs_list",
      "mass_scout_get",
      "mass_scout_export",
      "mass_scout_estimate",
      "mass_scout_diff",
      "mass_scout_search",
      "mass_scout_search_xjob",
      "mass_scout_register",
      "mass_scout_preclassify",
      "check_tool_replacements",
      "search_existing_benchmark",
      "security_triage_benchmark",
      "assess_model",
    ]) {
      expect(dynamicProfileGate("free", tool, { settings }), `${tool} must NOT be refused under free`).toBeNull();
    }
  });

  it("a normal tool under 'free' with a non-empty pool is never refused", () => {
    const settings = {
      allow_paid_models: false,
      profiles: { free: { mode: "remote", api: "openrouter-remote", model: "a:free", free_models: ["a:free"] } },
    } as never;
    expect(dynamicProfileGate("free", "chat", { settings })).toBeNull();
  });

  it("free with an EMPTY pool and no b.ai key refuses with the honest-limit message (§3.3)", async () => {
    // P6b-fix3 R-2(b): pinned. This case is "the pool is empty and a benchmark
    // IS coming"; with no credentials at all the gate correctly says something
    // else, which made this assertion leg-dependent.
    await withProviderKeys(() => {
      // P6b-fix2 S-1: `free_only: true` added to the fixture — the gate now
      // asks what resolveProfile would actually SEND (chainModelIds), and a
      // free_only profile serves from free_models while any other profile
      // serves `model`. The generated `free` section is always free_only (the
      // stub and the benchmark child both set it), so this is the real shape;
      // without it the fixture described a profile that CAN serve `x`, for
      // which "no usable free model" would be a false refusal.
      const settings = {
        allow_paid_models: false,
        profiles: { free: { mode: "remote", api: "openrouter-remote", free_only: true, model: "x", free_models: [] } },
      } as never;
      const gate = dynamicProfileGate("free", "chat", { settings });
      expect(gate).not.toBeNull();
      expect(gate?.message).toMatch(/no usable free model right now/);
      expect(gate?.message).toMatch(/A background benchmark is refreshing the pool/);
      // P14.1 (empty-pool-wait fix): THIS is the one refusal an update can
      // plausibly fix -- the dispatch pre-flight's synchronous
      // update-and-wait keys on this discriminant, never on the message text.
      expect(gate?.reason).toBe("empty-pool-refreshable");
    });
  });

  it("P6b-fix S2: when the empty pool is caused by a FAILED catalog fetch, the message says so instead of blaming a benchmark", async () => {
    // P6b-fix3 R-2(b): pinned — a missing credential now outranks a failed
    // fetch in the refusal, and it is the same missing credential that would
    // make the fetch fail, so the two causes must not be mixed in one fixture.
    await withProviderKeys(() => {
      const nowMs = 1_800_000_000_000;
      writeFileSync(
        catalogCachePath(),
        JSON.stringify({ fetchedAtMs: 0, models: [], failedAtMs: nowMs - 1_000 }),
        "utf-8",
      );
      // free_only, for the same reason as the case above (P6b-fix2 S-1).
      const settings = {
        allow_paid_models: false,
        profiles: { free: { mode: "remote", api: "openrouter-remote", free_only: true, model: "x", free_models: [] } },
      } as never;
      const gate = dynamicProfileGate("free", "chat", { settings, nowMs });
      expect(gate?.message).toMatch(/catalog\s+fetch failed/);
      expect(gate?.message).not.toMatch(/A background benchmark is refreshing the pool/);
      // P14.1: a just-failed catalog fetch is NOT "an update could plausibly
      // fix it" -- the dispatch pre-flight must refuse immediately here too.
      expect(gate?.reason).toBeUndefined();
    });
  });

  it("P6b-fix3 R-2(b), D5 shape: with the OpenRouter key unset, the empty-pool refusal names the variable and promises no benchmark", () => {
    // The regression this closes: on a no-keys run the gate said "A background
    // benchmark is refreshing the pool — retry in a few minutes", which is
    // unconditionally false (nothing can query a provider, so nothing can be
    // benchmarked) and sent the user to wait instead of to export a key.
    // D5: the gate list is OpenRouter-only — $BAI_API_KEY no longer gates a
    // generated model (the b.ai route is a user group + reserved slot), so
    // the message names only the variable that still matters.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      const settings = {
        allow_paid_models: false,
        profiles: { free: { mode: "remote", api: "openrouter-remote", free_only: true, model: "x", free_models: [] } },
      } as never;
      const gate = dynamicProfileGate("free", "chat", { settings });
      expect(gate).not.toBeNull();
      expect(gate?.message).toMatch(/no usable free model right now/);
      expect(gate?.message).toContain("$OPENROUTER_API_KEY");
      expect(gate?.message).not.toContain("$BAI_API_KEY");
      expect(gate?.message).not.toMatch(/A background benchmark is refreshing the pool/);
      // P14.1: no credentials means an update cannot help -- the dispatch
      // pre-flight must refuse immediately, never attempt one.
      expect(gate?.reason).toBeUndefined();
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("P6b-fix3 S-3': under LLM_EXT_DISABLE_AUTO_RECONCILE=1 the FREE empty-pool refusal names the opt-out, never a running benchmark", async () => {
    // S-3 fixed this for `paid` and left `free` — the DEFAULT profile — still
    // promising a benchmark the opt-out itself guarantees will never run.
    await withProviderKeys(() => {
      const settings = {
        allow_paid_models: false,
        profiles: { free: { mode: "remote", api: "openrouter-remote", free_only: true, model: "x", free_models: [] } },
      } as never;
      const prev = process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
      process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = "1";
      try {
        const gate = dynamicProfileGate("free", "chat", { settings });
        expect(gate).not.toBeNull();
        expect(gate?.message).not.toMatch(/A background benchmark is refreshing the pool/);
        expect(gate?.message).toContain("LLM_EXT_DISABLE_AUTO_RECONCILE=1");
        expect(gate?.message).toContain("--populate-default-profile free");
        // P14.1: the opt-out guarantees an update will never run -- the
        // dispatch pre-flight must refuse immediately, never attempt one.
        expect(gate?.reason).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
        else process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = prev;
      }
    });
  });

  it("'paid' without allow_paid_models refuses with the existing text (§3.3 table row 3)", () => {
    const settings = { allow_paid_models: false, profiles: {} } as never;
    const gate = dynamicProfileGate("paid", "chat", { settings });
    expect(gate?.message).toBe("paid profile needs allow_paid_models: true in settings.yaml");
  });

  it("P6b-fix S4/B1: 'paid' unpopulated with budget REMAINING refuses with the benchmark-in-progress row, never proceeds", () => {
    const settings = {
      allow_paid_models: true,
      paid_benchmark_daily_cap_usd: 0.5,
      profiles: { paid: { mode: "remote", api: "openrouter-remote", model: "placeholder/unpopulated-default-profile" } },
    } as never;
    // dailyRemainingUsd reads the real daily-spend.json under the isolated
    // LLM_EXT_CONFIG_DIR — nothing booked yet this UTC day, so the cap is NOT
    // reached. On HEAD's dispatch path this returned null and the placeholder
    // id went to the provider; it must refuse.
    const gate = dynamicProfileGate("paid", "chat", { settings });
    expect(gate).not.toBeNull();
    expect(gate?.message).toMatch(/being benchmarked now/);
  });

  it("P6b-fix S4: 'paid' unpopulated with the daily cap SPENT refuses, naming the cap as $X.XX (§3.3 table row 4)", () => {
    const settings = {
      allow_paid_models: true,
      paid_benchmark_daily_cap_usd: 0.5,
      profiles: { paid: { mode: "remote", api: "openrouter-remote", model: "placeholder/unpopulated-default-profile" } },
    } as never;
    const nowMs = Date.UTC(2026, 8, 17, 12, 0, 0);
    bookDailySpend(0.5, nowMs); // the whole cap, this UTC day
    const gate = dynamicProfileGate("paid", "chat", { settings, nowMs });
    expect(gate).not.toBeNull();
    expect(gate?.message).toContain("$0.50");
    expect(gate?.message).toMatch(/resumes tomorrow \(UTC\)/);
  });

  it("P6b-fix B1 last-line guard: a chain still holding the placeholder id never reaches a provider, even when every branch above said proceed", () => {
    // `paid` here is POPULATED by isPlaceholderProfile's own test (its `model`
    // is a real id), allow_paid_models is on and nothing is spent — so every
    // branch answers "proceed". The placeholder survives in paid_models, which
    // is part of the chain a 402 rotation walks.
    const settings = {
      allow_paid_models: true,
      profiles: {
        paid: {
          mode: "remote",
          api: "openrouter-remote",
          model: "vendor/real",
          paid_models: ["vendor/real", "placeholder/unpopulated-default-profile"],
        },
      },
    } as never;
    const gate = dynamicProfileGate("paid", "chat", { settings });
    expect(gate).not.toBeNull();
    expect(gate?.message).toContain("placeholder/unpopulated-default-profile");
  });

  it("P6b-fix2 S-1: an EMPTY free pool refuses even with BAI_API_KEY set — a key is not a model", () => {
    // The old gate skipped the empty-pool refusal whenever BAI_API_KEY was set.
    // But resolveProfile's free_only branch builds `model` from
    // `freeModels[0] ?? ""`, and the b.ai id was written to `patch.model`,
    // which that branch overwrites — so the command proceeded and sent the
    // EMPTY STRING as the model id. A b.ai slot that can actually serve lives
    // in free_models (with its route), where it counts itself.
    const prevKey = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-key-not-a-real-one";
    try {
      const settings = {
        allow_paid_models: false,
        profiles: { free: { mode: "remote", api: "openrouter-remote", free_only: true, model: "x", free_models: [] } },
      } as never;
      const gate = dynamicProfileGate("free", "chat", { settings });
      expect(gate, "an empty pool must refuse whether or not a b.ai key is exported").not.toBeNull();
      expect(gate?.message).toMatch(/no usable free model right now/);
    } finally {
      if (prevKey === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevKey;
    }
  });

  it("P6b-fix4 S3: a LITERAL api_key counts as a credential — the refusal never tells that user to export an env var", () => {
    // Two predicates disagreed about what a credential IS. The maintainer's
    // write-skip reads `profile.api_key` first (missingProviderKeyVar), while this
    // message read the two env vars ONLY — so a user who pasted their key into
    // settings.yaml and exported nothing was told "neither $OPENROUTER_API_KEY nor
    // $BAI_API_KEY is set … export one and re-run" about a credential they had
    // already supplied. Same "the message names the wrong cause" class R-2(b)
    // exists to remove.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      const settings = {
        allow_paid_models: false,
        profiles: {
          free: {
            mode: "remote",
            api: "openrouter-remote",
            free_only: true,
            model: "x",
            free_models: [],
            // The key IS here, in the file, as a literal — not an env-var ref.
            api_key: "a-literal-key-pasted-into-settings-yaml",
          },
        },
      } as never;
      const gate = dynamicProfileGate("free", "chat", { settings });
      expect(gate, "an empty pool still refuses — the question is only WHY").not.toBeNull();
      expect(gate?.message).toMatch(/no usable free model right now/);
      expect(gate?.message, "the user supplied a credential; do not blame a missing one").not.toMatch(
        /export one and re-run/,
      );
      expect(gate?.message).not.toMatch(/neither \$OPENROUTER_API_KEY/);
      // With a credential present the next arm speaks, which is the true cause.
      expect(gate?.message).toMatch(/A background benchmark is refreshing the pool/);
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

  it("P6b-fix4 N6: an UNREADABLE spend ledger is refused as itself, never as a spent budget", () => {
    // The wrap fails closed (no budget), which is right — but it did so THROUGH
    // the cap message, so a config dir that cannot be read was reported as
    // "today's paid-benchmark budget ($5.00) is used up — it resumes tomorrow
    // (UTC), or raise paid_benchmark_daily_cap_usd": two pieces of advice that
    // cannot fix it, and no mention of the thing that can.
    //
    // dailyRemainingUsd reaches getConfigDir(), which THROWS for a config dir
    // outside its allowlist — so pointing the env var somewhere illegal is the
    // real failure, not a simulated one.
    const prevCfg = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = "/etc/llm-ext-not-an-allowed-config-dir";
    try {
      const settings = {
        allow_paid_models: true,
        paid_benchmark_daily_cap_usd: 5,
        profiles: {
          paid: {
            mode: "remote",
            api: "openrouter-remote",
            model: "placeholder/unpopulated-default-profile",
            api_key: "a-literal-key",
          },
        },
      } as never;
      const gate = dynamicProfileGate("paid", "chat", { settings });
      expect(gate, "an unreadable ledger must refuse, never authorize spend").not.toBeNull();
      expect(gate?.message).toMatch(/spend ledger could not be read/);
      expect(gate?.message, "the cap is not what is wrong here").not.toMatch(/is used up/);
      expect(gate?.message).not.toMatch(/resumes tomorrow/);
    } finally {
      if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
    }
  });

  it("P6b-fix2 S-6: a MALFORMED free_models (a YAML scalar) refuses by name instead of throwing", () => {
    // `(profile?.free_models ?? []).filter(...)` — a scalar is neither null nor
    // undefined, so `??` does not fire and `.filter` is not a function. The one
    // function documented as "may never throw" threw, uncaught: index.ts has no
    // try/catch around the gate.
    const settings = {
      allow_paid_models: false,
      profiles: { free: { mode: "remote", api: "openrouter-remote", free_only: true, free_models: "oops-a-scalar" } },
    } as never;
    let gate: ReturnType<typeof dynamicProfileGate> = null;
    expect(() => {
      gate = dynamicProfileGate("free", "chat", { settings });
    }).not.toThrow();
    expect(gate).not.toBeNull();
    expect(gate!.message).toContain("free_models");
    expect(gate!.message).toMatch(/is not a list/);
  });

  it("P6b-fix2 S-6: a malformed paid_models refuses by name too", () => {
    const settings = {
      allow_paid_models: true,
      profiles: { paid: { mode: "remote", api: "openrouter-remote", model: "vendor/real", paid_models: 42 } },
    } as never;
    const gate = dynamicProfileGate("paid", "chat", { settings });
    expect(gate).not.toBeNull();
    expect(gate?.message).toContain("paid_models");
  });

  it("P6b-fix2 S-3: under LLM_EXT_DISABLE_AUTO_RECONCILE=1 the refusal names the opt-out and the populate command, never a running benchmark", () => {
    const settings = {
      allow_paid_models: true,
      paid_benchmark_daily_cap_usd: 0.5,
      profiles: { paid: { mode: "remote", api: "openrouter-remote", model: "placeholder/unpopulated-default-profile" } },
    } as never;
    // Both texts, as the finding asks: with the opt-out OFF the user is told a
    // benchmark is running (true — the maintainer just spawned it); with it ON
    // that sentence is a promise the opt-out itself guarantees cannot be kept.
    const on = dynamicProfileGate("paid", "chat", { settings });
    expect(on?.message).toMatch(/being benchmarked now/);

    const prev = process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = "1";
    try {
      const off = dynamicProfileGate("paid", "chat", { settings });
      expect(off).not.toBeNull();
      expect(off?.message).not.toMatch(/being benchmarked now/);
      expect(off?.message).toContain("LLM_EXT_DISABLE_AUTO_RECONCILE=1");
      expect(off?.message).toContain("--populate-default-profile paid");
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
      else process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = prev;
    }
  });

  it("P6b-fix3 N-7: when the 6h sweep floor is what holds the benchmark back, the refusal says QUEUED with the next sweep time", async () => {
    // The maintainer's two spawn throttles are deliberately SILENT (a line on
    // every dispatch for hours is noise), so the gate asserted "is being
    // benchmarked now (typically ~15 minutes) — re-run this command when it
    // finishes" for up to six hours in which nothing was running at all.
    const { recordDynamicBenchmarkAt } = await import("./default-profiles-state.js");
    const t0 = 1_800_000_000_000;
    // A sweep that started long enough ago that the child cannot still be alive.
    const sweepAt = t0 - 5 * 60 * 60 * 1000;
    recordDynamicBenchmarkAt("paid", sweepAt);
    const { updateDynamicProfileRecord } = await import("./default-profiles-state.js");
    updateDynamicProfileRecord("paid", (prev) => ({
      lastBenchmarkAt: prev?.lastBenchmarkAt ?? 0,
      poolFingerprint: prev?.poolFingerprint ?? "",
      modelIds: prev?.modelIds ?? [],
      failCount: prev?.failCount ?? 0,
      lastMaintainedAt: sweepAt,
    }));
    const settings = {
      allow_paid_models: true,
      paid_benchmark_daily_cap_usd: 0.5,
      profiles: { paid: { mode: "remote", api: "openrouter-remote", model: "placeholder/unpopulated-default-profile" } },
    } as never;
    const gate = dynamicProfileGate("paid", "chat", { settings, nowMs: t0 });
    expect(gate).not.toBeNull();
    expect(gate?.message).not.toMatch(/is being benchmarked now/);
    expect(gate?.message).toContain("QUEUED");
    // The one actionable fact: WHEN to come back. 6h after the sweep started.
    expect(gate?.message).toContain(new Date(sweepAt + MIN_SWEEP_INTERVAL_MS).toISOString());

    // Control: with NO recorded sweep the old sentence is the true one and must
    // still be produced — this must not become "always queued".
    const fresh = mkdtempSync(join(tmpdir(), "llmext-n7-fresh-"));
    const prevCfg = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = fresh;
    try {
      const running = dynamicProfileGate("paid", "chat", { settings, nowMs: t0 });
      expect(running?.message).toMatch(/is being benchmarked now/);
    } finally {
      if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("P6b-fix B1 last-line guard: a free_only profile's INERT placeholder `model` is not mistaken for a live chain entry", () => {
    // resolveProfile overrides `model` from free_models[0] on a free_only
    // profile, so the stub's leftover placeholder there is never sent. A guard
    // that read `model` flatly would refuse every healthy `free` profile.
    const settings = {
      allow_paid_models: false,
      profiles: {
        free: {
          mode: "remote",
          api: "openrouter-remote",
          free_only: true,
          free_models: ["a/one:free"],
          model: "placeholder/unpopulated-default-profile",
        },
      },
    } as never;
    expect(dynamicProfileGate("free", "chat", { settings })).toBeNull();
  });
});

describe("3c (review of 51a100c): the patch is on disk BEFORE the candidate is enqueued", () => {
  it("D5 shape: by the time enqueueCandidates(free, ...) runs, settings.yaml already carries the pool the candidates were decided against", async () => {
    // Was: the b.ai providers[] route had to precede the routed id's enqueue
    // (the old pruneUnroutedFreeCandidates would drop an un-routed non-':free'
    // id). D5 queues only ':free' ids and writes no route, so the pinned
    // ordering property survives with its observable narrowed: the enqueue
    // call's settingsAtCallTime snapshot must ALREADY contain the written
    // free_models — never a snapshot from before the patch landed.
    const prevKey = process.env.BAI_API_KEY;
    const prevOrKey = process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    try {
      writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      // D3c-1b: the strict gate only SERVES ids with a recorded benchmark
      // pass — seed one so the pool is written and the id queued.
      seedBenchmarkPass(["vendor/qualified:free"]);
      await maintainDynamicProfiles({
        fetchCatalog: async () => [
          { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
        ],
        log: noop,
      });
    } finally {
      if (prevKey === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevKey;
      if (prevOrKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOrKey;
    }

    const freeCall = enqueueCandidatesCalls.find((c) => c.profile === "free" && c.ids.includes("vendor/qualified:free"));
    expect(freeCall).toBeDefined();
    // The id is IN the disk content at the moment of enqueue — never a
    // snapshot from before the write. A violation of this ordering (enqueue
    // before the patch lands) is what any downstream reader of the section
    // at enqueue time would see stale.
    expect(freeCall?.settingsAtCallTime).toMatch(/free_models:/);
    expect(freeCall?.settingsAtCallTime).toMatch(/vendor\/qualified:free/);
  });
});

describe("row 80: paid arm order with a non-empty free_models slot", () => {
  // Row 80: `paid`'s isUnpopulated check (isPlaceholderProfile) keys on
  // `profile.model === PLACEHOLDER_MODEL_ID` for any non-free_only profile,
  // ignoring free_models entirely — so a placeholder `model` alongside a
  // b.ai `free_models` slot (however it got there) must still take the
  // population-state branch (spend/budget explanation) and never fall
  // through to the LAST-LINE placeholder-sentinel guard below it. Verified
  // green on HEAD (isPlaceholderProfile never looks at free_models for a
  // non-free_only profile) -- pinned here as a permanent regression test so
  // a future change to that predicate can't silently swap the message.
  it("paid, placeholder model, non-empty free_models -> names the population state, never the sentinel id", () => {
    const settings = {
      allow_paid_models: true,
      paid_benchmark_daily_cap_usd: 0.5,
      profiles: {
        paid: {
          mode: "remote",
          api: "openrouter-remote",
          model: "placeholder/unpopulated-default-profile",
          free_models: ["z-ai/glm-5.2:free"],
        },
      },
    } as never;
    const gate = dynamicProfileGate("paid", "chat", { settings });
    expect(gate).not.toBeNull();
    expect(gate?.message).toMatch(/being benchmarked now/);
    expect(gate?.message).not.toContain("placeholder/unpopulated-default-profile");
  });
});

// D2: the update a command requests runs this maintainer in a detached child
// (profile-detector.ts) holding ONE profile's lock, with forceSweep.
describe("D2 — a requested update: heldLockProfile + forceSweep", () => {
  const PAID_SETTINGS = [
    "active: paid",
    "allow_paid_models: true",
    "profiles:",
    ...FREE_PLACEHOLDER,
    "  paid:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    model: placeholder/unpopulated-default-profile",
    "    api_key: $OPENROUTER_API_KEY",
    "",
  ].join("\n");

  it("forceSweep re-benchmarks inside the 6 h floor with nothing new queued, hands the held lock, and stamps lastMaintainedAt every time", async () => {
    await withProviderKeys(async () => {
      writeSettings(PAID_SETTINGS);
      const t0 = 1_800_000_000_000;
      const run = (nowMs: number, requested: boolean) =>
        maintainDynamicProfiles({
          fetchCatalog: async () => [paidModel("vendor/a")],
            nowMs,
          log: noop,
          ...(requested ? { heldLockProfile: "paid" as const, forceSweep: true } : {}),
        });
      await run(t0, false);
      expect(spawnCallsFor("paid")).toBe(1);
      clearCandidates("paid", ["vendor/a"]);

      // CE9B7S8N: an hour later the t0 spawn still books NOTHING (the mock
      // never completes), so the completion-keyed floor is INACTIVE and a
      // normal pass respawns the re-queued arrival — the exact behavior the
      // spawn-time stamp used to suppress for 6 h. A requested pass must
      // still work and still hand the lock.
      clearCandidates("paid", ["vendor/a"]);
      await run(t0 + 3_600_000, false);
      expect(spawnCallsFor("paid")).toBe(2);
      await run(t0 + 3_600_000, true);
      expect(spawnCallsFor("paid")).toBe(3);
      const handed = populateDefaultProfileMock.mock.calls.at(-1)?.[0] as { alreadyHeldByCaller?: boolean };
      expect(handed.alreadyHeldByCaller, "the requested pass must HAND its lock to populate").toBe(true);
      expect(getDynamicProfileRecord("paid")?.lastMaintainedAt).toBe(t0 + 3_600_000);

      // Nothing moved since: a normal pass would skip the record write (N-5);
      // a requested one stamps it -- it is requestProfileUpdate's clock.
      await run(t0 + 3_700_000, true);
      expect(getDynamicProfileRecord("paid")?.lastMaintainedAt).toBe(t0 + 3_700_000);
    });
  });

  it("heldLockProfile maintains ONLY that profile (the other one's lock is not held)", async () => {
    await withProviderKeys(async () => {
      writeSettings(PAID_SETTINGS);
      await maintainDynamicProfiles({
        fetchCatalog: async () => [paidModel("vendor/a")],
        nowMs: 1_800_000_000_000,
        log: noop,
        heldLockProfile: "paid",
        forceSweep: true,
      });
      expect(getDynamicProfileRecord("paid")).toBeDefined();
      expect(getDynamicProfileRecord("free"), "the free profile must not be touched").toBeUndefined();
      expect(spawnCallsFor("free")).toBe(0);
    });
  });

  it("allow_paid_models: false still refuses a requested paid sweep", async () => {
    await withProviderKeys(async () => {
      writeSettings(PAID_SETTINGS.replace("allow_paid_models: true", "allow_paid_models: false"));
      await maintainDynamicProfiles({
        fetchCatalog: async () => [paidModel("vendor/a")],
        nowMs: 1_800_000_000_000,
        log: noop,
        heldLockProfile: "paid",
        forceSweep: true,
      });
      expect(spawnCallsFor("paid")).toBe(0);
    });
  });
});
