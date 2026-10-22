/**
 * profile-detector.ts — C2b's detached DETECTOR (TRDD-OE27RD7I §2).
 *
 * Real filesystem I/O against a per-test isolated config dir
 * (LLM_EXT_CONFIG_DIR), same discipline as dynamic-maintainer.test.ts. The
 * ONE seam stubbed is populateDefaultProfile (the UPDATER spawn) — a test can
 * never shell out to a real benchmark child. The catalog/b.ai fetchers are
 * declared DI parameters (`detectProfileChanges`'s own `opts`), never mocked.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "./test-tmp-root.js";
import { join } from "node:path";
import type { PopulationOutcome } from "./default-profiles-runner.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { populateDefaultProfileMock } = vi.hoisted(() => ({
  populateDefaultProfileMock: vi.fn(),
}));

vi.mock("./default-profiles-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./default-profiles-runner")>();
  return { ...actual, populateDefaultProfile: populateDefaultProfileMock };
});

// Spec item 3's atomicity proof needs to observe settingsPath's content AT
// THE INSTANT renameSync fires — vi.spyOn on node:fs's own namespace object
// is refused by Vitest ("Module namespace is not configurable in ESM"), so
// this goes through vi.mock instead: a transparent passthrough wrapper for
// EVERY renameSync call in this file (recorder only — the real rename always
// still runs), scoped to this one test file's own module graph.
const { renameSyncCalls } = vi.hoisted(() => ({
  renameSyncCalls: [] as Array<{ to: string; toContentBeforeRename: string | null }>,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      let toContentBeforeRename: string | null = null;
      try {
        toContentBeforeRename = actual.readFileSync(to, "utf-8");
      } catch {
        /* target doesn't exist yet — a legitimate first write */
      }
      renameSyncCalls.push({ to: String(to), toContentBeforeRename });
      return actual.renameSync(from, to);
    },
  };
});

import { detectProfileChanges, claimDetectThrottle, MIN_DETECT_INTERVAL_MS } from "./profile-detector.js";
import { poolFingerprint } from "./default-profiles.js";
import { updateDynamicProfileRecord, getDynamicProfileRecord } from "./default-profiles-state.js";
import {
  requestProfileUpdate,
  backgroundUpdateLockPathFor,
  backgroundUpdateRequestPathFor,
  profileUpdateRequestPending,
  PROFILE_UPDATE_REQUESTED_ENV,
} from "./default-profiles-runner.js";
import { claimBenchLock, commitBenchLock, releaseBenchLock } from "./bench-lock.js";
import { writeDynamicProfileSection } from "./benchmark/pick.js";
import type { Profile } from "./config.js";
// maintainDynamicProfiles is the REAL maintainer's own public entry point —
// imported here (not re-derived) so the equivalence test below runs the
// ACTUAL maintainer, not this file's guess at what it would compute.
import { maintainDynamicProfiles, type RawCatalogModel } from "./dynamic-maintainer.js";

let cfgDir: string;
let prevCfgDir: string | undefined;
let settingsPath: string;

const FREE_PLACEHOLDER = [
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models: []",
  "    model: placeholder/unpopulated-default-profile",
  "    api_key: $OPENROUTER_API_KEY",
];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  cfgDir = mkdtempSync(join(tmpdir(), "llmext-profdetect-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  settingsPath = join(cfgDir, "settings.yaml");
  populateDefaultProfileMock.mockReset();
  renameSyncCalls.length = 0;
  populateDefaultProfileMock.mockImplementation(
    (opts: { profile: string }): PopulationOutcome => ({
      kind: "spawned",
      profile: opts.profile as PopulationOutcome extends { profile: infer P } ? P : never,
      pid: 4242,
      blocksCaller: false,
      logPath: join(cfgDir, `default-profile-${opts.profile}.log`),
    }),
  );
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfgDir, { recursive: true, force: true });
});

function writeSettings(yaml: string): void {
  writeFileSync(settingsPath, yaml, "utf-8");
}

function paidModelCatalog(id: string): RawCatalogModel {
  return { id, pricing: { prompt: "0.0000003", completion: "0.0000005" }, context_length: 8000 };
}

// ── claimDetectThrottle ────────────────────────────────────────────────────

