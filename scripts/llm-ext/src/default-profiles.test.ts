import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  poolFingerprint,
  decideDefaultProfilePopulation,
  decideDynamicProfile,
  modelSpecFingerprint,
  type CatalogPriceSnapshot,
  type CachedPriceMap,
} from "./default-profiles.js";
import type { Profile } from "./config.js";
import {
  readDefaultProfilesState,
  getProfileRecord,
  recordBenchmarkSuccess,
  recordBenchmarkFailure,
  type DefaultProfileRecord,
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

// ── TRDD-RZSML8AC: per-tool context floors registry ──────────────────────
// The $0 patch consults TOOL_CONTEXT_FLOORS (src/tool-context-floors.ts)
// DIRECTLY — the old caller-injected `toolContextFloors` input is DELETED,
// so no caller argument can influence these outcomes. Polarity (the code's
// actual behavior): a tool head whose catalog contextLength is BELOW the
// tool's registered floor is DROPPED (refilled by an at-or-above-floor
// fallback, or removed when none qualifies); at-or-above is KEPT.
describe("decideDynamicProfile — per-tool context floors (TRDD-RZSML8AC)", () => {
  function paidToolProfile(toolModels: Record<string, string>): Profile {
    return {
      mode: "remote",
      api: "openrouter-remote",
      model: "a/one",
      second_model: "a/two",
      third_model: "a/three",
      paid_models: ["a/one", "a/two", "a/three"],
      tool_models: toolModels,
    };
  }

  it("drops a tool head below the tool's registered floor and refills with an at-or-above fallback — no caller argument exists", () => {
    const decision = decideDynamicProfile({
      name: "paid",
      current: paidToolProfile({ code_task: "a/small-ctx" }),
      // a/small-ctx: 8_000 < the registry's 128_000 floor for code_task.
      // The ranked pool (a/one..a/three) all sit at 200_000 >= the floor;
      // a/one is the first at-or-above candidate and becomes the refill.
      catalog: [
        { id: "a/one", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 200_000 },
        { id: "a/two", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 200_000 },
        { id: "a/three", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 200_000 },
        { id: "a/small-ctx", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 8_000 },
      ],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(),
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.tool_models?.code_task).toBe("a/one");
    expect(decision.patch?.tool_models?.code_task).not.toBe("a/small-ctx");
  });

  it("keeps a tool head AT the floor (boundary is <, not <=)", () => {
    // a/two absent from the catalog forces a non-null patch (model-removed),
    // so the KEEP of the at-floor head is observable in the written patch.
    const decision = decideDynamicProfile({
      name: "paid",
      current: paidToolProfile({ code_task: "a/exact-ctx" }),
      catalog: [
        { id: "a/one", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 200_000 },
        { id: "a/three", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 200_000 },
        { id: "a/exact-ctx", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 128_000 },
      ],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(),
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch).not.toBeNull();
    expect(decision.patch?.tool_models?.code_task).toBe("a/exact-ctx");
  });

  it("removes a below-floor head when no fallback qualifies (no refill, no under-floor substitution)", () => {
    const decision = decideDynamicProfile({
      name: "paid",
      current: paidToolProfile({ code_task: "a/small-ctx" }),
      // a/small-ctx is below floor; EVERY ranked-pool fallback candidate
      // (a/one..a/three at 8_000) is ALSO below floor — no candidate
      // qualifies, so the head is removed, not substituted under-floor.
      catalog: [
        { id: "a/one", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 8_000 },
        { id: "a/two", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 8_000 },
        { id: "a/three", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 8_000 },
        { id: "a/small-ctx", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 8_000 },
      ],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(),
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.tool_models).not.toHaveProperty("code_task");
  });
});

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
    recordBenchmarkSuccess("paid", "fp-abc123", ["a/one", "a/two"], 42);
    const record = getProfileRecord("paid");
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
    recordBenchmarkSuccess("paid", "fp-ens", ["a/one"], 2);

    recordBenchmarkSuccess("paid", "fp-ens-2", ["a/one", "a/two"], 3);

    expect(getProfileRecord("free")).toEqual({
      lastBenchmarkAt: 1,
      poolFingerprint: "fp-free",
      modelIds: ["free/x"],
      failCount: 0,
      cooldownUntil: 0,
    });
    expect(getProfileRecord("paid")?.poolFingerprint).toBe("fp-ens-2");
  });

  it("recordBenchmarkFailure increments failCount, grows the cooldown backoff, and preserves the previous poolFingerprint", () => {
    recordBenchmarkSuccess("paid", "fp-original", ["m/1"], 0);

    recordBenchmarkFailure("paid", 1_000);
    const afterFirst = getProfileRecord("paid");
    expect(afterFirst?.failCount).toBe(1);
    expect(afterFirst?.poolFingerprint).toBe("fp-original");
    const firstCooldownDelta = (afterFirst?.cooldownUntil ?? 0) - 1_000;

    recordBenchmarkFailure("paid", 2_000);
    const afterSecond = getProfileRecord("paid");
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

    recordBenchmarkSuccess("paid", poolFingerprint(pool), ["a/one", "a/two", "a/three"], Date.now());
    const record = getProfileRecord("paid");

    const decision = decideDefaultProfilePopulation(profile, [], {
      qualifyingPool: pool,
      lastPoolFingerprint: record?.poolFingerprint,
    });
    expect(decision).toEqual({ needsBenchmark: false, reason: "up-to-date" });
  });

  it("a pool that gained a qualifying model since the banked fingerprint reads back as new-model-arrived", () => {
    const profile = ensembleProfile();
    const oldPool = buildQualifyingPool(40);
    recordBenchmarkSuccess("paid", poolFingerprint(oldPool), ["a/one", "a/two", "a/three"], Date.now());
    const record = getProfileRecord("paid");

    const newPool = [...oldPool, model("filler/new-arrival", 1, 2)];
    const decision = decideDefaultProfilePopulation(profile, [], {
      qualifyingPool: newPool,
      lastPoolFingerprint: record?.poolFingerprint,
    });
    expect(decision).toEqual({ needsBenchmark: true, reason: "new-model-arrived" });
  });
});

