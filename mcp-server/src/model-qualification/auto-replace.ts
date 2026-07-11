/**
 * Auto-replacement loop CORE (TRDD-828238b5 A7-P2).
 *
 * The durable model-health ledger (A1) records every per-call mitigation event
 * keyed by model id, and `aggregateModelHealth` (model-events.ts) turns a window
 * of those events into a per-model `degraded` verdict. The per-tool benchmarks
 * (security-triage, search-existing, code-task, scan-folder) already know how to
 * score candidate models and pick the best same-or-cheaper passer. This module
 * joins the two:
 *
 *   for every tool that HAS a benchmark, ask "is its incumbent model degraded?"
 *   and, if so (or when the operator forces an explicit audit), run that tool's
 *   benchmark and surface the recommended replacement.
 *
 * It is the ADVISORY half of A7. `planToolReplacements` NEVER writes config — it
 * only computes findings + a markdown report. The CLI/cron writer that actually
 * mutates a settings.yaml `tool_models` entry lives in benchmark/pick.ts
 * (`applyToolModelToSettings`), behind the read-only-MCP guardrail. Splitting it
 * this way keeps the MCP surface incapable of self-rewriting its own config (the
 * standing read-only-MCP invariant) while a human-run CLI / scheduled cron can
 * adopt the recommendation deliberately.
 *
 * IO seams are injected so the whole planner is unit-testable WITHOUT network:
 *   - `settingsReader`   — resolves the incumbent model per tool (defaults to the
 *                          real loadSettings → resolveProfile → resolveModelForTool
 *                          chain).
 *   - `benchmarkRunner`  — runs a tool's benchmark over candidates (defaults to
 *                          dispatching to the real security-triage / search-existing /
 *                          code-task / scan-folder orchestrator by the registry's
 *                          `.benchmark` string).
 *   - `eventsPath`       — the ledger file to aggregate (defaults to the real
 *                          model-events.log via readModelEvents).
 */

import {
  aggregateModelHealth,
  assessModelPersistence,
  readModelEvents,
  type AggregateOptions,
  type ModelHealthSummary,
  type ModelPersistenceVerdict,
  type PersistenceOptions,
} from "../model-events.js";
import { ENSEMBLE_SLOTS, type EnsembleSlot } from "../benchmark/pick.js";
import {
  loadSettings,
  resolveModelForTool,
  resolveProfile,
} from "../config.js";
import { DEFAULT_MODEL } from "../security_scan/types.js";
import { TOOL_MODEL_REGISTRY } from "./registry.js";
import { runSecurityTriageBenchmark } from "../benchmark/security-triage/index.js";
import { runSearchExistingBenchmark } from "../benchmark/search-existing/index.js";
import { runCodeAuditBenchmark } from "../benchmark/code-task/index.js";
import { runScanFolderBenchmark } from "../benchmark/scan-folder/index.js";

/** A model the benchmark rejected (mirrors the selectors' RejectedCandidate). */
export interface RejectedReplacement {
  modelId: string;
  reason: string;
}

/**
 * One tool's auto-replacement verdict. Carries the incumbent, its ledger health,
 * whether the benchmark actually ran, and what (if anything) it recommends.
 * `changed === true` means the benchmark found a same-or-cheaper passer that
 * beats the incumbent — a recommendation to adopt, NOT an applied change.
 */
export interface ToolReplacementFinding {
  tool: string;
  benchmark: string;
  incumbentModelId: string;
  /** The incumbent's rolled-up health over the ledger window. */
  health: ModelHealthSummary;
  /** True when the ledger crossed a degradation threshold for the incumbent. */
  degraded: boolean;
  /** True when this tool's benchmark was actually executed (degraded OR force). */
  ranBenchmark: boolean;
  /** The model the benchmark recommends (== incumbent when no benchmark ran). */
  recommendedModelId: string;
  /** True iff the recommendation differs from the incumbent. */
  changed: boolean;
  /** One-line human rationale. */
  reason: string;
  /** Models the benchmark rejected (only when ranBenchmark === true). */
  rejected?: RejectedReplacement[];
}

/**
 * What the injected benchmark runner returns. A thin projection of each
 * orchestrator's result — only the fields the planner needs to build a finding.
 */
export interface ReplacementBenchmarkOutcome {
  recommendedModelId: string;
  changed: boolean;
  reason: string;
  rejected?: RejectedReplacement[];
}

/**
 * Injectable seam: resolve the incumbent model per tool. The default reads the
 * real active profile; tests pass a fake.
 */
