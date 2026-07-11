/**
 * check_against_specs (SPEC ADHERENCE) model benchmark — orchestrator (P2d).
 *
 * The single callable behind the CLI phase and the --auto-replace planner. It mirrors the
 * code-task, scan-folder and search-existing orchestrators step for step:
 *   1. load + validate the golden corpus (deterministic — no LLM judge),
 *   2. build the candidate pool — explicit `models`, else auto-discovered candidates
 *      filtered by check_against_specs's per-tool requirements
 *      (TOOL_MODEL_REGISTRY.check_against_specs.requirements) AND not pricier than the
 *      incumbent (the cost gate would reject pricier ones — don't spend budget on them),
 *   3. score each candidate via the REAL pipeline runner (bench-runner.ts →
 *      runCheckAgainstSpecs in-process), with a per-model-per-day cache,
 *   4. apply the selection gate (select.ts → selectCheckSpecsModel),
 *   5. render markdown + JSON reports and return the recommendation + paths.
 *
 * ADVISORY only — this module NEVER writes config. The recommendation is surfaced for the
 * operator to adopt via `tool_models.check_against_specs` on a settings.yaml profile; the
 * only writer is the CLI (benchmark/pick.ts's applyToolModelToSettings), behind the
 * read-only-MCP guardrail.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBenchmarkRoster,
  rankByQualityIndex,
  fetchProgrammingModels,
  qualify,
  type OpenRouterModel,
  type QualifiedModel,
} from "../discover.js";
import { getConfigDir, getActiveFreeOnly } from "../../config.js";
import { resolveProjectMainRoot } from "../../project-root.js";
import { KNOWN_PRICING, type ModelPricing } from "../../mass_scouting/cost-estimate.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import { DEFAULT_MODEL } from "../../security_scan/types.js";
// The confusion-matrix aggregate is the shared one (see score.ts's header) — a skipped
// model still needs a well-formed, empty score object.
import { aggregateScores } from "../search-existing/score.js";
import { readFileAsCodeBlock, DEFAULT_MAX_PAYLOAD_BYTES } from "../../scan-pipeline.js";
import { CHECK_SPECS_SYSTEM_PROMPT } from "../../check-specs/core.js";
import type { BenchmarkWorkload } from "../workload-types.js";

import {
  CHECK_SPECS_FIXTURES,
  CHECK_SPECS_INSTRUCTIONS,
  datasetFingerprint,
  validateDataset,
  fixtureAbsPath,
  resolveFixtureRoot,
  specPath,
  type SpecFixture,
} from "./dataset.js";
import { runCheckSpecsBenchmarkOnModel, CHECK_SPECS_MAX_OUTPUT_TOKENS } from "./bench-runner.js";
import {
  accuracyOf,
  passesThresholds,
  DEFAULT_CHECK_SPECS_THRESHOLDS,
  type CheckSpecsScore,
  type CheckSpecsThresholds,
} from "./score.js";
import {
  CHECK_SPECS_CRITERIA,
  selectCheckSpecsModel,
  type CheckSpecsCandidate,
  type CheckSpecsSelectionResult,
} from "./select.js";

/**
 * check_against_specs has no per-tool default model of its own — it runs on the active
 * profile's ensemble. So the benchmark's incumbent defaults to DEFAULT_MODEL (the shared
 * baseline the other benchmarks also use) unless the caller passes `incumbentModelId`.
 * The cost gate anchors on that incumbent's pricing.
 */
const INCUMBENT_FALLBACK_PRICING: ModelPricing = KNOWN_PRICING[DEFAULT_MODEL] ?? {
  input_per_m_usd: 0.04,
  output_per_m_usd: 0.1,
  context_window: 32_768,
};

