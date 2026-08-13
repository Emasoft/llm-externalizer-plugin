/**
 * Dynamic default-profile lifecycle: `free`, `ensemble`, `mass-scout`.
 *
 * These 3 profiles (config.ts's DEFAULT_PROFILE_NAMES) carry NO predefined
 * model id — they are populated, and kept current, by a scan/benchmark/compare
 * procedure that fires:
 *   1. LAZILY, the first time that profile type is actually used (it is still
 *      an unpopulated placeholder — see config.ts's isPlaceholderProfile).
 *   2. On CATALOG DRIFT: a configured model was removed/deactivated from
 *      OpenRouter, a configured model's price increased, or a new model
 *      arrived that qualifies for this profile and isn't configured yet.
 *
 * Using an unpopulated (or drift-invalidated) default profile MUST NOT error —
 * it triggers the benchmark, then proceeds. This module is the pure decision
 * core (`decideDefaultProfilePopulation`) plus a thin injected-dependency
 * orchestrator (`ensureDefaultProfileReady`): it fetches nothing and writes
 * nothing on its own. Callers supply the live catalog snapshot, the cached
 * benchmark prices (reused from the existing benchmark-results.json shape —
 * see pick.ts's loadCachedReport / CachedResult), and a `runBenchmark`
 * implementation. Production wires `runBenchmark` to the real per-profile
 * discover -> pick.ts-selector -> pick.ts-writer pipeline (pickTopN family +
 * applyFreePoolToSettings / applyPicksToSettings / applyEnsembleSlotToSettings,
 * all reused, never re-implemented); tests inject a stub and assert it ran.
 */

import {
  isPlaceholderProfile,
  isDefaultProfileName,
  DEFAULT_PROFILE_NAMES,
  type Profile,
  type DefaultProfileName,
} from "./config.js";
// NOTE on the "runtime failure invalidates the profile" trigger: it is NOT
// built on classifyUnavailable's "gone" verdict. That verdict is a substring
// sniff over an error string ("404", "not found") backing a ONE-HOUR rotation
// cooldown — far too eager to authorize a paid benchmark. The durable verdict
// is model-events.ts's assessModelPersistence: three consecutive
// ROTATE_WORTHY_STATUSES (400/404/410/422) within 24h. A 429/502/503 blip must
// never cost money, so the trigger lives there and reaches this module as the
// "model-unavailable-at-runtime" reason.

/** One catalog model's id + live price — the minimal shape drift-detection needs. */
export interface CatalogPriceSnapshot {
  id: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
}

/** A profile's configured model ids, extracted uniformly across shapes
 *  (free_only pool vs model/second_model/third_model ensemble slots). */
export function defaultProfileModelIds(profile: Profile): string[] {
  if (profile.free_only) return [...(profile.free_models ?? [])];
  return [profile.model, profile.second_model, profile.third_model].filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
}

export type PopulationReason =
  | "unpopulated"
  | "model-removed"
  | "model-price-increased"
  | "new-model-arrived"
  | "model-unavailable-at-runtime"
  | "up-to-date";

export interface PopulationDecision {
  needsBenchmark: boolean;
  reason: PopulationReason;
}

/** Last-known price per model id, keyed by model id (`in`/`out` USD per
 *  million tokens) — the drift baseline a benchmark report supplies. */
export type CachedPriceMap = ReadonlyMap<string, { in: number; out: number }>;

/**
 * Build a CachedPriceMap from a benchmark report's cached results (the SAME
 * on-disk shape `pick.ts`'s `loadCachedReport` reads) — reused, not
 * reinvented, as the "last known price" drift baseline.
 */
export function cachedPricesFromResults(
  results: readonly {
    modelId: string;
    inputDollarsPerMillion: number;
    outputDollarsPerMillion: number;
  }[],
): Map<string, { in: number; out: number }> {
  const m = new Map<string, { in: number; out: number }>();
  for (const r of results) {
    m.set(r.modelId, { in: r.inputDollarsPerMillion, out: r.outputDollarsPerMillion });
  }
  return m;
}

