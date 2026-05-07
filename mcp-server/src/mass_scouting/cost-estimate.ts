/**
 * Cost + ETA estimator for a mass-scouting run. Pure functions — no I/O,
 * no network — so the estimate phase is instant and the budget gate is
 * deterministic.
 *
 * The token model is the simple "chars / TOKENS_PER_CHAR_DIVISOR" heuristic
 * (conservatively 4). It overestimates by ~10-15% for English ASCII source
 * code, which is the right direction for a budget gate: the user is more
 * upset by a surprise overrun than by a slight under-quote.
 *
 * Pricing comes from the caller. The default `qwen/qwen-2.5-7b-instruct`
 * entry in `KNOWN_PRICING` is taken from the blueprint (§3.1, $0.04/M in
 * + $0.10/M out, 128K context). Real-world prices drift; if the caller
 * has fresher numbers, they pass them in and KNOWN_PRICING is ignored.
 *
 * Cap policy (TRDD §15 Q5/Q6):
 *   • register cap = 50% of model context (rejected at registration; here
 *     we don't enforce it again — it's already enforced by `mass_scout_register`
 *     before the row exists. We DO double-check though, because a registry
 *     written under one model can be queried under another with smaller
 *     context).
 *   • scout    cap = 40% of model context (the file is in the registry but
 *     skipped at scout time; reported as `files_skipped_too_big`).
 */

import type { Registry, RegistryRow } from "./registry";

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Bytes-per-token heuristic. 4 is the OpenAI rule-of-thumb for English
 * text; for source code it's actually closer to 3.3 (lots of whitespace
 * compresses well), so 4 leaves a small safety margin in the estimator.
 */
export const BYTES_PER_TOKEN = 4;

/** Default scout-time max as a fraction of model context. */
export const DEFAULT_MAX_CONTEXT_PCT_SCOUT = 0.4;

/** Default register-time max — also applied here for sanity. */
export const DEFAULT_MAX_CONTEXT_PCT_REGISTER = 0.5;

// ── Types ──────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD per 1M input tokens (prompt). */
  input_per_m_usd: number;
  /** USD per 1M output tokens (completion). */
  output_per_m_usd: number;
  /** Context window in tokens (prompt + completion). */
  context_window: number;
}

/** Inputs needed to estimate a single file's cost. */
export interface FileCostInputs {
  /** Length of the cached body, in bytes. */
  body_bytes: number;
  /** Length of the rendered prompt template (without the body), in bytes. */
  prompt_overhead_bytes: number;
  /** Length of the compiled JSON Schema string, in bytes. */
  schema_overhead_bytes: number;
  /**
   * Estimated bytes of model output (the JSON object that satisfies the
   * schema). Caller derives this from the fieldset — typically 80-300 bytes.
   */
  expected_output_bytes: number;
  pricing: ModelPricing;
}