export interface CheckSpecsBenchmarkOptions {
  apiKey?: string;
  /** Explicit model ids to assess. When absent, auto-discover the candidate pool. */
  models?: string[];
  /** Report dir. Default `<main-repo-root>/reports/check-specs-benchmark/`. */
  outputDir?: string;
  mainRoot?: string;
  /** Ignore the per-model-per-day cache and re-run every model. */
  force?: boolean;
  thresholds?: CheckSpecsThresholds;
  /** The incumbent to compare against. Default DEFAULT_MODEL. */
  incumbentModelId?: string;
  /** Cap the auto-discovered pool (quality-ranked). Default 16. */
  qualifyingTopN?: number;
  /** Per-call timeout in ms forwarded to the runner. Default 300_000. */
  perCallTimeoutMs?: number;
  /** Test seam — injected HTTP impl forwarded to the runner. */
  fetchImpl?: FetchImpl;
  onProgress?: (message: string) => void;
}

export interface CheckSpecsAssessment extends CheckSpecsCandidate {
  /** Files whose LLM call produced no report (scored as unscored). */
  failureReasons: string[];
  /** Reported, never gated — see score.ts::accuracyOf. */
  accuracy: number;
  costUsd: number;
}

export interface CheckSpecsBenchmarkResult {
  recommendedModelId: string;
  changed: boolean;
  selection: CheckSpecsSelectionResult;
  results: CheckSpecsAssessment[];
  costUsd: number;
  reportPath: string;
  jsonReportPath: string;
  summaryLine: string;
}

// ── Cache (per-model-per-day, corpus-fingerprint-keyed) ─────────────────────

interface CacheEntry {
  date: string;
  datasetHash: string;
  score: CheckSpecsScore;
  accuracy: number;
  costUsd: number;
  latencyMs: number;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  qualified: boolean;
  disqualifyReason?: string;
  failureReasons: string[];
}
type CacheFile = Record<string, CacheEntry>;

function cachePath(): string {
  return join(getConfigDir(), "check-specs-results.json");
}

function cacheKey(modelId: string, date: string, datasetHash: string): string {
  return `${modelId}::${date}::${datasetHash}`;
}

function loadCache(): CacheFile {
  const p = cachePath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as CacheFile;
  } catch {
    // Corrupt cache is non-fatal — treat as empty and overwrite on save.
  }
  return {};
}

function saveCache(cache: CacheFile): void {
  mkdirSync(getConfigDir(), { recursive: true });
  const p = cachePath();
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  renameSync(tmp, p);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveApiKey(override?: string): string {
  const k =
    override ||
    process.env.OPENROUTER_API_KEY ||
    process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
  if (!k) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Export it in your shell, or set the plugin option 'openrouter_api_key' via Claude Code's /plugin configure.",
    );
  }
  return k;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** local-time + GMT-offset compact stamp (agent-reports-location convention). */
function reportStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${oh}${om}`;
}

function pricingFromModel(m: QualifiedModel): ModelPricing {
  return {
    input_per_m_usd: m.inputDollarsPerMillion,
    output_per_m_usd: m.outputDollarsPerMillion,
    context_window: m.contextTokens,
  };
}

/** Best-effort decorate a raw OpenRouter model with numeric pricing fields. */
function decorate(raw: OpenRouterModel): QualifiedModel {
  const ctx = raw.context_length ?? 0;
  const maxOutRaw = raw.top_provider?.max_completion_tokens;
  const maxOut = maxOutRaw === null ? ctx : (maxOutRaw ?? 0);
  const promptPerToken = parseFloat(raw.pricing?.prompt ?? "NaN");
  const completionPerToken = parseFloat(raw.pricing?.completion ?? "NaN");
  const params = new Set(raw.supported_parameters ?? []);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    contextTokens: ctx,
    maxOutputTokens: maxOut,
    inputDollarsPerMillion: isFinite(promptPerToken) ? promptPerToken * 1_000_000 : Infinity,
    outputDollarsPerMillion: isFinite(completionPerToken) ? completionPerToken * 1_000_000 : Infinity,
    supportsStructured: params.has("structured_outputs") || params.has("response_format"),
    supportsReasoning: params.has("reasoning") || params.has("include_reasoning"),
    raw,
  };
}

// ── Pre-flight workload description (P4) ─────────────────────────────────────

/**
 * Describe what ONE model is asked to do, for the P4 pre-flight spend estimate.
 *
 * This builds the EXACT same messages bench-runner.ts's mode-0 loop sends per file
 * (check-specs/core.ts:317-325) — the same `readFileAsCodeBlock` calls (same
 * `redact_secrets: false`, same `max_payload_kb` default, same `"specs-"` tag prefix
 * on the spec), the same system prompt, the same section headers, concatenated in the
 * same order. Nothing here is re-derived or approximated: it is the real corpus read
 * off disk through the same helpers the runner itself calls, so a corpus or spec edit
 * moves this estimate automatically and it can never silently drift from what a run
 * actually sends.
 */
export function describeWorkload(): BenchmarkWorkload {
  const fixtures: readonly SpecFixture[] = CHECK_SPECS_FIXTURES;
  const root = resolveFixtureRoot();
  // Mirrors bench-runner.ts's csBudgetBytes = (max_payload_kb ?? 400) * 1024 — the
  // benchmark never passes max_payload_kb, so the pipeline default applies to every call.
  const specBlock = readFileAsCodeBlock(
    specPath(root),
    undefined,
    false, // redact_secrets: false — the benchmark's args, verbatim
    DEFAULT_MAX_PAYLOAD_BYTES,
    null,
    "specs-",
  );

  let promptCharsPerModel = 0;
  for (const fixture of fixtures) {
    const fileBlock = readFileAsCodeBlock(
      fixtureAbsPath(fixture.file, root),
      undefined,
      false, // redact_secrets: false
      DEFAULT_MAX_PAYLOAD_BYTES,
      null,
    );
    let userContent = "## SPECIFICATION (source of truth)\n\n" + specBlock + "\n\n";
    userContent += "## ADDITIONAL INSTRUCTIONS\n\n" + CHECK_SPECS_INSTRUCTIONS + "\n\n";
    userContent += "## SOURCE FILES TO CHECK\n\n" + fileBlock;
    // One call per file (mode 0): the system prompt rides on EVERY call, and so does
    // the whole spec block — that per-call spec resend is the reason this benchmark's
    // real cost scales with file count, not with the spec's size alone.
    promptCharsPerModel += CHECK_SPECS_SYSTEM_PROMPT.length + userContent.length;
  }

  return {
    tool: "check_against_specs",
    benchmark: "check-specs",
    callsPerModel: fixtures.length,
    promptCharsPerModel,
    maxOutputTokensPerCall: CHECK_SPECS_MAX_OUTPUT_TOKENS,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function runCheckSpecsBenchmark(
  opts: CheckSpecsBenchmarkOptions = {},
): Promise<CheckSpecsBenchmarkResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const fixtures: readonly SpecFixture[] = CHECK_SPECS_FIXTURES;
  // Fail BEFORE spending a cent if the corpus and its answer key have drifted (a missing
  // fixture, an edited fixture whose truth probe no longer holds, a corpus with nothing
  // left to find).
  validateDataset(fixtures);

  // Fingerprint the labels, the instructions, the SPEC and the corpus bytes, so editing
  // any of them invalidates yesterday's cached scores.
  const datasetHash = datasetFingerprint();
  const thresholds = opts.thresholds ?? DEFAULT_CHECK_SPECS_THRESHOLDS;
  const incumbentId = opts.incumbentModelId ?? DEFAULT_MODEL;
  const progress = opts.onProgress ?? ((): void => {});
  const freeOnly = getActiveFreeOnly();

  const violations = fixtures.filter((f) => f.truth === "VIOLATION").length;
  progress(
    `Loaded 1 real spec over ${fixtures.length} real source files ` +
      `(${violations} VIOLATION / ${fixtures.length - violations} CLEAN) — corpus ${datasetHash}.`,
  );

  progress("Fetching OpenRouter model catalog…");
  const catalog = await fetchProgrammingModels();
  const byId = new Map(catalog.map((m) => [m.id, m] as const));

  const incumbentRaw = byId.get(incumbentId);
  const incumbentDecorated = incumbentRaw ? decorate(incumbentRaw) : null;
  const incumbentIn =
    incumbentDecorated && isFinite(incumbentDecorated.inputDollarsPerMillion)
      ? incumbentDecorated.inputDollarsPerMillion
      : INCUMBENT_FALLBACK_PRICING.input_per_m_usd;
  const incumbentOut =
    incumbentDecorated && isFinite(incumbentDecorated.outputDollarsPerMillion)
      ? incumbentDecorated.outputDollarsPerMillion
      : INCUMBENT_FALLBACK_PRICING.output_per_m_usd;

  const toAssess = new Map<
    string,
    { model: QualifiedModel; qualified: boolean; disqualifyReason?: string }
  >();
  const addModel = (model: QualifiedModel, qualified: boolean, disqualifyReason?: string): void => {
    if (!toAssess.has(model.id)) toAssess.set(model.id, { model, qualified, disqualifyReason });
  };

  if (opts.models && opts.models.length > 0) {
    for (const id of opts.models) {
      const raw = byId.get(id);
      if (raw) {
        const q = qualify(raw, CHECK_SPECS_CRITERIA);
        addModel(
          q ?? decorate(raw),
          q !== null,
          q ? undefined : "below check-against-specs requirements (cost/context/structured-output)",
        );
      } else {
        // Unknown to the catalog — assess with fallback pricing so the user still sees a
        // score, but it cannot qualify (no capability data).
        const fp = KNOWN_PRICING[id] ?? INCUMBENT_FALLBACK_PRICING;
        addModel(
          {
            id,
            name: id,
            contextTokens: fp.context_window,
            maxOutputTokens: fp.context_window,
            inputDollarsPerMillion: fp.input_per_m_usd,
            outputDollarsPerMillion: fp.output_per_m_usd,
            supportsStructured: false,
            supportsReasoning: false,
            raw: { id },
          },
          false,
          "not found in the OpenRouter catalog",
        );
      }
    }
  } else {
    const { candidates } = buildBenchmarkRoster(catalog, CHECK_SPECS_CRITERIA, []);
    const affordable = candidates.filter(
      (c) =>
        c.inputDollarsPerMillion <= incumbentIn + 1e-9 &&
        c.outputDollarsPerMillion <= incumbentOut + 1e-9,
    );
    const sameOrCheaper = rankByQualityIndex(affordable).slice(0, opts.qualifyingTopN ?? 16);
    for (const c of sameOrCheaper) addModel(c, true);
  }

  // ALWAYS assess the incumbent, so the report confirms it still passes and the gate has
  // a fallback.
  if (!toAssess.has(incumbentId)) {
    if (incumbentDecorated) {
      const q = qualify(incumbentDecorated.raw, CHECK_SPECS_CRITERIA);
      addModel(
        incumbentDecorated,
        q !== null,
        q ? undefined : "below check-against-specs requirements",
      );
    } else {
      addModel(
        {
          id: incumbentId,
          name: incumbentId,
          contextTokens: INCUMBENT_FALLBACK_PRICING.context_window,
          maxOutputTokens: INCUMBENT_FALLBACK_PRICING.context_window,
          inputDollarsPerMillion: incumbentIn,
          outputDollarsPerMillion: incumbentOut,
          supportsStructured: true,
          supportsReasoning: true,
          raw: { id: incumbentId },
        },
        true,
      );
    }
  }

  progress(`Assessing ${toAssess.size} model(s) over ${fixtures.length} file decisions…`);

  const cache = loadCache();
  const assessments: CheckSpecsAssessment[] = [];
  let totalCost = 0;

  for (const { model, qualified, disqualifyReason } of toAssess.values()) {
    // free_only cost-safety: a non-':free' model cannot become the free-mode default, so
    // don't spend a cent running it.
    if (freeOnly && !model.id.endsWith(":free")) {
      progress(`  ${model.id}: skipped (free_only — non-':free' model).`);
      const empty = aggregateScores([]);
      assessments.push({
        modelId: model.id,
        qualified: false,
        disqualifyReason: "free_only active — non-':free' model not benchmarked",
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        latencyMs: 0,
        score: empty,
        accuracy: 0,
        failureReasons: [],
        costUsd: 0,
      });
      continue;
    }

    const key = cacheKey(model.id, today(), datasetHash);
    const cached = cache[key];
    let score: CheckSpecsScore;
    let accuracy: number;
    let costUsd: number;
    let latencyMs: number;
    let failureReasons: string[];

    if (cached && !opts.force) {
      progress(`  ${model.id}: cache hit (${today()}).`);
      score = cached.score;
      accuracy = cached.accuracy;
      costUsd = cached.costUsd;
      latencyMs = cached.latencyMs;
      failureReasons = cached.failureReasons;
    } else {
      progress(`  ${model.id}: running…`);
      const run = await runCheckSpecsBenchmarkOnModel(
        model.id,
        fixtures,
        {
          apiKey,
          pricing: pricingFromModel(model),
          perCallTimeoutMs: opts.perCallTimeoutMs ?? 300_000,
        },
        opts.fetchImpl,
      );
      score = run.aggregate;
      accuracy = run.accuracy;
      costUsd = run.costUsd;
      latencyMs = Math.round(run.meanLatencyMs);
      failureReasons = run.failures.map((f) => `${f.file}: ${f.reason}`);
      cache[key] = {
        date: today(),
        datasetHash,
        score,
        accuracy,
        costUsd,
        latencyMs,
        inputDollarsPerMillion: model.inputDollarsPerMillion,
        outputDollarsPerMillion: model.outputDollarsPerMillion,
        qualified,
        disqualifyReason,
        failureReasons,
      };
    }

    totalCost += costUsd;
    assessments.push({
      modelId: model.id,
      qualified,
      disqualifyReason,
      inputDollarsPerMillion: model.inputDollarsPerMillion,
      outputDollarsPerMillion: model.outputDollarsPerMillion,
      latencyMs,
      score,
      accuracy,
      failureReasons,
      costUsd,
    });
    const thr = passesThresholds(score, thresholds);
    progress(
      `    ${model.id}: ${thr.pass ? "PASS" : "FAIL"} ` +
        `microF1=${score.microF1.toFixed(3)} microP=${score.microPrecision.toFixed(3)} ` +
        `microR=${score.microRecall.toFixed(3)} acc=${accuracy.toFixed(3)} ` +
        `cov=${score.coverage.toFixed(3)} unscored=${failureReasons.length}`,
    );
  }

  saveCache(cache);

  const selection = selectCheckSpecsModel({
    candidates: assessments,
    incumbentModelId: incumbentId,
    incumbentInputDollarsPerMillion: incumbentIn,
    incumbentOutputDollarsPerMillion: incumbentOut,
  });

  const mainRoot = resolveProjectMainRoot(opts.mainRoot);
  const reportDir = opts.outputDir ?? join(mainRoot, "reports", "check-specs-benchmark");
  mkdirSync(reportDir, { recursive: true });
  const stamp = reportStamp();
  const jsonReportPath = join(reportDir, `${stamp}-check-specs-benchmark.json`);
  const reportPath = join(reportDir, `${stamp}-check-specs-benchmark.md`);

  const jsonPayload = {
    timestamp: new Date().toISOString(),
    datasetHash,
    fixtureCount: fixtures.length,
    violationCount: violations,
    cleanCount: fixtures.length - violations,
    thresholds,
    incumbent: {
      modelId: incumbentId,
      inputDollarsPerMillion: incumbentIn,
      outputDollarsPerMillion: incumbentOut,
    },
    recommendedModelId: selection.recommendedModelId,
    changed: selection.changed,
    reason: selection.reason,
    costUsd: totalCost,
    assessments: assessments.map((a) => {
      const thr = passesThresholds(a.score, thresholds);
      return {
        modelId: a.modelId,
        qualified: a.qualified,
        disqualifyReason: a.disqualifyReason,
        inputDollarsPerMillion: a.inputDollarsPerMillion,
        outputDollarsPerMillion: a.outputDollarsPerMillion,
        latencyMs: a.latencyMs,
        pass: thr.pass,
        failures: thr.failures,
        microPrecision: a.score.microPrecision,
        microRecall: a.score.microRecall,
        microF1: a.score.microF1,
        accuracy: a.accuracy,
        coverage: a.score.coverage,
        failureReasons: a.failureReasons,
        costUsd: a.costUsd,
      };
    }),
    rejected: selection.rejected,
    perCase: Object.fromEntries(assessments.map((a) => [a.modelId, a.score.cases])),
  };
  const jtmp = `${jsonReportPath}.tmp.${process.pid}`;
  writeFileSync(jtmp, JSON.stringify(jsonPayload, null, 2), "utf-8");
  renameSync(jtmp, jsonReportPath);

  const md = buildReportMarkdown({
    fixtures,
    datasetHash,
    incumbentId,
    incumbentIn,
    incumbentOut,
    thresholds,
    assessments,
    selection,
    totalCost,
  });
  const mtmp = `${reportPath}.tmp.${process.pid}`;
  writeFileSync(mtmp, md, "utf-8");
  renameSync(mtmp, reportPath);

  const summaryLine = selection.changed
    ? `RECOMMEND switch: ${incumbentId} -> ${selection.recommendedModelId} (best same-or-cheaper passer).`
    : `KEEP ${selection.recommendedModelId} (no eligible same-or-cheaper model scored higher).`;

  return {
    recommendedModelId: selection.recommendedModelId,
    changed: selection.changed,
    selection,
    results: assessments,
    costUsd: totalCost,
    reportPath,
    jsonReportPath,
    summaryLine,
  };
}

// ── Markdown report ─────────────────────────────────────────────────────────

function buildReportMarkdown(args: {
  fixtures: readonly SpecFixture[];
  datasetHash: string;
  incumbentId: string;
  incumbentIn: number;
  incumbentOut: number;
  thresholds: CheckSpecsThresholds;
  assessments: readonly CheckSpecsAssessment[];
  selection: CheckSpecsSelectionResult;
  totalCost: number;
}): string {
  const violations = args.fixtures.filter((f) => f.truth === "VIOLATION").length;
  const lines: string[] = [];
  lines.push("# check_against_specs (SPEC ADHERENCE) — model benchmark");
  lines.push("");
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(
    `**Corpus:** 1 real spec (this repo's own \`mcp-server/TESTING.md\`) × ${args.fixtures.length} real source files ` +
      `= ${args.fixtures.length} per-file decisions (${violations} VIOLATION / ${args.fixtures.length - violations} CLEAN) — corpus ${args.datasetHash}`,
  );
  lines.push(
    `**Incumbent:** \`${args.incumbentId}\` (in $${args.incumbentIn.toFixed(3)}/M, out $${args.incumbentOut.toFixed(3)}/M)`,
  );
  lines.push(
    `**Pass gate:** micro-F1 ≥ ${args.thresholds.minMicroF1.toFixed(2)} AND ` +
      `micro-recall ≥ ${args.thresholds.minMicroRecall.toFixed(2)} AND ` +
      `coverage ≥ ${args.thresholds.minCoverage.toFixed(2)}`,
  );
  lines.push(`**Total LLM spend:** $${args.totalCost.toFixed(6)}`);
  lines.push("");
  lines.push(
    "**Scoring is 100% deterministic — no LLM judge.** The spec is a verbatim copy of this " +
      "repo's shipped `mcp-server/TESTING.md`; every source file is a byte-for-byte snapshot of a " +
      "real revision out of git. The four VIOLATION fixtures are the exact bytes commit `31ce212` " +
      "replaced *because they really violated this spec* — the defect drained a real OpenRouter " +
      "balance ($17.67 in one hour) before it was found. The score is precision/recall/F1 over the " +
      "per-file CLEAN/VIOLATION verdicts.",
  );
  lines.push("");
  lines.push(
    "**What is NOT scored (stated, not smuggled past):** the rule a VIOLATION line cites is " +
      "printed below but NOT graded — deciding whether a quoted rule really is the one that was " +
      "broken is a semantic judgment, which would need the LLM judge this benchmark refuses to " +
      "use. Severity (CRITICAL/HIGH/MEDIUM/LOW) is not graded either: human reviewers disagree " +
      "about it, so scoring it would require a rubric somebody's opinion authored. Accuracy is " +
      "reported but is NOT part of the gate — on a 4/9 corpus, answering CLEAN to everything " +
      "scores 0.69 while finding nothing.",
  );
  lines.push("");
  lines.push("## The corpus");
  lines.push("");
  lines.push("| Fixture | Truth | Blob | Why |");
  lines.push("|---|---|---|---|");
  for (const f of args.fixtures) {
    lines.push(
      `| \`${f.file}\` | **${f.truth}** | \`${f.provenance}\` | ${f.rule} — ${f.rationale} |`,
    );
  }
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(
    `**${args.selection.changed ? "SWITCH" : "KEEP"} → \`${args.selection.recommendedModelId}\`**`,
  );
  lines.push("");
  lines.push(args.selection.reason);
  lines.push("");
  lines.push("## Assessed models");
  lines.push("");
  lines.push(
    "| Model | Req | Bench | micro-F1 | micro-P | micro-R | Accuracy | Coverage | Unscored | in $/M | out $/M | lat ms |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sorted = [...args.assessments].sort((a, b) => b.score.microF1 - a.score.microF1);
  for (const a of sorted) {
    const thr = passesThresholds(a.score, args.thresholds);
    lines.push(
      `| \`${a.modelId}\` | ${a.qualified ? "ok" : "no"} | ${thr.pass ? "PASS" : "FAIL"} | ` +
        `${a.score.microF1.toFixed(3)} | ${a.score.microPrecision.toFixed(3)} | ${a.score.microRecall.toFixed(3)} | ` +
        `${a.accuracy.toFixed(3)} | ${(a.score.coverage * 100).toFixed(0)}% | ${a.failureReasons.length} | ` +
        `${a.inputDollarsPerMillion.toFixed(3)} | ${a.outputDollarsPerMillion.toFixed(3)} | ${a.latencyMs} |`,
    );
  }
  lines.push("");
  if (args.selection.rejected.length > 0) {
    lines.push("## Rejected (and why)");
    lines.push("");
    for (const r of args.selection.rejected) lines.push(`- \`${r.modelId}\` — ${r.reason}`);
    lines.push("");
  }

  const rec = args.assessments.find((a) => a.modelId === args.selection.recommendedModelId);
  if (rec) {
    lines.push(`## Confusion matrix — \`${rec.modelId}\``);
    lines.push("");
    lines.push("| Files | TP | FP | FN | TN | Unscored | Precision | Recall | F1 | Accuracy |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const c of rec.score.cases) {
      lines.push(
        `| ${c.scannedFiles} | ${c.truePositives} | ${c.falsePositives} | ${c.falseNegatives} | ` +
          `${c.trueNegatives} | ${c.unscored} | ${c.precision.toFixed(3)} | ${c.recall.toFixed(3)} | ` +
          `${c.f1.toFixed(3)} | ${accuracyOf(rec.score).toFixed(3)} |`,
      );
    }
    lines.push("");
    if (rec.failureReasons.length > 0) {
      lines.push(`### Files with no parseable verdict — \`${rec.modelId}\``);
      lines.push("");
      for (const f of rec.failureReasons) lines.push(`- ${f}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Re-run: `llm-externalizer benchmark --check-specs` (auto-discover) or `--check-specs <id> [<id>...]` " +
      "(assess specific models). ADVISORY by default; add `--apply-profile <P>` to write the winner into " +
      "that profile's `tool_models.check_against_specs` (CLI-only writer — the MCP surface never writes).",
  );
  return lines.join("\n") + "\n";
}
