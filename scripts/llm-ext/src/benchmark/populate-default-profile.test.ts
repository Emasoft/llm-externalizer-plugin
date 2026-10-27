// `--populate-default-profile NAME` — populates exactly ONE named machine-managed
// dynamic profile ('free' | 'paid'), unlike --update-all (which writes whatever the
// effective profile
// happens to be, plus every registered tool).
//
// Hermetic: no network, no real LLM calls, no spend. The OpenRouter catalog and the
// keyword sweep are both injected via PopulateDefaultProfileDeps (same seam shape as
// update-all.ts's UpdateAllDeps) — production wiring (fetchProgrammingModels /
// runKeywordSweep) is never exercised here. settings.yaml is a REAL file in a tmp dir,
// written by the REAL atomic writers, so a broken write is a failing test here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parse as yamlParse } from "yaml";

import { runPopulateDefaultProfilePhase, runKeywordSweep, type PopulateDefaultProfileDeps, type SweepOutcome } from "./index.js";
import { parseArgs, type CliOptions } from "./cli-args.js";
import type { CachedResult } from "./pick.js";
import type { OpenRouterModel } from "./discover.js";
import { withPaidBenchmarksAllowed } from "./discover.js";
import { SpendLedger, makeBudgetedGlobalFetch, type PriceLookup } from "./budget.js";
import { bookDailySpend, dailySpendPath } from "./daily-spend.js";
// P6b-fix3 N-9: resolveProfile/validateSettings are how "is the b.ai pin still in
// the SERVING chain, and does the file still load?" is asserted — the two
// questions the old shape answered wrongly and silently.
import { getSettingsPath, setAllowPaidModels, setActiveFreeOnly, resolveProfile, validateSettings, validateProfile, type Profile } from "../config.js";
import { getProfileRecord, getDynamicProfileRecord } from "../default-profiles-state.js";
import { enqueueCandidates } from "../dynamic-candidates.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A catalog entry that clears DEFAULT_CRITERIA (128K ctx / 64K out / structured +
 *  reasoning) at the given $/M price. */
function model(id: string, inPerM: number, outPerM: number): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: 256_000,
    top_provider: { max_completion_tokens: 128_000 },
    pricing: { prompt: String(inPerM / 1_000_000), completion: String(outPerM / 1_000_000) },
    supported_parameters: ["structured_outputs", "reasoning"],
  } as unknown as OpenRouterModel;
}

/** A sweep row for the given model — `ok`/`pass`/`schemaCompliant` all true by
 *  default so callers only need to override what the test actually varies. */
function result(over: Partial<CachedResult> & { modelId: string }): CachedResult {
  return {
    name: over.modelId,
    isBaseline: false,
    contextTokens: 256_000,
    maxOutputTokens: 128_000,
    inputDollarsPerMillion: 0.1,
    outputDollarsPerMillion: 0.1,
    supportsStructured: true,
    supportsReasoning: true,
    ok: true,
    pass: true,
    schemaCompliant: true,
    meanF1: 0.99,
    latencyMs: 500,
    actualCost: 0.001,
    ...over,
  };
}

const SETTINGS = [
  "profiles:",
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    free_only: true",
  "    free_models: []",
  "    model: placeholder/unpopulated-default-profile",
  "  paid:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: placeholder/unpopulated-default-profile",
  "",
].join("\n");

/** D0 (TRDD-AL8GIZYA): the custom-ceiling tests below write straight to
 *  settings.yaml, so they need to write it where getEnsemblePriceCeiling now
 *  reads it (`profiles.paid.selection`), not the retired top-level key. */
function settingsWithPaidCeiling(ceiling: number): string {
  return [
    "profiles:",
    "  free:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    api_key: $OPENROUTER_API_KEY",
    "    free_only: true",
    "    free_models: []",
    "    model: placeholder/unpopulated-default-profile",
    "  paid:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    api_key: $OPENROUTER_API_KEY",
    "    model: placeholder/unpopulated-default-profile",
    "    selection:",
    `      price_ceiling_usd_per_million: ${ceiling}`,
    "",
  ].join("\n");
}

function baseOpts(): CliOptions {
  // parseArgs with no argv tokens gives every code default (budgetUsd, qualifyingTopN,
  // …) without re-deriving them by hand — the one spelling of "default CLI options".
  return parseArgs(["node", "benchmark.js"]);
}

interface WrittenProfile {
  free_models?: string[];
  paid_models?: string[];
  model?: string;
  second_model?: string;
  third_model?: string;
  /** P6b-fix3 N-9: the b.ai route written alongside a non-':free' pool entry. */
  providers?: { api: string; api_key?: string; models: string[] }[];
}
interface WrittenSettings {
  profiles: Record<string, WrittenProfile>;
}
function readSettings(path: string): WrittenSettings {
  return yamlParse(readFileSync(path, "utf-8")) as WrittenSettings;
}