export interface FileCostResult {
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

export interface JobEstimateOptions {
  pricing: ModelPricing;
  /** Bytes of prompt template (rendered §5.5 minus the body). */
  prompt_overhead_bytes: number;
  /** Bytes of the compiled JSON schema string. */
  schema_overhead_bytes: number;
  /** Bytes of the expected JSON output for this fieldset. */
  expected_output_bytes: number;
  /** Optional preclassifier bucket filter (matches `listEligible({bucket})`). */
  bucket?: string;
  /** Number of OpenRouter workers (for ETA). Default 256 from blueprint §3.2. */
  worker_count?: number;
  /**
   * Average wall-clock seconds per call when the worker is busy. Blueprint
   * §3.2 row "256 workers, qwen-7b" measured ≈0.9s; we use 1.0 to leave a
   * safety margin.
   */
  per_call_seconds?: number;
  /** Override `DEFAULT_MAX_CONTEXT_PCT_SCOUT` (e.g. 0.3 for tighter cap). */
  max_context_pct_scout?: number;
  /** Override `DEFAULT_MAX_CONTEXT_PCT_REGISTER`. */
  max_context_pct_register?: number;
}

export interface BucketEstimate {
  bucket: string;
  files: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface JobEstimate {
  /** Files that pass every cap and will be sent to the LLM. */
  files_eligible: number;
  /** Files in the registry but above the 40% scout cap (skipped at scout). */
  files_skipped_too_big: number;
  /** Files above the 50% registration cap — should never happen post-register; flagged separately. */
  files_over_register_cap: number;
  total_input_tokens: number;
  total_output_tokens: number;
  est_cost_usd: number;
  /** Wall-clock seconds at `worker_count` parallelism. */
  est_seconds: number;
  /**
   * Per-preclassifier-bucket breakdown of cost / tokens / files. Useful
   * for "documentation costs $X, sourcecode costs $Y" reasoning before
   * picking a `--bucket` filter. Buckets with zero eligible files are
   * omitted. Sorted by cost desc.
   */
  by_bucket: BucketEstimate[];
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

// ── Built-in pricing table ─────────────────────────────────────────────

/**
 * Hard-coded pricing for the default model. Real OpenRouter prices shift;
 * if a caller wants live prices they look them up via the existing
 * `or_model_info_*` plumbing in `index.ts` and pass `ModelPricing` in.
 *
 * Empirical calibration (2026-05-06,
 *   reports/mass_scouting_calibration/20260506_175433+0200-tweet-classification.md):
 * the active OpenRouter provider for `qwen/qwen-2.5-7b-instruct` caps
 * inputs at **32_768 tokens** despite the model's architectural 128K
 * limit. Files larger than ≈ 32 768 × 4 bytes = 128 KB return
 *   HTTP 400 "This endpoint's maximum context length is 32768 tokens".
 * We use the provider ceiling here so the default 40%/50% caps
 * (~51 KB scout / ~64 KB register) land inside the truth. Callers who
 * route to a different provider with a higher endpoint cap can override
 * `context_window` per-request.
 */
export const KNOWN_PRICING: Record<string, ModelPricing> = {
  "qwen/qwen-2.5-7b-instruct": {
    input_per_m_usd: 0.04,
    output_per_m_usd: 0.1,
    context_window: 32_768,
  },
};

// ── Pure helpers ───────────────────────────────────────────────────────

/**
 * Convert byte count to estimated token count via the cheap divisor model.
 * `Math.ceil` ensures even tiny files contribute ≥ 1 token to the estimate.
 */
export function estimateTokens(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** Per-file cost of one LLM call. */
export function estimateFileCost(args: FileCostInputs): FileCostResult {
  const inputTokens =
    estimateTokens(args.body_bytes) +
    estimateTokens(args.prompt_overhead_bytes) +
    estimateTokens(args.schema_overhead_bytes);
  const outputTokens = estimateTokens(args.expected_output_bytes);
  const cost =
    (inputTokens / 1_000_000) * args.pricing.input_per_m_usd +
    (outputTokens / 1_000_000) * args.pricing.output_per_m_usd;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    est_cost_usd: cost,
  };
}

/**
 * Convert "fraction of context" into a byte cap. The caps are stored as
 * a fraction × context_window; multiplied by `BYTES_PER_TOKEN` gives the
 * inclusive byte cap for the file body.
 *
 * Example: 32K context × 0.4 × 4 bytes/token = 51,200 byte cap → any body
 * larger than 51,200 bytes is skipped at scout time.
 */
export function bytesCapFromPct(
  contextWindow: number,
  pct: number,
): number {
  if (contextWindow <= 0 || pct <= 0) return 0;
  return Math.floor(contextWindow * pct * BYTES_PER_TOKEN);
}

// ── Job-level estimate (Registry-bound) ────────────────────────────────

/**
 * Walk the registry, sum tokens / cost, count caps. Pure aside from
 * reading the registry. The body cache is NOT touched — only the
 * `file_size_bytes` column on `file_short_id`. (Token-frugality: estimating
 * never re-reads any body.)
 */
export function estimateJobCost(
  reg: Registry,
  opts: JobEstimateOptions,
): JobEstimate {
  const scoutPct = opts.max_context_pct_scout ?? DEFAULT_MAX_CONTEXT_PCT_SCOUT;
  const registerPct =
    opts.max_context_pct_register ?? DEFAULT_MAX_CONTEXT_PCT_REGISTER;
  const scoutCap = bytesCapFromPct(opts.pricing.context_window, scoutPct);
  const registerCap = bytesCapFromPct(
    opts.pricing.context_window,
    registerPct,
  );

  const rows: RegistryRow[] = reg.listEligible(
    opts.bucket !== undefined ? { bucket: opts.bucket } : {},
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let eligible = 0;
  let skippedTooBig = 0;
  let overRegisterCap = 0;
  // Per-bucket aggregates — only count files that pass every cap.
  const buckets = new Map<string, BucketEstimate>();
  const bumpBucket = (
    bucket: string,
    fc: FileCostResult,
  ): void => {
    let b = buckets.get(bucket);
    if (!b) {
      b = {
        bucket,
        files: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      };
      buckets.set(bucket, b);
    }
    b.files++;
    b.input_tokens += fc.input_tokens;
    b.output_tokens += fc.output_tokens;
    b.cost_usd += fc.est_cost_usd;
  };

  for (const row of rows) {
    const bytes = row.file_size_bytes;
    if (bytes > registerCap) {
      // Should be impossible in practice — caller registered with a cap
      // already. Counted separately so the report can flag the anomaly.
      overRegisterCap++;
      continue;
    }
    if (bytes > scoutCap) {
      skippedTooBig++;
      continue;
    }
    const fc = estimateFileCost({
      body_bytes: bytes,
      prompt_overhead_bytes: opts.prompt_overhead_bytes,
      schema_overhead_bytes: opts.schema_overhead_bytes,
      expected_output_bytes: opts.expected_output_bytes,
      pricing: opts.pricing,
    });
    totalInputTokens += fc.input_tokens;
    totalOutputTokens += fc.output_tokens;
    totalCost += fc.est_cost_usd;
    eligible++;
    bumpBucket(row.classifier_bucket ?? "unknown", fc);
  }
  const by_bucket = Array.from(buckets.values()).sort(
    (a, b) => b.cost_usd - a.cost_usd,
  );

  const workers = Math.max(1, opts.worker_count ?? 256);
  const perCall = opts.per_call_seconds ?? 1.0;
  // Floor at 1 if any work was scheduled — protects callers from rendering
  // "0 seconds" for tiny runs (which would also break ETA UIs).
  const estSeconds =
    eligible === 0 ? 0 : Math.max(1, Math.ceil((eligible * perCall) / workers));

  return {
    files_eligible: eligible,
    files_skipped_too_big: skippedTooBig,
    files_over_register_cap: overRegisterCap,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    est_cost_usd: totalCost,
    est_seconds: estSeconds,
    by_bucket,
  };
}

// ── Budget gate ────────────────────────────────────────────────────────

/**
 * Fetch the active provider's actual `context_length` from OpenRouter
 * for `modelId`. The architectural ceiling baked into KNOWN_PRICING
 * is the model's MAX, not the provider's cap — providers commonly
 * route to endpoints with a smaller cap (32K vs 128K, see calibration
 * report 2026-05-06). Returns the smallest `context_length` across
 * available endpoints (defensive — the smallest is what we'll actually hit).
 *
 * Returns `null` on any failure (network, parse, missing key, etc.); the
 * caller should fall back to KNOWN_PRICING. Tests inject `fetchImpl`.
 */
export async function fetchProviderContext(
  modelId: string,
  apiKey: string,
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  baseUrl = "https://openrouter.ai/api/v1",
): Promise<number | null> {
  if (!modelId || !apiKey) return null;
  try {
    const url = `${baseUrl}/models/${encodeURIComponent(modelId)}/endpoints`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      data?: { endpoints?: { context_length?: number }[] };
    };
    const endpoints = payload?.data?.endpoints ?? [];
    let smallest: number | null = null;
    for (const ep of endpoints) {
      const c = ep.context_length;
      if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
      if (smallest === null || c < smallest) smallest = c;
    }
    return smallest;
  } catch {
    return null;
  }
}

/**
 * Compare an estimate against the user's `--budget-usd` value (TRDD §15 Q4).
 * Returns `{allowed: false, reason}` if over budget. `null` budget means
 * "no gate" — caller did not opt-in to enforcement.
 */
export function checkBudget(
  estCostUsd: number,
  budgetUsd: number | null,
): BudgetCheckResult {
  if (budgetUsd === null || budgetUsd === undefined) {
    return { allowed: true };
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    return {
      allowed: false,
      reason: `Invalid --budget-usd value ${budgetUsd}`,
    };
  }
  if (estCostUsd <= budgetUsd) return { allowed: true };
  const over = estCostUsd - budgetUsd;
  return {
    allowed: false,
    reason: `Estimated cost $${estCostUsd.toFixed(4)} exceeds budget $${budgetUsd.toFixed(4)} by $${over.toFixed(4)}`,
  };
}
