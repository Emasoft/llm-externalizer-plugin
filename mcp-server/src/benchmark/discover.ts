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
 *   - pricing.prompt     <= $1.5 / 1M tokens
 *   - pricing.completion <= $2.0 / 1M tokens
 *   - `:free` tier excluded by default (opt in with allowFree)
 *
 * Models that are manually requested via `includeIds` bypass the
 * cost/capability filters — useful for benchmarking the current
 * production ensemble against the replacement candidates even when it
 * sits just above the cap.
 */

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
  maxInputDollarsPerMillion: 1.5,
  maxOutputDollarsPerMillion: 2.0,
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
  raw: OpenRouterModel;
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
 * Check one model against the criteria. Returns the decorated qualified
 * model when it passes, otherwise null.
 */
export function qualify(m: OpenRouterModel, criteria: ModelCriteria): QualifiedModel | null {
  if (!criteria.allowFree && m.id.endsWith(":free")) return null;
  const params = new Set(m.supported_parameters ?? []);
  const supportsStructured = params.has("structured_outputs") || params.has("response_format");
  const supportsReasoning = params.has("reasoning") || params.has("include_reasoning");
  if (criteria.requireStructuredOutputs && !supportsStructured) return null;
  if (criteria.requireReasoning && !supportsReasoning) return null;

  const ctx = m.context_length ?? 0;
  if (ctx < criteria.minContextTokens) return null;

  const maxOut = m.top_provider?.max_completion_tokens ?? 0;
  if (!maxOut || maxOut < criteria.minOutputTokens) return null;

  const promptPerToken = parseFloat(m.pricing?.prompt ?? "NaN");
  const completionPerToken = parseFloat(m.pricing?.completion ?? "NaN");
  if (!isFinite(promptPerToken) || !isFinite(completionPerToken)) return null;

  const inputDollarsPerMillion = promptPerToken * 1_000_000;
  const outputDollarsPerMillion = completionPerToken * 1_000_000;
  if (inputDollarsPerMillion > criteria.maxInputDollarsPerMillion) return null;
  if (outputDollarsPerMillion > criteria.maxOutputDollarsPerMillion) return null;

  return {
    id: m.id,
    name: m.name ?? m.id,
    contextTokens: ctx,
    maxOutputTokens: maxOut,
    inputDollarsPerMillion,
    outputDollarsPerMillion,
    supportsStructured,
    supportsReasoning,
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
  const baselines: QualifiedModel[] = [];
  for (const id of includeIds) {
    if (inRoster.has(id)) continue;
    const raw = baselineLookupPool.find((m) => m.id === id);
    if (!raw) {
      // Truly unknown — the runner will surface a clear error if the
      // user typed a non-existent model ID. Keep going.
      continue;
    }
    const params = new Set(raw.supported_parameters ?? []);
    const promptPerToken = parseFloat(raw.pricing?.prompt ?? "NaN");
    const completionPerToken = parseFloat(raw.pricing?.completion ?? "NaN");
    baselines.push({
      id: raw.id,
      name: raw.name ?? raw.id,
      contextTokens: raw.context_length ?? 0,
      maxOutputTokens: raw.top_provider?.max_completion_tokens ?? 0,
      inputDollarsPerMillion: isFinite(promptPerToken) ? promptPerToken * 1_000_000 : Infinity,
      outputDollarsPerMillion: isFinite(completionPerToken) ? completionPerToken * 1_000_000 : Infinity,
      supportsStructured: params.has("structured_outputs") || params.has("response_format"),
      supportsReasoning: params.has("reasoning") || params.has("include_reasoning"),
      raw,
    });
  }
  return { candidates, baselines };
}