describe("claimDetectThrottle — the atomic claim BEFORE any spawn (review correction 1)", () => {
  it("the first claim in a window wins; a second claim in the SAME window (even a different profile call site) loses", () => {
    expect(claimDetectThrottle("free", 1_000)).toBe(true);
    expect(claimDetectThrottle("free", 1_050)).toBe(false);
    // 'paid' has its OWN throttle — one profile's claim must never block another's.
    expect(claimDetectThrottle("paid", 1_050)).toBe(true);
  });

  it("a claim outside the window succeeds again", () => {
    expect(claimDetectThrottle("free", 1_000)).toBe(true);
    expect(claimDetectThrottle("free", 1_000 + MIN_DETECT_INTERVAL_MS + 1)).toBe(true);
  });

  it("the clearing rule is pure AGE, so a crashed claimant (no unlink, no cleanup) reclaims exactly like a clean one (review follow-up: C2b-FOLLOWUP item 1)", () => {
    // Simulate: this call wins the claim, then the caller dies right after —
    // the spawned detector child crashes, or the parent process itself is
    // killed — before doing anything else. Nothing runs any cleanup/unlink
    // for this stamp; there is nothing TO clean up, because the throttle
    // never holds a lock or a live-pid reference across the spawn, only a
    // timestamp written once, inside the lock, before the spawn is even
    // attempted (see claimDetectThrottle's CLEARING RULE doc comment).
    expect(claimDetectThrottle("free", 3_000)).toBe(true);
    // "crash": no further calls, no cleanup, for this profile — until the
    // next real check, still throttled while inside the window.
    expect(claimDetectThrottle("free", 3_000 + MIN_DETECT_INTERVAL_MS - 1)).toBe(false);
    // Once the interval has fully elapsed, the very next claim succeeds with
    // no special crash-recovery step — age alone cleared it.
    expect(claimDetectThrottle("free", 3_000 + MIN_DETECT_INTERVAL_MS + 1)).toBe(true);
  });

  it("the boundary is exclusive: exactly MIN_DETECT_INTERVAL_MS since the prior claim already clears it (review round 2: the +1 tests above never exercised the exact edge)", () => {
    expect(claimDetectThrottle("free", 4_000)).toBe(true);
    // `nowMs - prev < MIN_DETECT_INTERVAL_MS` — at EXACTLY the interval this
    // is `false`, so the claim succeeds; an off-by-one flip to `<=` here
    // would make this assertion fail without moving any of the `+1`/`-1`
    // assertions elsewhere in this describe block.
    expect(claimDetectThrottle("free", 4_000 + MIN_DETECT_INTERVAL_MS)).toBe(true);
  });

  it("two 'simultaneous' claims (same nowMs, back to back) — exactly one wins, never both", () => {
    const nowMs = 5_000;
    const results = [claimDetectThrottle("free", nowMs), claimDetectThrottle("free", nowMs)];
    expect(results.filter(Boolean).length).toBe(1);
  });

  // Fix-queue row 95d: `nowMs` comes from the CALLER (Date.now() by default,
  // but every call site can pass its own), so a system clock that jumps
  // BACKWARDS (NTP correction, a manual clock set) must never let the
  // throttle re-open early — the guard is `nowMs - prev < MIN_DETECT_INTERVAL_MS`,
  // and a backwards jump makes that difference NEGATIVE, which is still
  // `< MIN_DETECT_INTERVAL_MS`, so the claim correctly stays blocked. This
  // pins that a backwards step only ever DELAYS the next successful claim
  // (by at most the size of the step) and can never BLOCK it forever.
  it("a clock that jumps backwards delays the next claim but never blocks it forever", () => {
    const t0 = 100_000;
    expect(claimDetectThrottle("free", t0)).toBe(true);
    // Clock jumps back an hour: still "inside the window" by the same
    // arithmetic (a negative delta is < MIN_DETECT_INTERVAL_MS), so this
    // must NOT succeed.
    expect(claimDetectThrottle("free", t0 - 3_600_000)).toBe(false);
    // Row 96(1): the failed backwards claim above must NOT have moved the
    // stored stamp — a claim measured relative to the (rejected) backwards
    // timestamp instead of the ORIGINAL t0 would already be far enough past
    // MIN_DETECT_INTERVAL_MS to wrongly succeed here. It must still be
    // refused, because the delay is measured from the ORIGINAL stamp t0.
    expect(claimDetectThrottle("free", t0 - 3_600_000 + MIN_DETECT_INTERVAL_MS + 1)).toBe(false);
    // Once real elapsed time (relative to the ORIGINAL claim, which the
    // backwards call above did not overwrite) passes the interval, the
    // claim succeeds again exactly as if the backwards jump never happened.
    expect(claimDetectThrottle("free", t0 + MIN_DETECT_INTERVAL_MS + 1)).toBe(true);
  });
});