describe("decideDynamicProfile", () => {
  function dynamicProfile(overrides: Partial<Profile> = {}): Profile {
    return {
      mode: "remote",
      api: "openrouter-remote",
      model: "a/dyn-default:free",
      free_only: true,
      free_models: ["a/one:free", "a/two:free"],
      ...overrides,
    };
  }

  function paidProfile(overrides: Partial<Profile> = {}): Profile {
    return {
      mode: "remote",
      api: "openrouter-remote",
      model: "a/one",
      second_model: "a/two",
      third_model: "a/three",
      paid_models: ["a/one", "a/two", "a/three"],
      ...overrides,
    };
  }

  // D5 (TRDD-90DM5YHO): the generated b.ai prepend + binding is GONE — the
  // b.ai route is the user's own providers group, seeded once by migration,
  // and its model rides a reserved slot. decideDynamicProfile's unpopulated
  // free arm handles ONLY the OpenRouter ':free' catalog ids now. The old
  // fix-queue 82/53/P6b-fix2 S-1/P6b-fix4 B1 tests pinned that deleted
  // mechanism and are replaced by these D5 pins.
  it("D5: the unpopulated free arm queues and serves ONLY ':free' catalog ids — no b.ai model anywhere", () => {
      const decision = decideDynamicProfile({
        name: "free",
        current: undefined,
        catalog: [],
        catalogFreeQualified: ["a/one:free"],
        benchmarkPassed: new Set(["a/one:free"]),
        unusable: new Set(),
        queued: new Set(),
        priceCeiling: 0,
        openRouterCredentialUsable: true,
      });
      expect(decision.candidates).toEqual(["a/one:free"]);
      expect(decision.patch?.free_models).toEqual(["a/one:free"]);
    });

    it("D5: a credential-less machine (no usable OpenRouter key) serves and queues nothing — the b.ai-only provisional pool is gone with the b.ai prepend", () => {
      const decision = decideDynamicProfile({
        name: "free",
        current: undefined,
        catalog: [],
        catalogFreeQualified: ["a/one:free"],
        benchmarkPassed: new Set(),
        unusable: new Set(),
        queued: new Set(),
        priceCeiling: 0,
        openRouterCredentialUsable: false,
      });
      expect(decision.patch?.free_models).toEqual([]);
      expect(decision.candidates).toEqual([]);
    });

    it("D5: D3c-1b strict gate still holds on the unpopulated arm — only recorded PASS ids are served", () => {
      const decision = decideDynamicProfile({
        name: "free",
        current: undefined,
        catalog: [],
        catalogFreeQualified: ["a/one:free", "a/two:free"],
        benchmarkPassed: new Set(["a/one:free"]),
        unusable: new Set(),
        queued: new Set(),
        priceCeiling: 0,
        openRouterCredentialUsable: true,
      });
      expect(decision.patch?.free_models).toEqual(["a/one:free"]);
      expect(decision.candidates).toEqual(["a/one:free", "a/two:free"]);
    });

  it("drops a configured id absent from the catalog and refills the slot from the remaining ranked pool", () => {
    const current = dynamicProfile({ free_models: ["a/one:free", "a/two:free", "a/three:free"] });
    const decision = decideDynamicProfile({
      name: "free",
      current,
      catalog: [model("a/one:free", 0, 0), model("a/three:free", 0, 0)], // a/two:free removed
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused by the populated arm (isDead-only liveness check)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.free_models).toEqual(["a/one:free", "a/three:free"]);
    expect(decision.reason).toBe("model-removed");
  });

  it("D5: a catalog-absent id served by a user group IS evicted from paid_models — the pool ranks only OpenRouter ids; a non-catalog model belongs in a reserved slot", () => {
    // D5's replacement for the old addendum-A pin ("keeps a route-served id
    // absent from the catalog"): the b.ai membership-eviction EXEMPTION is
    // gone along with the generated binding it exempted. paid_models is the
    // OpenRouter ranking; an id absent from the catalog is dead there no
    // matter what user group serves it. The user's own non-catalog model is
    // reserved via `ensemble.reserved` — which the maintainer never touches.
    const current = paidProfile({
      providers: [{ name: "bai", api: "chat-b-ai-remote", models: ["b-ai/served-model"] }],
      model: "a/two",
      second_model: "a/three",
      third_model: undefined,
      paid_models: ["a/two", "a/three", "b-ai/served-model"],
      ensemble: { reserved: [{ provider: "bai", model: "b-ai/served-model" }] },
    });
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/two", 1, 1)], // b-ai/served-model AND a/three both absent
      catalogFreeQualified: [],
      benchmarkPassed: new Set(),
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.paid_models).toEqual(["a/two"]);
    expect(decision.reason).toBe("model-removed");
  });

  it("never adopts a classifier-named arrival", () => {
    const current = dynamicProfile({ free_models: ["a/one:free"] });
    const decision = decideDynamicProfile({
      name: "free",
      current,
      catalog: [model("a/one:free", 0, 0)],
      catalogFreeQualified: ["a/one:free", "nvidia/nemotron-content-safety:free"],
      benchmarkPassed: new Set(), // D3c-1b: this test asserts `candidates` only (discovery, lenient)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.candidates).not.toContain("nvidia/nemotron-content-safety:free");
  });

  it("queues arrivals instead of writing them", () => {
    const current = dynamicProfile({ free_models: ["a/one:free"] });
    const decision = decideDynamicProfile({
      name: "free",
      current,
      catalog: [model("a/one:free", 0, 0), model("a/new:free", 0, 0)],
      catalogFreeQualified: ["a/one:free", "a/new:free"],
      benchmarkPassed: new Set(), // D3c-1b: this test asserts `candidates` only (discovery, lenient)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.candidates).toEqual(["a/new:free"]);
    expect(decision.patch?.free_models ?? []).not.toContain("a/new:free"); // never written
  });

  it("re-queues a spec-changed model (addendum I)", () => {
    const current = paidProfile({ paid_models: ["a/one"], model: "a/one", second_model: undefined, third_model: undefined });
    const record: DefaultProfileRecord = {
      lastBenchmarkAt: 0,
      poolFingerprint: "",
      modelIds: ["a/one"],
      failCount: 0,
      cooldownUntil: 0,
      modelSpecFingerprints: { "a/one": modelSpecFingerprint({ id: "a/one", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 8000 }, true) },
    };
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [{ id: "a/one", inputDollarsPerMillion: 1, outputDollarsPerMillion: 1, contextLength: 128000 }], // context grew
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      record,
      openRouterCredentialUsable: true,
    });
    expect(decision.candidates).toContain("a/one");
  });

  it("provisional free on an unpopulated profile, once both ids have a recorded pass (addendum J)", () => {
    // D3c-1b: addendum J's ORIGINAL claim ("an unpopulated free never blocks
    // -- serve provisionally from the catalog") is only true once the
    // candidates actually carry a recorded benchmark PASS -- see the three
    // tests below for what happens BEFORE that (the bug the card names).
    const decision = decideDynamicProfile({
      name: "free",
      current: undefined,
      catalog: [],
      catalogFreeQualified: ["a/one:free", "a/two:free"],
      benchmarkPassed: new Set(["a/one:free", "a/two:free"]),
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.free_models).toEqual(["a/one:free", "a/two:free"]);
    expect(decision.candidates).toEqual(expect.arrayContaining(["a/one:free", "a/two:free"]));
    expect(decision.reason).toBe("unpopulated");
  });

  it("D3c-1b (TRDD-FDI9NYAS): an unpopulated free profile with ONLY never-benchmarked catalog ids serves nothing, but still queues them as candidates", () => {
    // The open bug the card named: `decideDynamicProfile`'s unpopulated-free
    // arm used to write `catalogFreeQualified` straight into `free_models` on
    // a profile's very first population, with zero recorded benchmark
    // evidence -- the module's own "serve provisionally... while queueing
    // them all so the real benchmark still validates every one" comment was
    // only true of the QUEUE, never of what got SERVED.
    const decision = decideDynamicProfile({
      name: "free",
      current: undefined,
      catalog: [],
      catalogFreeQualified: ["a/one:free", "a/two:free"],
      benchmarkPassed: new Set(), // neither id has ever been benchmarked
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    // No provisional serve: `patch.free_models` is EMPTY (not `null` -- the
    // patch shape is built the same way regardless of pool content, matching
    // every other unpopulated-free case). It is validateProfile's own
    // "free_only requires a non-empty 'free_models' list" rule (config.ts)
    // that makes the maintainer refuse to WRITE this candidate at all
    // (dynamic-maintainer.ts's B1(2) invariant); and even were it written,
    // dynamicProfileGate reads the chain's actual (empty) length and returns
    // the SAME "retry later" refusal regardless. See default-profiles.ts's
    // own comment on this exact point.
    expect(decision.patch?.free_models).toEqual([]);
    // Discovery stays LENIENT: both never-benchmarked ids are still queued
    // for their first benchmark, or neither could ever earn a recorded pass.
    expect(decision.candidates).toEqual(expect.arrayContaining(["a/one:free", "a/two:free"]));
    expect(decision.candidates.length).toBe(2);
  });

  it("D3c-1b: an unpopulated free profile with ONE recorded-pass id among several candidates serves only that id", () => {
    const decision = decideDynamicProfile({
      name: "free",
      current: undefined,
      catalog: [],
      catalogFreeQualified: ["a/one:free", "a/two:free", "a/three:free"],
      benchmarkPassed: new Set(["a/two:free"]), // only a/two:free ever passed
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.free_models).toEqual(["a/two:free"]);
    // Discovery still queues every never-benchmarked id too, alongside the
    // already-passed one -- a recorded pass is not a reason to stop
    // re-verifying the id, and the others still need their own first pass.
    expect(decision.candidates).toEqual(
      expect.arrayContaining(["a/one:free", "a/two:free", "a/three:free"]),
    );
  });

  it("D3c-1b: an unpopulated PAID profile still serves nothing provisionally regardless of benchmarkPassed (regression guard)", () => {
    // The paid arm never had the free arm's bug in the first place -- an
    // unpopulated `paid` always returns `patch: null` (see the existing B1
    // test below), independent of any benchmark-pass evidence. This pins
    // that the D3c-1b param addition didn't change that.
    const decision = decideDynamicProfile({
      name: "paid",
      current: undefined,
      catalog: [model("a/one", 1, 1)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(["a/one"]), // even WITH a recorded pass
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch).toBeNull();
    expect(decision.candidates).toEqual(["a/one"]);
  });

  it("an unpopulated paid profile serves nothing provisionally, but QUEUES the under-ceiling class so the populator can run (P6b-fix B1)", () => {
    // The `patch: null` half is unchanged and is the money-safe half: no paid
    // model is ever written into the profile without a real benchmark first.
    //
    // The candidates half CHANGED, deliberately. It used to return `[]`, which
    // meant an unpopulated `paid` queued nothing, the populator was never
    // spawned, the section kept its unroutable placeholder id forever, and the
    // dispatch gate handed that sentinel to OpenRouter as a raw 404. Queuing is
    // not spending: every actual authorization (allow_paid_models, the §2.5
    // daily cap, the failure cooldown and the 6h sweep floor) gates the SPAWN,
    // in the maintainer — see dynamic-maintainer.test.ts's B1/S6 cases.
    const decision = decideDynamicProfile({
      name: "paid",
      current: undefined,
      catalog: [model("a/one", 1, 1)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm always patch:null unpopulated)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch).toBeNull();
    expect(decision.candidates).toEqual(["a/one"]);
  });

  it("an unpopulated paid profile applies the SAME arrivals filter as a populated one — unusable and already-queued ids are excluded (P6b-fix B1)", () => {
    const decision = decideDynamicProfile({
      name: "paid",
      current: undefined,
      catalog: [model("a/one", 1, 1), model("a/dead", 1, 1), model("a/queued", 1, 1), model("a/dear", 110, 110)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(["a/dead"]),
      queued: new Set(["a/queued"]),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    // a/dear is over the ceiling on EACH component (110 > 100 -- USER
    // 2026-09-18 "one ceiling, <=" gates each side, not the sum: a 90/90
    // model would now qualify since 90 <= 100 on both), a/dead is unusable,
    // a/queued is already waiting — queueing any of them would be a wasted
    // billable run.
    expect(decision.candidates).toEqual(["a/one"]);
  });

  it("a 403 suspect is queued for re-verify, not dropped", () => {
    const current = paidProfile({ model: "a/one", second_model: undefined, third_model: undefined, paid_models: ["a/one"] });
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/one", 1, 1)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(), // NOT unusable yet -- just a suspect
      queued: new Set(),
      priceCeiling: 100,
      suspects: new Set(["a/one"]),
      openRouterCredentialUsable: true,
    });
    // Nothing else changed and the suspect was NOT evicted, so the $0 patch
    // stays null — that null IS the "not dropped" proof (a real eviction
    // would have produced a non-null patch missing the id).
    expect(decision.patch).toBeNull();
    expect(decision.candidates).toContain("a/one"); // queued for re-verify
  });

  it("the old flip-flop model (in $0.50 / out $0.95, sum $1.45) is not evicted by the maintainer — USER 2026-09-18 'one ceiling, <=' gates each component, not the sum", () => {
    // Pre-fix: isDead's SUM gate would evict this model the very next dispatch
    // after the populate writer wrote it (0.5 + 0.95 = 1.45 > 1.3), even
    // though each component individually clears the ceiling — the "profile
    // section flip-flops between the two writers" defect the conformance
    // audit named (evidence 1a/1b vs 1c).
    const current = paidProfile({ model: "a/flip", second_model: undefined, third_model: undefined, paid_models: ["a/flip"] });
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/flip", 0.5, 0.95)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 1.3,
      openRouterCredentialUsable: true,
    });
    // The maintainer's own $0 patch (isDead) does not evict it -- patch stays
    // null, same "not dropped" proof the 403-suspect test above uses.
    expect(decision.patch).toBeNull();
  });

  it("the same flip-flop model is admitted by the populate writer's own candidate gate (paidQualified) when it is a NEW arrival", () => {
    const current = paidProfile({ model: "a/one", second_model: undefined, third_model: undefined, paid_models: ["a/one"] });
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/one", 1, 1), model("a/flip", 0.5, 0.95)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 1.3,
      openRouterCredentialUsable: true,
    });
    expect(decision.candidates).toContain("a/flip");
  });

  it("no paid arrivals when the pool fingerprint is unchanged (loop guard)", () => {
    const current = paidProfile({ model: "a/one", second_model: undefined, third_model: undefined, paid_models: ["a/one"] });
    const pool = [model("a/one", 1, 1), model("a/two", 1, 1)];
    const fp = poolFingerprint(pool);
    const record: DefaultProfileRecord = {
      lastBenchmarkAt: 0,
      poolFingerprint: fp,
      modelIds: ["a/one"],
      failCount: 0,
      cooldownUntil: 0,
    };
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: pool,
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      record,
      openRouterCredentialUsable: true,
    });
    expect(decision.candidates).not.toContain("a/two");
  });

  it("paid arrivals appear once the pool fingerprint changes", () => {
    const current = paidProfile({ model: "a/one", second_model: undefined, third_model: undefined, paid_models: ["a/one"] });
    const record: DefaultProfileRecord = {
      lastBenchmarkAt: 0,
      poolFingerprint: "stale-fingerprint",
      modelIds: ["a/one"],
      failCount: 0,
      cooldownUntil: 0,
    };
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/one", 1, 1), model("a/two", 1, 1)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      record,
      openRouterCredentialUsable: true,
    });
    expect(decision.candidates).toContain("a/two");
  });

  it("mass_scout and high_quality_scan are never set under free (addendum H)", () => {
    const current = dynamicProfile({
      free_models: ["a/one:free"],
      tool_models: { mass_scout: "a/one:free", high_quality_scan: "a/one:free", coding: "a/one:free" },
    });
    const decision = decideDynamicProfile({
      name: "free",
      current,
      catalog: [model("a/one:free", 0, 0)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (populated arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch?.tool_models?.mass_scout).toBeUndefined();
    expect(decision.patch?.tool_models?.high_quality_scan).toBeUndefined();
    expect(decision.patch?.tool_models?.coding).toBe("a/one:free");
  });

  it("nothing changed -> patch is null, reason is up-to-date", () => {
    const current = dynamicProfile({ free_models: ["a/one:free"] });
    const decision = decideDynamicProfile({
      name: "free",
      current,
      catalog: [model("a/one:free", 0, 0)],
      catalogFreeQualified: ["a/one:free"], // already configured, not an arrival
      benchmarkPassed: new Set(), // D3c-1b: unused (populated arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch).toBeNull();
    expect(decision.reason).toBe("up-to-date");
  });

  it("a stale leftover paid_models on a FREE profile never forces a permanent false-dirty patch (review fix)", () => {
    // A profile switched from paid to free might still carry an old
    // paid_models array nobody pruned. Before the fix, patchCandidate.paid_models
    // stayed undefined (free branch never sets it) while current.paid_models
    // was a non-empty array, so patchChanged was permanently true.
    const current = dynamicProfile({
      free_models: ["a/one:free"],
      paid_models: ["a/stale-leftover"],
    });
    const decision = decideDynamicProfile({
      name: "free",
      current,
      catalog: [model("a/one:free", 0, 0)],
      catalogFreeQualified: ["a/one:free"],
      benchmarkPassed: new Set(), // D3c-1b: unused (populated arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 0,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch).toBeNull();
    expect(decision.reason).toBe("up-to-date");
  });

  it("a stale leftover free_models on a PAID profile never forces a permanent false-dirty patch (review fix)", () => {
    const current = paidProfile({
      model: "a/one",
      second_model: "a/two",
      third_model: "a/three",
      paid_models: ["a/one", "a/two", "a/three"],
      free_models: ["b/stale-leftover:free"],
    });
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/one", 1, 1), model("a/two", 1, 1), model("a/three", 1, 1)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    expect(decision.patch).toBeNull();
    expect(decision.reason).toBe("up-to-date");
  });

  it("D5: a route-served local id is never assessed against the OpenRouter catalog (no membership eviction of any kind)", () => {
    // D5 deleted the b.ai-membership eviction entirely. What remains pinned
    // here: a local-preset binding's model (no '/') falls through the
    // bare-id fail-open path and is never declared dead by the catalog.
    const current = paidProfile({
      providers: [{ api: "local-ollama", models: ["local-model"] }],
      model: "local-model",
      second_model: "a/two",
      third_model: "a/three",
      paid_models: ["local-model", "a/two", "a/three"],
    });
    const decision = decideDynamicProfile({
      name: "paid",
      current,
      catalog: [model("a/two", 1, 1), model("a/three", 1, 1)],
      catalogFreeQualified: [],
      benchmarkPassed: new Set(), // D3c-1b: unused (paid arm)
      unusable: new Set(),
      queued: new Set(),
      priceCeiling: 100,
      openRouterCredentialUsable: true,
    });
    // local-model has no '/' -> never assessable -> never dead.
    expect(decision.patch).toBeNull();
  });
});
