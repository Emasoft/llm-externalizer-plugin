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
   * `onExcluded` is the optional --preview reason channel (TRDD-SCLGL8T4):
   * when passed, the resolver reports every skipped path with WHY.
   */
  resolveFiles(
    args: Record<string, unknown>,
    onExcluded?: (path: string, reason: string) => void,
  ): { files: string[]; error?: string };
  /** Size of one file on disk. Injected so tests never touch the real fs. */
  fileSizeBytes(path: string): number;
  /**
   * The model slots the run would actually send to: ensemble slots in
   * remote-ensemble mode, else the single backend model. Never empty.
   * `toolName` lets the seam price tool-specific routing — high_quality_scan
   * bills its single premium model, not the cheap ensemble (ultracode F5).
   */
  ensembleSlots(toolName?: string): EstimateModelSlot[];
  /** Live catalog pricing, null when unknown (estimate degrades to tokens-only). */
  pricingFor(modelId: string): EstimatePricing | null;
  /** The max_tokens the run would default to when the caller passes none. */
  defaultMaxTokens(): number;
  /**
   * Calibrated mean completion tokens per request for a tool×model (the
   * output-EWMA sidecar, task #188), or null when no calibration exists.
   * Optional so pure tests and older callers need not provide it.
   */
  calibratedOutputTokens?(
    toolName: string,
    modelId: string,
  ): { ewma: number; n: number } | null;
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

/** One request per resolved file, per slot (the pipeline maps files→calls).
 *  NOT here (ultracode F5/F12, 2026-08-05): `compare_files` sends one request
 *  per PAIR (handled by its own branch below), and `security_scan` runs
 *  through the mass_scouting subsystem on its own model selection — pricing
 *  either with this family produced confidently wrong numbers. */