// ── detectProfileChanges ────────────────────────────────────────────────────

describe("detectProfileChanges — fingerprint-only, never writes settings.yaml or the sidecar itself", () => {
  it("LLM_EXT_DISABLE_AUTO_RECONCILE=1 skips entirely — the fetcher is never called (same opt-out as the maintainer)", async () => {
    const prev = process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = "1";
    const fetchCatalog = vi.fn(async () => []);
    try {
      const result = await detectProfileChanges("free", { fetchCatalog, nowMs: 1000 });
      expect(result).toEqual({ changed: false, spawned: false, reason: "disabled" });
      expect(fetchCatalog).not.toHaveBeenCalled();
      expect(populateDefaultProfileMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
      else process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = prev;
    }
  });

  it("throttled: a second call within MIN_DETECT_INTERVAL_MS never re-fetches and never spawns", async () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    const fetchCatalog = vi.fn(async () => [] as RawCatalogModel[]);
    const first = await detectProfileChanges("free", { fetchCatalog, nowMs: 1000 });
    expect(first.reason).not.toBe("throttled");
    expect(fetchCatalog).toHaveBeenCalledTimes(1);

    const second = await detectProfileChanges("free", { fetchCatalog, nowMs: 1050 });
    expect(second).toEqual({ changed: false, spawned: false, reason: "throttled" });
    expect(fetchCatalog).toHaveBeenCalledTimes(1); // not called again
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });

  it("no fingerprint difference — no in-process read of the catalog beyond the compare, no spawn, no throttle-only reason", async () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    // classPool for 'free' with no ':free'-suffixed catalog entries is [] —
    // the same empty pool the maintainer would fingerprint from this exact
    // catalog. Seeding the record with that value in advance is how this test
    // gets to a genuine "unchanged" verdict without ever running the (mocked)
    // updater first.
    updateDynamicProfileRecord("free", () => ({
      lastBenchmarkAt: 0,
      poolFingerprint: poolFingerprint([]),
      modelIds: [],
      failCount: 0,
      modelSpecFingerprints: {},
    }));
    const result = await detectProfileChanges("free", {
      fetchCatalog: async () => [paidModelCatalog("vendor/not-free")], // non-':free' id: catalogFreeQualified stays []
            nowMs: 1000,
    });
    expect(result).toEqual({ changed: false, spawned: false });
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });

  it("a network-injected catalog change is detected and spawns the UPDATER (the existing populate path), for the correct profile", async () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    // Baseline the record against the OLD (empty) catalog view.
    updateDynamicProfileRecord("free", () => ({
      lastBenchmarkAt: 0,
      poolFingerprint: poolFingerprint([]),
      modelIds: [],
      failCount: 0,
      modelSpecFingerprints: {},
    }));
    // The live catalog now offers a genuine ':free' id — the world changed.
    const result = await detectProfileChanges("free", {
      fetchCatalog: async () => [
        { id: "vendor/new:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
      ],
            nowMs: 1000,
    });
    expect(result.changed).toBe(true);
    expect(result.spawned).toBe(true);
    expect(populateDefaultProfileMock).toHaveBeenCalledTimes(1);
    expect(populateDefaultProfileMock.mock.calls[0][0].profile).toBe("free");
  });

  it("fix-queue 53 follow-up (row 53 review, S1): a fingerprint banked WITH a resolvable OPENROUTER_API_KEY and re-checked WITHOUT one, same catalog, reports NO change -- classPool no longer varies with this process's own credential env", async () => {
    const prevOr = process.env.OPENROUTER_API_KEY;
    try {
      writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      const catalog: RawCatalogModel[] = [
        { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
      ];
      // Two maintainer passes WITH a resolvable OpenRouter key: the first
      // turns the unpopulated placeholder into a populated 'free' section
      // (its own sidecar write banks an EMPTY modelSpecFingerprints baseline
      // -- a documented one-pass lag, see the C2b comment on buildRecord in
      // dynamic-maintainer.ts -- unrelated to S1); the second pass reads the
      // now-populated section and banks the REAL per-model baseline, so the
      // record reaches the steady state a genuine live dispatch would only
      // reach on its second run.
      process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
      await maintainDynamicProfiles({
        fetchCatalog: async () => catalog,
                log: () => {},
      });
      await maintainDynamicProfiles({
        fetchCatalog: async () => catalog,
                log: () => {},
      });
      populateDefaultProfileMock.mockClear();

      // Pass 3: a detector run on the SAME catalog with NO OpenRouter key —
      // a different process's environment, same shared catalog fact. Before
      // S1 (048f3b0's `classPool` credential gate), classPool collapsed to
      // [] here regardless of the catalog, its fingerprint disagreed with
      // the one banked above, and the detector reported a spurious
      // 'changed' every time the two processes' environments differed.
      delete process.env.OPENROUTER_API_KEY;
      const result = await detectProfileChanges("free", {
        fetchCatalog: async () => catalog,
                nowMs: 1000,
      });
      expect(result.changed).toBe(false);
      expect(populateDefaultProfileMock).not.toHaveBeenCalled();
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
    }
  });

  it("no settings.yaml — no fetch, no spawn, no throw", async () => {
    const fetchCatalog = vi.fn(async () => []);
    const result = await detectProfileChanges("free", { fetchCatalog, nowMs: 1000 });
    expect(result).toEqual({ changed: false, spawned: false, reason: "no settings.yaml" });
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("a throwing fetcher never propagates — catalog-cache.ts's getCatalog fails OPEN (empty, cached) around it, so this reads as an ordinary 'nothing changed', never a throw", async () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    const result = await detectProfileChanges("free", {
      fetchCatalog: async () => {
        throw new Error("network unreachable, deliberately, for this test");
      },
            nowMs: 1000,
    });
    expect(result.changed).toBe(false);
    expect(result.spawned).toBe(false);
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });
});

// ── the UPDATER's write must be atomic (spec item 3) ────────────────────────

describe("the section write the UPDATER performs (writeDynamicProfileSection in pick.ts) is atomic", () => {
  it("settingsPath still holds the OLD content in full at the instant renameSync fires — the writer never truncates/appends into it directly", () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    const before = readFileSync(settingsPath, "utf-8");

    const patched: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: ["new/model:free"],
      model: "placeholder/unpopulated-default-profile",
      api_key: "$OPENROUTER_API_KEY",
    } as Profile;
    writeDynamicProfileSection(settingsPath, "free", () => patched, { notify: () => {} });

    const renameOfSettings = renameSyncCalls.find((c) => c.to === settingsPath);
    expect(renameOfSettings).toBeDefined();
    // A non-atomic writer (write-in-place) would already have mutated
    // settingsPath before its OWN rename call, or would not rename at all —
    // either way `toContentBeforeRename` would not still be the pristine OLD
    // content. This is exactly the window a concurrent reader (C2a's
    // synchronous retry) could land in.
    expect(renameOfSettings?.toContentBeforeRename).toBe(before);
    const after = readFileSync(settingsPath, "utf-8");
    expect(after).not.toBe(before);
    expect(after).toMatch(/new\/model:free/);
  });
});