export interface ToolSettingsReader {
  profileName: string;
  /** The model the given tool currently runs on. */
  toolModel: (tool: string) => string;
}

/** Signature of the injectable per-tool benchmark runner. */
export type ReplacementBenchmarkRunner = (
  tool: string,
  benchmark: string,
  incumbentModelId: string,
  candidates: string[] | undefined,
  apiKey: string | undefined,
) => Promise<ReplacementBenchmarkOutcome>;

export interface AutoReplaceOptions {
  apiKey?: string;
  /** Restrict to a named profile's incumbent resolution (default: active). */
  profileName?: string;
  /** Explicit candidate model ids forwarded to each benchmark (else auto-discover). */
  candidateModels?: string[];
  /** Degraded-verdict thresholds forwarded to aggregateModelHealth. */
  aggregate?: AggregateOptions;
  /** Ledger path to aggregate (default: the real model-events.log). */
  eventsPath?: string;
  /**
   * Run every tool's benchmark even when its incumbent is NOT degraded — an
   * explicit operator audit. Without it, a healthy/empty ledger runs NO
   * benchmarks and every finding is changed=false.
   */
  force?: boolean;
  onProgress?: (message: string) => void;
  /** Test seam — resolve the incumbent model per tool. */
  settingsReader?: () => ToolSettingsReader;
  /** Test seam — run a tool's benchmark over candidates. */
  benchmarkRunner?: ReplacementBenchmarkRunner;
}

/**
 * Default incumbent resolver: read the real active profile and resolve each
 * tool's model through the same chain the runtime uses. When no settings.yaml
 * exists yet, fall back to DEFAULT_MODEL for every tool and an "(unconfigured)"
 * profile label — so the planner still produces a coherent report on a fresh
 * install rather than throwing.
 */
function defaultSettingsReader(profileNameOverride?: string): ToolSettingsReader {
  const settings = loadSettings();
  if (!settings || !settings.active) {
    return {
      profileName: profileNameOverride ?? "(unconfigured)",
      toolModel: () => DEFAULT_MODEL,
    };
  }
  const profileName = profileNameOverride ?? settings.active;
  const profile = settings.profiles[profileName];
  if (!profile) {
    return {
      profileName,
      toolModel: () => DEFAULT_MODEL,
    };
  }
  const resolved = resolveProfile(profileName, profile);
  return {
    profileName,
    // Each per-tool benchmark anchors on DEFAULT_MODEL as the shared baseline
    // incumbent (security-triage and search-existing both default their
    // incumbent to DEFAULT_MODEL), so a tool with no per-tool override resolves
    // to DEFAULT_MODEL here too — keeping the planner's incumbent and the
    // benchmark's incumbent identical.
    toolModel: (tool: string) => resolveModelForTool(resolved, tool, DEFAULT_MODEL),
  };
}

/**
 * Default benchmark runner: dispatch to the real orchestrator for each known
 * benchmark id. The orchestrators are ADVISORY (they never write config), so
 * calling them here is safe — the planner just reads back their recommendation.
 * An unknown benchmark id is a programming error (the registry and this switch
 * must stay in sync) and throws loudly rather than silently no-op'ing.
 */
async function defaultBenchmarkRunner(
  tool: string,
  benchmark: string,
  incumbentModelId: string,
  candidates: string[] | undefined,
  apiKey: string | undefined,
  onProgress?: (message: string) => void,
): Promise<ReplacementBenchmarkOutcome> {
  if (benchmark === "security-triage") {
    const r = await runSecurityTriageBenchmark({
      apiKey,
      models: candidates,
      incumbentModelId,
      onProgress,
    });
    return {
      recommendedModelId: r.recommendedModelId,
      changed: r.changed,
      reason: r.selection.reason,
      rejected: r.selection.rejected,
    };
  }
  if (benchmark === "search-existing") {
    const r = await runSearchExistingBenchmark({
      apiKey,
      models: candidates,
      incumbentModelId,
      onProgress,
    });
    return {
      recommendedModelId: r.recommendedModelId,
      changed: r.changed,
      reason: r.selection.reason,
      rejected: r.selection.rejected,
    };
  }
  if (benchmark === "code-task") {
    const r = await runCodeAuditBenchmark({
      apiKey,
      models: candidates,
      incumbentModelId,
      onProgress,
    });
    return {
      recommendedModelId: r.recommendedModelId,
      changed: r.changed,
      reason: r.selection.reason,
      rejected: r.selection.rejected,
    };
  }
  if (benchmark === "scan-folder") {
    const r = await runScanFolderBenchmark({
      apiKey,
      models: candidates,
      incumbentModelId,
      onProgress,
    });
    return {
      recommendedModelId: r.recommendedModelId,
      changed: r.changed,
      reason: r.selection.reason,
      rejected: r.selection.rejected,
    };
  }
  throw new Error(
    `defaultBenchmarkRunner: no orchestrator wired for benchmark '${benchmark}' (tool '${tool}'). ` +
      `The model-qualification registry declared a benchmark the auto-replace dispatcher does not know — ` +
      `add a case here when a new per-tool benchmark ships.`,
  );
}

