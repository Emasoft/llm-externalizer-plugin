/**
 * Model selection for session-summary — TRDD-T4MZ8YQR P3.
 *
 * Queries the public OpenRouter catalog ($0, no API key) and filters it to
 * the free, genuinely-text models eligible for a compaction summary run,
 * returning them BIGGEST-CONTEXT-FIRST with no implicit floor — "the
 * biggest free model with the biggest context memory", whatever the
 * catalog happens to offer today. `selectModels()` hands the whole ordered
 * list to the driver so it can fall back down the list if the top pick
 * becomes unavailable mid-run (delisted, no longer free, or daily-cap
 * exhausted) — see driver.ts's model-fallback handling. Two hard-learned
 * constraints, both proven in the TRDD:
 *
 *  1. **The modality filter is PERMISSIVE by design: text present on BOTH
 *     sides of `->`, extra modalities irrelevant.** An exact
 *     `modality === "text->text"` match is too strict — it drops usable
 *     models that accept more than text but still emit text
 *     (`text+image+video->text`). The final rule is simpler and more
 *     future-proof: split on `->`, require `"text"` to be a `+`-separated
 *     member of BOTH the input side and the output side (never a raw
 *     substring match — `"textual"` must not match `"text"`); any OTHER
 *     modality on either side never disqualifies. On modality alone this
 *     WOULD admit `google/lyria-3-pro-preview` / `google/lyria-3-clip-preview`
 *     (`text+image->text+audio`, $0, 1,048,576 context) even though they're
 *     music-generation models — on purpose. A metadata string cannot
 *     reliably predict whether a model's text output is actually USABLE for
 *     summarization, so this module does not try; the driver's runtime
 *     fallback chain enforces usability instead — an empty/no-text response
 *     demotes the model and moves to the next ranked candidate (driver.ts's
 *     "no-text" fallback reason). In practice the lyria ids are excluded
 *     earlier, by rule 2, because their ids carry no ':free' suffix. A
 *     missing or malformed `architecture.modality` is always ineligible —
 *     never assume text.
 *  2. **Never a paid model, even under a paid profile.** This tool exists
 *     specifically to guarantee $0 spend. Eligibility therefore requires BOTH
 *     $0 pricing AND a ':free'-suffixed id — they are different predicates,
 *     and OpenRouter genuinely lists $0 models without the suffix. Only
 *     ':free' ids are admissible under free_only (`assertFreeOnlyModel`,
 *     config.ts, TRDD-97ef8b63), which every live send still passes through.
 *     An unsuffixed id is EXCLUDED here, never fatal: calling the gate inline
 *     made one such catalog row take the whole run down, and since the
 *     unsuffixed lyria ids have the largest context in the free tier they are
 *     hit first — so the command failed before it could reach a usable model.
 *
 * Fetch (network IO) and filter (pure) are kept in separate functions so
 * the filter is fully unit-testable against injected fixtures, per the
 * project's PURE CORE + THIN IO SHELL convention (see free-rotation.ts).
 */

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
  /** Minimum context_length required. Optional — when omitted there is NO floor:
   *  every eligible free text->text model qualifies and the caller gets the
   *  BIGGEST one available today, whatever that happens to be. Only set this
   *  when the caller genuinely needs a hard guarantee and would rather fail
   *  than accept a smaller model. */
  minContext?: number;
}

/** Documented reference point only — no longer applied as an implicit default.
 *  Pass it explicitly as `{ minContext: DEFAULT_MIN_CONTEXT }` to restore the
 *  old hard-floor behavior. */
export const DEFAULT_MIN_CONTEXT = 1_000_000;

const TEXT_TO_TEXT_MODALITY = "text->text";

/**
 * A model is eligible on modality when TEXT is present on BOTH sides of the
 * `->` — it can take a text prompt and it can emit text back. Any OTHER
 * modality on either side is irrelevant and never disqualifies: multimodal
 * models are only going to become more common, and a filter written today
 * must not exclude a model whose extra input/output types didn't exist yet
 * when this was written. `"text+image+video->text"` is eligible.
 * `"text+image->text+audio"` (lyria) is ALSO eligible on this predicate —
 * text is present on both sides, full stop. `"image->text"` (no text
 * input) and `"text->audio"` (no text output) are NOT eligible. A
 * missing/malformed modality string is never eligible — never assume text.
 *
 * DELIBERATE TRADE-OFF, do not "simplify" this back to an output-purity
 * check: a metadata string cannot reliably predict whether a model's text
 * output is actually usable for a summarization task (a lyria-shaped model
 * might return no text at all for a text prompt). Selection is permissive
 * BY DESIGN; the driver's runtime fallback chain is what actually enforces
 * usability — an empty/no-text response demotes the model and moves on to
 * the next ranked candidate (see driver.ts's "no-text" fallback reason).
 * A selector that silently drops candidates on a metadata guess is the
 * failure mode this design deliberately avoids.
 *
 * `split("+").includes(...)` (never a raw substring match) so an input
 * side like `"textual"` does NOT falsely match `"text"`.
 */
