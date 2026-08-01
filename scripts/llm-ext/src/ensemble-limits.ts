// ── Ensemble per-model limits (A3, TRDD-828238b5) ──────────────────────
//
// Two fields with DIFFERENT provenance — DO NOT conflate them:
//
//   • maxOutput      — the output-token budget we REQUEST from the model. Our
//     calibrated value (the literals below / DEFAULT_MODEL_LIMITS) is the
//     CEILING. The live catalog `top_provider.max_completion_tokens` can only
//     LOWER it — i.e. we respect a provider that tightened its cap, but we never
//     let the catalog RAISE the budget above our calibrated value.
//     WHY (TRDD-ec45c66f): reasoning models do NOT self-limit. Given a 65K
//     budget they fill it with thinking tokens, every one of which is billed.
//     So a higher cap is a higher BILL, not free headroom. An earlier A3 change
//     made the catalog the authority and let it raise the cap from the 32K
//     default to 65K for models absent from the table — which 2x'd the per-call
//     output cost for the active ensemble. The catalog is a floor-only signal.
//
//   • maxInputLines  — how many source LINES we FEED the model. This is an
//     EMPIRICAL QUALITY cap, deliberately far below each model's architectural
//     context (e.g. grok 20K lines despite its multi-hundred-K-token context)
//     to avoid long-context quality degradation. The catalog does NOT carry a
//     per-model line budget, so this field is NEVER auto-derived from the
//     catalog and MUST stay hand-calibrated. A future maintainer must not
//     "de-hardcode" it into a context_length fraction — that regresses quality.

export interface ModelLimits {
  /** Output-token budget to request (catalog-preferred, see module note). */
  maxOutput: number;
  /** Input LINE cap — empirical quality calibration, never catalog-derived. */
  maxInputLines: number;
}

/**
 * Calibrated per-model limits. `maxOutput` here is the cold-cache fallback;
 * `maxInputLines` is the authoritative quality cap (catalog has no equivalent).
 */
export const KNOWN_MODEL_LIMITS: Record<string, ModelLimits> = {
  "x-ai/grok-4.1-fast": { maxOutput: 30_000, maxInputLines: 20_000 },
  "google/gemini-2.5-flash": { maxOutput: 65_535, maxInputLines: 50_000 },
  // Qwen 3.6 Plus: 1M context, 65K max output.
  "qwen/qwen3.6-plus": { maxOutput: 65_535, maxInputLines: 40_000 },
  // Nemotron 3 Super: 262K context, free on OpenRouter. Conservative 40K-line
  // input cap to avoid quality degradation on very long contexts.
  "nvidia/nemotron-3-super-120b-a12b:free": { maxOutput: 65_535, maxInputLines: 40_000 },
};

/** Fallback for any model not in KNOWN_MODEL_LIMITS (and cold catalog). */
export const DEFAULT_MODEL_LIMITS: ModelLimits = { maxOutput: 32_000, maxInputLines: 30_000 };

/**
 * Catalog `max_completion_tokens` values below this are implausible (truncated
 * or garbage) and are ignored in favour of the calibrated fallback. 1024 is a
 * floor no real chat model undercuts for its output cap.
 */
export const MIN_PLAUSIBLE_MAX_OUTPUT = 1024;

/**
 * Resolve one model's ensemble limits, preferring the live catalog for the
 * catalog-authoritative field and keeping the empirical field hand-calibrated.
 *
 * @param id              model id
 * @param catalogMaxOutput live `top_provider.max_completion_tokens` from the
 *                         warm 1h-TTL catalog cache, or `undefined` when the
 *                         cache is cold or the model is absent from it
 * @param known           calibrated table (injectable for tests)
 * @param fallback        default when the id is in neither catalog nor table
 *
 * maxOutput     ← min(calibrated, live catalog) — catalog can only LOWER it.
 *                 calibrated = known[id].maxOutput ?? fallback.maxOutput
 * maxInputLines ← known[id] → fallback                (NEVER from the catalog)
 */
export function resolveEnsembleModelLimits(
  id: string,
  catalogMaxOutput: number | undefined,
  known: Record<string, ModelLimits> = KNOWN_MODEL_LIMITS,
  fallback: ModelLimits = DEFAULT_MODEL_LIMITS,
): ModelLimits {
  const knownEntry = known[id];
  const maxInputLines = knownEntry?.maxInputLines ?? fallback.maxInputLines;
  // Calibrated ceiling — this is the most output we'll ever REQUEST.
  const calibrated = knownEntry?.maxOutput ?? fallback.maxOutput;
  const liveMaxOutput =
    typeof catalogMaxOutput === "number" &&
    Number.isFinite(catalogMaxOutput) &&
    catalogMaxOutput >= MIN_PLAUSIBLE_MAX_OUTPUT
      ? Math.floor(catalogMaxOutput)
      : undefined;
  // Catalog can only LOWER the budget (provider tightened its cap), never raise
  // it above the calibrated ceiling — a reasoning model spends every extra token
  // of budget on billed thinking (TRDD-ec45c66f).
  const maxOutput =
    liveMaxOutput !== undefined
      ? Math.min(liveMaxOutput, calibrated)
      : calibrated;
  return { maxOutput, maxInputLines };
}