const PER_FILE_TOOLS = new Set([
  "scan_folder",
  "code_task",
  "chat",
  "check_imports",
  "check_references",
  "check_against_specs",
  "search_existing_implementations",
  "high_quality_scan",
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
  if (toolName === "security_scan") {
    // security_scan routes through the mass_scouting subsystem with its own
    // model selection — pricing it against the profile ensemble quoted models
    // the run never sends to (ultracode F5).
    throw new Error(
      "security_scan runs through the mass_scouting subsystem with its own cost " +
        "controls (--budget-usd / mass-scout-estimate) — this generic estimator " +
        "would price the wrong models.",
    );
  }

  const perFile = PER_FILE_TOOLS.has(toolName);
  const singleCall = SINGLE_CALL_TOOLS.has(toolName);
  const pairTool = toolName === "compare_files";
  if (!perFile && !singleCall && !pairTool) {
    throw new Error(
      `--estimate does not model '${toolName}' yet; refusing to print a guess. ` +
        "File an issue if you need it.",
    );
  }

  // compare_files (ultracode F12) resolves PAIRS, not a flat file list: git
  // mode never calls an LLM at all, file_pairs batch sends one request per
  // 2-element pair, and pair mode requires exactly 2 input_files_paths —
  // mirroring the tool's own three documented input modes.
  let comparePairs: [string, string][] | null = null;
  if (pairTool) {
    if (typeof args.git_repo === "string" && args.git_repo.length > 0) {
      return {
        tool: toolName,
        files: 0,
        requests: 0,
        rows: [],
        totalCeilingUsd: 0,
        totalExpectedUsd: 0,
        notes: ["git mode diffs refs locally — no LLM request, $0 by construction"],
      };
    }
    if (Array.isArray(args.file_pairs) && args.file_pairs.length > 0) {
      comparePairs = (args.file_pairs as unknown[]).filter(
        (e): e is [string, string] =>
          Array.isArray(e) &&
          e.length === 2 &&
          typeof e[0] === "string" &&
          typeof e[1] === "string",
      );
      if (comparePairs.length === 0) {
        throw new Error(
          "estimate aborted — file_pairs contains no [fileA, fileB] pairs " +
            "(single-element entries are group markers, not pairs)",
        );
      }
    }
  }

  // Byte inputs the request payload carries beyond the file bodies:
  // inline instructions, instruction FILES (resolvePrompt inlines their
  // contents into every request), and chat's inline input_files_content.
  const instrFilePaths = Array.isArray(args.instructions_files_paths)
    ? (args.instructions_files_paths as unknown[]).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      )
    : typeof args.instructions_files_paths === "string"
      ? [args.instructions_files_paths]
      : [];
  const instructionBytes =
    (typeof args.instructions === "string" ? Buffer.byteLength(args.instructions) : 0) +
    instrFilePaths.reduce((a, p) => a + deps.fileSizeBytes(p), 0);
  const contentBytes =
    typeof args.input_files_content === "string"
      ? Buffer.byteLength(args.input_files_content)
      : 0;

  let files: string[];
  let chatZeroFiles = false;
  if (comparePairs) {
    files = comparePairs.flat();
  } else {
    const resolved = deps.resolveFiles(args);
    // chat is billable with ZERO files (ultracode F8): instructions-only and
    // input_files_content-only calls are legal paid runs that send exactly
    // one request per slot — aborting on them made "estimate before every
    // paid run" impossible for that shape.
    chatZeroFiles =
      toolName === "chat" &&
      (resolved.error !== undefined || resolved.files.length === 0) &&
      (typeof args.instructions === "string" || instrFilePaths.length > 0 || contentBytes > 0);
    if (resolved.error && !chatZeroFiles) {
      throw new Error(`estimate aborted — file resolution failed: ${resolved.error}`);
    }
    files = chatZeroFiles ? [] : resolved.files;
    if (files.length === 0 && !chatZeroFiles) {
      throw new Error("estimate aborted — the run would process zero files");
    }
    if (pairTool) {
      if (files.length !== 2) {
        throw new Error(
          "estimate aborted — compare_files pair mode needs exactly 2 input_files_paths " +
            "(or use file_pairs for batches, or git_repo for a $0 git diff)",
        );
      }
      comparePairs = [[files[0], files[1]]];
    }
  }
  if (chatZeroFiles) {
    notes.push("no input files — instructions/input_files_content-only chat: one request per slot");
  }

  const fileBytes = files.map((f) => deps.fileSizeBytes(f));
  const totalFileBytes = fileBytes.reduce((a, b) => a + b, 0);

  // Input tokens across the whole run (per slot): per-file tools re-send the
  // instructions + template with EVERY request; single-call tools once;
  // compare_files once per pair (payload ≈ 2×(A+B): the unified diff plus
  // both full file bodies when they fit — worst-case-shaped on purpose).
  const requestsPerSlot = comparePairs
    ? comparePairs.length
    : perFile && !chatZeroFiles
      ? files.length
      : 1;
  const perSlotInputTokens = comparePairs
    ? comparePairs.reduce(
        (sum, [a, b]) =>
          sum +
          estimateTokens(2 * (deps.fileSizeBytes(a) + deps.fileSizeBytes(b))) +
          estimateTokens(instructionBytes) +
          PROMPT_OVERHEAD_TOKENS,
        0,
      )
    : perFile && !chatZeroFiles
      ? fileBytes.reduce(
          (sum, bytes) =>
            sum +
            estimateTokens(bytes) +
            estimateTokens(instructionBytes + contentBytes) +
            PROMPT_OVERHEAD_TOKENS,
          0,
        )
      : estimateTokens(totalFileBytes) +
        estimateTokens(instructionBytes + contentBytes) +
        PROMPT_OVERHEAD_TOKENS;
  if (comparePairs) {
    notes.push("compare_files: one request per pair, payload sized ≈2×(A+B) (diff + full bodies)");
  }

  const requestedMax =
    typeof args.max_tokens === "number" && args.max_tokens > 0
      ? args.max_tokens
      : deps.defaultMaxTokens();

  const slots = deps.ensembleSlots(toolName);
  if (slots.length === 0) {
    throw new Error("estimate aborted — no model slot resolved (no active profile?)");
  }

  const rows: ModelEstimateRow[] = [];
  let totalCeil: number | null = 0;
  let totalExp: number | null = 0;
  for (const slot of slots) {
    const perRequestCeil = Math.min(requestedMax, slot.maxOutput);
    const outCeil = perRequestCeil * requestsPerSlot;
    // EXPECTED prefers the calibrated EWMA once it has ≥3 real samples for
    // this tool×model (task #188); the CEILING is a guarantee and never
    // calibrates. Below 3 samples the constant stays — one lucky short reply
    // must not swing a budget decision.
    const calibrated = deps.calibratedOutputTokens?.(toolName, slot.id) ?? null;
    const perRequestExpected =
      calibrated && calibrated.n >= 3
        ? Math.ceil(calibrated.ewma)
        : EXPECTED_OUTPUT_TOKENS_PER_REQUEST;
    if (calibrated && calibrated.n >= 3) {
      notes.push(
        `${slot.id}: expected calibrated from ${calibrated.n} recorded runs (~${Math.ceil(calibrated.ewma)} tok/request)`,
      );
    }
    const outExp = Math.min(perRequestExpected, perRequestCeil) * requestsPerSlot;
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