/**
 * Decide whether a default profile needs its benchmark (re)run.
 *
 * Fail-open on drift: an EMPTY `catalog` (cold/failed catalog fetch) never
 * falsely invalidates an already-populated profile — a network hiccup must
 * not trigger spend. An unpopulated placeholder still triggers regardless
 * (population needs no catalog snapshot; the benchmark runner fetches its
 * own catalog).
 *
 * `newArrivalPool`, when supplied, is the set of live ids that qualify for
 * THIS profile (e.g. the passing `:free` pool for `free`, or the
 * ceiling-qualifying paid ids for `ensemble`/`mass-scout`) — an id present
 * there but absent from the profile's configured ids counts as a "new model
 * arrived" trigger. Omitted (undefined) ⟹ that check is skipped (no
 * catalog-derived candidate pool available to the caller yet).
 */
export function decideDefaultProfilePopulation(
  profile: Profile,
  catalog: readonly CatalogPriceSnapshot[],
  opts: {
    cachedPrices?: CachedPriceMap;
    newArrivalPool?: readonly string[];
  } = {},
): PopulationDecision {
  if (isPlaceholderProfile(profile)) {
    return { needsBenchmark: true, reason: "unpopulated" };
  }
  const configured = defaultProfileModelIds(profile);
  const configuredSet = new Set(configured);

  if (catalog.length > 0) {
    const liveById = new Map(catalog.map((m) => [m.id, m]));
    const cachedPrices = opts.cachedPrices ?? new Map();
    for (const id of configured) {
      const live = liveById.get(id);
      if (!live) return { needsBenchmark: true, reason: "model-removed" };
      const cached = cachedPrices.get(id);
      if (
        cached &&
        (live.inputDollarsPerMillion > cached.in || live.outputDollarsPerMillion > cached.out)
      ) {
        return { needsBenchmark: true, reason: "model-price-increased" };
      }
    }
  }

  if (opts.newArrivalPool) {
    const arrived = opts.newArrivalPool.some((id) => !configuredSet.has(id));
    if (arrived) return { needsBenchmark: true, reason: "new-model-arrived" };
  }

  return { needsBenchmark: false, reason: "up-to-date" };
}

/** Injected per-profile benchmark runner. Production points this at the real
 *  discover -> benchmark -> pick.ts-writer pipeline for that profile type
 *  (see pick.ts's pickEnsembleByPriceCeiling / pickMassScoutModel /
 *  passingFreePoolIds + updateFreeDefaultProfile / updateEnsembleDefaultProfile
 *  / updateMassScoutDefaultProfile); tests inject a stub and assert it ran. */
export type DefaultProfileBenchmarkRunner = (
  profileName: DefaultProfileName,
  settingsPath: string,
) => Promise<void>;

export interface EnsureDefaultProfileResult {
  profileName: DefaultProfileName;
  decision: PopulationDecision;
  benchmarkRan: boolean;
}

/**
 * The single entry point a command handler calls before USING a default
 * profile: decide, trigger the injected benchmark runner when needed, then
 * proceed. Never throws for "unpopulated" or any drift reason — that is the
 * expected lazy-population / refresh path, not an error condition.
 */
export async function ensureDefaultProfileReady(
  profileName: string,
  profile: Profile,
  catalog: readonly CatalogPriceSnapshot[],
  settingsPath: string,
  runBenchmark: DefaultProfileBenchmarkRunner,
  opts: { cachedPrices?: CachedPriceMap; newArrivalPool?: readonly string[] } = {},
): Promise<EnsureDefaultProfileResult> {
  if (!isDefaultProfileName(profileName)) {
    throw new Error(
      `ensureDefaultProfileReady: '${profileName}' is not a machine-owned default profile ` +
        `(${DEFAULT_PROFILE_NAMES.join(", ")}).`,
    );
  }
  const decision = decideDefaultProfilePopulation(profile, catalog, opts);
  if (decision.needsBenchmark) {
    await runBenchmark(profileName, settingsPath);
  }
  return { profileName, decision, benchmarkRan: decision.needsBenchmark };
}