/** Tools that have a real model-judgment benchmark, in registry order. */
function benchmarkedTools(): { tool: string; benchmark: string }[] {
  const out: { tool: string; benchmark: string }[] = [];
  for (const [tool, descriptor] of Object.entries(TOOL_MODEL_REGISTRY)) {
    // Only tools with a per-tool model-JUDGMENT benchmark this module can run.
    // `mass_scout` carries benchmark: "keyword-classification" but that path is
    // the ensemble's keyword benchmark (benchmark/pick.ts), not a per-tool
    // same-or-cheaper selector — so it is intentionally excluded here. We gate on
    // the dispatchable benchmark ids the default runner actually handles.
    if (
      descriptor.benchmark === "security-triage" ||
      descriptor.benchmark === "search-existing" ||
      descriptor.benchmark === "code-task" ||
      descriptor.benchmark === "scan-folder"
    ) {
      out.push({ tool, benchmark: descriptor.benchmark });
    }
  }
  return out;
}

/**
 * Plan auto-replacements across every benchmarked tool. PURE wrt config — it
 * NEVER mutates settings.yaml; it only aggregates the ledger, conditionally runs
 * each tool's (advisory) benchmark, and returns findings + a markdown report.
 *
 * For each benchmarked tool:
 *   1. resolve the incumbent model (settingsReader);
 *   2. aggregate the ledger window for that model id (degraded verdict);
 *   3. if degraded OR force → run the tool's benchmark over candidates and feed
 *      its selector; else ranBenchmark=false, recommended=incumbent, changed=false;
 *   4. record the finding.
 *
 * Guard: on a healthy/empty ledger with !force, NO benchmark runs and every
 * finding is changed=false — zero false positives.
 */
export async function planToolReplacements(
  opts: AutoReplaceOptions = {},
): Promise<{ findings: ToolReplacementFinding[]; reportMarkdown: string }> {
  const progress = opts.onProgress ?? (() => {});
  const reader = (opts.settingsReader ?? (() => defaultSettingsReader(opts.profileName)))();
  const runBenchmark: ReplacementBenchmarkRunner =
    opts.benchmarkRunner ??
    ((tool, benchmark, incumbent, candidates, apiKey) =>
      defaultBenchmarkRunner(tool, benchmark, incumbent, candidates, apiKey, progress));

  // Aggregate the ledger ONCE — every tool's incumbent health is read from the
  // same window, so a single read + aggregate covers them all.
  const events = readModelEvents({ path: opts.eventsPath });
  const healthByModel = aggregateModelHealth(events, opts.aggregate);

  const findings: ToolReplacementFinding[] = [];
  for (const { tool, benchmark } of benchmarkedTools()) {
    const incumbentModelId = reader.toolModel(tool);
    // A model never seen in the ledger has a zero-event healthy summary — a
    // brand-new or quiet model is NOT degraded by default.
    const health: ModelHealthSummary = healthByModel.get(incumbentModelId) ?? {
      model: incumbentModelId,
      total: 0,
      byKind: {
        param_drop: 0,
        reasoning_downgrade: 0,
        rate_limit_429: 0,
        schema_heal: 0,
        truncation_retry: 0,
        empty_response: 0,
        non_retryable_failure: 0,
      },
      degraded: false,
      reasons: [],
    };

    if (!health.degraded && !opts.force) {
      progress(`${tool}: incumbent ${incumbentModelId} healthy — no benchmark run.`);
      findings.push({
        tool,
        benchmark,
        incumbentModelId,
        health,
        degraded: false,
        ranBenchmark: false,
        recommendedModelId: incumbentModelId,
        changed: false,
        reason: "model healthy — no benchmark run",
      });
      continue;
    }

    const trigger = health.degraded ? "degraded incumbent" : "forced audit";
    progress(`${tool}: ${trigger} — running ${benchmark} benchmark for ${incumbentModelId}…`);
    const outcome = await runBenchmark(
      tool,
      benchmark,
      incumbentModelId,
      opts.candidateModels,
      opts.apiKey,
    );
    findings.push({
      tool,
      benchmark,
      incumbentModelId,
      health,
      degraded: health.degraded,
      ranBenchmark: true,
      recommendedModelId: outcome.recommendedModelId,
      changed: outcome.changed,
      reason: outcome.reason,
      rejected: outcome.rejected,
    });
  }

  const reportMarkdown = renderReport(reader.profileName, !!opts.force, findings);
  return { findings, reportMarkdown };
}

