import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  poolFingerprint,
  decideDefaultProfilePopulation,
  ensureDefaultProfileReady,
  type CatalogPriceSnapshot,
  type CachedPriceMap,
} from "./default-profiles.js";
import type { Profile } from "./config.js";
import {
  readDefaultProfilesState,
  getProfileRecord,
  recordBenchmarkSuccess,
  recordBenchmarkFailure,
} from "./default-profiles-state.js";

// ── helpers ──────────────────────────────────────────────────────────────

function model(id: string, inp: number, out: number): CatalogPriceSnapshot {
  return { id, inputDollarsPerMillion: inp, outputDollarsPerMillion: out };
}

function ensembleProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    mode: "remote",
    api: "openrouter-remote",
    model: "a/one",
    second_model: "a/two",
    third_model: "a/three",
    ...overrides,
  };
}

function placeholderProfile(): Profile {
  return {
    mode: "remote",
    api: "openrouter-remote",
    model: "placeholder/unpopulated-default-profile",
  };
}

/** Build a qualifying pool of N models: 3 configured (a/one, a/two, a/three)
 *  plus N-3 filler models that are NOT configured on the ensemble profile. */
function buildQualifyingPool(size: number): CatalogPriceSnapshot[] {
  const pool: CatalogPriceSnapshot[] = [
    model("a/one", 1, 2),
    model("a/two", 1, 2),
    model("a/three", 1, 2),
  ];
  for (let i = pool.length; i < size; i++) {
    pool.push(model(`filler/${i}`, 1, 2));
  }
  return pool;
}

// ── Unit A — poolFingerprint ────────────────────────────────────────────

describe("poolFingerprint", () => {
  it("fingerprints identical pools in different array order identically (anti-spend order-independence guard)", () => {
    const a = [model("x/1", 1, 2), model("x/2", 3, 4), model("x/3", 5, 6)];
    const b = [model("x/3", 5, 6), model("x/1", 1, 2), model("x/2", 3, 4)];
    expect(poolFingerprint(a)).toBe(poolFingerprint(b));
  });

  it("changes the fingerprint when one model's input price changes", () => {
    const base = [model("x/1", 1, 2), model("x/2", 3, 4)];
    const changed = [model("x/1", 1.5, 2), model("x/2", 3, 4)];
    expect(poolFingerprint(base)).not.toBe(poolFingerprint(changed));
  });

  it("changes the fingerprint when one model's output price changes", () => {
    const base = [model("x/1", 1, 2), model("x/2", 3, 4)];
    const changed = [model("x/1", 1, 2.5), model("x/2", 3, 4)];
    expect(poolFingerprint(base)).not.toBe(poolFingerprint(changed));
  });

  it("changes the fingerprint when a model is added or removed", () => {
    const base = [model("x/1", 1, 2), model("x/2", 3, 4)];
    const added = [...base, model("x/3", 5, 6)];
    const removed = [model("x/1", 1, 2)];
    expect(poolFingerprint(added)).not.toBe(poolFingerprint(base));
    expect(poolFingerprint(removed)).not.toBe(poolFingerprint(base));
  });

  it("has a stable fingerprint for the empty pool and does not throw", () => {
    expect(() => poolFingerprint([])).not.toThrow();
    expect(poolFingerprint([])).toBe(poolFingerprint([]));
  });
});

// ── Unit B — decideDefaultProfilePopulation ─────────────────────────────