describe("--populate-default-profile", () => {
  let cfg = "";
  let settingsPath = "";
  let prevCfgDir: string | undefined;
  let prevBaiKey: string | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "populate-default-profile-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    // P6b-fix3 N-9: the b.ai key is PINNED UNSET for every case in this describe.
    // The child's written shape now depends on it (the pin goes into
    // free_models[0] with its route, where a free_only profile actually reads
    // from), so an ambient BAI_API_KEY — exported in this project's login shells —
    // would make these assertions pass or fail by env leg rather than by
    // behaviour. The one case that is ABOUT the pin sets it explicitly.
    prevBaiKey = process.env.BAI_API_KEY;
    delete process.env.BAI_API_KEY;
    settingsPath = getSettingsPath();
    writeFileSync(settingsPath, SETTINGS, "utf-8");
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = prevBaiKey;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("--populate-default-profile free selects via passingFreePoolIds and writes the 'free' profile's free_models (it absorbed the retired free ensemble profile — P5)", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 0,
        baselines: 2,
        results: [
          result({ modelId: "v/alpha:free", meanF1: 0.99 }),
          result({ modelId: "v/beta:free", pass: false, meanF1: 0.2 }),
        ],
        reportPath: "",
        passers: 1,
        total: 2,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    expect(readSettings(settingsPath).profiles.free.free_models).toEqual(["v/alpha:free"]);
    // A completed benchmark banks the picks + a fingerprint of the pool that
    // produced them (default-profiles-state.ts), so a later drift check can
    // tell "unchanged" from "the world moved" without re-benchmarking.
    const record = getProfileRecord("free");
    expect(record?.modelIds).toEqual(["v/alpha:free"]);
    expect(record?.failCount).toBe(0);
    expect(typeof record?.poolFingerprint).toBe("string");
    expect(record?.poolFingerprint.length).toBeGreaterThan(0);
  });

  // fix-queue 95b/96(4): `local` has no catalog/sweep at all -- it is routed
  // to runPopulateLocalDefaultProfile BEFORE this shared phase would ever
  // touch fetchCatalog/runSweep (deps below throw if called, proving that).
  // It used to stamp only lastBenchmarkAt, leaving `settings status --profile
  // local` printing "not yet maintained" forever after a real populate,
  // because that command reads lastMaintainedAt, a different field.
  it("--populate-default-profile local stamps lastMaintainedAt (not just lastBenchmarkAt), never touching fetchCatalog/runSweep", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "local" as const };
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => {
        throw new Error("local must never fetch the OpenRouter catalog");
      },
      runSweep: async () => {
        throw new Error("local must never run a benchmark sweep");
      },
    };

    const before = Date.now();
    const r = await runPopulateDefaultProfilePhase(opts, deps);
    expect(r.ok).toBe(true);

    // `local` (and free/paid's own maintainer) bank into the DYNAMIC
    // profiles state (getDynamicProfileRecord) -- a SEPARATE store from the
    // one-off benchmark's own getProfileRecord used above; index.ts's
    // `settings status` reads THIS one via getDynamicProfileRecord.
    const record = getDynamicProfileRecord("local");
    expect(record?.lastMaintainedAt).toBeDefined();
    expect(record!.lastMaintainedAt!).toBeGreaterThanOrEqual(before);
    expect(record?.lastBenchmarkAt).toBeDefined();
    expect(record?.failCount).toBe(0);
  }, 30_000);

  it("D5: the child writes ONLY the benchmarked ':free' pool — no b.ai pin, no generated providers binding, whatever keys are set", async () => {
    // Replaces the deleted P6b-fix3 N-9 pin. D5 removed the child's b.ai
    // prepend + binding: the b.ai route is the user's own providers group,
    // seeded once by the bai-reserved-seed migration step, and its model
    // rides ensemble.reserved — never a generated key this sweep would
    // rewrite. The written pool is exactly the sweep's passing ':free' ids.
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    // The credential is pinned to a LITERAL: the assertion at the end is
    // "settings.yaml still VALIDATES", and validateProfile's Remote-auth rule
    // fails for an unset $OPENROUTER_API_KEY — which has nothing to do with
    // the shape under test and made the old case pass or fail by env leg.
    // Nothing here reaches the network (runSweep and fetchCatalog are injected).
    const prevOrKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    try {
      const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
      const deps: PopulateDefaultProfileDeps = {
        fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 0,
          baselines: 2,
          results: [
            result({ modelId: "v/alpha:free", meanF1: 0.99 }),
            result({ modelId: "v/beta:free", meanF1: 0.98 }),
          ],
          reportPath: "",
          passers: 2,
          total: 2,
        }),
      };

      const r = await runPopulateDefaultProfilePhase(opts, deps);
      expect(r.ok).toBe(true);

      const written = readSettings(settingsPath).profiles.free;
      expect(written.free_models).toEqual(["v/alpha:free", "v/beta:free"]);
      // No generated providers binding, no ensemble key: both are USER-OWNED
      // now, and this child never writes either.
      expect(written.providers).toBeUndefined();
      expect((written as Record<string, unknown>).ensemble).toBeUndefined();
      // The served head is the sweep's winner.
      const resolved = resolveProfile("free", written as never);
      expect(resolved.model, "the benchmarked winner must be the served head").toBe("v/alpha:free");
      expect(validateSettings(readSettings(settingsPath) as never).valid).toBe(true);
    } finally {
      if (prevOrKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOrKey;
    }
  });

  // TRDD-38QAM06E root cause 2 (P6d symptom): a MACHINE ALREADY CARRYING the
  // b.ai route-served id in `free_models` (written by a prior successful run,
  // or by default-profiles.ts's own provisional patch) fed that id straight
  // into `resolveFreePool` on the NEXT sweep — it is absent from the
  // OpenRouter catalog and lacks the ':free' suffix, so resolveFreePool
  // rejected it and the WHOLE populate call refused, even though the id is
  // provably $0 via its OWN `providers[]` route (ApiPreset.isFreeProvider).
  // Mixed pool (routed id + a real ':free' candidate), matching the Tests
  // §1 two-key fixture in the spec: the pure b.ai-only case (fix-queue 53)
  // hits a SEPARATE, still-open gate — see that test below.
  it("D5: a machine still carrying the old b.ai id in free_models sweep-cleans it — the written pool is only the sweep's passing ':free' ids", async () => {
    // Replaces the deleted TRDD-38QAM06E "route-aware guard" pin. That guard
    // existed to stop a route-served (non-':free') id from being priced
    // against the OpenRouter catalog; D5 removes the generated binding the id
    // came from, so the migration's bai-binding-to-reserved-slot step is what
    // such a machine hits first. If a stale non-':free' id is still in
    // free_models when this child runs, it is dropped from the written pool
    // like any other id the sweep did not measure — never re-pinned.
    const prevBaiKey2 = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      // Simulates the machine state the old guard protected: the b.ai
      // id already sits in free_models[0] with its recorded route, alongside
      // a real OpenRouter ':free' survivor.
      writeFileSync(
        settingsPath,
        [
          "profiles:",
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    free_only: true",
          "    free_models: [glm-5.3-flash, v/alpha:free]",
          "    model: glm-5.3-flash",
          "    providers:",
          "      - api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-5.3-flash]",
          "  paid:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    model: placeholder/unpopulated-default-profile",
          "",
        ].join("\n"),
        "utf-8",
      );

      const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
      const deps: PopulateDefaultProfileDeps = {
        // glm-5.3-flash deliberately absent — route-served, never OpenRouter-priced.
        fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 0,
          baselines: 1,
          results: [result({ modelId: "v/alpha:free", meanF1: 0.99 })],
          reportPath: "",
          passers: 1,
          total: 1,
        }),
      };

      const r = await runPopulateDefaultProfilePhase(opts, deps);

      // Before the fix: r.ok === false, "NOT priced at $0 by the live catalog"
      // (rejected=["glm-5.3-flash"]). The route-aware guard fixed that. Under
      // D5 the written pool is ONLY what the sweep measured: the stale b.ai
      // id is dropped, never re-pinned.
      expect(r.ok).toBe(true);
      const written = readSettings(settingsPath).profiles.free;
      expect(written.free_models).toEqual(["v/alpha:free"]);
      // The user's providers group (the route) survives untouched — user-owned.
      expect(written.providers).toEqual([
        { api: "chat-b-ai-remote", api_key: "$BAI_API_KEY", models: ["glm-5.3-flash"] },
      ]);
    } finally {
      if (prevBaiKey2 === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBaiKey2;
    }
  });

  // Fix-queue row 53 / spec Tests §3: a b.ai-ONLY machine (no OpenRouter ':free'
  // candidate at all — just the routed id) still refuses, one step further down
  // than root cause 2's guard. Excluding the route-served id from the $0 check
  // (this card's fix) leaves `catalogCandidateIds` empty, so `resolveFreePool`
  // returns no pool and the "nothing to benchmark" early return fires BEFORE the
  // existing b.ai-pin logic (further down, unconditional on `passing`) ever
  // runs — that pin logic was written assuming it only ever ADDS to an
  // OpenRouter-sourced pool, never that it might be the pool's ONLY member.
  // Making that case populate needs the "nothing to benchmark" / "no model
  // passed the sweep" early returns to also check `routeServedFreeIds`/
  // `baiKeySet`, which touches control flow beyond this card's root cause 2 —
  // left here as a RECORDED, explicitly-open gap (not silently missed) per the
  // spec's "documented as expected or fixed" acceptance clause.
  it("KNOWN GAP (fix-queue 53, NOT fixed by this card): a b.ai-only pool (no OpenRouter ':free' candidate at all) still refuses, at the 'nothing to benchmark' gate rather than the $0-price gate", async () => {
    const prevBaiKey3 = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      writeFileSync(
        settingsPath,
        [
          "profiles:",
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    free_only: true",
          "    free_models: [glm-5.3-flash]",
          "    model: glm-5.3-flash",
          "    providers:",
          "      - api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-5.3-flash]",
          "  paid:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    model: placeholder/unpopulated-default-profile",
          "",
        ].join("\n"),
        "utf-8",
      );
      const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
      const deps: PopulateDefaultProfileDeps = {
        fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 0,
          baselines: 0,
          results: [],
          reportPath: "",
          passers: 0,
          total: 0,
        }),
      };
      const r = await runPopulateDefaultProfilePhase(opts, deps);
      // Excluding the routed id from the $0 check (this card's fix) leaves
      // `catalogCandidateIds` empty when it was the ONLY candidate, so
      // resolveFreePool returns no pool and this early return fires BEFORE the
      // existing (unmodified) b.ai-pin logic — further down, unconditional on
      // `passing` — ever runs; that pin logic was written assuming it only ever
      // ADDS to an OpenRouter-sourced pool, never that it might be the pool's
      // ONLY member. Fixing this needs the "nothing to benchmark" / "no model
      // passed the sweep" early returns to also check `routeServedFreeIds`/
      // `baiKeySet`, which is control flow beyond this card's root cause 2 —
      // recorded here per the spec's "documented as expected or fixed" clause,
      // not silently missed.
      expect(r.ok).toBe(false);
      expect(r.summary).toContain("nothing to benchmark");
    } finally {
      if (prevBaiKey3 === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBaiKey3;
    }
  });

  // Adversarial-review follow-up on the KNOWN GAP above: does a routed id
  // arriving ONLY via the candidate queue (free_models EMPTY, not just
  // "only the routed id") hit the same gate? It does NOT — `configured`
  // falls back to the ~15-id FREE_POOL_SEED constant whenever free_models is
  // empty (pre-existing behaviour, unrelated to this card), so
  // `catalogCandidateIds` is never empty in this shape and the "nothing to
  // benchmark" gate never fires; it proceeds to the sweep and refuses one
  // gate LATER instead ("no model passed the sweep") because the injected
  // sweep here (deliberately) returns no results. This confirms the
  // queue-vs-configured distinction the review raised is NOT a second,
  // untested gap — `candidateIds` is `configured ∪ queued` built into ONE
  // list before the route filter runs either way — it is the SAME code path,
  // just reached via a different `configured` shape (empty vs. exactly the
  // routed id) that a real fresh-install machine would actually have.
  it("candidateIds is configured-union-queued: a routed id sourced ONLY from the queue (free_models empty, so FREE_POOL_SEED fills 'configured') still fails to populate — one gate later ('no model passed the sweep'), same underlying gap", async () => {
    const prevBaiKey4 = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      // `free_models: []` — the route is recorded on the profile (as a prior
      // maintainer pass would leave it) but the routed id itself is NOT in
      // `configured`, only in the queue.
      writeFileSync(
        settingsPath,
        [
          "profiles:",
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    free_only: true",
          "    free_models: []",
          "    providers:",
          "      - api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-5.3-flash]",
          "  paid:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    model: placeholder/unpopulated-default-profile",
          "",
        ].join("\n"),
        "utf-8",
      );
      enqueueCandidates("free", ["glm-5.3-flash"]);

      const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
      const deps: PopulateDefaultProfileDeps = {
        fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 0,
          baselines: 0,
          results: [],
          reportPath: "",
          passers: 0,
          total: 0,
        }),
      };
      const r = await runPopulateDefaultProfilePhase(opts, deps);
      expect(r.ok).toBe(false);
      // NOT "nothing to benchmark" — see the comment above the test: this
      // shape's `configured` is FREE_POOL_SEED (free_models empty), so the
      // sweep DOES run; it refuses one gate later because the injected sweep
      // returns no results.
      expect(r.summary).toContain("no ':free' model passed the sweep");
    } finally {
      if (prevBaiKey4 === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBaiKey4;
    }
  });

  it("--populate-default-profile paid selects via pickEnsembleByPriceCeiling and writes the 'paid' profile's slots (it absorbed the retired paid ensemble profile — P5)", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/a", 0.2, 0.2), model("v/b", 0.3, 0.3), model("v/c", 0.4, 0.4)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 3,
        baselines: 0,
        results: [
          result({ modelId: "v/a", meanF1: 0.99, inputDollarsPerMillion: 0.2, outputDollarsPerMillion: 0.2 }),
          result({ modelId: "v/b", meanF1: 0.98, inputDollarsPerMillion: 0.3, outputDollarsPerMillion: 0.3 }),
          result({ modelId: "v/c", meanF1: 0.97, inputDollarsPerMillion: 0.4, outputDollarsPerMillion: 0.4 }),
        ],
        reportPath: "",
        passers: 3,
        total: 3,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const written = readSettings(settingsPath).profiles.paid;
    expect(written.model).toBe("v/a");
    expect(written.second_model).toBe("v/b");
    expect(written.third_model).toBe("v/c");
    // The write is always banked under 'paid' now — the absorbed old name
    // (the retired paid ensemble name) no longer gets its own state record.
    const record = getProfileRecord("paid");
    expect(record?.modelIds).toEqual(["v/a", "v/b", "v/c"]);
    expect(record?.failCount).toBe(0);
  });

  it("--populate-default-profile paid selects via pickEnsembleByPriceCeiling and writes the 'paid' profile's slots + paid_models pool", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/a", 0.2, 0.2), model("v/b", 0.3, 0.3)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 2,
        baselines: 0,
        results: [
          result({ modelId: "v/a", meanF1: 0.99, inputDollarsPerMillion: 0.2, outputDollarsPerMillion: 0.2 }),
          result({ modelId: "v/b", meanF1: 0.98, inputDollarsPerMillion: 0.3, outputDollarsPerMillion: 0.3 }),
        ],
        reportPath: "",
        passers: 2,
        total: 2,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const written = readSettings(settingsPath).profiles.paid;
    expect(written.model).toBe("v/a");
    // Only 2 candidates exist, so the top-3 ensemble slots fill only what's there.
    expect(written.second_model).toBe("v/b");
    expect(written.third_model).toBeUndefined();
    expect(written.paid_models).toEqual(["v/a", "v/b"]);
    const record = getProfileRecord("paid");
    expect(record?.modelIds).toEqual(["v/a", "v/b"]);
    expect(record?.failCount).toBe(0);
  });

  it("TRDD-2GIA66AK: free sweep where exactly one ':free' model passes writes mode 'remote' and the section passes validateProfile", async () => {
    // Old code hardcoded mode "remote-ensemble", which validateProfile rejects
    // for a free_only pool of 1 member -> this test failed on it.
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-dummy";
    try {
      const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
      const deps: PopulateDefaultProfileDeps = {
        fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 0,
          baselines: 2,
          results: [
            result({ modelId: "v/alpha:free", meanF1: 0.99 }),
            result({ modelId: "v/beta:free", pass: false, meanF1: 0.2 }),
          ],
          reportPath: "",
          passers: 1,
          total: 2,
        }),
      };

      const r = await runPopulateDefaultProfilePhase(opts, deps);

      expect(r.ok).toBe(true);
      const written = readSettings(settingsPath).profiles.free;
      expect(written.free_models).toEqual(["v/alpha:free"]);
      expect((written as { mode?: string }).mode).toBe("remote");
      expect(validateProfile("free", written as unknown as Profile).errors).toEqual([]);
    } finally {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });

  it("TRDD-2GIA66AK: paid sweep yielding exactly one pick writes mode 'remote' and the section passes validateProfile", async () => {
    // Old code hardcoded mode "remote-ensemble" with no second_model, which
    // validateProfile rejects -> this test failed on it.
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-dummy";
    try {
      const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
      const deps: PopulateDefaultProfileDeps = {
        fetchCatalog: async () => [model("v/a", 0.2, 0.2)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 1,
          baselines: 0,
          results: [result({ modelId: "v/a", meanF1: 0.99, inputDollarsPerMillion: 0.2, outputDollarsPerMillion: 0.2 })],
          reportPath: "",
          passers: 1,
          total: 1,
        }),
      };

      const r = await runPopulateDefaultProfilePhase(opts, deps);

      expect(r.ok).toBe(true);
      const written = readSettings(settingsPath).profiles.paid;
      expect(written.model).toBe("v/a");
      expect(written.second_model).toBeUndefined();
      expect((written as { mode?: string }).mode).toBe("remote");
      expect(validateProfile("paid", written as unknown as Profile).errors).toEqual([]);
    } finally {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });
  it("--populate-default-profile paid selects via pickMassScoutModel and writes the 'paid' profile's tool_models.mass_scout (it absorbed the retired mass-scout profile — P5)", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/cheap", 0.05, 0.05)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 1,
        baselines: 0,
        results: [result({ modelId: "v/cheap", meanF1: 0.99, inputDollarsPerMillion: 0.05, outputDollarsPerMillion: 0.05 })],
        reportPath: "",
        passers: 1,
        total: 1,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const written = readSettings(settingsPath).profiles.paid as unknown as {
      model?: string;
      tool_models?: Record<string, string>;
    };
    expect(written.model).toBe("v/cheap");
    expect(written.tool_models?.mass_scout).toBe("v/cheap");
    expect(getProfileRecord("paid")?.modelIds).toEqual(["v/cheap"]);
  });

  // TRDD-FDI9NYAS D3c-2 (D2 report Item 9): a CERTAIN 402 is the key's credit,
  // not the model — the id must keep its paid_models seat and must NOT get a
  // fail verdict in the general-keyword ledger (the latest-wins ledger would
  // otherwise refuse it at send time until a re-benchmark that itself needs
  // credit).
  it("a certain-402 sweep row keeps the id's paid_models seat and records NO ledger verdict (D3c-2 Item 9)", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    // Pre-populate the paid section: v/x is the incumbent second entry.
    writeFileSync(
      settingsPath,
      [
        "profiles:",
        "  free:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    api_key: $OPENROUTER_API_KEY",
        "    free_only: true",
        "    free_models: []",
        "    model: placeholder/unpopulated-default-profile",
        "  paid:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    api_key: $OPENROUTER_API_KEY",
        "    model: v/incumbent",
        "    paid_models: [v/incumbent, v/x]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const catalog = [model("v/a", 0.2, 0.2), model("v/incumbent", 0.3, 0.3), model("v/x", 0.25, 0.25)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 3,
        baselines: 0,
        results: [
          result({ modelId: "v/a", meanF1: 0.99, inputDollarsPerMillion: 0.2, outputDollarsPerMillion: 0.2 }),
          result({ modelId: "v/incumbent", meanF1: 0.98, inputDollarsPerMillion: 0.3, outputDollarsPerMillion: 0.3 }),
          // The KEY ran out of credit mid-sweep: a certain 402 for the incumbent v/x.
          result({
            modelId: "v/x",
            ok: false,
            pass: false,
            httpStatus: 402,
            error: "HTTP 402: Insufficient credits",
          }),
        ],
        reportPath: "",
        passers: 2,
        total: 3,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const written = readSettings(settingsPath).profiles.paid;
    // v/x survives — after the freshly benchmarked pool, in its previous relative order.
    expect(written.paid_models).toEqual(["v/a", "v/incumbent", "v/x"]);
    // The unjudged id never heads the chain: model/second/third stay benchmark picks.
    expect(written.model).toBe("v/a");
    // NO verdict was recorded for the certain-402 row: the ledger has no entry
    // for v/x dated today (a fail entry would refuse it at send time).
    const ledgerPath = join(cfg, "general-keyword-results.json");
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as Record<string, unknown>;
    const today = new Date().toISOString().slice(0, 10);
    expect(ledger[`v/x::${today}`]).toBeUndefined();
    // The other rows still recorded their verdicts.
    expect(ledger[`v/a::${today}`]).toBeDefined();
  });

  it("an invalid --populate-default-profile name fails fast and names the three valid options", () => {
    expect(() => parseArgs(["node", "benchmark.js", "--populate-default-profile", "bogus"])).toThrow(
      /--populate-default-profile must be one of free, paid, local, got 'bogus'/,
    );
  });

  // D4 (D3c-2 review F1, TRDD-90DM5YHO): the certain-402 no-verdict skip is
  // PAID-scope only. On a FREE sweep a certain 402 means the model STOPPED
  // BEING FREE — a fact about the model, which the latest-wins ledger must
  // record, or a dead free model keeps its validated status and is served
  // until a send-time 402.
  it("a certain-402 sweep row on the FREE arm records a fail verdict (D4 scope fix)", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
    const catalog = [model("f/a:free", 0, 0), model("f/dead:free", 0, 0)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 2,
        baselines: 0,
        results: [
          result({ modelId: "f/a:free", meanF1: 0.9, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }),
          // "No longer free" is a certain 402 on the free arm — a fact about
          // the model, not the key.
          result({
            modelId: "f/dead:free",
            ok: false,
            pass: false,
            httpStatus: 402,
            error: "HTTP 402: Insufficient credits",
          }),
        ],
        reportPath: "",
        passers: 1,
        total: 2,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const ledgerPath = join(cfg, "general-keyword-results.json");
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as Record<string, unknown>;
    const today = new Date().toISOString().slice(0, 10);
    const dead = ledger[`f/dead:free::${today}`] as { ok: boolean; pass: boolean } | undefined;
    // THE BEHAVIOUR: the free arm records the fail verdict for the certain-402 row.
    expect(dead).toBeDefined();
    expect(dead?.ok).toBe(false);
    expect(dead?.pass).toBe(false);
    const live = ledger[`f/a:free::${today}`] as { ok: boolean } | undefined;
    expect(live?.ok).toBe(true);
  });

  it("the mass_scout head NEVER gets a ':free' id, even when a ':free' candidate has the best score", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/cheap", 0.05, 0.05)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 1,
        baselines: 1,
        // The ':free' row scores higher than the paid one — pickMassScoutModel must
        // exclude it from consideration entirely (never merely rank it second).
        results: [
          result({ modelId: "v/best:free", meanF1: 1.0, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }),
          result({ modelId: "v/cheap", meanF1: 0.9, inputDollarsPerMillion: 0.05, outputDollarsPerMillion: 0.05 }),
        ],
        reportPath: "",
        passers: 2,
        total: 2,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const written = readSettings(settingsPath).profiles.paid as unknown as { tool_models?: Record<string, string> };
    const massScout = written.tool_models?.mass_scout ?? "";
    expect(massScout.endsWith(":free")).toBe(false);
    expect(massScout).toBe("v/cheap");
  });

  it("paid honours a settings-provided price ceiling, not the 1.3 default", async () => {
    // 0.6/1M is well under the 1.3 built-in default but OVER a custom 0.5 ceiling.
    writeFileSync(settingsPath, settingsWithPaidCeiling(0.5), "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/under-ceiling", 0.3, 0.3), model("v/over-custom-ceiling", 0.6, 0.6)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 2,
        baselines: 0,
        results: [
          // Higher meanF1 but priced OVER the custom 0.5 ceiling — must be rejected.
          result({ modelId: "v/over-custom-ceiling", meanF1: 0.99, inputDollarsPerMillion: 0.6, outputDollarsPerMillion: 0.6 }),
          result({ modelId: "v/under-ceiling", meanF1: 0.9, inputDollarsPerMillion: 0.3, outputDollarsPerMillion: 0.3 }),
        ],
        reportPath: "",
        passers: 2,
        total: 2,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    const written = readSettings(settingsPath).profiles.paid;
    expect(written.model).toBe("v/under-ceiling");
    expect(written.second_model).toBeUndefined();
  });

  it("--dry-run writes nothing to settings.yaml and never calls the sweep", async () => {
    const before = readFileSync(settingsPath, "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const, dryRun: true };
    const runSweep = vi.fn(async (): Promise<SweepOutcome> => {
      throw new Error("runSweep must not be called under --dry-run");
    });
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => [model("v/a", 0.2, 0.2)],
      runSweep,
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(true);
    expect(runSweep).not.toHaveBeenCalled();
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    // --dry-run must persist NOTHING to the state sidecar either — it's a
    // preview, not an attempt.
    expect(getProfileRecord("paid")).toBeUndefined();
  });

  it("a paid name with a budget lower than the worst-case estimate aborts BEFORE any billable call and arms the failure cooldown", async () => {
    const before = readFileSync(settingsPath, "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const, budgetUsd: 0.0000001 };
    const runSweep = vi.fn(async (): Promise<SweepOutcome> => {
      throw new Error("runSweep must not be called once the pre-flight estimate exceeds the budget");
    });
    const deps: PopulateDefaultProfileDeps = {
      // Priced just under the DEFAULT_CRITERIA $1/M cap, so it clears the requirement
      // gate but its worst-case estimate is certain to exceed the near-zero budget.
      fetchCatalog: async () => [model("v/expensive", 0.99, 0.99)],
      runSweep,
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/WORST-CASE pre-flight estimate/);
    expect(runSweep).not.toHaveBeenCalled();
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    // Failure is always banked under 'paid' now (never the invoked legacy
    // name) — the same key success banks under, so cooldown/fingerprint
    // state never splits across two records for the same absorbed profile.
    const record = getProfileRecord("paid");
    expect(record?.failCount).toBe(1);
    expect(record?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("free: only zero-cost, non-':free'-suffixed candidates survive resolveFreePool — freeSuffixOnly leaves nothing, banks a benchmark failure", async () => {
    // FREE_POOL_SEED's own ids all carry ':free', so an empty catalog alone can't reach
    // this branch (the seed fallback would still contribute ids) — pin the profile's
    // OWN free_models to a $0 id lacking the ':free' suffix instead: resolveFreePool
    // accepts it (catalog proves $0), but the runtime-required ':free' chokepoint
    // (freeSuffixOnly) then drops it, leaving zero candidates to sweep.
    const settingsNoSuffix = SETTINGS.replace(
      "  free:\n    mode: remote\n    api: openrouter-remote\n    api_key: $OPENROUTER_API_KEY\n    free_only: true\n    free_models: []",
      '  free:\n    mode: remote\n    api: openrouter-remote\n    api_key: $OPENROUTER_API_KEY\n    free_only: true\n    free_models: ["v/zero-cost-no-suffix"]',
    );
    writeFileSync(settingsPath, settingsNoSuffix, "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => [model("v/zero-cost-no-suffix", 0, 0)],
      runSweep: vi.fn(async (): Promise<SweepOutcome> => {
        throw new Error("runSweep must not be called with zero candidates");
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(false);
    expect(getProfileRecord("free")?.failCount).toBe(1);
  });

  it("free: every candidate fails the sweep — banks a benchmark failure, 'free' left unchanged", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => [model("v/paid", 0.5, 0.5)],
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 0,
        baselines: 1,
        results: [result({ modelId: "v/alpha:free", pass: false, meanF1: 0.1 })],
        reportPath: "",
        passers: 0,
        total: 1,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(false);
    expect(getProfileRecord("free")?.failCount).toBe(1);
  });

  it("paid: no candidate clears the price ceiling — banks a benchmark failure, 'paid' left unchanged", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/pricey", 2, 2)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 1,
        baselines: 0,
        results: [result({ modelId: "v/pricey", meanF1: 0.99, inputDollarsPerMillion: 2, outputDollarsPerMillion: 2 })],
        reportPath: "",
        passers: 1,
        total: 1,
      }),
    };

    // Nothing clears DEFAULT_CRITERIA's $1/M cap, so the requirement gate itself empties
    // the candidate roster before the sweep even runs — same failure surface as
    // "no candidate model met the requirement gate".
    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(false);
    expect(getProfileRecord("paid")?.failCount).toBe(1);
  });

  it("paid: a sweep survivor priced back over the CUSTOM ceiling at pick-time (live price rose since discovery) — banks a benchmark failure post-sweep", async () => {
    // USER 2026-09-18 "one ceiling, <=" (TRDD d3a-price-ceiling): the
    // requirement gate (discovery) and pickEnsembleByPriceCeiling both read
    // the SAME configurable ceiling now (no more hardcoded $1.00 discovery
    // cap that could pass a model the pick stage then rejected). So this test
    // no longer reaches "post-sweep" by pricing under the old $1.00 default
    // and over a custom ceiling -- it instead proves the pick-stage gate is
    // STILL an independent, final check: the catalog price at discovery time
    // (0.05/0.05) clears the custom 0.1 ceiling, but the model's live price
    // reported by the actual sweep run (0.5/0.5) has since risen above it, so
    // pickEnsembleByPriceCeiling — reading the sweep's OWN measured price —
    // still rejects it.
    writeFileSync(settingsPath, settingsWithPaidCeiling(0.1), "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/price-rose-since-discovery", 0.05, 0.05)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 1,
        baselines: 0,
        results: [
          result({
            modelId: "v/price-rose-since-discovery",
            meanF1: 0.99,
            inputDollarsPerMillion: 0.5,
            outputDollarsPerMillion: 0.5,
          }),
        ],
        reportPath: "",
        passers: 1,
        total: 1,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/no candidate cleared/);
    expect(getProfileRecord("paid")?.failCount).toBe(1);
  });

  it("paid: pickMassScoutModel throwing (only ':free' survivors) banks a benchmark failure", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
    const catalog = [model("v/cheap", 0.05, 0.05)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 1,
        baselines: 1,
        results: [result({ modelId: "v/only:free", meanF1: 0.99, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 })],
        reportPath: "",
        passers: 1,
        total: 1,
      }),
    };

    const r = await runPopulateDefaultProfilePhase(opts, deps);

    expect(r.ok).toBe(false);
    expect(getProfileRecord("paid")?.failCount).toBe(1);
  });

  // p14.1-c2c (TRDD-38QAM06E follow-up, review of 51a100c item 3c), D5 shape:
  // a stale non-':free' id still sitting in free_models is never priced
  // against the OpenRouter catalog's DECOY for it either — the route-served
  // exclusion (benchmark/index.ts's routeServedFreeIds, keyed on the USER's
  // own free-provider group now) filters the id out BEFORE resolveFreePool
  // ever sees the catalog, so the sweep never rejects over it; the written
  // pool just drops it (only measured ':free' ids survive).
  it("a route-served free id is never checked against the OpenRouter catalog — a decoy PAID entry for the same id does not cause a rejection", async () => {
    const prevBaiKey5 = process.env.BAI_API_KEY;
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    try {
      writeFileSync(
        settingsPath,
        [
          "profiles:",
          "  free:",
          "    mode: remote-ensemble",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    free_only: true",
          "    free_models: [glm-5.3-flash, v/alpha:free]",
          "    model: glm-5.3-flash",
          "    providers:",
          "      - api: chat-b-ai-remote",
          "        api_key: $BAI_API_KEY",
          "        models: [glm-5.3-flash]",
          "  paid:",
          "    mode: remote",
          "    api: openrouter-remote",
          "    api_key: $OPENROUTER_API_KEY",
          "    model: placeholder/unpopulated-default-profile",
          "",
        ].join("\n"),
        "utf-8",
      );

      const opts = { ...baseOpts(), populateDefaultProfile: "free" as const };
      const deps: PopulateDefaultProfileDeps = {
        // The decoy: same id as the route, but priced at $5/M — a real $0
        // check against this entry would reject it outright.
        fetchCatalog: async () => [model("glm-5.3-flash", 5, 5), model("v/paid", 0.5, 0.5)],
        runSweep: async (): Promise<SweepOutcome> => ({
          dryRun: false,
          candidates: 0,
          baselines: 1,
          results: [result({ modelId: "v/alpha:free", meanF1: 0.99 })],
          reportPath: "",
          passers: 1,
          total: 1,
        }),
      };

      const r = await runPopulateDefaultProfilePhase(opts, deps);

      // If the routed id had reached resolveFreePool, the $5/M decoy would
      // have rejected it and r.ok would be false — it is true only because
      // the id never entered that check. D5: the written pool drops it.
      expect(r.ok).toBe(true);
      const written = readSettings(settingsPath).profiles.free;
      expect(written.free_models).toEqual(["v/alpha:free"]);
    } finally {
      if (prevBaiKey5 === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBaiKey5;
    }
  });

  // p14.1-c2c task 2/3 (spec §3c): a route-served id (e.g. glm-5.3-flash via
  // b.ai) never gets an availability/spec (structured-output, context length,
  // etc.) classification IN THIS FILE — this populate command only benchmarks
  // OpenRouter ':free' candidates and pins the b.ai id unconditionally
  // (see the docstring above the b.ai-pin block further down). That is not a
  // gap: dynamic-maintainer.ts's maintainOneDynamicProfile fetches the LIVE
  // b.ai catalog itself (getBaiCatalog, feeding `baiModels`/`unusable` into
  // decideDynamicProfile — see maintainOneDynamicProfile in that file) BEFORE
  // a b.ai id is ever enqueued here, so the availability/spec check already
  // happened upstream, against the b.ai catalog the maintainer holds — this
  // populate command intentionally never re-derives it against a DIFFERENT
  // (OpenRouter) catalog. No test needed here for that classification; this
  // comment is the record the spec asked for.
});