// ── ENSEMBLE coverage (P1 zero-token model pipeline) ─────────────────────────
//
// The planner above only covers tools that have a per-tool SELECTOR benchmark
// (security-triage, search-existing, code-task, scan-folder) — see
// benchmarkedTools()'s scoping comment.
// That left the ensemble slots (`model` / `second_model` / `third_model`), which
// serve EVERY other tool, with no automated health verdict at all: when one of them
// started 404ing, the ensemble-autoselect SKILL asked the AGENT to read the retry
// history and judge whether the failure was "persistent". That judgment is now
// assessModelPersistence's code threshold (model-events.ts), and this planner is
// what applies it to the models the ensemble actually runs on.
//
// It stays ADVISORY, exactly like planToolReplacements: it computes the verdict and
// never writes. The write lives in the CLI (--auto-replace --apply), behind the
// read-only-MCP guardrail.

/** One ensemble slot's rotation verdict. */
export interface EnsembleSlotFinding {
  slot: EnsembleSlot;
  modelId: string;
  /** The code threshold's verdict — no agent judgment anywhere in this path. */
  verdict: ModelPersistenceVerdict;
}

export interface EnsembleRotationPlan {
  profileName: string;
  /** One finding per CONFIGURED slot (unset slots are skipped). */
  slots: EnsembleSlotFinding[];
  /** The subset whose verdict crossed the persistence threshold. */
  brokenSlots: EnsembleSlotFinding[];
  /** True iff ≥1 configured slot is persistently broken — the rotation trigger. */
  rotationNeeded: boolean;
}

/** Injectable seam: which models the ensemble currently runs on. */
export interface EnsembleReader {
  profileName: string;
  /** Configured slots, in ensemble order. An unset slot is simply absent. */
  slots: { slot: EnsembleSlot; modelId: string }[];
}

export interface EnsembleRotationOptions {
  /** Ledger path to aggregate (default: the real model-events.log). */
  eventsPath?: string;
  /** Rotation-threshold overrides (window / min-consecutive / clock). */
  persistence?: PersistenceOptions;
  /** Test seam — resolve the ensemble's configured slots. */
  settingsReader?: () => EnsembleReader;
}

/**
 * Default ensemble reader: the ACTIVE profile's resolved slots. Under `free_only`
 * the ensemble is served from the `free_models` pool rather than these three keys,
 * so resolveProfile's model/secondModel/thirdModel already reflect whichever source
 * is authoritative — we read the RESOLVED values, not the raw YAML, so the verdict
 * is about the models actually being CALLED.
 */
function defaultEnsembleReader(): EnsembleReader {
  const settings = loadSettings();
  if (!settings || !settings.active) return { profileName: "(unconfigured)", slots: [] };
  const profile = settings.profiles[settings.active];
  if (!profile) return { profileName: settings.active, slots: [] };
  const resolved = resolveProfile(settings.active, profile);
  const bySlot: Record<EnsembleSlot, string> = {
    model: resolved.model,
    second_model: resolved.secondModel,
    third_model: resolved.thirdModel,
  };
  const slots = ENSEMBLE_SLOTS.filter((s) => !!bySlot[s]).map((s) => ({ slot: s, modelId: bySlot[s] }));
  return { profileName: settings.active, slots };
}

/**
 * Assess every configured ensemble slot against the durable ledger's rotation
 * threshold. PURE wrt config — never writes. A model with no in-window,
 * status-carrying non-retryable failure is not in the verdict map, and is reported
 * healthy: a brand-new or simply quiet model must NEVER trigger a rotation.
 */