describe("decideDefaultProfilePopulation", () => {
  it("THE THRASH REGRESSION: a populated 3-slot ensemble checked twice against an unchanged ~40-model qualifying pool stays up-to-date both times", () => {
    // The previous implementation asked "is any qualifying id not currently
    // configured?" — for a 3-of-40 selection that is permanently true (37
    // filler ids are never configured), so it re-benchmarked on EVERY check:
    // an unbounded billable loop on the paid profiles. The fingerprint
    // approach compares the pool only to its OWN previous self, so an
    // unchanged pool of 40 candidates around 3 fixed picks must report
    // up-to-date on both checks, not just the first.
    const profile = ensembleProfile();
    const pool = buildQualifyingPool(40);
    const fp = poolFingerprint(pool);
    const opts = { qualifyingPool: pool, lastPoolFingerprint: fp };

    const first = decideDefaultProfilePopulation(profile, [], opts);
    const second = decideDefaultProfilePopulation(profile, [], opts);

    expect(first).toEqual({ needsBenchmark: false, reason: "up-to-date" });
    expect(second).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });

  it("flags an unpopulated placeholder profile as needing a benchmark", () => {
    const decision = decideDefaultProfilePopulation(placeholderProfile(), []);
    expect(decision).toEqual({ needsBenchmark: true, reason: "unpopulated" });
  });

  it("treats an empty catalog with a populated profile as up-to-date (a cold/failed fetch must never authorize spend)", () => {
    const decision = decideDefaultProfilePopulation(ensembleProfile(), []);
    expect(decision).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });

  it("flags model-removed when a configured id is absent from a non-empty catalog", () => {
    const catalog = [model("a/one", 1, 2), model("a/three", 1, 2)]; // a/two missing
    const decision = decideDefaultProfilePopulation(ensembleProfile(), catalog);
    expect(decision).toEqual({ needsBenchmark: true, reason: "model-removed" });
  });

  it("flags model-price-increased when a configured id's live price exceeds the cached baseline, but not on a price drop", () => {
    const catalog = [model("a/one", 2, 2), model("a/two", 1, 2), model("a/three", 1, 2)];
    const cachedPrices: CachedPriceMap = new Map([
      ["a/one", { in: 1, out: 2 }],
      ["a/two", { in: 1, out: 2 }],
      ["a/three", { in: 1, out: 2 }],
    ]);
    const increased = decideDefaultProfilePopulation(ensembleProfile(), catalog, { cachedPrices });
    expect(increased).toEqual({ needsBenchmark: true, reason: "model-price-increased" });

    const droppedCatalog = [model("a/one", 0.5, 2), model("a/two", 1, 2), model("a/three", 1, 2)];
    const dropped = decideDefaultProfilePopulation(ensembleProfile(), droppedCatalog, { cachedPrices });
    expect(dropped).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });

  it("flags new-model-arrived when the qualifying pool's fingerprint differs from the banked one", () => {
    const oldPool = buildQualifyingPool(40);
    const newPool = [...oldPool, model("filler/new", 1, 2)];
    const decision = decideDefaultProfilePopulation(ensembleProfile(), [], {
      qualifyingPool: newPool,
      lastPoolFingerprint: poolFingerprint(oldPool),
    });
    expect(decision).toEqual({ needsBenchmark: true, reason: "new-model-arrived" });
  });

  it("does not fire the pool check when lastPoolFingerprint is undefined (never benchmarked with a recorded pool)", () => {
    const pool = buildQualifyingPool(40);
    const decision = decideDefaultProfilePopulation(ensembleProfile(), [], {
      qualifyingPool: pool,
      // lastPoolFingerprint intentionally omitted
    });
    expect(decision).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });

  it("flags model-unavailable-at-runtime only when the unavailable id is actually configured on this profile", () => {
    const profile = ensembleProfile();
    const configuredHit = decideDefaultProfilePopulation(profile, [], {
      runtimeUnavailableIds: ["a/two"],
    });
    expect(configuredHit).toEqual({
      needsBenchmark: true,
      reason: "model-unavailable-at-runtime",
    });

    const unrelated = decideDefaultProfilePopulation(profile, [], {
      runtimeUnavailableIds: ["someone/else"],
    });
    expect(unrelated).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });
});

// ── Unit C — ensureDefaultProfileReady ──────────────────────────────────

describe("ensureDefaultProfileReady", () => {
  function makeStubRunner() {
    let calls = 0;
    const runner = async (): Promise<void> => {
      calls += 1;
    };
    return { runner, callCount: () => calls };
  }

  it("throws naming the five valid default profile names when given a non-default profile name", async () => {
    const { runner } = makeStubRunner();
    await expect(
      ensureDefaultProfileReady("custom-profile", ensembleProfile(), [], "/tmp/settings.yaml", runner),
    ).rejects.toThrow(/free, free-ensemble, paid, paid-ensemble, paid-mass-scout/);
  });

  it("runs the runner exactly once and reports benchmarkRan when the decision needs a benchmark", async () => {
    const { runner, callCount } = makeStubRunner();
    const result = await ensureDefaultProfileReady(
      "paid-ensemble",
      placeholderProfile(),
      [],
      "/tmp/settings.yaml",
      runner,
    );
    expect(callCount()).toBe(1);
    expect(result.benchmarkRan).toBe(true);
    expect(result.decision.reason).toBe("unpopulated");
  });

  it("does not run the runner when the decision is up-to-date", async () => {
    const { runner, callCount } = makeStubRunner();
    const result = await ensureDefaultProfileReady(
      "paid-ensemble",
      ensembleProfile(),
      [],
      "/tmp/settings.yaml",
      runner,
    );
    expect(callCount()).toBe(0);
    expect(result.benchmarkRan).toBe(false);
    expect(result.decision.reason).toBe("up-to-date");
  });

  it("cooldown suppresses the ATTEMPT but the returned decision still reports the real staleness reason", async () => {
    const { runner, callCount } = makeStubRunner();
    const nowMs = 1_000_000;
    const result = await ensureDefaultProfileReady(
      "paid-ensemble",
      placeholderProfile(),
      [],
      "/tmp/settings.yaml",
      runner,
      { cooldownUntil: nowMs + 60_000, nowMs },
    );
    expect(callCount()).toBe(0);
    expect(result.benchmarkRan).toBe(false);
    // The diagnosis is not suppressed, only the attempt.
    expect(result.decision).toEqual({ needsBenchmark: true, reason: "unpopulated" });
  });

  it("runs the runner once the cooldown is in the past", async () => {
    const { runner, callCount } = makeStubRunner();
    const nowMs = 1_000_000;
    const result = await ensureDefaultProfileReady(
      "paid-ensemble",
      placeholderProfile(),
      [],
      "/tmp/settings.yaml",
      runner,
      { cooldownUntil: nowMs - 60_000, nowMs },
    );
    expect(callCount()).toBe(1);
    expect(result.benchmarkRan).toBe(true);
  });
});

