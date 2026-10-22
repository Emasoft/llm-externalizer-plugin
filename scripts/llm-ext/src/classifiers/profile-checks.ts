// PF-02 (plan §8): checks that need the decisions catalog, run when a profile is selected and in `settings validate`; loading settings never calls these.
import { inferProfileType, type ProfileType, type Settings } from "../config.js";
import { ANY_PROFILE_TYPE } from "../profile-accept.js";
import { loadDecisionsCatalog, readCachedDecisionsCatalog, type DecisionsModel } from "./l0/catalog.js";
import { resolveModel } from "./l0/model.js";
import type { DecisionsEndpoint, GlobalFetch } from "./l0/transport.js";

/** Command that lists current decisions models (C4-06 adds the Jev filter to the existing model-info command). */
const MODEL_INFO_HINT = "list the current decisions models with the model-info command's Jev filter";

export interface SelectionCheckInput {
  name: string;
  type: ProfileType;
  model: string;
  fetch: GlobalFetch;
  now?: number;
  path?: string;
  ttlMs?: number;
  /** The classifier profile's `endpoint:` as written (PF-07); only `systemone` is checked. */
  endpoint?: DecisionsEndpoint;
}

/**
 * Errors for a profile being selected; empty when it passes.
 * - local: skipped (nothing to look up).
 * - free/paid/scouting: refused when the model is a decisions model in the CACHED catalog; no cache means skipped,
 *   so the provider's own error surfaces. WHY it replaces the `typesafe/jev-*` regex: that missed 13 of 14 decisions models.
 * - classifier: the model must exist in the catalog (alias resolved via alias_target, E19). An expired cache plus a failed
 *   refresh throws (loadDecisionsCatalog, E16): stale data is never used silently.
 */
export async function selectionCatalogErrors(input: SelectionCheckInput, loadCatalog?: () => Promise<DecisionsModel[]>): Promise<string[]> {
  const { name, type, model } = input;
  if (type === "local") return [];
  if (type !== "classifier") {
    const cached = readCachedDecisionsCatalog(input.path);
    if (cached?.some((m) => m.id === model || m.canonicalSlug === model)) {
      return [`Profile '${name}' (${type}): model '${model}' is a decisions model; it cannot answer chat requests. Use a classifier profile for it, or a chat model here.`];
    }
    return [];
  }
  // WHY `loadCatalog` is a separate internal argument and not an option: a public option would replace the cache/TTL/E16 handling silently; only the runner passes its memoised loader so selection and the model lookup share one load.
  const catalog = await (loadCatalog ?? (() => loadDecisionsCatalog({ fetch: input.fetch, now: input.now, path: input.path, ttlMs: input.ttlMs })))();
  // WHY branch on membership, not on resolveModel's message: only a model absent from the catalog may be called "removed";
  // an alias with a missing target or a chain must surface resolveModel's own error.
  if (!catalog.some((m) => m.id === model || m.canonicalSlug === model)) {
    return [`Profile '${name}': unknown decisions model: ${model}. It is not in the decisions catalog (it may have been removed); ${MODEL_INFO_HINT}.`];
  }
  let effective: DecisionsModel;
  try {
    effective = resolveModel(model, catalog).effective;
  } catch (e) {
    return [`Profile '${name}': ${(e as Error).message}`];
  }
  // PF-07 (plan section 14 error 14): the System One endpoint is served only for models that declare it. WHY the RESOLVED model's flag: an alias is judged by its target, and l0/catalog.ts (toModel) already sets `systemOne` for every `typesafe/` id, so no second id test is needed.
  if (input.endpoint === "systemone" && !effective.systemOne) {
    return [`Profile '${name}': endpoint 'systemone' is not available for model '${model}': its catalog entry does not declare System One and it is not a typesafe/* model. Fix: use endpoint: decisions, or a model that declares System One.`];
  }
  return [];
}


/** The check options a caller may pass through (cache path, clock, TTL), without the per-profile fields. */
export type SelectionCheckOptions = Omit<SelectionCheckInput, "name" | "type" | "model" | "fetch" | "endpoint">;

/**
 * PF-02 wiring: the catalog errors of one profile of `settings`. A profile with no model string has nothing to look up
 * (its own validation reports that). The profile must exist: callers select before they check.
 */
export async function profileCatalogErrors(
  settings: Pick<Settings, "profiles">,
  name: string,
  fetch: GlobalFetch,
  options: SelectionCheckOptions = {},
): Promise<string[]> {
  const profile = settings.profiles[name];
  if (profile === undefined) throw new Error(`profileCatalogErrors: profile '${name}' is not defined`);
  const model: unknown = profile.model;
  if (typeof model !== "string" || model.length === 0) return [];
  // WHY no endpoint guard: a value outside the union is reported by validateClassifierProfile (config.ts, run by validateProfile and by resolveClassifierProfile); only === "systemone" is acted on here.
  return selectionCatalogErrors({ name, type: inferProfileType(name, profile), model, fetch, endpoint: profile.endpoint, ...options });
}

/**
 * Run at CLI profile selection (cli/main.ts), after the PT-03 type check. Only the chat guard applies here: a command that
 * accepts every type makes no model call, and a classifier profile is checked by the classifier resolver (l2/profile.ts),
 * so a classifier is skipped. WHY the `accepted` filter: `active:` is not the profile a classifier-only command uses.
 * The chat guard reads the cached catalog only, so selecting a profile never touches the network.
 */
export async function selectedChatProfileErrors(
  settings: Pick<Settings, "profiles">,
  name: string,
  accepted: readonly ProfileType[],
  fetch: GlobalFetch,
  options: SelectionCheckOptions = {},
): Promise<string[]> {
  const profile = settings.profiles[name];
  if (accepted === ANY_PROFILE_TYPE || profile === undefined) return [];
  const type = inferProfileType(name, profile);
  if (type === "classifier" || !accepted.includes(type)) return [];
  return profileCatalogErrors(settings, name, fetch, options);
}

/**
 * `settings validate`: every profile of the file, chat guard and classifier checks alike. WHY every profile and not the
 * selected one: a typo in an unselected profile must show too (same rule as the offline load checks). A classifier profile
 * may fetch the catalog (E16 throws when the cache is expired and the refresh fails); that is the one place this is allowed
 * besides classifier selection. There is no `settings validate` command yet: the command card calls this.
 */
export async function settingsCatalogErrors(
  settings: Pick<Settings, "profiles">,
  fetch: GlobalFetch,
  options: SelectionCheckOptions = {},
): Promise<string[]> {
  const errors: string[] = [];
  for (const name of Object.keys(settings.profiles)) errors.push(...(await profileCatalogErrors(settings, name, fetch, options)));
  return errors;
}
