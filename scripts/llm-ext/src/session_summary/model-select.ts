/**
 * Model selection for session-summary — TRDD-T4MZ8YQR P3.
 *
 * Queries the public OpenRouter catalog ($0, no API key) and filters it to
 * the free, big-context, genuinely-text models eligible for a compaction
 * summary run. Two hard-learned constraints, both proven in the TRDD:
 *
 *  1. **The modality filter is load-bearing.** `google/lyria-3-pro-preview`
 *     and `google/lyria-3-clip-preview` are free with 1,048,576 context but
 *     are `text+image->text+audio` music models — a price+context-only
 *     filter selects them and the command silently breaks in a way that
 *     looks like a model bug, not a filter bug. `architecture.modality`
 *     must be exactly `"text->text"`.
 *  2. **Never a paid model, even under a paid profile.** This tool exists
 *     specifically to guarantee $0 spend, so every selected id is passed
 *     through the project's own `assertFreeOnlyModel` cost-safety gate
 *     (config.ts, TRDD-97ef8b63) with `freeOnly` forced to `true` — the
 *     same chokepoint every other subsystem's live sends go through — so a
 *     filtering bug that let a non-':free' id slip through fails fast
 *     instead of silently being handed to a caller.
 *
 * Fetch (network IO) and filter (pure) are kept in separate functions so
 * the filter is fully unit-testable against injected fixtures, per the
 * project's PURE CORE + THIN IO SHELL convention (see free-rotation.ts).
 */

import { assertFreeOnlyModel } from "../config.js";

/** The subset of the OpenRouter `/api/v1/models` catalog entry this module reads. */
export interface CatalogModel {
  id: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  architecture?: {
    modality?: string;
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  };
}

/** A model that passed the eligibility filter, with the fields the caller needs. */
export interface EligibleModel {
  id: string;
  contextLength: number;
  maxCompletionTokens: number;
}

export interface SelectModelsOptions {
  /** Minimum context_length required. Default: 1,000,000 (the literal user request). */
  minContext?: number;
  /** Drop the default floor to LOWER_CONTEXT_FLOOR (262,144) when `minContext` is not
   *  given explicitly. A one-model pool has nothing to rotate to when its daily cap
   *  hits — this widens the pool to ~5 free text models so a long run can rotate. */
  allowLowerContext?: boolean;
}

export const DEFAULT_MIN_CONTEXT = 1_000_000;
/** The lower floor an `allowLowerContext`-style caller drops to — see the TRDD's
 *  rotation-partner rationale: a one-model pool has nothing to rotate to when its
 *  daily cap hits, so 262,144 (today's next tier, ~5 free text models) is the
 *  documented escape hatch. Exported so callers don't hardcode the magic number. */
export const LOWER_CONTEXT_FLOOR = 262_144;

const TEXT_TO_TEXT_MODALITY = "text->text";

/**
 * Pure filter: given a raw catalog snapshot, return the eligible free
 * text->text models at or above `minContext`, ordered by context_length
 * descending. Throws a fail-fast, actionable error when nothing qualifies
 * — this tool must never silently fall back to a paid model.
 */
export function selectEligibleModels(
  catalog: readonly CatalogModel[],
  options: SelectModelsOptions = {},
): EligibleModel[] {
  const minContext =
    options.minContext ?? (options.allowLowerContext ? LOWER_CONTEXT_FLOOR : DEFAULT_MIN_CONTEXT);

  const eligible: EligibleModel[] = [];
  for (const m of catalog) {
    const promptPrice = parseFloat(m.pricing?.prompt ?? "NaN");
    const completionPrice = parseFloat(m.pricing?.completion ?? "NaN");
    if (promptPrice !== 0 || completionPrice !== 0) continue;

    const contextLength = m.context_length ?? 0;
    if (contextLength < minContext) continue;

    if (m.architecture?.modality !== TEXT_TO_TEXT_MODALITY) continue;

    // Cost-safety backstop (TRDD-97ef8b63 chokepoint): this module exists to
    // guarantee $0 spend, so every id it hands out must itself be admissible
    // under free_only regardless of the caller's active profile. A model
    // that priced at $0 but somehow lacks the ':free' suffix (a malformed or
    // future catalog entry) must fail fast here, not ride downstream into a
    // real request.
    assertFreeOnlyModel(true, "openrouter", m.id);

    eligible.push({
      id: m.id,
      contextLength,
      maxCompletionTokens: m.top_provider?.max_completion_tokens ?? 0,
    });
  }

  eligible.sort((a, b) => b.contextLength - a.contextLength);

  if (eligible.length === 0) {
    throw new Error(
      `session-summary: no free text->text model with context_length >= ${minContext} ` +
        `found on the OpenRouter catalog. Filters applied: pricing.prompt == 0 AND ` +
        `pricing.completion == 0 AND context_length >= ${minContext} AND ` +
        `architecture.modality == "${TEXT_TO_TEXT_MODALITY}" (this excludes free ` +
        `non-text models like music/image models that otherwise qualify on price ` +
        `and context alone). Try a lower --min-context (e.g. ${LOWER_CONTEXT_FLOOR}, ` +
        `today's next tier down) to widen the pool.`,
    );
  }

  return eligible;
}

/**
 * Fetch the OpenRouter model catalog. No auth required — the catalog is
 * public. Thin IO shell around selectEligibleModels() so callers can inject
 * a fixture in tests instead of hitting the network.
 */
export async function fetchCatalog(): Promise<CatalogModel[]> {
  const url = "https://openrouter.ai/api/v1/models";
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`OpenRouter model catalog fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const body = (await resp.json()) as { data?: CatalogModel[] };
  return body.data ?? [];
}

/** Fetch the live catalog and return the eligible models. Network + filter combined
 *  for the common case; tests exercise fetchCatalog and selectEligibleModels separately. */
export async function selectModels(options: SelectModelsOptions = {}): Promise<EligibleModel[]> {
  const catalog = await fetchCatalog();
  return selectEligibleModels(catalog, options);
}