function hasTextInputAndOutput(modality: string | undefined): boolean {
  if (!modality) return false;
  const arrow = modality.indexOf("->");
  if (arrow === -1) return false;
  const input = modality.slice(0, arrow);
  const output = modality.slice(arrow + 2);
  return input.split("+").includes("text") && output.split("+").includes("text");
}

/**
 * Pure filter: given a raw catalog snapshot, return the eligible free
 * text->text models, ordered BIGGEST-CONTEXT-FIRST (ties broken by the
 * larger `top_provider.max_completion_tokens`, then by model id ascending
 * for a fully deterministic, reproducible order).
 *
 * With no `minContext`, there is no floor: the caller always gets every
 * eligible model, biggest first — "the biggest free model with the biggest
 * context memory" available TODAY, whatever that is. Passing `minContext`
 * adds an explicit hard requirement: if nothing clears it, this throws
 * (naming the floor and the biggest model that WAS available) rather than
 * silently handing back something smaller than the caller asked for.
 *
 * Throws when the catalog contains no eligible free text->text model at
 * all — this tool must never silently fall back to a paid model.
 */
export function selectEligibleModels(
  catalog: readonly CatalogModel[],
  options: SelectModelsOptions = {},
): EligibleModel[] {
  const all: EligibleModel[] = [];
  for (const m of catalog) {
    const promptPrice = parseFloat(m.pricing?.prompt ?? "NaN");
    const completionPrice = parseFloat(m.pricing?.completion ?? "NaN");
    if (promptPrice !== 0 || completionPrice !== 0) continue;

    if (!hasTextInputAndOutput(m.architecture?.modality)) continue;

    // Cost-safety (TRDD-97ef8b63 chokepoint): only a ':free'-suffixed id is
    // admissible under free_only, and this module must hand out ids that are
    // admissible regardless of the caller's active profile. $0 PRICING IS NOT
    // THE SAME PREDICATE: OpenRouter lists genuinely $0 models whose id carries
    // no ':free' suffix (google/lyria-3-pro-preview is one). Such a model is
    // simply NOT ELIGIBLE, so it is EXCLUDED here.
    //
    // It must be a `continue`, never a throw. This previously called
    // assertFreeOnlyModel() inline, which made one unusable catalog entry fatal
    // to the whole run — and because lyria has the largest context in the free
    // tier it is encountered first, so selection threw before it could reach any
    // usable model. That is exactly how the first live run failed: the command
    // could not summarize anything, reporting a cost-safety bug rather than
    // simply picking the next-biggest model.
    if (!m.id.endsWith(":free")) continue;

    all.push({
      id: m.id,
      contextLength: m.context_length ?? 0,
      maxCompletionTokens: m.top_provider?.max_completion_tokens ?? 0,
    });
  }

  // Biggest context first; equal context breaks on the larger completion
  // ceiling, then on model id so the result is reproducible run to run —
  // never guess a parameter count out of the id string itself.
  all.sort((a, b) => {
    if (b.contextLength !== a.contextLength) return b.contextLength - a.contextLength;
    if (b.maxCompletionTokens !== a.maxCompletionTokens) return b.maxCompletionTokens - a.maxCompletionTokens;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (all.length === 0) {
    throw new Error(
      `session-summary: no free text-capable model found on the OpenRouter catalog. Filters ` +
        `applied: pricing.prompt == 0 AND pricing.completion == 0 AND architecture.modality has ` +
        `"text" on BOTH sides of "->" (e.g. "${TEXT_TO_TEXT_MODALITY}" or "text+image->text+audio"; ` +
        `extra modalities on either side are fine — this only excludes models that cannot take a ` +
        `text prompt or cannot emit text back at all).`,
    );
  }

  if (options.minContext === undefined) {
    return all;
  }

  const eligible = all.filter((m) => m.contextLength >= options.minContext!);
  if (eligible.length === 0) {
    throw new Error(
      `session-summary: no free text-capable model with context_length >= ${options.minContext} ` +
        `found on the OpenRouter catalog (biggest available today: '${all[0].id}' at ` +
        `${all[0].contextLength.toLocaleString()}). Filters applied: pricing.prompt == 0 AND ` +
        `pricing.completion == 0 AND context_length >= ${options.minContext} AND ` +
        `architecture.modality has "text" on both sides of "->" (extra modalities on either side ` +
        `are fine). Drop --min-context to use the biggest model available instead of requiring a ` +
        `hard floor.`,
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
