/**
 * Cost-estimation dry-run for tool invocations (`--estimate`, task #187).
 *
 * USER directive (2026-08-04): every command must be able to report its
 * ESTIMATED cost instead of running — a dry-run gate the paid-mode skills and
 * rules tell agents to run BEFORE any paid operation. The whole module is
 * therefore pure and network-free: deps are injected, no request is ever sent
 * from here, and the CLI routes to it INSTEAD of dispatchCallTool.
 *
 * Token model, deliberately shared with mass_scouting/cost-estimate.ts:
 * bytes / BYTES_PER_TOKEN (4). It overestimates code by ~10-15%, which is the
 * right direction for a budget gate — a surprise overrun is worse than a
 * slight over-quote. (mass_scout keeps its own registry-bound estimator; this
 * one covers the file/instruction tools the funnel dispatches.)
 *
 * Output tokens are the honest hard part: input is deterministic (the bytes
 * are on disk before any send) but completion length is the model's choice.
 * So every estimate carries TWO numbers per model slot:
 *   • CEILING  — every request bills its full max_tokens budget. The number
 *     that can never be exceeded (reasoning models really do hit it).
 *   • EXPECTED — requests average EXPECTED_OUTPUT_TOKENS_PER_REQUEST. A
 *     calibration constant, not a promise; the estimate-vs-actual history
 *     loop can tighten it per tool × model later without changing callers.
 */

import { estimateTokens } from "./mass_scouting/cost-estimate.js";

// ── Calibration constants ──────────────────────────────────────────────

/**
 * Prompt-template overhead per request, in tokens: system prompt, rubric,
 * per-file framing, JSON-schema text. Measured request payloads for
 * scan_folder/code_task sit at 900-1400 tokens of non-file prompt; 1500 keeps
 * the estimate conservative without dominating small files.
 */
export const PROMPT_OVERHEAD_TOKENS = 1500;

/**
 * Expected completion tokens per request for the EXPECTED line. Per-file
 * review reports from the ensemble average 1-3 KB of markdown (≈250-750
 * tokens); reasoning models spend more. 2500 is deliberately above the
 * observed mean — EXPECTED should still lean conservative, just not at the
 * full-ceiling level.
 */
export const EXPECTED_OUTPUT_TOKENS_PER_REQUEST = 2500;

// ── Types ──────────────────────────────────────────────────────────────

export interface EstimatePricing {
  /** USD per 1M input tokens. */
  inputUsdPerM: number;
  /** USD per 1M output tokens. */
  outputUsdPerM: number;
}

export interface EstimateModelSlot {
  id: string;
  /** Per-model completion ceiling (tokens) — clamps max_tokens. */
  maxOutput: number;
}

/** Injected seams — the CLI builds these from index.ts internals. */
export interface EstimateDeps {
  /**
   * Resolve the file set EXACTLY like the real tool would (folder walk,
   * gitignore, extension filter, explicit path list). An estimate computed
   * over a different file set than the run would use is worse than none.
   */
  resolveFiles(args: Record<string, unknown>): { files: string[]; error?: string };
  /** Size of one file on disk. Injected so tests never touch the real fs. */
  fileSizeBytes(path: string): number;
  /**
   * The model slots the run would actually send to: ensemble slots in
   * remote-ensemble mode, else the single backend model. Never empty.
   */
  ensembleSlots(): EstimateModelSlot[];
  /** Live catalog pricing, null when unknown (estimate degrades to tokens-only). */
  pricingFor(modelId: string): EstimatePricing | null;
  /** The max_tokens the run would default to when the caller passes none. */
  defaultMaxTokens(): number;
}

export interface ModelEstimateRow {
  model: string;
  requests: number;
  inputTokens: number;
  outputCeilingTokens: number;
  outputExpectedTokens: number;
  /** null ⇔ pricing unknown for this model (tokens still reported). */
  ceilingUsd: number | null;
  expectedUsd: number | null;
}

export interface ToolEstimate {
  tool: string;
  files: number;
  /** Total requests across all model slots. */
  requests: number;
  rows: ModelEstimateRow[];
  /** null ⇔ at least one slot had unknown pricing. */
  totalCeilingUsd: number | null;
  totalExpectedUsd: number | null;
  notes: string[];
}

// ── Tool families ──────────────────────────────────────────────────────
// How many LLM requests a tool makes per model slot. Kept as explicit sets —
// a tool absent from BOTH sets is one this estimator does not understand,
// and the answer is a fail-fast error, never a silently-wrong guess.

/** One request per resolved file, per slot (the pipeline maps files→calls). */
const PER_FILE_TOOLS = new Set([
  "scan_folder",
  "code_task",
  "chat",
  "check_imports",
  "check_references",
  "check_against_specs",
  "search_existing_implementations",
  "compare_files",
  "high_quality_scan",
  "security_scan",
]);

/** Exactly one request per slot regardless of input size. */
const SINGLE_CALL_TOOLS = new Set(["cluster_synonyms"]);

/** $0 by construction: local/config/read-only tools that never call an LLM. */
const ZERO_COST_TOOLS = new Set([
  "discover",
  "get_settings",
  "reset",
  "or_model_info",
  "or_model_info_by_id",
  // Delegate mode (TRDD-SNAEERHU): emits scaffolding only, the host agent reviews.
  "review_plan",
]);

// ── Core ───────────────────────────────────────────────────────────────

/**
 * Estimate one tool invocation. Pure: reads nothing but the injected deps.
 * Throws (fail-fast) for tools it cannot honestly model — the caller surfaces
 * that instead of printing a fabricated number.
 */
