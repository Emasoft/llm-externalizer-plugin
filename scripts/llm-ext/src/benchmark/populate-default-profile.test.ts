// `--populate-default-profile NAME` — populates exactly ONE named machine-managed
// default profile ('free' | 'free-ensemble' | 'paid' | 'paid-ensemble' |
// 'paid-mass-scout'), unlike --update-all (which writes whatever `settings.active`
// happens to be, plus every registered tool).
//
// Hermetic: no network, no real LLM calls, no spend. The OpenRouter catalog and the
// keyword sweep are both injected via PopulateDefaultProfileDeps (same seam shape as
// update-all.ts's UpdateAllDeps) — production wiring (fetchProgrammingModels /
// runKeywordSweep) is never exercised here. settings.yaml is a REAL file in a tmp dir,
// written by the REAL atomic writers, so a broken write is a failing test here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { runPopulateDefaultProfilePhase, type PopulateDefaultProfileDeps, type SweepOutcome } from "./index.js";
import { parseArgs, type CliOptions } from "./cli-args.js";
import type { CachedResult } from "./pick.js";
import type { OpenRouterModel } from "./discover.js";
import { getSettingsPath } from "../config.js";
import { getProfileRecord } from "../default-profiles-state.js";

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
  "active: paid-ensemble",
  "profiles:",
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    free_only: true",
  "    free_models: []",
  "    model: placeholder/unpopulated-default-profile",
  "  free-ensemble:",
  "    mode: remote-ensemble",
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
  "  paid-ensemble:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: placeholder/unpopulated-default-profile",
  "    second_model: placeholder/unpopulated-default-profile",
  "    third_model: placeholder/unpopulated-default-profile",
  "  paid-mass-scout:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    model: placeholder/unpopulated-default-profile",
  "",
].join("\n");

function baseOpts(): CliOptions {
  // parseArgs with no argv tokens gives every code default (budgetUsd, qualifyingTopN,
  // …) without re-deriving them by hand — the one spelling of "default CLI options".
  return parseArgs(["node", "benchmark.js"]);
}

interface WrittenProfile {
  free_models?: string[];
  model?: string;
  second_model?: string;
  third_model?: string;
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

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "populate-default-profile-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    settingsPath = getSettingsPath();
    writeFileSync(settingsPath, SETTINGS, "utf-8");
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("--populate-default-profile free selects via passingFreePoolIds and writes BOTH the 'free' and 'free-ensemble' profiles' free_models", async () => {
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
    // The SAME sweep populates 'free-ensemble' too — one benchmark run, two profiles.
    expect(readSettings(settingsPath).profiles["free-ensemble"].free_models).toEqual(["v/alpha:free"]);
    // A completed benchmark banks the picks + a fingerprint of the pool that
    // produced them (default-profiles-state.ts), so a later drift check can
    // tell "unchanged" from "the world moved" without re-benchmarking.
    const record = getProfileRecord("free");
    expect(record?.modelIds).toEqual(["v/alpha:free"]);
    expect(record?.failCount).toBe(0);
    expect(typeof record?.poolFingerprint).toBe("string");
    expect(record?.poolFingerprint.length).toBeGreaterThan(0);
    const ensembleRecord = getProfileRecord("free-ensemble");
    expect(ensembleRecord?.modelIds).toEqual(["v/alpha:free"]);
    expect(ensembleRecord?.failCount).toBe(0);
  });

