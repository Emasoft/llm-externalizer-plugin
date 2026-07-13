/**
 * OpenRouter model discovery + filtering for the benchmark.
 *
 * Queries https://openrouter.ai/api/v1/models?category=<cat> once, then
 * applies a set of hard constraints that reflect the user's
 * cost-and-capability budget:
 *
 *   - ctx_length >= 128K tokens
 *   - top_provider.max_completion_tokens >= 64K tokens
 *   - supported_parameters includes `structured_outputs` OR `response_format`
 *   - supported_parameters includes `reasoning` OR `include_reasoning`
 *   - pricing.prompt     <  $1.0 / 1M tokens    (STRICTLY less — hard ceiling)
 *   - pricing.completion <  $1.0 / 1M tokens    (STRICTLY less — hard ceiling)
 *   - `:free` tier excluded by default (opt in with allowFree)
 *
 * The $1/M ceiling is intentionally aggressive: ensemble runs touch
 * three models per request, so a $2/M model triples the per-call cost.
 * Models like gemini-3-flash-preview that just clear the bar at $0.60
 * out remain in scope; gemini-3.1-flash-lite-preview at $1.50 out is
 * excluded by this filter even though it's "cheap" relative to flagship
 * frontier models. If the user wants such a model in the ensemble they
 * can still --include it explicitly — the filter only governs the
 * *auto-discovered* candidate pool.
 *
 * Models that are manually requested via `includeIds` bypass the
 * cost/capability filters — useful for benchmarking the current
 * production ensemble against the replacement candidates even when it
 * sits just above the cap.
 */

import { isFreeSuffixModelId } from "./free-mode.js";

export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  };
  supported_parameters?: string[];
  created?: number;
  /**
   * Third-party benchmark rankings OpenRouter ships inline on the public
   * `/api/v1/models` catalog (the key is omitted entirely when a model has no
   * data). Two sub-shapes are used as credit-free quality pre-filters
   * (TRDD-WJND1N2W):
   *   - `artificial_analysis.coding_index` — the user's "codex index" (0-100;
   *     live but under-documented, so always parse defensively).
   *   - `design_arena[]` — per (arena, category) ELO rows; the code signal is
   *     the `arena="models", category="codecategories"` entry's `elo`.
   */
  benchmarks?: {
    artificial_analysis?: {
      coding_index?: number;
      intelligence_index?: number;
      agentic_index?: number;
    };
    design_arena?: Array<{
      arena?: string;
      category?: string;
      elo?: number;
      win_rate?: number;
      rank?: number;
    }>;
  };
}

export interface ModelCriteria {
  category: string;
  minContextTokens: number;
  minOutputTokens: number;
  maxInputDollarsPerMillion: number;
  maxOutputDollarsPerMillion: number;
  requireStructuredOutputs: boolean;
  requireReasoning: boolean;
  allowFree: boolean;
}

export const DEFAULT_CRITERIA: ModelCriteria = {
  category: "programming",
  minContextTokens: 128_000,
  minOutputTokens: 64_000,
  // Hard caps for auto-selection: STRICTLY less than $1/M for both
  // input AND output. Anything at or above is rejected from the
  // candidate pool. The `qualify()` predicate enforces this with `<`
  // (not `<=`) so $1.00 itself is out. Override only via --include.
  maxInputDollarsPerMillion: 1.0,
  maxOutputDollarsPerMillion: 1.0,
  requireStructuredOutputs: true,
  requireReasoning: true,
  allowFree: false,
};

export interface QualifiedModel {
  id: string;
  name: string;
  contextTokens: number;
  maxOutputTokens: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  supportsStructured: boolean;
  supportsReasoning: boolean;
  // Credit-free quality indexes parsed from the catalog `benchmarks` object
  // (TRDD-WJND1N2W). `undefined` means "OpenRouter has no such score for this
  // model" — coverage is partial (~60/339 codex, ~94/339 ELO), so a consumer
  // MUST treat undefined as UNKNOWN, never as "bad" (never drop an unscored
  // model on the strength of a missing index).
  codexIndex?: number;
  designArenaElo?: number;
  raw: OpenRouterModel;
}