// ── Unit D — state sidecar (default-profiles-state.ts) ──────────────────

describe("default-profiles-state sidecar", () => {
  let cfgDir: string;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    cfgDir = mkdtempSync(join("/tmp", "aps-default-profiles-state-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it("reading with no state file on disk returns the empty state without throwing and without creating a file", () => {
    const state = readDefaultProfilesState();
    expect(state).toEqual({ version: 1, profiles: {} });
  });

  it("reading corrupt JSON on disk yields the empty state without throwing (fail-open)", () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "default-profiles-state.json"), "{ not valid json", "utf-8");
    expect(() => readDefaultProfilesState()).not.toThrow();
    expect(readDefaultProfilesState()).toEqual({ version: 1, profiles: {} });
  });

  it("recordBenchmarkSuccess then getProfileRecord round-trips fingerprint + modelIds and clears failCount", () => {
    recordBenchmarkSuccess("paid-ensemble", "fp-abc123", ["a/one", "a/two"], 42);
    const record = getProfileRecord("paid-ensemble");
    expect(record).toEqual({
      lastBenchmarkAt: 42,
      poolFingerprint: "fp-abc123",
      modelIds: ["a/one", "a/two"],
      failCount: 0,
      cooldownUntil: 0,
    });
  });

  it("writing one profile's record leaves the other profiles' records untouched", () => {
    recordBenchmarkSuccess("free", "fp-free", ["free/x"], 1);
    recordBenchmarkSuccess("paid-ensemble", "fp-ens", ["a/one"], 2);

    recordBenchmarkSuccess("paid-ensemble", "fp-ens-2", ["a/one", "a/two"], 3);

    expect(getProfileRecord("free")).toEqual({
      lastBenchmarkAt: 1,
      poolFingerprint: "fp-free",
      modelIds: ["free/x"],
      failCount: 0,
      cooldownUntil: 0,
    });
    expect(getProfileRecord("paid-ensemble")?.poolFingerprint).toBe("fp-ens-2");
  });

  it("recordBenchmarkFailure increments failCount, grows the cooldown backoff, and preserves the previous poolFingerprint", () => {
    recordBenchmarkSuccess("paid-mass-scout", "fp-original", ["m/1"], 0);

    recordBenchmarkFailure("paid-mass-scout", 1_000);
    const afterFirst = getProfileRecord("paid-mass-scout");
    expect(afterFirst?.failCount).toBe(1);
    expect(afterFirst?.poolFingerprint).toBe("fp-original");
    const firstCooldownDelta = (afterFirst?.cooldownUntil ?? 0) - 1_000;

    recordBenchmarkFailure("paid-mass-scout", 2_000);
    const afterSecond = getProfileRecord("paid-mass-scout");
    expect(afterSecond?.failCount).toBe(2);
    // Banking the new fingerprint here would mark the drift as "handled" and
    // the profile would never retry once the cooldown expired — the previous
    // fingerprint must survive a failed attempt.
    expect(afterSecond?.poolFingerprint).toBe("fp-original");
    const secondCooldownDelta = (afterSecond?.cooldownUntil ?? 0) - 2_000;

    expect(secondCooldownDelta).toBeGreaterThan(firstCooldownDelta);
  });

  // ── Unit E — round trip: state sidecar → decideDefaultProfilePopulation ──
  // The anti-thrash guarantee (see poolFingerprint's docstring) must survive
  // an ACTUAL disk round-trip, not merely an in-memory `opts` object — a bug
  // in the JSON (de)serialization of poolFingerprint would only surface here.

  it("a completed benchmark banked via recordBenchmarkSuccess reads back as up-to-date against the SAME pool", () => {
    const profile = ensembleProfile();
    const pool = buildQualifyingPool(40);

    recordBenchmarkSuccess("paid-ensemble", poolFingerprint(pool), ["a/one", "a/two", "a/three"], Date.now());
    const record = getProfileRecord("paid-ensemble");

    const decision = decideDefaultProfilePopulation(profile, [], {
      qualifyingPool: pool,
      lastPoolFingerprint: record?.poolFingerprint,
    });
    expect(decision).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });

  it("a pool that gained a qualifying model since the banked fingerprint reads back as new-model-arrived", () => {
    const profile = ensembleProfile();
    const oldPool = buildQualifyingPool(40);
    recordBenchmarkSuccess("paid-ensemble", poolFingerprint(oldPool), ["a/one", "a/two", "a/three"], Date.now());
    const record = getProfileRecord("paid-ensemble");

    const newPool = [...oldPool, model("filler/new-arrival", 1, 2)];
    const decision = decideDefaultProfilePopulation(profile, [], {
      qualifyingPool: newPool,
      lastPoolFingerprint: record?.poolFingerprint,
    });
    expect(decision).toEqual({ needsBenchmark: true, reason: "new-model-arrived" });
  });
});