// ── the detector's fingerprint must AGREE with the real maintainer's ───────

describe("detectRemoteProfileChange's fingerprint agrees with maintainOneDynamicProfile's own (review follow-up)", () => {
  it("after the REAL maintainer runs against a catalog and banks its fingerprint, the detector sees NO change against the identical catalog", async () => {
    writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
    const catalog: RawCatalogModel[] = [
      { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
    ];
    // Step 1: run the REAL maintainer TWICE against the identical catalog —
    // maintainOneDynamicProfile computes `modelSpecFingerprints` from
    // `current`'s OWN configured ids, read BEFORE this pass's own write, so
    // the FIRST pass (current === the placeholder, configured = []) banks an
    // EMPTY modelSpecFingerprints even though it just populated
    // `free_models`. Only the SECOND pass sees the now-populated `current`
    // and banks the real per-model baseline — i.e. two real dispatches is the
    // genuine steady state a detector running on a LATER dispatch would
    // compare against, not one. (An earlier version of this test called the
    // maintainer only once and got a false "changed" here — not a detector
    // bug, a test that hadn't reached steady state.)
    await maintainDynamicProfiles({
      fetchCatalog: async () => catalog,
            log: () => {},
    });
    await maintainDynamicProfiles({
      fetchCatalog: async () => catalog,
            log: () => {},
    });
    populateDefaultProfileMock.mockClear();

    // Step 2: the detector, against the IDENTICAL catalog, on a LATER
    // dispatch (current is now the maintainer's own populated section, not
    // the placeholder). If decideDynamicProfile's fingerprint ever grows a
    // dependency on `unusable`/`queued`/`record` (which the detector
    // deliberately passes empty/absent, per the source read in this file's
    // header comment), this is the test that would start failing — not a
    // self-consistency check, but a real maintainer-vs-detector agreement
    // check.
    const result = await detectProfileChanges("free", {
      fetchCatalog: async () => catalog,
            nowMs: 1000,
    });
    expect(result.changed).toBe(false);
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });

  it("fix-queue 53 follow-up (row 53 review, S1/S3 pin): with no usable credential at all, the maintainer writes nothing and the detector agrees -- no spurious 'changed' every pass", async () => {
    // Retained as a pin, not a demonstration of the (now-removed) classPool
    // credential gate: `openRouterCredentialUsable`/`baiCredentialUsable`
    // stay REQUIRED params (default-profiles.ts) so a caller can never
    // silently skip the credential question, but `classPool` itself (S1, row
    // 53 third review) no longer reads either flag -- it converges to a
    // stable pool fingerprint (built from the catalog listing alone) on
    // both sides regardless of credentials, so the detector never sees
    // drift and never triggers an updater. What this test still covers: the
    // maintainer's own WRITE decision (via `qualified`, gated separately)
    // stays credential-gated, so no credential still means no write.
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevBai = process.env.BAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.BAI_API_KEY;
    try {
      writeSettings(["active: free", "profiles:", ...FREE_PLACEHOLDER, ""].join("\n"));
      const catalog: RawCatalogModel[] = [
        { id: "vendor/qualified:free", pricing: { prompt: "0", completion: "0" }, context_length: 100_000 },
      ];
      const wrote1 = await maintainDynamicProfiles({
        fetchCatalog: async () => catalog,
                log: () => {},
      });
      const wrote2 = await maintainDynamicProfiles({
        fetchCatalog: async () => catalog,
                log: () => {},
      });
      expect(wrote1, "nothing can serve this pool -- the maintainer must not write it").toBe(false);
      expect(wrote2).toBe(false);
      populateDefaultProfileMock.mockClear();

      const result = await detectProfileChanges("free", {
        fetchCatalog: async () => catalog,
                nowMs: 1000,
      });
      expect(result.changed).toBe(false);
      expect(populateDefaultProfileMock).not.toHaveBeenCalled();
    } finally {
      if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevBai === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBai;
    }
  });

});

// ── D2: the update a command requested, run by the lock's holder ─────────────

describe("D2 — detectProfileChanges runs a REQUESTED update (env flag or a pending marker)", () => {
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

  let prevFlag: string | undefined;
  let prevOr: string | undefined;
  beforeEach(() => {
    prevFlag = process.env[PROFILE_UPDATE_REQUESTED_ENV];
    delete process.env[PROFILE_UPDATE_REQUESTED_ENV];
    prevOr = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[PROFILE_UPDATE_REQUESTED_ENV];
    else process.env[PROFILE_UPDATE_REQUESTED_ENV] = prevFlag;
    if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOr;
  });

  /** Stamp `profile`'s lock with THIS process's pid, as spawnDetachedBench's
   *  commitBenchLock does for a real detector child. */
  function holdLockAsThisProcess(profile: "free" | "paid" | "local"): string {
    const lockPath = backgroundUpdateLockPathFor(profile);
    expect(claimBenchLock(lockPath, Date.now(), () => {}).ok).toBe(true);
    commitBenchLock(lockPath, process.pid);
    return lockPath;
  }

  const handedPaidSpawns = () =>
    populateDefaultProfileMock.mock.calls.filter(
      (c) => (c[0] as { profile: string; alreadyHeldByCaller?: boolean }).profile === "paid" &&
        (c[0] as { alreadyHeldByCaller?: boolean }).alreadyHeldByCaller === true,
    ).length;

  it("the env flag: the maintainer pass for THAT profile only (no detect throttle, no fingerprint), then the re-benchmark handed this lock", async () => {
    writeSettings(PAID_SETTINGS);
    const lockPath = holdLockAsThisProcess("paid");
    try {
      process.env[PROFILE_UPDATE_REQUESTED_ENV] = "1";
      const nowMs = Date.now();
      // A plain detection would now be throttled -- a requested update is not.
      expect(claimDetectThrottle("paid", nowMs)).toBe(true);
      const result = await detectProfileChanges("paid", {
        nowMs,
        fetchCatalog: async () => [paidModelCatalog("vendor/a")],
              });
      expect(result.changed).toBe(true);
      expect(handedPaidSpawns()).toBe(1);
      expect(getDynamicProfileRecord("paid")?.lastMaintainedAt).toBe(nowMs);
      expect(getDynamicProfileRecord("free"), "only the profile whose lock is held").toBeUndefined();
    } finally {
      releaseBenchLock(lockPath);
    }
  });

  it("the env flag on `local`: the local rescan, handed this lock -- no maintainer pass", async () => {
    writeSettings(PAID_SETTINGS);
    const lockPath = holdLockAsThisProcess("local");
    try {
      process.env[PROFILE_UPDATE_REQUESTED_ENV] = "1";
      await detectProfileChanges("local", { nowMs: Date.now() });
      expect(populateDefaultProfileMock).toHaveBeenCalledTimes(1);
      expect(populateDefaultProfileMock.mock.calls[0][0]).toMatchObject({ profile: "local", alreadyHeldByCaller: true });
      expect(getDynamicProfileRecord("paid")).toBeUndefined();
    } finally {
      releaseBenchLock(lockPath);
    }
  });

  it("two commands: A's PLAIN detector holds the lock and finds no change, B's models all fail meanwhile -> exactly ONE requested update runs, before A releases the lock", async () => {
    writeSettings(PAID_SETTINGS);
    const lockPath = holdLockAsThisProcess("paid");
    try {
      let bState = "";
      let fetches = 0;
      // A's catalog fetch is where B arrives: B finds A's lock held, so it
      // starts nothing and leaves its request. Then the fetch fails, so A's
      // plain detection itself finds "no change".
      const fetchCatalog = async (): Promise<RawCatalogModel[]> => {
        fetches += 1;
        if (fetches === 1) bState = requestProfileUpdate({ profile: "paid", log: () => {} }).state;
        throw new Error("simulated catalog outage");
      };
      const a = await detectProfileChanges("paid", { nowMs: Date.now(), fetchCatalog });
      expect(bState, "B must have found the lock held").toBe("running");
      expect(a.changed, "A ran B's requested update").toBe(true);
      expect(handedPaidSpawns(), "exactly one requested update").toBe(1);
      expect(profileUpdateRequestPending("paid")).toBe(false);

      // A later plain detection has nothing left to honour.
      await detectProfileChanges("paid", { nowMs: Date.now(), fetchCatalog });
      expect(handedPaidSpawns()).toBe(1);
    } finally {
      releaseBenchLock(lockPath);
    }
  });

  it("a marker an update already served (it finished after the request) is dropped, never re-run", async () => {
    writeSettings(PAID_SETTINGS);
    const now = Date.now();
    updateDynamicProfileRecord("paid", () => ({
      lastBenchmarkAt: now - 1_000,
      poolFingerprint: "",
      modelIds: [],
      failCount: 0,
    }));
    writeFileSync(backgroundUpdateRequestPathFor("paid"), String(now - 60_000), "utf-8");
    await detectProfileChanges("paid", {
      nowMs: now,
      fetchCatalog: async () => {
        throw new Error("simulated catalog outage");
      },
          });
    expect(handedPaidSpawns()).toBe(0);
    expect(profileUpdateRequestPending("paid")).toBe(false);
  });
});
