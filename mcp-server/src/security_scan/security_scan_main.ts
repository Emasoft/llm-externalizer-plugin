/**
 * Orchestrator — `runSecurityScan(input, deps)`. Ties the bespoke pipeline
 * together: validate → intake (expand + redact + dedup) → pre-flight budget
 * gate → judge (the injection-hardened LLM loop) → aggregate → write report.
 *
 * Fail-safe contract (TRDD §3.7): the ONLY non-zero exit is a usage/shape
 * error (invalid input, missing API key). Everything else — API failure,
 * timeout, circuit-breaker, malformed model output — fans out to the default
 * verdict (uncertain) and still produces a report. The return value carries
 * only the report paths + a one-line counter (TRDD §4).
 */

import {
  bytesCapFromPct,
  checkBudget,
  estimateFileCost,
  KNOWN_PRICING,
  type ModelPricing,
} from "../mass_scouting/cost-estimate";
import { intake } from "./intake";
import { floorFailSafeVerdict, judgeGroups, type FetchImpl } from "./judge";
import { realFetch } from "./openrouter";
import {
  promptOverheadBytes,
  buildSystemPrompt,
  makeNonce,
  preScanInjection,
  schemaOverheadBytes,
} from "./prompt";
import {
  aggregate,
  resolveReportDir,
  writeReport,
  type WrittenReport,
} from "./report";
import {
  validateInput,
  type SecurityScanInput,
  type SecurityScanReport,
} from "./types";

// ── Result envelope (CLI-friendly: stdout/stderr/exitCode) ───────────────

export interface SecurityScanRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The structured report (present iff exitCode === 0). */
  report?: SecurityScanReport;
  paths?: WrittenReport;
}

export interface SecurityScanDeps {
  /** Inject a mock HTTP impl for tests; defaults to the real fetch. */
  fetchImpl?: FetchImpl;
  /** Override the resolved API key (tests inject a stub). */
  apiKey?: string;
  /** Override the main-repo root for report paths (tests use tmpdir). */
  mainRoot?: string;
  /** Pricing override (tests / non-default models). Falls back to KNOWN_PRICING. */
  pricing?: ModelPricing;
  /** Stable job id; defaults to a timestamped value. */
  jobId?: string;
  /** Progress callback forwarded to the judge loop. */
  onProgress?: (done: number, total: number, message?: string) => void;
}

// ── Fallback pricing for unknown models ──────────────────────────────────
// Used only when the model isn't in KNOWN_PRICING and no override is given.
// Conservative numbers keep the budget gate honest; callers wanting accuracy
// can pass `deps.pricing`. The context window matches the qwen default cap so
// the size cap is sane.
const FALLBACK_PRICING: ModelPricing = {
  input_per_m_usd: 1.0,
  output_per_m_usd: 3.0,
  context_window: 32_768,
};

function resolvePricing(model: string, override?: ModelPricing): ModelPricing {
  if (override) return override;
  return KNOWN_PRICING[model] ?? FALLBACK_PRICING;
}