export function estimateToolRun(
  toolName: string,
  args: Record<string, unknown>,
  deps: EstimateDeps,
): ToolEstimate {
  const notes: string[] = [];

  if (ZERO_COST_TOOLS.has(toolName)) {
    return {
      tool: toolName,
      files: 0,
      requests: 0,
      rows: [],
      totalCeilingUsd: 0,
      totalExpectedUsd: 0,
      notes: ["local/read-only tool — no LLM request, $0 by construction"],
    };
  }

  if (toolName.startsWith("mass_scout")) {
    // mass_scout has its own registry-bound estimator with tighter caps —
    // pointing there is more honest than re-deriving a looser number here.
    throw new Error(
      "mass_scout tools carry their own estimator: run the scout with --budget-usd, " +
        "or use mass-scout-estimate — this generic estimator would only be less precise.",
    );
  }

  const perFile = PER_FILE_TOOLS.has(toolName);
  const singleCall = SINGLE_CALL_TOOLS.has(toolName);
  if (!perFile && !singleCall) {
    throw new Error(
      `--estimate does not model '${toolName}' yet; refusing to print a guess. ` +
        "File an issue if you need it.",
    );
  }

  const resolved = deps.resolveFiles(args);
  if (resolved.error) {
    throw new Error(`estimate aborted — file resolution failed: ${resolved.error}`);
  }
  const files = resolved.files;
  if (files.length === 0) {
    throw new Error("estimate aborted — the run would process zero files");
  }

  const instructionBytes =
    typeof args.instructions === "string" ? Buffer.byteLength(args.instructions) : 0;
  const fileBytes = files.map((f) => deps.fileSizeBytes(f));
  const totalFileBytes = fileBytes.reduce((a, b) => a + b, 0);

  // Input tokens across the whole run (per slot): per-file tools re-send the
  // instructions + template with EVERY request; single-call tools once.
  const requestsPerSlot = perFile ? files.length : 1;
  const perSlotInputTokens = perFile
    ? fileBytes.reduce(
        (sum, bytes) =>
          sum +
          estimateTokens(bytes) +
          estimateTokens(instructionBytes) +
          PROMPT_OVERHEAD_TOKENS,
        0,
      )
    : estimateTokens(totalFileBytes) +
      estimateTokens(instructionBytes) +
      PROMPT_OVERHEAD_TOKENS;

  const requestedMax =
    typeof args.max_tokens === "number" && args.max_tokens > 0
      ? args.max_tokens
      : deps.defaultMaxTokens();

  const slots = deps.ensembleSlots();
  if (slots.length === 0) {
    throw new Error("estimate aborted — no model slot resolved (no active profile?)");
  }

  const rows: ModelEstimateRow[] = [];
  let totalCeil: number | null = 0;
  let totalExp: number | null = 0;
  for (const slot of slots) {
    const perRequestCeil = Math.min(requestedMax, slot.maxOutput);
    const outCeil = perRequestCeil * requestsPerSlot;
    const outExp =
      Math.min(EXPECTED_OUTPUT_TOKENS_PER_REQUEST, perRequestCeil) * requestsPerSlot;
    const pricing = slot.id.endsWith(":free")
      ? { inputUsdPerM: 0, outputUsdPerM: 0 }
      : deps.pricingFor(slot.id);
    let ceilingUsd: number | null = null;
    let expectedUsd: number | null = null;
    if (pricing) {
      ceilingUsd =
        (perSlotInputTokens / 1_000_000) * pricing.inputUsdPerM +
        (outCeil / 1_000_000) * pricing.outputUsdPerM;
      expectedUsd =
        (perSlotInputTokens / 1_000_000) * pricing.inputUsdPerM +
        (outExp / 1_000_000) * pricing.outputUsdPerM;
    } else {
      notes.push(`pricing unknown for ${slot.id} — its USD column is blank`);
    }
    rows.push({
      model: slot.id,
      requests: requestsPerSlot,
      inputTokens: perSlotInputTokens,
      outputCeilingTokens: outCeil,
      outputExpectedTokens: outExp,
      ceilingUsd,
      expectedUsd,
    });
    totalCeil = totalCeil === null || ceilingUsd === null ? null : totalCeil + ceilingUsd;
    totalExp = totalExp === null || expectedUsd === null ? null : totalExp + expectedUsd;
  }

  notes.push(
    "retries not included (×1); a rate-limited free run retries at $0, a paid retry re-bills",
  );

  return {
    tool: toolName,
    files: files.length,
    requests: requestsPerSlot * slots.length,
    rows,
    totalCeilingUsd: totalCeil,
    totalExpectedUsd: totalExp,
    notes,
  };
}

// ── Rendering ──────────────────────────────────────────────────────────

const usd = (v: number | null): string => (v === null ? "?" : `$${v.toFixed(4)}`);

/** Plain-terminal table — no UI, no color, greppable. */
export function renderEstimate(e: ToolEstimate): string {
  const lines: string[] = [];
  lines.push(`ESTIMATE (dry-run — nothing was sent) — ${e.tool}`);
  lines.push(`files: ${e.files}   total requests: ${e.requests}`);
  for (const r of e.rows) {
    lines.push(
      `  ${r.model}: ${r.requests} req, in ~${r.inputTokens.toLocaleString()} tok, ` +
        `out ≤${r.outputCeilingTokens.toLocaleString()} tok — ` +
        `expected ${usd(r.expectedUsd)}, ceiling ${usd(r.ceilingUsd)}`,
    );
  }
  lines.push(
    `TOTAL: expected ${usd(e.totalExpectedUsd)}, ceiling ${usd(e.totalCeilingUsd)}`,
  );
  for (const n of e.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}