export function planEnsembleRotation(opts: EnsembleRotationOptions = {}): EnsembleRotationPlan {
  const reader = (opts.settingsReader ?? defaultEnsembleReader)();
  const events = readModelEvents({ path: opts.eventsPath });
  const verdicts = assessModelPersistence(events, opts.persistence);
  const windowHours = opts.persistence?.windowHours ?? 24;

  const slots: EnsembleSlotFinding[] = reader.slots.map(({ slot, modelId }) => ({
    slot,
    modelId,
    verdict: verdicts.get(modelId) ?? {
      model: modelId,
      persistentlyBroken: false,
      httpStatus: null,
      consecutiveFailures: 0,
      windowHours,
      reason: `no model-scoped failure on the ledger in the last ${windowHours}h`,
    },
  }));
  const brokenSlots = slots.filter((s) => s.verdict.persistentlyBroken);
  return {
    profileName: reader.profileName,
    slots,
    brokenSlots,
    rotationNeeded: brokenSlots.length > 0,
  };
}

/** Markdown section for the ensemble half of the auto-replace report. */
export function renderEnsembleRotationSection(plan: EnsembleRotationPlan): string {
  const lines: string[] = [];
  lines.push("## Ensemble slots (ledger rotation threshold)");
  lines.push("");
  if (plan.slots.length === 0) {
    lines.push("No ensemble slot is configured on the active profile — nothing to check.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    plan.rotationNeeded
      ? `${plan.brokenSlots.length} of ${plan.slots.length} slot(s) are PERSISTENTLY BROKEN — rotation is warranted.`
      : `All ${plan.slots.length} configured slot(s) are healthy — no rotation.`,
  );
  lines.push("");
  for (const s of plan.slots) {
    lines.push(
      `- **${s.slot}:** \`${s.modelId}\` — ${s.verdict.persistentlyBroken ? "BROKEN" : "healthy"} (${s.verdict.reason})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the advisory markdown report. Mirrors the security-triage report style:
 * a header, an overall verdict line, then one section per tool with the
 * incumbent, degradation reasons, benchmark verdict, and recommendation.
 */
function renderReport(
  profileName: string,
  force: boolean,
  findings: readonly ToolReplacementFinding[],
): string {
  const lines: string[] = [];
  lines.push("# Auto-replacement plan — per-tool model health");
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(`**Profile:** \`${profileName}\``);
  lines.push(`**Mode:** ${force ? "forced audit (benchmark every tool)" : "ledger-triggered (benchmark only degraded tools)"}`);
  lines.push("");
  lines.push(
    "ADVISORY ONLY — this plan never changes your config. Adopt a recommendation by " +
      "setting the tool's `tool_models` entry on your active profile (CLI / cron only).",
  );
  lines.push("");

  const changed = findings.filter((f) => f.changed);
  const benchmarked = findings.filter((f) => f.ranBenchmark);
  lines.push("## Summary");
  lines.push("");
  if (findings.length === 0) {
    lines.push("No benchmarked tools are registered — nothing to plan.");
  } else if (changed.length > 0) {
    lines.push(
      `${changed.length} of ${findings.length} tool(s) have a recommended replacement ` +
        `(${benchmarked.length} benchmark run(s)).`,
    );
  } else if (benchmarked.length > 0) {
    lines.push(
      `${benchmarked.length} benchmark run(s); no eligible same-or-cheaper model beat any incumbent. ` +
        "Keeping every current model.",
    );
  } else {
    lines.push(
      "Every incumbent model is healthy on the ledger and no audit was forced — " +
        "no benchmark was run and no change is recommended.",
    );
  }
  lines.push("");

  for (const f of findings) {
    lines.push(`## ${f.tool} (benchmark: ${f.benchmark})`);
    lines.push("");
    lines.push(`- **Incumbent:** \`${f.incumbentModelId}\``);
    lines.push(
      `- **Ledger health:** ${f.degraded ? "DEGRADED" : "healthy"} ` +
        `(${f.health.total} event(s) in window)`,
    );
    if (f.health.reasons.length > 0) {
      for (const r of f.health.reasons) lines.push(`  - ${r}`);
    }
    lines.push(`- **Benchmark run:** ${f.ranBenchmark ? "yes" : "no"}`);
    if (f.ranBenchmark) {
      lines.push(
        `- **Recommendation:** ${f.changed ? "SWITCH" : "KEEP"} → \`${f.recommendedModelId}\``,
      );
      lines.push(`- **Reason:** ${f.reason}`);
      if (f.rejected && f.rejected.length > 0) {
        lines.push(`- **Rejected candidates:**`);
        for (const rej of f.rejected) lines.push(`  - \`${rej.modelId}\` — ${rej.reason}`);
      }
    } else {
      lines.push(`- **Recommendation:** KEEP → \`${f.recommendedModelId}\` (${f.reason})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