  it("--populate-default-profile paid-ensemble selects via pickEnsembleByPriceCeiling and writes the 'paid-ensemble' profile's slots", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-ensemble" as const };
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
    const written = readSettings(settingsPath).profiles["paid-ensemble"];
    expect(written.model).toBe("v/a");
    expect(written.second_model).toBe("v/b");
    expect(written.third_model).toBe("v/c");
    const record = getProfileRecord("paid-ensemble");
    expect(record?.modelIds).toEqual(["v/a", "v/b", "v/c"]);
    expect(record?.failCount).toBe(0);
  });

  it("--populate-default-profile paid selects via pickEnsembleByPriceCeiling with topN 1 and writes only the 'paid' profile's model slot", async () => {
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
    expect(written.second_model).toBeUndefined();
    expect(written.third_model).toBeUndefined();
    const record = getProfileRecord("paid");
    expect(record?.modelIds).toEqual(["v/a"]);
    expect(record?.failCount).toBe(0);
  });

  it("--populate-default-profile paid-mass-scout selects via pickMassScoutModel and writes the 'paid-mass-scout' profile's model slot", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-mass-scout" as const };
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
    expect(readSettings(settingsPath).profiles["paid-mass-scout"].model).toBe("v/cheap");
    expect(getProfileRecord("paid-mass-scout")?.modelIds).toEqual(["v/cheap"]);
  });

  it("an invalid --populate-default-profile name fails fast and names the five valid options", () => {
    expect(() => parseArgs(["node", "benchmark.js", "--populate-default-profile", "bogus"])).toThrow(
      /--populate-default-profile must be one of free, free-ensemble, paid, paid-ensemble, paid-mass-scout, got 'bogus'/,
    );
  });

  it("paid-mass-scout NEVER writes a ':free' id, even when a ':free' candidate has the best score", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-mass-scout" as const };
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
    const written = readSettings(settingsPath).profiles["paid-mass-scout"].model as string;
    expect(written.endsWith(":free")).toBe(false);
    expect(written).toBe("v/cheap");
  });

  it("paid-ensemble honours a settings-provided price ceiling, not the 1.3 default", async () => {
    // 0.6/1M is well under the 1.3 built-in default but OVER a custom 0.5 ceiling.
    writeFileSync(
      settingsPath,
      `ensemble_price_ceiling_usd_per_million: 0.5\n${SETTINGS}`,
      "utf-8",
    );
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-ensemble" as const };
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
    const written = readSettings(settingsPath).profiles["paid-ensemble"];
    expect(written.model).toBe("v/under-ceiling");
    expect(written.second_model).toBeUndefined();
  });

  it("--dry-run writes nothing to settings.yaml and never calls the sweep", async () => {
    const before = readFileSync(settingsPath, "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-ensemble" as const, dryRun: true };
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
    expect(getProfileRecord("paid-ensemble")).toBeUndefined();
  });

  it("a paid name with a budget lower than the worst-case estimate aborts BEFORE any billable call and arms the failure cooldown", async () => {
    const before = readFileSync(settingsPath, "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-ensemble" as const, budgetUsd: 0.0000001 };
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
    const record = getProfileRecord("paid-ensemble");
    expect(record?.failCount).toBe(1);
    expect(record?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("free: only zero-cost, non-':free'-suffixed candidates survive resolveFreePool — freeSuffixOnly leaves nothing, banks a benchmark failure for both free profiles", async () => {
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
    expect(getProfileRecord("free-ensemble")?.failCount).toBe(1);
  });

  it("free: every candidate fails the sweep — banks a benchmark failure for both free profiles, both left unchanged", async () => {
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
    expect(getProfileRecord("free-ensemble")?.failCount).toBe(1);
  });

  it("paid-ensemble: no candidate clears the price ceiling — banks a benchmark failure, 'paid-ensemble' left unchanged", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-ensemble" as const };
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
    expect(getProfileRecord("paid-ensemble")?.failCount).toBe(1);
  });

  it("paid-ensemble: every sweep survivor is over a CUSTOM price ceiling — banks a benchmark failure post-sweep", async () => {
    writeFileSync(settingsPath, `ensemble_price_ceiling_usd_per_million: 0.1\n${SETTINGS}`, "utf-8");
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-ensemble" as const };
    const catalog = [model("v/under-default-cap-over-custom-ceiling", 0.5, 0.5)];
    const deps: PopulateDefaultProfileDeps = {
      fetchCatalog: async () => catalog,
      runSweep: async (): Promise<SweepOutcome> => ({
        dryRun: false,
        candidates: 1,
        baselines: 0,
        results: [
          result({
            modelId: "v/under-default-cap-over-custom-ceiling",
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
    expect(getProfileRecord("paid-ensemble")?.failCount).toBe(1);
  });

  it("paid-mass-scout: pickMassScoutModel throwing (only ':free' survivors) banks a benchmark failure", async () => {
    const opts = { ...baseOpts(), populateDefaultProfile: "paid-mass-scout" as const };
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
    expect(getProfileRecord("paid-mass-scout")?.failCount).toBe(1);
  });
});