function err(text: string): SecurityScanRunResult {
  return { stdout: "", stderr: `Error: ${text}\n`, exitCode: 1 };
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function runSecurityScan(
  rawInput: unknown,
  deps: SecurityScanDeps = {},
): Promise<SecurityScanRunResult> {
  // 1. Validate (the only hard-error path — §3.7).
  const validation = validateInput(rawInput);
  if (!validation.ok) {
    return err(`invalid input:\n  - ${validation.errors.join("\n  - ")}`);
  }
  const input: Required<
    Pick<
      SecurityScanInput,
      | "targets"
      | "category_rubrics"
      | "default_verdict_on_error"
      | "model"
      | "workers"
      | "max_retries"
      | "per_call_timeout_ms"
      | "consecutive_failure_limit"
    >
  > &
    Pick<
      SecurityScanInput,
      "budget_usd" | "git_diff_ref" | "folder_root" | "output_dir"
    > = validation.value;

  // 2. Resolve API key. Missing key is a fail-safe scenario, NOT a hard error:
  //    we still produce a report where every item is the default verdict.
  const apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
  const pricing = resolvePricing(input.model, deps.pricing);
  const fetchImpl = deps.fetchImpl ?? realFetch;
  const jobId = deps.jobId ?? `security-scan-${Date.now()}`;
  const byteCap = bytesCapFromPct(pricing.context_window, 0.4);

  // 3. Intake — expand, redact, dedup. Pure + synchronous.
  const intakeResult = intake(input.targets, {
    folderRoot: input.folder_root,
    gitDiffRef: input.git_diff_ref,
    honorGitignore: true,
    byteCap,
  });

  // 4. Pre-flight budget gate (whole-job, all-or-nothing — §3.7 / T8). We
  //    estimate using a representative system prompt's overhead so the number
  //    reflects the hardened prompt, not the naive one.
  const sampleNonce = makeNonce();
  const sampleSystemPrompt = buildSystemPrompt({
    nonce: sampleNonce,
    category: intakeResult.groups[0]?.category ?? "sample",
    rubric:
      input.category_rubrics[intakeResult.groups[0]?.category ?? ""] ??
      undefined,
    injectionMarkers: [],
  });
  const promptOverhead = promptOverheadBytes(sampleSystemPrompt, sampleNonce);
  const schemaOverhead = schemaOverheadBytes();

  let estCost = 0;
  for (const g of intakeResult.groups) {
    estCost += estimateFileCost({
      body_bytes: Buffer.byteLength(g.content, "utf-8"),
      prompt_overhead_bytes: promptOverhead,
      schema_overhead_bytes: schemaOverhead,
      expected_output_bytes: 200,
      pricing,
    }).est_cost_usd;
  }

  const budget = input.budget_usd ?? null;
  const gate = checkBudget(estCost, budget);
  if (!gate.allowed) {
    // Documented whole-job refusal (T8): report it, do NOT silently scan a
    // partial set. This still writes a report so the caller has an artifact.
    const report = aggregate({
      jobId,
      model: input.model,
      groups: [],
      verdicts: [],
      skipped: intakeResult.skipped,
      recordsTotal: intakeResult.recordsTotal,
      budgetSpent: 0,
      itemsSkippedOverBudget: intakeResult.recordsTotal,
    });
    const reportDir = resolveReportDir(input.output_dir, deps.mainRoot);
    const paths = writeReport(report, reportDir);
    return {
      stdout: budgetRefusalLine(gate.reason ?? "over budget", paths, estCost),
      stderr: "",
      exitCode: 0,
      report,
      paths,
    };
  }

  // 5. Judge — the injection-hardened LLM loop. If there is no API key, skip
  //    the network entirely and synthesize an all-default-verdict run (§3.7).
  let judge;
  if (!apiKey) {
    // Still run the script-only pre-scan so the report carries injection
    // markers even though no LLM judgement was possible (§3.6 + §3.7).
    judge = {
      verdicts: intakeResult.groups.map((g) => {
        const markers = preScanInjection(g.content).markers;
        return {
          key: g.key,
          payload: {
            // F2 (aegis 2026-05-23): defense-in-depth — even on the no-key path
            // the verdict is floored away from not_threat, so the fail-safe can
            // never fail open regardless of what default was configured.
            verdict: floorFailSafeVerdict(input.default_verdict_on_error),
            confidence: 0,
            reason:
              "Fail-safe: OPENROUTER_API_KEY not configured — no judgement possible.",
            injection_observed: markers.length > 0,
          },
          injectionMarkers: markers,
          failSafe: true,
          costUsd: 0,
        };
      }),
      costUsd: 0,
      circuitTripped: false,
      groupsOk: 0,
      groupsFailSafe: intakeResult.groups.length,
    };
  } else {
    judge = await judgeGroups(
      intakeResult.groups,
      {
        model: input.model,
        apiKey,
        pricing,
        workers: input.workers,
        maxRetries: input.max_retries,
        perCallTimeoutMs: input.per_call_timeout_ms,
        consecutiveFailureLimit: input.consecutive_failure_limit,
        defaultVerdictOnError: input.default_verdict_on_error,
        rubrics: input.category_rubrics,
        onProgress: deps.onProgress
          ? (done, total) =>
              deps.onProgress?.(done, total, `security-scan: ${done}/${total}`)
          : undefined,
      },
      fetchImpl,
    );
  }

  // 6. Aggregate + write.
  const report = aggregate({
    jobId,
    model: input.model,
    groups: intakeResult.groups,
    verdicts: judge.verdicts,
    skipped: intakeResult.skipped,
    recordsTotal: intakeResult.recordsTotal,
    budgetSpent: judge.costUsd,
    itemsSkippedOverBudget: 0,
  });
  const reportDir = resolveReportDir(input.output_dir, deps.mainRoot);
  const paths = writeReport(report, reportDir);

  return {
    stdout: successLine(report, paths, judge.circuitTripped),
    stderr: "",
    exitCode: 0,
    report,
    paths,
  };
}

// ── Return-line formatting (the only thing the tool emits — §4) ──────────

function successLine(
  report: SecurityScanReport,
  paths: WrittenReport,
  circuitTripped: boolean,
): string {
  const s = report.summary;
  const parts = [
    `job_id=${report.job_id}`,
    `items=${s.items_total}`,
    `threat=${s.counts_by_verdict.threat}`,
    `not_threat=${s.counts_by_verdict.not_threat}`,
    `uncertain=${s.counts_by_verdict.uncertain}`,
    `deduped=${s.items_deduped}`,
    `skipped_too_big=${s.items_skipped_too_big}`,
    `spent=$${s.budget_usd_spent.toFixed(6)}`,
  ];
  if (circuitTripped) parts.push("circuit_tripped=true");
  parts.push(`json=${paths.jsonPath}`, `report=${paths.mdPath}`);
  return parts.join("\n") + "\n";
}

function budgetRefusalLine(
  reason: string,
  paths: WrittenReport,
  estCost: number,
): string {
  return (
    [
      `budget_gate=refused`,
      `reason=${reason}`,
      `est_cost_usd=$${estCost.toFixed(6)}`,
      `items_skipped_over_budget=all`,
      `json=${paths.jsonPath}`,
      `report=${paths.mdPath}`,
    ].join("\n") + "\n"
  );
}