/**
 * The Artificial Analysis "Coding Index" (0-100) OpenRouter reports inline as
 * `benchmarks.artificial_analysis.coding_index` — the user's "codex index
 * score". Returns undefined when absent or non-finite. This field is live but
 * NOT in OpenRouter's documented Benchmarks schema, so it is parsed defensively
 * (a future shape change degrades to "unknown", never throws).
 */
export function extractCodexIndex(m: OpenRouterModel): number | undefined {
  const v = m.benchmarks?.artificial_analysis?.coding_index;
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

/**
 * The Design Arena ELO for the code arena — the `benchmarks.design_arena[]` row
 * with `arena === "models"` and `category === "codecategories"`, its `elo`.
 * This is the user's "design arena code categories ELO". Returns undefined when
 * the model has no such row or the elo is non-finite. ELO is computed only
 * among OpenRouter-listed models, so it is comparable cross-model within one
 * catalog snapshot.
 */
export function extractDesignArenaCodeElo(m: OpenRouterModel): number | undefined {
  const row = (m.benchmarks?.design_arena ?? []).find(
    (e) => e.arena === "models" && e.category === "codecategories",
  );
  const v = row?.elo;
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

/**
 * Fetch the OpenRouter model list. No auth required — the model catalog
 * is public (auth is only needed to CALL a model). Pass a category to
 * narrow, or leave undefined to fetch every model (used for baseline
 * lookups where the candidate model is explicitly requested and may
 * not belong to the programming category).
 */
export async function fetchProgrammingModels(category?: string): Promise<OpenRouterModel[]> {
  const url = category
    ? `https://openrouter.ai/api/v1/models?category=${encodeURIComponent(category)}`
    : `https://openrouter.ai/api/v1/models`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`OpenRouter model list fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const body = (await resp.json()) as { data?: OpenRouterModel[] };
  return body.data ?? [];
}

/**
 * Apply the criteria to a raw model list and return only the qualifying
 * entries, decorated with the parsed numeric fields.
 */
export function filterModels(
  models: readonly OpenRouterModel[],
  criteria: ModelCriteria = DEFAULT_CRITERIA,
): QualifiedModel[] {
  const out: QualifiedModel[] = [];
  for (const m of models) {
    const q = qualify(m, criteria);
    if (q) out.push(q);
  }
  return out;
}

/**
 * The qualification PREDICATE as a human-readable reason: returns the first
 * failing criterion as a short string, or null when the model qualifies. This
 * is the single source of truth for "does this model meet these criteria" —
 * `qualify()` delegates the yes/no decision here so the predicate never drifts
 * between the boolean path and the explain path (used by the per-tool assess
 * command, TRDD-f45eeaa0).
 */
export function disqualifyReason(m: OpenRouterModel, criteria: ModelCriteria): string | null {
  if (!criteria.allowFree && m.id.endsWith(":free")) return "free model not allowed (allowFree=false)";
  const params = new Set(m.supported_parameters ?? []);
  const supportsStructured = params.has("structured_outputs") || params.has("response_format");
  const supportsReasoning = params.has("reasoning") || params.has("include_reasoning");
  if (criteria.requireStructuredOutputs && !supportsStructured) {
    return "no structured-output support (needs response_format or structured_outputs)";
  }
  if (criteria.requireReasoning && !supportsReasoning) return "no reasoning support";

  const ctx = m.context_length ?? 0;
  if (ctx < criteria.minContextTokens) return `context ${ctx} < required ${criteria.minContextTokens}`;

  // OpenRouter convention: top_provider.max_completion_tokens === null means
  // "no completion-token cap below context_length" — treat as ctx, not 0.
  // (Treating null as 0 silently rejected models like z-ai/glm-5 that meet
  // every other criterion.) Missing field (undefined) stays 0, since that
  // means we have no information.
  const maxOutRaw = m.top_provider?.max_completion_tokens;
  const maxOut = maxOutRaw === null ? ctx : (maxOutRaw ?? 0);
  if (!maxOut || maxOut < criteria.minOutputTokens) {
    return `max output ${maxOut} < required ${criteria.minOutputTokens}`;
  }

  const promptPerToken = parseFloat(m.pricing?.prompt ?? "NaN");
  const completionPerToken = parseFloat(m.pricing?.completion ?? "NaN");
  if (!isFinite(promptPerToken) || !isFinite(completionPerToken)) return "missing or invalid pricing";

  const inputDollarsPerMillion = promptPerToken * 1_000_000;
  const outputDollarsPerMillion = completionPerToken * 1_000_000;
  // STRICTLY less than the cap (>= rejects), per the auto-selection rule
  // recorded in the llm-externalizer-ensemble-autoselect skill.
  if (inputDollarsPerMillion >= criteria.maxInputDollarsPerMillion) {
    return `input $${inputDollarsPerMillion.toFixed(3)}/M >= cap $${criteria.maxInputDollarsPerMillion.toFixed(3)}/M`;
  }
  if (outputDollarsPerMillion >= criteria.maxOutputDollarsPerMillion) {
    return `output $${outputDollarsPerMillion.toFixed(3)}/M >= cap $${criteria.maxOutputDollarsPerMillion.toFixed(3)}/M`;
  }
  return null;
}

/**
 * Check one model against the criteria. Returns the decorated qualified
 * model when it passes, otherwise null. The pass/fail decision is delegated to
 * `disqualifyReason()` so the predicate stays single-sourced.
 */
export function qualify(m: OpenRouterModel, criteria: ModelCriteria): QualifiedModel | null {
  if (disqualifyReason(m, criteria) !== null) return null;

  // All checks passed — recompute the decorated numeric fields for the result.
  const params = new Set(m.supported_parameters ?? []);
  const supportsStructured = params.has("structured_outputs") || params.has("response_format");
  const supportsReasoning = params.has("reasoning") || params.has("include_reasoning");
  const ctx = m.context_length ?? 0;
  const maxOutRaw = m.top_provider?.max_completion_tokens;
  const maxOut = maxOutRaw === null ? ctx : (maxOutRaw ?? 0);
  const inputDollarsPerMillion = parseFloat(m.pricing?.prompt ?? "NaN") * 1_000_000;
  const outputDollarsPerMillion = parseFloat(m.pricing?.completion ?? "NaN") * 1_000_000;

  return {
    id: m.id,
    name: m.name ?? m.id,
    contextTokens: ctx,
    maxOutputTokens: maxOut,
    inputDollarsPerMillion,
    outputDollarsPerMillion,
    supportsStructured,
    supportsReasoning,
    codexIndex: extractCodexIndex(m),
    designArenaElo: extractDesignArenaCodeElo(m),
    raw: m,
  };
}

/**
 * Build the final benchmark roster: all qualifying candidates, plus any
 * explicitly requested baseline IDs (the "currently in production"
 * ensemble that needs a fair comparison even if it exceeds the budget).
 *
 * The candidate pool is filtered via `qualify()`; the baseline pool is
 * only used to look up IDs the user asked for by name, and is NOT
 * filter-applied. Passing the same list for both is fine when every
 * baseline sits inside the candidate pool; pass a larger baseline pool
 * (e.g. the full OpenRouter catalog) when baselines can fall outside.
 *
 * Baselines receive best-effort numeric fields; qualify() is not run
 * against them. De-duplication: if a baseline ID is already a candidate
 * it is dropped from the baseline list (no double-counting).
 */
export function buildBenchmarkRoster(
  candidatePool: readonly OpenRouterModel[],
  criteria: ModelCriteria,
  includeIds: readonly string[],
  baselineLookupPool: readonly OpenRouterModel[] = candidatePool,
): { candidates: QualifiedModel[]; baselines: QualifiedModel[] } {
  const candidates = filterModels(candidatePool, criteria);
  const inRoster = new Set(candidates.map((m) => m.id));
  // The docstring promises "no double-counting" — but a duplicate id in
  // `includeIds` (e.g. ["openai/gpt-5", "openai/gpt-5"]) used to push the
  // same baseline twice. Track baseline ids alongside candidate ids and
  // skip duplicates regardless of which list they came from.
  const seen = new Set(inRoster);
  const baselines: QualifiedModel[] = [];
  for (const id of includeIds) {
    if (seen.has(id)) continue;
    const raw = baselineLookupPool.find((m) => m.id === id);
    if (!raw) {
      // Truly unknown — the runner will surface a clear error if the
      // user typed a non-existent model ID. Keep going.
      continue;
    }
    const params = new Set(raw.supported_parameters ?? []);
    const promptPerToken = parseFloat(raw.pricing?.prompt ?? "NaN");
    const completionPerToken = parseFloat(raw.pricing?.completion ?? "NaN");
    // Same null-as-context-length normalisation as qualify(): an
    // explicit null means "no completion-token cap"; missing field stays 0.
    const ctx = raw.context_length ?? 0;
    const maxOutRaw = raw.top_provider?.max_completion_tokens;
    const maxOut = maxOutRaw === null ? ctx : (maxOutRaw ?? 0);
    baselines.push({
      id: raw.id,
      name: raw.name ?? raw.id,
      contextTokens: ctx,
      maxOutputTokens: maxOut,
      inputDollarsPerMillion: isFinite(promptPerToken) ? promptPerToken * 1_000_000 : Infinity,
      outputDollarsPerMillion: isFinite(completionPerToken) ? completionPerToken * 1_000_000 : Infinity,
      supportsStructured: params.has("structured_outputs") || params.has("response_format"),
      supportsReasoning: params.has("reasoning") || params.has("include_reasoning"),
      codexIndex: extractCodexIndex(raw),
      designArenaElo: extractDesignArenaCodeElo(raw),
      raw,
    });
    seen.add(raw.id);
  }
  return { candidates, baselines };
}

/**
 * Rank qualified candidates by their catalog quality indexes (codex coding_index
 * + design-arena code ELO), BEST FIRST, so a credit-bounded benchmark spends its
 * budget on the most-promising candidates rather than an arbitrary subset
 * (TRDD-WJND1N2W P2 — "use the indexes to restrict candidates before the paid
 * benchmark and consuming tokens").
 *
 * Order, by priority:
 *   1. A model with AT LEAST ONE index ranks ABOVE a model with neither. A
 *      missing index means UNKNOWN, not bad (coverage is only ~18-28% of the
 *      catalog), so unscored models are only DEPRIORITISED, never dropped — they
 *      stay reachable via a larger top-N or an explicit include.
 *   2. Among scored models, higher composite quality first. codex (0-100) and ELO
 *      (~1200-1420) live on different scales, so each PRESENT axis is min-max
 *      normalised to [0,1] WITHIN this candidate set and the score is the MEAN of
 *      the present axes (a one-axis model is judged on that axis, not penalised
 *      for the absent one).
 *   3. Cheapest (input+output $/M) breaks quality ties — keeps "best CHEAP model"
 *      intact and orders the entire unscored tier by price (the prior behaviour
 *      of the cheapest-first candidate sort).
 *   4. id ascending is the final deterministic tiebreak (stable across runs).
 *
 * Pure + non-mutating: returns a new array; the input is untouched.
 */
export function rankByQualityIndex(models: readonly QualifiedModel[]): QualifiedModel[] {
  const codexVals = models.map((m) => m.codexIndex).filter((v): v is number => v !== undefined);
  const eloVals = models.map((m) => m.designArenaElo).filter((v): v is number => v !== undefined);
  const normalise = (v: number | undefined, pool: number[]): number | undefined => {
    if (v === undefined || pool.length === 0) return undefined;
    const lo = Math.min(...pool);
    const hi = Math.max(...pool);
    // All-equal pool (incl. a single scored model) → 1: they tie at the top of
    // that axis, so the OTHER axis / cheapness decides the order (no div-by-zero).
    return hi === lo ? 1 : (v - lo) / (hi - lo);
  };
  const qualityScore = (m: QualifiedModel): number | undefined => {
    const axes = [normalise(m.codexIndex, codexVals), normalise(m.designArenaElo, eloVals)].filter(
      (v): v is number => v !== undefined,
    );
    return axes.length === 0 ? undefined : axes.reduce((a, b) => a + b, 0) / axes.length;
  };
  const cheapness = (m: QualifiedModel): number => m.inputDollarsPerMillion + m.outputDollarsPerMillion;
  return [...models].sort((a, b) => {
    const sa = qualityScore(a);
    const sb = qualityScore(b);
    if ((sa === undefined) !== (sb === undefined)) return sa === undefined ? 1 : -1; // scored before unscored
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa; // higher score first
    const ca = cheapness(a);
    const cb = cheapness(b);
    if (ca !== cb) return ca - cb; // cheaper first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic
  });
}

/**
 * True iff a model's catalog pricing is exactly zero on BOTH axes — i.e. it is
 * genuinely free to call right now, REGARDLESS of a `:free` id suffix. This is
 * the SEMANTIC zero-cost test that admits open-beta "free for now" models (e.g.
 * `openrouter/owl-alpha`, which has NO `:free` suffix) into free-mode use
 * WITHOUT surrendering the zero-spend guarantee: OpenRouter bills per the SAME
 * catalog price these numbers are parsed from, so price-0 = $0 for the call, and
 * if a beta model ever flips to paid its re-read price is non-zero → not free →
 * rejected (fail-safe). `NaN` / `Infinity` (missing or unparseable pricing — e.g.
 * a baseline with no catalog entry) are not `=== 0`, so they also fail to "not
 * free", never silently billing. (TRDD-WJND1N2W P3.)
 */
export function isZeroCostPriced(
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number,
): boolean {
  return inputDollarsPerMillion === 0 && outputDollarsPerMillion === 0;
}

/**
 * The single predicate the runtime `free_only` cost-safety chokepoint enforces
 * (runner.ts): a model may be called/benchmarked under a free_only profile iff
 * it is zero-cost — a `:free` id (the historical syntactic guarantee) OR catalog
 * price exactly 0 (the semantic guarantee that admits open-beta no-suffix models
 * like `openrouter/owl-alpha`). Replacing the bare `endsWith(":free")` check with
 * this preserves "zero-spend by construction" — anything not provably free
 * (positive price, or NaN/Infinity from missing pricing) returns false and is
 * rejected, never billed. (TRDD-WJND1N2W P3.)
 */
export function isFreeModeEligible(
  id: string,
  inputDollarsPerMillion: number,
  outputDollarsPerMillion: number,
): boolean {
  return id.endsWith(":free") || isZeroCostPriced(inputDollarsPerMillion, outputDollarsPerMillion);
}

/**
 * Keep ONLY ids that carry OpenRouter's ':free' suffix — exactly the set the runtime
 * send-time cost-safety chokepoint `assertFreeOnlyModel` (config.ts) admits under a
 * free_only profile. That guard has NO catalog-price context, so a zero-cost model that
 * LACKS the suffix — a ROUTER/auto pseudo-model such as `openrouter/free` /
 * `openrouter/auto`, or an open-beta no-suffix model — is REJECTED there and THROWS
 * before its request. `resolveFreePool`, by contrast, admits any zero-cost-priced id
 * (isZeroCostPriced, which intentionally welcomes no-suffix betas for a non-free_only
 * `--bench-free-pool`). Filtering a free candidate pool through this before it feeds a
 * free_only sweep is what stops a non-':free' id from reaching a benchmark: sending it is
 * impossible (assertFreeOnlyModel throws), writing it to `free_models` is impossible
 * (config.ts rejects it), and a SINGLE such id thrown inside one tool's judge would abort
 * an entire `--update-all --free` sweep. Predicate is IDENTICAL to assertFreeOnlyModel's
 * (`endsWith(":free")`) so the pool matches precisely what can actually be sent.
 */
export function freeSuffixOnly(ids: readonly string[]): string[] {
  // Delegates to the ONE predicate (free-mode.ts) so the pool filter, the
  // per-benchmark model skip, and assertFreeOnlyModel can never drift apart.
  return ids.filter(isFreeSuffixModelId);
}

export interface FreePoolResolution {
  /** The verified zero-cost pool: configured ids that passed + auto-discovered, deduped. */
  pool: string[];
  /** The ids auto-discovery ADDED (for logging) — a subset of `pool`. */
  autoDiscovered: string[];
  /** Configured non-`:free` ids that the catalog does NOT price at $0 — the caller MUST fail fast. */
  rejected: string[];
}

/**
 * Resolve a dedicated free-pool id list against the LIVE catalog into a set that
 * is provably zero-cost, and optionally AUTO-DISCOVER every other zero-cost model
 * (TRDD-WJND1N2W P3b — the "do this automatically for all models" ask).
 *
 * WHY this verifies price here instead of trusting the runtime chokepoint: the
 * `runner.ts` free_only guard only fires when a free_only profile is ACTIVE, but
 * `--bench-free-pool` can run without one — so this resolution is the only thing
 * standing between a mis-listed PAID model and a real charge. A configured
 * non-`:free` id is therefore admitted ONLY when the catalog prices it at exactly
 * $0 (both axes); anything priced, or absent from the catalog, lands in `rejected`
 * and the caller fails fast BEFORE any benchmark runs. `:free` ids are admitted
 * as-is (the suffix is OpenRouter's own free-tier marker).
 *
 * Auto-discovery applies the SAME structural bar as candidate selection (structured
 * output, reasoning, context, output length) minus the price cap and the `:free`
 * exclusion — a model that cannot do structured output would fail the benchmark
 * anyway — then keeps only the zero-cost survivors, ranks them by the free quality
 * indexes (so the BEST free models benchmark first), and caps at `autoDiscoverTopN`.
 * This is what admits open-beta no-suffix models like `openrouter/owl-alpha`.
 */
export function resolveFreePool(
  configuredIds: readonly string[],
  catalog: readonly OpenRouterModel[],
  opts: { autoDiscover: boolean; autoDiscoverTopN: number },
): FreePoolResolution {
  const pricePerMillion = (m: OpenRouterModel): { input: number; output: number } => ({
    input: parseFloat(m.pricing?.prompt ?? "NaN") * 1_000_000,
    output: parseFloat(m.pricing?.completion ?? "NaN") * 1_000_000,
  });
  const priceById = new Map<string, { input: number; output: number }>();
  for (const m of catalog) priceById.set(m.id, pricePerMillion(m));

  const pool: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      pool.push(id);
    }
  };

  // 1) Configured pool — :free as-is; a non-:free id ONLY if the catalog proves $0.
  const rejected: string[] = [];
  for (const id of configuredIds) {
    if (id.endsWith(":free")) {
      add(id);
      continue;
    }
    const p = priceById.get(id);
    if (p && isZeroCostPriced(p.input, p.output)) add(id);
    else rejected.push(id); // priced, or absent from the catalog → fail-safe reject
  }

  // 2) Auto-discovery — structurally-qualified, zero-cost catalog models, best-first.
  const autoDiscovered: string[] = [];
  if (opts.autoDiscover) {
    const freeCriteria: ModelCriteria = {
      ...DEFAULT_CRITERIA,
      allowFree: true,
      maxInputDollarsPerMillion: Infinity,
      maxOutputDollarsPerMillion: Infinity,
    };
    const zeroCost = filterModels(catalog, freeCriteria).filter((q) =>
      isZeroCostPriced(q.inputDollarsPerMillion, q.outputDollarsPerMillion),
    );
    for (const q of rankByQualityIndex(zeroCost).slice(0, opts.autoDiscoverTopN)) {
      if (!seen.has(q.id)) {
        add(q.id);
        autoDiscovered.push(q.id);
      }
    }
  }

  return { pool, autoDiscovered, rejected };
}