// ── P5 §2.5 requirement 1/2/3 — per-call daily-spend booking + mid-run stop ──
//
// Unlike the suite above (deliberately hermetic via a canned SweepOutcome), these
// three tests exercise the REAL wiring end to end: a real node:http server stands
// in for openrouter.ai (only the global `fetch`'s DNS target is redirected —
// nothing in runner.ts/index.ts/budget.ts/daily-spend.ts is mocked), driving the
// real SpendLedger, the real makeBudgetedGlobalFetch chokepoint, and the real
// bookDailySpend writer. They prove runPopulatePaidDefaultProfile now books every
// call's ACTUAL cost as it happens (instead of one lump sum after the sweep
// returns) and stops sending once the run's spend cap trips mid-sweep.

/** A real local HTTP server standing in for openrouter.ai: one route for the
 *  model catalog, one for chat completions. `onCompletion` runs SYNCHRONOUSLY
 *  before the response is sent, so a test can observe daily-spend.json's state
 *  between calls — proving incremental booking, not a post-sweep lump. */
function startFakeOpenRouter(opts: {
  catalog: OpenRouterModel[];
  onCompletion: (callIndex: number, body: { model?: string }) => { promptTokens: number; completionTokens: number };
}): Promise<{ baseUrl: string; completionCalls: () => number; close: () => Promise<void> }> {
  let completionCalls = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      if (req.url?.startsWith("/api/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: opts.catalog }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/chat/completions") {
        const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
        const idx = completionCalls++;
        const { promptTokens, completionTokens } = opts.onCompletion(idx, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              { message: { content: '{"kw1_functions":[],"kw2_functions":[],"kw3_functions":[]}' }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        completionCalls: () => completionCalls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Redirect the global `fetch` used by discover.ts's catalog call AND by
 *  budget.ts's default GlobalFetch `inner` (both call the bare global `fetch`,
 *  neither imports it) at openrouter.ai to the given local server — real network
 *  I/O over loopback, byte-for-byte elsewhere. Only the DNS target moves; nothing
 *  in runner.ts/index.ts/budget.ts is mocked. */
function redirectOpenRouterFetchTo(baseUrl: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw);
    if (url.hostname !== "openrouter.ai") return real(input as never, init);
    return real(new URL(url.pathname + url.search, baseUrl) as unknown as string, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe("paid sweep — per-call daily-spend booking (P5 §2.5 requirement 1/2)", () => {
  let cfg = "";
  let prevCfgDir: string | undefined;
  let prevApiKey: string | undefined;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "paid-sweep-daily-spend-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    prevApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    setAllowPaidModels(true);
    // (a)/(b) call runKeywordSweep directly, skipping runPopulatePaidDefaultProfile
    // (the real caller that sets this before every sweep it runs — index.ts:1496).
    // Without it, _activeFreeOnly is whatever the LAST test in this file left it as
    // (module-level singleton, not reset between tests) — a preceding 'free' populate
    // test leaves it `true`, so the runner's cost-safety guard skips every paid
    // candidate here as "non-free". Set it explicitly, matching what every real
    // paid-sweep caller does.
    setActiveFreeOnly(false);
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevApiKey;
    setAllowPaidModels(false);
    rmSync(cfg, { recursive: true, force: true });
  });

  function todaySpend(): number {
    if (!existsSync(dailySpendPath())) return 0;
    const parsed = JSON.parse(readFileSync(dailySpendPath(), "utf-8")) as { days: Record<string, number> };
    const key = new Date().toISOString().slice(0, 10);
    return parsed.days[key] ?? 0;
  }

  it("(a) three priced calls book three separate increments, not one post-sweep lump", async () => {
    const catalog = [model("v/a", 0.05, 0.05), model("v/b", 0.05, 0.05), model("v/c", 0.05, 0.05)];
    const observedBefore: number[] = [];
    const server = await startFakeOpenRouter({
      catalog,
      onCompletion: () => {
        // On HEAD every entry here would be 0 (nothing is booked until the whole
        // sweep returns); with the fix, entry N reflects the N-1 calls already
        // completed — the concrete difference between per-call and lump booking.
        observedBefore.push(todaySpend());
        return { promptTokens: 1000, completionTokens: 1000 }; // @ $0.05/M => $0.00005 in + $0.00005 out = $0.0001/call
      },
    });
    restoreFetch = redirectOpenRouterFetchTo(server.baseUrl);

    await withPaidBenchmarksAllowed(true, async () => {
      const opts: CliOptions = { ...baseOpts(), includeIds: [], qualifyingTopN: null, reportPath: join(cfg, "report.md") };
      const ledger = new SpendLedger(opts.budgetUsd, { onBook: bookDailySpend });
      // Row 92 fix-queue: freeOnly is explicit now; this scenario books PAID
      // spend (withPaidBenchmarksAllowed(true, ...) above), so false.
      const sweep = await runKeywordSweep(opts, false, undefined, ledger);
      expect(sweep.results.filter((r) => r.ok)).toHaveLength(3);
    });

    await server.close();

    expect(observedBefore).toHaveLength(3);
    expect(observedBefore[0]).toBeCloseTo(0, 6);
    expect(observedBefore[1]).toBeCloseTo(0.0001, 6);
    expect(observedBefore[2]).toBeCloseTo(0.0002, 6);
    expect(todaySpend()).toBeCloseTo(0.0003, 6);
  });

  it("(b) the run cap tripping mid-sweep skips the remaining candidate — never sent, and the outcome names the cap", async () => {
    // v/a, v/b: cheap candidates — their worst-case RESERVE (real fixture prompt,
    // ASSUMED_MAX_OUTPUT_TOKENS, @ $0.05/M) is ~$0.0011 each, confirmed offline via
    // budget.ts's own estimateCostUsd (not recomputed here — that would make this a
    // test of the estimator, not of the sweep). v/costly1 + v/costly2: two --include
    // baselines at $1.20/M (under the $1.25/M global cap) whose OWN worst-case
    // reserve (~$0.0274 each) alone exceeds a $0.01 cap once v/a and v/b have spent
    // into it. Baselines always run AFTER candidates (roster = candidates then
    // baselines), so v/costly1 is the call whose OWN reserve trips the ledger —
    // that refusal is caught by the runner's never-throw contract and reported as a
    // per-call error naming the cap — and v/costly2 is a SECOND candidate the loop
    // must never even attempt once the ledger is tripped (the actual "stop the
    // sweep, skip the rest" behaviour, requirement 2).
    const catalog = [
      model("v/a", 0.05, 0.05),
      model("v/b", 0.05, 0.05),
      model("v/costly1", 1.2, 1.2),
      model("v/costly2", 1.2, 1.2),
    ];
    const server = await startFakeOpenRouter({
      catalog,
      onCompletion: () => ({ promptTokens: 1000, completionTokens: 1000 }), // tiny actual cost either way
    });
    restoreFetch = redirectOpenRouterFetchTo(server.baseUrl);

    await withPaidBenchmarksAllowed(true, async () => {
      const opts: CliOptions = {
        ...baseOpts(),
        includeIds: ["v/costly1", "v/costly2"],
        qualifyingTopN: null,
        budgetUsd: 0.01,
        reportPath: join(cfg, "report.md"),
      };
      const ledger = new SpendLedger(opts.budgetUsd, { onBook: bookDailySpend });
      // Row 92 fix-queue: freeOnly explicit; paid scenario (spend cap test) → false.
      const sweep = await runKeywordSweep(opts, false, undefined, ledger);

      const ok = sweep.results.filter((r) => r.ok);
      const skipped = sweep.results.filter((r) => !r.ok);
      expect(ok).toHaveLength(2);
      expect(skipped).toHaveLength(2);
      const costly1 = skipped.find((r) => r.modelId === "v/costly1");
      const costly2 = skipped.find((r) => r.modelId === "v/costly2");
      // v/costly1's OWN reserve() refused it, before it was ever sent — names the cap.
      expect(costly1?.error).toMatch(/SPEND CAP/i);
      expect(costly1?.error).toMatch(/\$0\.01 cap/);
      // v/costly2 is the candidate the loop must skip WITHOUT attempting, once the
      // ledger already tripped on v/costly1 — the clean "skipped, not sent" message,
      // not another reserve-refusal (the trip reason it names is v/costly1's own
      // reserve failure, which is where the $0.01 cap is spelled out above).
      expect(costly2?.error).toMatch(/spend cap reached/i);
      expect(costly2?.error).toMatch(/skipped, not sent/i);
    });

    // Neither costly candidate was ever sent — only v/a and v/b made real HTTP calls.
    expect(server.completionCalls()).toBe(2);
    await server.close();
  });

  it("(c) a sweep that throws mid-run still leaves the completed calls' bookings on disk", async () => {
    const catalog = [model("v/x", 0.05, 0.05)];
    const server = await startFakeOpenRouter({
      catalog,
      onCompletion: () => ({ promptTokens: 1000, completionTokens: 1000 }), // @ $0.05/M => $0.0001/call
    });

    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      // Stands in for the network/report machinery of runKeywordSweep (not under
      // test here) while driving the REAL ledger the caller passes — proving
      // requirement 1's per-call booking survives requirement 2's crash-mid-sweep
      // scenario. On HEAD, runPopulatePaidDefaultProfile calls `deps.runSweep(opts)`
      // with NO ledger at all, so this throws immediately with 0 calls/bookings —
      // the correct RED signal for "the daily-spend file already shows the first
      // two bookings" not holding on HEAD.
      // Row 92 fix-queue: runSweep's params shifted (opts, freeOnly, ledger) — the
      // real caller (runPopulatePaidDefaultProfile) now passes freeOnly=false
      // positionally BEFORE the ledger, so the mock must destructure it too or
      // it would silently receive `false` where it expects the SpendLedger.
      runSweep: async (_sweepOpts, _freeOnly, ledger) => {
        if (!ledger) throw new Error("test setup: caller did not pass a SpendLedger");
        const priceOf: PriceLookup = () => ({ inputDollarsPerMillion: 0.05, outputDollarsPerMillion: 0.05 });
        const budgetedFetch = makeBudgetedGlobalFetch(ledger, priceOf);
        for (let i = 0; i < 2; i++) {
          await budgetedFetch(`${server.baseUrl}/api/v1/chat/completions`, {
            method: "POST",
            body: JSON.stringify({ model: "v/x", messages: [], max_tokens: 100 }),
          });
        }
        throw new Error("simulated mid-sweep crash after 2 successful calls");
      },
    };

    await withPaidBenchmarksAllowed(true, async () => {
      const opts = { ...baseOpts(), populateDefaultProfile: "paid" as const };
      await expect(runPopulateDefaultProfilePhase(opts, deps)).rejects.toThrow(/simulated mid-sweep crash/);
    });

    await server.close();
    expect(server.completionCalls()).toBe(2);
    expect(todaySpend()).toBeCloseTo(0.0002, 6); // 2 calls x $0.0001 — survives the throw
  });

  it("fix-queue 29: buildReportPath routes an isolated run's report under LLM_EXT_CONFIG_DIR, never under process.cwd()'s reports/benchmark/", async () => {
    const catalog = [model("v/a", 0.05, 0.05)];
    const server = await startFakeOpenRouter({
      catalog,
      onCompletion: () => ({ promptTokens: 10, completionTokens: 10 }),
    });
    restoreFetch = redirectOpenRouterFetchTo(server.baseUrl);

    const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    // Deterministic: force resolveMainRoot()'s process.cwd() fallback, matching a
    // real subprocess test run with no override — the exact condition the bug
    // needs (an ambient CLAUDE_PROJECT_DIR would make the second assertion below
    // pass vacuously by anchoring resolveMainRoot() somewhere else entirely).
    delete process.env.CLAUDE_PROJECT_DIR;
    let sweep: SweepOutcome | undefined;
    try {
      await withPaidBenchmarksAllowed(true, async () => {
        // No opts.reportPath — every other case in this file pins one explicitly,
        // which bypasses buildReportPath() entirely; baseOpts() itself defaults
        // reportPath to null (cli-args.ts), so omitting it here is what forces
        // the resolution under test.
        const opts: CliOptions = { ...baseOpts(), includeIds: [], qualifyingTopN: null };
        // Row 92 fix-queue: freeOnly explicit; withPaidBenchmarksAllowed(true, ...) above → false.
        sweep = await runKeywordSweep(opts, false);
      });
    } finally {
      if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    }
    await server.close();

    // realpath both sides: mkdtempSync("/tmp/...") returns the /tmp spelling, but
    // getConfigDir() resolves through the real filesystem entry (/private/tmp on
    // macOS) — comparing the raw strings would false-fail on every macOS run.
    // This one assertion carries the test: it failed red on the HEAD archive
    // (pre-fix resolveMainRoot() falls back to process.cwd(), not cfgReal).
    const cfgReal = realpathSync(cfg);
    expect(sweep!.reportPath.startsWith(cfgReal + "/")).toBe(true);
  });
});

// D0 (TRDD-AL8GIZYA, plan item 2b): USER 2026-09-18 "no, manual is manual"
// (TRDD-DS6OM3KX) — a model named explicitly via --include is manual and must
// NOT be refused for price, even when it is priced above the ensemble ceiling.
// Before this fix, runKeywordSweep's price-cap fail-fast ran over the FULL
// roster (auto candidates + explicit baselines), so an over-ceiling --include
// aborted the whole sweep before any send — exactly the "old
// explicit-includes-are-never-capped behaviour" comment this fix reverses.
describe("paid sweep — explicit --include is manual, never price-capped (D0, TRDD-AL8GIZYA)", () => {
  let cfg = "";
  let prevCfgDir: string | undefined;
  let prevApiKey: string | undefined;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "paid-sweep-manual-price-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    prevApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    setAllowPaidModels(true);
    setActiveFreeOnly(false);
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevApiKey;
    setAllowPaidModels(false);
    rmSync(cfg, { recursive: true, force: true });
  });

  it("does not refuse an --include'd model priced above the $1.30/M default ceiling", async () => {
    // $2.00/M in AND out: above DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M ($1.3/M).
    const catalog = [model("v/over-cap-manual", 2.0, 2.0)];
    const server = await startFakeOpenRouter({
      catalog,
      onCompletion: () => ({ promptTokens: 10, completionTokens: 10 }),
    });
    restoreFetch = redirectOpenRouterFetchTo(server.baseUrl);

    await withPaidBenchmarksAllowed(true, async () => {
      const opts: CliOptions = {
        ...baseOpts(),
        includeIds: ["v/over-cap-manual"],
        qualifyingTopN: null,
        reportPath: join(cfg, "report.md"),
      };
      // On HEAD this throws ("benchmark price cap: refusing...") before any send,
      // $0 spent — the exact bug this slice fixes. After the fix the manual
      // include is assessed like any other baseline.
      const sweep = await runKeywordSweep(opts, false);
      const row = sweep.results.find((r) => r.modelId === "v/over-cap-manual");
      expect(row).toBeDefined();
      expect(row?.isBaseline).toBe(true);
    });
    await server.close();
  });
});