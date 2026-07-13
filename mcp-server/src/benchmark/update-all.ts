/**
 * `--update-all` — the WHOLE model refresh as ONE command, with zero decisions left
 * to a human or an agent (P3), under a hard spend cap (P4).
 *
 * discover → requirement-gate → benchmark → rank + write → report.
 *
 * WHY THIS EXISTS: every piece below already existed, but the GLUE between them was
 * prose in a slash command — "fetch the catalog, decide which tools to sweep, pick the
 * flags, read the report, then hand-edit settings.yaml". That glue was judgment, and
 * judgment costs agent tokens and drifts. It is now code.
 *
 * TWO INVARIANTS THIS MODULE EXISTS TO HOLD:
 *
 *  1. HONESTY ABOUT THE GATE. A tool with `benchmark: null` in the registry is
 *     REQUIREMENT-GATED — its model was checked against cost/context/output/params and
 *     nothing else. A tool with a benchmark is BENCHMARK-PROVEN — a model actually ran
 *     its golden dataset and passed. The report says which is which, per tool, always.
 *     Never let an unbenchmarked tool read as if it had been tested.
 *
 *  2. THE MONEY IS BOUNDED. `--free` is provably $0 (the free_only chokepoint refuses a
 *     non-zero-cost model before the request; a zero-priced model cannot move the
 *     ledger). Paid runs are capped: a pre-flight estimate aborts before the first call,
 *     and the per-call reserve in budget.ts is the hard guarantee behind it.
 *
 * WRITERS ARE CLI-ONLY. applyPicksToSettings / applyToolModelToSettings /
 * applyFreePoolToSettings mutate settings.yaml and MUST NEVER become reachable from an
 * MCP handler (the read-only-MCP guardrail at pick.ts). This module is called from the
 * benchmark CLI and nowhere else.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  rankByQualityIndex,
  resolveFreePool,
  freeSuffixOnly,
  qualify,
  isZeroCostPriced,
  DEFAULT_CRITERIA,
  type OpenRouterModel,
  type QualifiedModel,
} from "./discover.js";
import { FreeModeSkipError } from "./free-mode.js";
import {
  TOOL_MODEL_REGISTRY,
  registeredTools,
  type ToolModelDescriptor,
} from "../model-qualification/registry.js";
import {
  applyFreePoolToSettings,
  applyPicksToSettings,
  applyToolModelToSettings,
  type PickedModel,
} from "./pick.js";
import {
  SpendLedger,
  BudgetExceededError,
  estimateCostUsd,
  makeBudgetedFetch,
  makeBudgetedGlobalFetch,
  CONSERVATIVE_CHARS_PER_TOKEN,
  type ModelPrice,
  type PriceLookup,
  type GlobalFetch,
} from "./budget.js";
import type { BenchmarkWorkload } from "./workload-types.js";
import type { FetchImpl } from "../security_scan/judge.js";
import { setActiveFreeOnly } from "../config.js";

import { describeWorkload as describeSecurityTriage } from "./security-triage/index.js";
import { describeWorkload as describeSearchExisting } from "./search-existing/index.js";
import { describeWorkload as describeCodeTask } from "./code-task/index.js";
import { describeWorkload as describeScanFolder } from "./scan-folder/index.js";
import { describeWorkload as describeCheckSpecs } from "./check-specs/index.js";

/** free = zero-cost models only ($0, no key needed to be safe). paid = the priced
 *  catalog. both = the free phase first, then the paid phase, on ONE shared budget. */
export type UpdateMode = "free" | "paid" | "both";

/** How a tool's model was chosen — the distinction the report MUST NOT blur. */
export type ToolGate = "benchmark-proven" | "requirement-gated";

export interface ToolOutcome {
  tool: string;
  /** Which phase produced this row. `--both` runs free THEN paid, so a tool appears
   *  once per phase — the rows are not duplicates, they are two different sweeps. */
  phase: "free" | "paid";
  gate: ToolGate;
  /** The registry's benchmark id, or null for a requirement-gated tool. */
  benchmark: string | null;
  /** Models that met this tool's hard requirements in the live catalog. */
  qualifiedModels: number;
  /** Models that actually RAN this tool's benchmark. 0 for a requirement-gated tool. */
  benchmarkedModels: number;
  /** The model this run selected, or null when nothing was selected. */
  winner: string | null;
  changed: boolean;
  costUsd: number;
  /** Did we persist `tool_models.<tool>`? False under --dry-run or when unchanged. */
  written: boolean;
  note: string;
  reportPath?: string;
}

/** What one per-tool benchmark run reports back. */
export interface ToolBenchmarkRun {
  recommendedModelId: string;
  changed: boolean;
  /** Eligible same-or-cheaper passers. 0 ⇒ the "recommendation" is just the incumbent. */
  eligibleCount: number;
  costUsd: number;
  reportPath: string;
}

export type ToolBenchmarkRunner = (args: {
  tool: string;
  benchmark: string;
  models: string[];
  fetchImpl: FetchImpl;
  force: boolean;
  onProgress: (m: string) => void;
}) => Promise<ToolBenchmarkRun>;

/** What the keyword/ensemble sweep reports back. */
export interface EnsembleSweepRun {
  /** Top-N picks, best first. Empty when the pick could not be satisfied. */
  picks: PickedModel[];
  /** Why the pick failed, or null. Fail-fast: we never write a half-picked ensemble. */
  pickError: string | null;
  /** ':free' models that PASSED, best first (pick.ts::passingFreePoolIds). */
  passingFreeIds: string[];
  modelsRun: number;
  passers: number;
  costUsd: number;
  reportPath: string;
}

export type EnsembleSweepRunner = (args: {
  /** Model ids to sweep. In free mode this is the resolved zero-cost pool. */
  models: string[];
  /** Sweep only these ids (free mode), or let the roster auto-discover (paid). */
  restrictToModels: boolean;
  fetchImpl: GlobalFetch;
  topN: number;
  onProgress: (m: string) => void;
}) => Promise<EnsembleSweepRun>;

export interface UpdateAllDeps {
  /** The live OpenRouter catalog. Injected so the orchestrator is testable offline. */
  fetchCatalog: () => Promise<OpenRouterModel[]>;
  runToolBenchmark: ToolBenchmarkRunner;
  runEnsembleSweep: EnsembleSweepRunner;
  /** The keyword sweep's workload — lives in index.ts (it owns fixture resolution). */
  describeEnsembleWorkload: () => BenchmarkWorkload;
  /**
   * The RAW HTTP boundary the budget guard wraps. Defaults to real `fetch`.
   *
   * Injectable so a test can drive REAL spend through the REAL ledger and prove the
   * mid-sweep abort — the guard is only worth having if something exercises it end to
   * end. Production always uses the default; nothing else may override it.
   */
  httpFetch?: FetchImpl;
  /** Same, for the keyword sweep's global-fetch-shaped seam. */
  httpGlobalFetch?: GlobalFetch;
}

export interface UpdateAllOptions {
  mode: UpdateMode;
  budgetUsd: number;
  dryRun: boolean;
  settingsPath: string;
  /** Profile to write. The caller resolves the active profile. */
  profileName: string;
  /** The profile's configured free_models (seeds free-pool resolution). */
  configuredFreeModels: readonly string[];
  /** Pre-benchmark candidate cap per tool. null = exhaustive. */
  qualifyingTopN: number | null;
  /** Ensemble slots to re-pick (the profile's current slot count). */
  ensembleTopN: number;
  force: boolean;
  mainRoot: string;
  onProgress?: (m: string) => void;
}

export interface UpdateAllResult {
  ok: boolean;
  mode: UpdateMode;
  dryRun: boolean;
  budgetUsd: number;
  /** Worst-case pre-flight estimate for the whole plan. */
  estimatedUsd: number;
  /** Actual spend, from the providers' own usage blocks. */
  spentUsd: number;
  modelsScanned: number;
  /** Distinct models meeting >= 1 tool's requirements. */
  modelsQualified: number;
  /** Distinct models that actually ran at least one benchmark. */
  modelsBenchmarked: number;
  toolsUpdated: number;
  tools: ToolOutcome[];
  ensemble: { picks: string[]; written: boolean; note: string } | null;
  freePool: { pool: string[]; written: boolean; note: string } | null;
  /** Non-null when the run aborted (budget, or a hard failure). */
  aborted: string | null;
  reportPath: string;
  /** One line, no trailing period — the CLI adds the [OK]/[FAILED] tag. */
  summary: string;
}

/** Per-tool benchmarks that run as their OWN sweep, keyed by the registry's benchmark id. */
const WORKLOAD_DESCRIBERS: Record<string, () => BenchmarkWorkload> = {
  "security-triage": describeSecurityTriage,
  "search-existing": describeSearchExisting,
  "code-task": describeCodeTask,
  "scan-folder": describeScanFolder,
  "check-specs": describeCheckSpecs,
};

/**
 * The registry benchmark id served by the ENSEMBLE sweep rather than by a per-tool run.
 *
 * A tool carrying this id (today: `mass_scout`) IS benchmark-proven — the keyword sweep
 * is its golden dataset — but it has no separate sweep and no `tool_models` write: it is
 * served by whatever the ensemble resolves to. It therefore falls through the per-tool
 * plan loop, and until this constant existed it fell out of the REPORT ENTIRELY: the
 * summary read "5 benchmark-proven + 5 requirement-gated" against an 11-tool registry,
 * and nobody could see that a tool was missing. A silently-omitted tool is the exact
 * failure this module refuses, so it gets an explicit row (and a test that counts them).
 */
const ENSEMBLE_BENCHMARK = "keyword-classification";

/** Tools the ENSEMBLE sweep gates (no per-tool sweep, no per-tool write). */
function ensembleGatedTools(): ToolModelDescriptor[] {
  return registeredTools()
    .map((t) => TOOL_MODEL_REGISTRY[t])
    .filter((d) => d.benchmark === ENSEMBLE_BENCHMARK);
}

function priceOfModel(m: OpenRouterModel): ModelPrice {
  const prompt = parseFloat(m.pricing?.prompt ?? "NaN") * 1_000_000;
  const completion = parseFloat(m.pricing?.completion ?? "NaN") * 1_000_000;
  return {
    inputDollarsPerMillion: isFinite(prompt) ? prompt : Infinity,
    outputDollarsPerMillion: isFinite(completion) ? completion : Infinity,
  };
}

/**
 * Worst-case cost of running ONE workload against ONE model.
 *
 * Both halves are deliberately pessimistic: input tokens use budget.ts's conservative
 * chars-per-token divisor, and output assumes EVERY call emits its full `max_tokens`.
 * A spend estimate that errs low is worse than useless — it authorizes a run it should
 * have refused — so it errs high, always.
 */
export function estimateWorkloadCostUsd(w: BenchmarkWorkload, price: ModelPrice): number {
  if (price.inputDollarsPerMillion === 0 && price.outputDollarsPerMillion === 0) return 0;
  const inTokens = Math.ceil(w.promptCharsPerModel / CONSERVATIVE_CHARS_PER_TOKEN);
  const outTokens = w.callsPerModel * w.maxOutputTokensPerCall;
  return estimateCostUsd(inTokens, outTokens, price);
}

/** One (tool × model) unit of paid work, priced before anything is sent. */
interface PlanItem {
  tool: string;
  benchmark: string;
  models: string[];
  workload: BenchmarkWorkload;
  estimatedUsd: number;
}

/**
 * THE ORCHESTRATOR. Everything above is types; this is the pipeline.
 */
export async function runUpdateAll(
  opts: UpdateAllOptions,
  deps: UpdateAllDeps,
): Promise<UpdateAllResult> {
  const progress = opts.onProgress ?? ((): void => {});
  const ledger = new SpendLedger(opts.budgetUsd);

  // ── 1. DISCOVER ────────────────────────────────────────────────────────────
  progress("discover: fetching the live OpenRouter catalog…");
  const catalog = await deps.fetchCatalog();
  progress(`discover: ${catalog.length} models in the catalog.`);

  const priceById = new Map<string, ModelPrice>();
  for (const m of catalog) priceById.set(m.id, priceOfModel(m));
  const priceOf: PriceLookup = (id) => priceById.get(id);

  // `both` = the FREE phase, then the PAID phase, on ONE shared ledger. Free costs $0,
  // so the whole budget survives for the paid half. A phase is never "both".
  const phases: Array<"free" | "paid"> =
    opts.mode === "both" ? ["free", "paid"] : opts.mode === "free" ? ["free"] : ["paid"];
  const tools: ToolOutcome[] = [];
  const benchmarkedModels = new Set<string>();
  const qualifiedModels = new Set<string>();
  let ensemble: UpdateAllResult["ensemble"] = null;
  let freePool: UpdateAllResult["freePool"] = null;
  let aborted: string | null = null;
  let estimatedUsd = 0;
  let toolsUpdated = 0;

  for (const phase of phases) {
    if (aborted !== null) break;

    // ── 2. REQUIREMENT-GATE ──────────────────────────────────────────────────
    //
    // free_only is published to config.ts BEFORE any benchmark runs, so every runner's
    // own chokepoint (runner.ts / each per-tool index.ts) refuses a non-zero-cost model
    // on its own. That is what makes `--free` provably $0 rather than $0-by-convention:
    // the guarantee lives at the call site, not in this orchestrator's good intentions.
    const isFree = phase === "free";
    setActiveFreeOnly(isFree);
    progress(`gate: ${phase} phase — free_only=${isFree}.`);

    /** Candidate ids per tool, after that tool's own requirements. */
    const candidatesForTool = new Map<string, string[]>();
    // Assigned by BOTH branches below (free pool / paid roster) — no initializer, so a
    // future branch that forgets to set it is a compile error rather than a silent
    // "swept zero candidates and reported success".
    let ensembleCandidates: string[];

    if (isFree) {
      // FREE-MODELS SEARCH (an explicit part of the goal — the pool is no longer
      // hand-edited). Zero-cost models are discovered from the live catalog, VERIFIED
      // against it, and the survivors become every tool's candidate set.
      const { pool: discoveredPool, autoDiscovered, rejected } = resolveFreePool(
        opts.configuredFreeModels,
        catalog,
        { autoDiscover: true, autoDiscoverTopN: opts.qualifyingTopN ?? 16 },
      );
      if (rejected.length > 0) {
        // Fail fast: a configured "free" id the catalog PRICES is a model that would
        // silently bill. Never quietly drop it — the pool itself is wrong.
        return abortResult(
          opts,
          ledger,
          catalog.length,
          `free-pool: configured non-':free' id(s) ${JSON.stringify(rejected)} are NOT priced at $0 by the live catalog (they would cost money) or are absent from it — fix the profile's free_models`,
        );
      }
      // This phase has activated free_only (setActiveFreeOnly(true) above), and the runtime
      // send-time chokepoint assertFreeOnlyModel() (config.ts) admits ONLY ':free'-suffixed
      // ids — it has no catalog-price context. resolveFreePool, by contrast, ALSO admits
      // zero-cost models that LACK the suffix (isZeroCostPriced): ROUTER/auto pseudo-models
      // like 'openrouter/free' / 'openrouter/auto', plus open-beta no-suffix models. Under
      // free_only such an id can NEVER be sent (assertFreeOnlyModel throws) and can NEVER be
      // written to free_models (config.ts rejects it) — benchmarking it is meaningless, and a
      // SINGLE one throwing inside a per-tool judge (e.g. security-triage's judgeGroups) would
      // abort this whole multi-tool sweep at its first send. So drop every non-':free' id HERE,
      // before the pool feeds ANY consumer (ensemble sweep, every per-tool benchmark, the
      // free_models write-back), matching exactly what assertFreeOnlyModel permits.
      const pool = freeSuffixOnly(discoveredPool);
      const nonFreeExcluded = discoveredPool.length - pool.length;
      if (pool.length === 0) {
        return abortResult(
          opts,
          ledger,
          catalog.length,
          "free-pool: the live catalog currently offers no zero-cost ':free' model that meets the structural bar (structured output / context / output length) — nothing to benchmark" +
            (nonFreeExcluded > 0
              ? ` (${nonFreeExcluded} zero-cost non-':free' id(s) were excluded — unusable under free_only)`
              : ""),
        );
      }
      progress(
        `gate: free pool = ${pool.length} ':free' model(s)` +
          (autoDiscovered.length > 0 ? ` (${freeSuffixOnly(autoDiscovered).length} auto-discovered)` : "") +
          (nonFreeExcluded > 0
            ? `; excluded ${nonFreeExcluded} zero-cost non-':free' id(s) (unusable under free_only)`
            : "") +
          ".",
      );
      ensembleCandidates = [...pool];
      for (const tool of registeredTools()) candidatesForTool.set(tool, [...pool]);
      for (const id of pool) qualifiedModels.add(id);
    } else {
      // PAID: each tool's own requirements from the registry, quality-ranked, capped.
      for (const tool of registeredTools()) {
        const d = TOOL_MODEL_REGISTRY[tool];
        const q: QualifiedModel[] = [];
        for (const m of catalog) {
          const ok = qualify(m, d.requirements);
          // A zero-cost model is benchmarked in the FREE phase; including it here too
          // would double-run it under `--both` for no new information.
          if (ok && !isZeroCostPriced(ok.inputDollarsPerMillion, ok.outputDollarsPerMillion)) {
            q.push(ok);
          }
        }
        const ranked = rankByQualityIndex(q);
        const capped = opts.qualifyingTopN !== null ? ranked.slice(0, opts.qualifyingTopN) : ranked;
        candidatesForTool.set(
          tool,
          capped.map((c) => c.id),
        );
        for (const c of capped) qualifiedModels.add(c.id);
      }
      // The ensemble serves every tool WITHOUT a per-tool override, so it is gated on
      // the shared baseline criteria, not on any single tool's.
      const ensQ = catalog
        .map((m) => qualify(m, DEFAULT_CRITERIA))
        .filter((m): m is QualifiedModel => m !== null);
      ensembleCandidates = rankByQualityIndex(ensQ)
        .slice(0, opts.qualifyingTopN ?? ensQ.length)
        .map((m) => m.id);
      for (const id of ensembleCandidates) qualifiedModels.add(id);
    }

    // ── 3a. PRE-FLIGHT COST ESTIMATE (before ANY paid call) ───────────────────
    const plan: PlanItem[] = [];
    const ensembleWorkload = deps.describeEnsembleWorkload();
    let phaseEstimate = 0;
    for (const id of ensembleCandidates) {
      const p = priceOf(id);
      if (p) phaseEstimate += estimateWorkloadCostUsd(ensembleWorkload, p);
    }
    for (const tool of registeredTools()) {
      const d = TOOL_MODEL_REGISTRY[tool];
      if (d.benchmark === null) continue; // requirement-gated: makes no LLM call
      const describe = WORKLOAD_DESCRIBERS[d.benchmark];
      if (describe === undefined) continue; // keyword-classification: the ensemble, above
      const models = candidatesForTool.get(tool) ?? [];
      const workload = describe();
      let est = 0;
      for (const id of models) {
        const p = priceOf(id);
        if (p) est += estimateWorkloadCostUsd(workload, p);
      }
      phaseEstimate += est;
      plan.push({ tool, benchmark: d.benchmark, models, workload, estimatedUsd: est });
    }
    estimatedUsd += phaseEstimate;
    progress(
      `plan: ${phase} phase — worst-case estimate $${phaseEstimate.toFixed(4)} ` +
        `(cap $${opts.budgetUsd.toFixed(2)}, already spent $${ledger.spentUsd.toFixed(4)}).`,
    );

    if (ledger.spentUsd + phaseEstimate > opts.budgetUsd) {
      // ABORT BEFORE SPENDING A CENT. Say the number, and say the exact flag that
      // would let it through — so raising the cap is an informed, typed decision and
      // never a shrug. (In free mode the estimate is $0, so this can never fire.)
      // No trailing period: finalLine() appends ". Report: <path>", and a period here
      // would render as "…free ($0).. Report:".
      return abortResult(
        opts,
        ledger,
        catalog.length,
        `WORST-CASE pre-flight estimate $${(ledger.spentUsd + phaseEstimate).toFixed(4)} exceeds the $${opts.budgetUsd.toFixed(2)} cap — nothing was sent, $0 spent. ` +
          `This bound assumes every call emits its full max_tokens, so real spend is typically far lower. ` +
          `To proceed: --budget-usd ${Math.ceil((ledger.spentUsd + phaseEstimate) * 100) / 100} (authorizes the worst case), ` +
          `or shrink the sweep with --qualifying-top-n N, or use --free ($0)`,
        { tools, estimatedUsd, ensemble, freePool },
      );
    }

    if (opts.dryRun) {
      // Dry-run stops HERE — after the full plan is priced, before any call and before
      // any write. The plan and the estimate ARE the output.
      progress(`dry-run: ${plan.length} benchmark(s) planned over ${ensembleCandidates.length} ensemble candidate(s); nothing sent, nothing written.`);
      for (const item of plan) {
        tools.push({
          tool: item.tool,
          phase,
          gate: "benchmark-proven",
          benchmark: item.benchmark,
          qualifiedModels: item.models.length,
          benchmarkedModels: 0,
          winner: null,
          changed: false,
          costUsd: 0,
          written: false,
          note: `dry-run — would benchmark ${item.models.length} model(s), worst case $${item.estimatedUsd.toFixed(4)}`,
        });
      }
      for (const d of ensembleGatedTools()) {
        tools.push({
          tool: d.tool,
          phase,
          gate: "benchmark-proven",
          benchmark: d.benchmark,
          qualifiedModels: ensembleCandidates.length,
          benchmarkedModels: 0,
          winner: null,
          changed: false,
          costUsd: 0,
          written: false,
          note: `dry-run — gated by the ensemble's keyword sweep (${ensembleCandidates.length} candidate(s)); served by the ensemble default, no per-tool write`,
        });
      }
      for (const tool of requirementGatedTools()) {
        tools.push(requirementGatedOutcome(tool, phase, (candidatesForTool.get(tool.tool) ?? []).length, true));
      }
      ensemble = {
        picks: [],
        written: false,
        note: `dry-run — would sweep ${ensembleCandidates.length} candidate(s) for ${opts.ensembleTopN} slot(s)`,
      };
      continue;
    }

    // ── 3b. BENCHMARK — the ensemble (keyword) sweep ──────────────────────────
    // THE chokepoint. Every paid call the sweep or any tool benchmark makes goes through
    // one of these two wrappers, so the cap is enforced at the moment money is committed
    // — not by trusting each runner to behave.
    const budgetedGlobal = makeBudgetedGlobalFetch(ledger, priceOf, deps.httpGlobalFetch);
    const budgetedFetch = makeBudgetedFetch(deps.httpFetch ?? defaultFetchImpl, ledger, priceOf);

    progress(`benchmark: ensemble keyword sweep over ${ensembleCandidates.length} candidate(s)…`);
    let sweep: EnsembleSweepRun;
    try {
      sweep = await deps.runEnsembleSweep({
        models: ensembleCandidates,
        restrictToModels: isFree,
        fetchImpl: budgetedGlobal,
        topN: opts.ensembleTopN,
        onProgress: progress,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return abortResult(opts, ledger, catalog.length, err.message, {
          tools,
          estimatedUsd,
          ensemble,
          freePool,
        });
      }
      throw err;
    }
    for (const id of ensembleCandidates) benchmarkedModels.add(id);

    // The trip latch is why this check exists AT ALL: the runners CATCH fetch errors
    // (never-throw contract), so a BudgetExceededError raised inside the sweep is
    // swallowed into per-model failures. The ledger remembers. Fail the run here.
    if (ledger.tripped !== null) {
      return abortResult(opts, ledger, catalog.length, `SPEND CAP hit during the ensemble sweep — ${ledger.tripped}. Nothing further was sent.`, {
        tools,
        estimatedUsd,
        ensemble,
        freePool,
      });
    }

    // ── 4a. RANK + WRITE — the ensemble, and (free mode) the free_models pool ──
    if (sweep.pickError !== null) {
      // No silent fallback. A half-picked ensemble is worse than an untouched one.
      ensemble = { picks: [], written: false, note: `NOT written — ${sweep.pickError}` };
    } else if (sweep.picks.length > 0) {
      applyPicksToSettings(opts.settingsPath, opts.profileName, sweep.picks);
      ensemble = {
        picks: sweep.picks.map((p) => p.modelId),
        written: true,
        note: `top-${sweep.picks.length} of ${sweep.passers} passer(s)`,
      };
      progress(`write: ensemble → ${sweep.picks.map((p) => p.modelId).join(", ")}`);
    } else {
      ensemble = { picks: [], written: false, note: "no model passed the keyword sweep" };
    }

    if (isFree) {
      if (sweep.passingFreeIds.length > 0) {
        const w = applyFreePoolToSettings(
          opts.settingsPath,
          opts.profileName,
          sweep.passingFreeIds,
        );
        freePool = {
          pool: w.newPool,
          written: true,
          note: `${w.oldPool.length} → ${w.newPool.length} (the ':free' models that passed)`,
        };
        progress(`write: free_models → ${w.newPool.length} model(s)`);
      } else {
        // Refuse to write an empty pool: config.ts rejects it under free_only, so the
        // "successful" write would hand the user an unloadable settings.yaml.
        freePool = {
          pool: [],
          written: false,
          note: "NOT written — no ':free' model passed the sweep; the existing pool is left alone",
        };
      }
    }

    // The ensemble-gated tools (mass_scout): benchmark-PROVEN by the keyword sweep that
    // just ran, but served by the ensemble default — no separate sweep, no tool_models
    // write. They get an explicit row so the report accounts for EVERY registered tool.
    for (const d of ensembleGatedTools()) {
      tools.push({
        tool: d.tool,
        phase,
        gate: "benchmark-proven",
        benchmark: d.benchmark,
        qualifiedModels: ensembleCandidates.length,
        benchmarkedModels: ensembleCandidates.length,
        winner: ensemble.picks[0] ?? null,
        changed: ensemble.written,
        costUsd: 0,
        written: false, // the ENSEMBLE write serves it; a tool_models entry would be redundant
        note: ensemble.written
          ? "proven by the ensemble's keyword sweep; served by the ensemble default (no per-tool override needed)"
          : `proven by the ensemble's keyword sweep, but the ensemble was not written — ${ensemble.note}`,
      });
    }

    // ── 3c/4b. BENCHMARK + WRITE — each tool that HAS a benchmark ─────────────
    for (const item of plan) {
      if (ledger.tripped !== null) {
        tools.push({
          tool: item.tool,
          phase,
          gate: "benchmark-proven",
          benchmark: item.benchmark,
          qualifiedModels: item.models.length,
          benchmarkedModels: 0,
          winner: null,
          changed: false,
          costUsd: 0,
          written: false,
          note: "SKIPPED — spend cap already hit",
        });
        continue;
      }

      progress(`benchmark: ${item.tool} (${item.benchmark}) over ${item.models.length} model(s)…`);
      let run: ToolBenchmarkRun;
      try {
        run = await deps.runToolBenchmark({
          tool: item.tool,
          benchmark: item.benchmark,
          models: item.models,
          fetchImpl: budgetedFetch,
          force: opts.force,
          onProgress: progress,
        });
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          aborted = err.message;
          tools.push({
            tool: item.tool,
            phase,
            gate: "benchmark-proven",
            benchmark: item.benchmark,
            qualifiedModels: item.models.length,
            benchmarkedModels: 0,
            winner: null,
            changed: false,
            costUsd: 0,
            written: false,
            note: "ABORTED — spend cap",
          });
          // `continue`, NOT `break`: the loop's top-of-iteration guard then records every
          // remaining tool as SKIPPED. Breaking here would leave them with no row at all
          // — an omission the reader could easily misread as "fine, nothing to report",
          // which is precisely the silence this whole module refuses.
          continue;
        }
        if (err instanceof FreeModeSkipError) {
          // EXPECTED under `--free`, NOT a bug: this tool's benchmark has no ':free'
          // model it may send (its only model is the paid incumbent), so it cannot be
          // benchmarked in this phase. Say exactly that. The cost-safety guard's
          // "this is a bug, please report it" wording stays reserved for a GENUINE
          // leak — a paid id reaching the sender — which falls through to the ERRORED
          // path below and SHOULD read as a bug.
          progress(`benchmark: ${item.tool} skipped under free mode: ${err.message} (sweep continues).`);
          tools.push({
            tool: item.tool,
            phase,
            gate: "benchmark-proven",
            benchmark: item.benchmark,
            qualifiedModels: item.models.length,
            benchmarkedModels: 0,
            winner: null,
            changed: false,
            costUsd: 0,
            written: false,
            note: `skipped under free mode: ${err.message}`,
          });
          continue;
        }
        // RESILIENCE (defense in depth — TRDD free-pool fix): a per-tool benchmark that
        // THROWS for a NON-budget reason must NOT abort the entire multi-tool sweep and
        // discard every tool already written this phase. The canonical trigger is a
        // cost-safety guard throw (assertFreeOnlyModel) reaching us from inside a tool's
        // per-model judge — but ANY unexpected per-tool error is contained the same way.
        // Record this tool as ERRORED and continue; the ensemble keyword phase already
        // tolerates per-model errors identically (runner.ts returns a RunError, never
        // throws). The run still ends [OK] — only a genuine whole-run failure (budget,
        // catalog fetch, the ensemble sweep itself) aborts, so `aborted` is NOT set here.
        const errMsg = err instanceof Error ? err.message : String(err);
        progress(`benchmark: ${item.tool} ERRORED — ${errMsg} (skipped; sweep continues).`);
        tools.push({
          tool: item.tool,
          phase,
          gate: "benchmark-proven",
          benchmark: item.benchmark,
          qualifiedModels: item.models.length,
          benchmarkedModels: 0,
          winner: null,
          changed: false,
          costUsd: 0,
          written: false,
          note: `ERRORED — ${errMsg} (skipped; sweep continued)`,
        });
        continue;
      }
      for (const id of item.models) benchmarkedModels.add(id);

      // An empty eligible set means the "recommendation" IS the incumbent — writing it
      // back would masquerade as an adoption. Say so instead of quietly no-op'ing.
      let written = false;
      let note: string;
      if (run.eligibleCount === 0) {
        note = "no eligible same-or-cheaper passer — incumbent kept, nothing written";
      } else if (!run.changed) {
        note = "incumbent is still the best eligible passer — nothing to write";
      } else {
        applyToolModelToSettings(opts.settingsPath, opts.profileName, item.tool, run.recommendedModelId);
        written = true;
        toolsUpdated++;
        note = `adopted into tool_models.${item.tool}`;
        progress(`write: tool_models.${item.tool} → ${run.recommendedModelId}`);
      }

      tools.push({
        tool: item.tool,
        phase,
        gate: "benchmark-proven",
        benchmark: item.benchmark,
        qualifiedModels: item.models.length,
        benchmarkedModels: item.models.length,
        winner: run.recommendedModelId,
        changed: run.changed,
        costUsd: run.costUsd,
        written,
        note,
        reportPath: run.reportPath,
      });

      if (ledger.tripped !== null) {
        // Record the abort, but keep looping so the remaining tools are each written out
        // as SKIPPED (see the top-of-iteration guard). The ledger is latched, so not one
        // further call can be sent — looping costs nothing and buys a complete report.
        aborted = `SPEND CAP hit during the ${item.tool} benchmark — ${ledger.tripped}. Nothing further was sent.`;
      }
    }

    // ── The requirement-gated tools. They make NO LLM call, so they cost nothing and
    //    can never be "proven". They are listed so the report is complete — and
    //    labelled so nobody mistakes a requirements check for a benchmark pass.
    for (const tool of requirementGatedTools()) {
      tools.push(requirementGatedOutcome(tool, phase, (candidatesForTool.get(tool.tool) ?? []).length, false));
    }
  }

  // Free mode must have cost nothing. If it somehow did, that is a BUG in a chokepoint,
  // and a cost-safety bug must be loud, not swallowed.
  if (opts.mode === "free" && ledger.spentUsd > 0) {
    aborted = `FREE MODE SPENT MONEY ($${ledger.spentUsd.toFixed(6)}) — this is a cost-safety bug in a free_only chokepoint, not a normal failure. Report it.`;
  }

  const result: UpdateAllResult = {
    ok: aborted === null,
    mode: opts.mode,
    dryRun: opts.dryRun,
    budgetUsd: opts.budgetUsd,
    estimatedUsd,
    spentUsd: ledger.spentUsd,
    modelsScanned: catalog.length,
    modelsQualified: qualifiedModels.size,
    modelsBenchmarked: benchmarkedModels.size,
    toolsUpdated,
    tools,
    ensemble,
    freePool,
    aborted,
    reportPath: "",
    summary: "",
  };
  result.reportPath = writeReport(result, opts);
  result.summary = buildSummary(result);
  return result;
}

/** Tools the registry gates on REQUIREMENTS ONLY — no benchmark exists for them yet. */
function requirementGatedTools(): ToolModelDescriptor[] {
  return registeredTools()
    .map((t) => TOOL_MODEL_REGISTRY[t])
    .filter((d) => d.benchmark === null);
}

function requirementGatedOutcome(
  d: ToolModelDescriptor,
  phase: "free" | "paid",
  qualified: number,
  dryRun: boolean,
): ToolOutcome {
  return {
    tool: d.tool,
    phase,
    gate: "requirement-gated",
    benchmark: null,
    qualifiedModels: qualified,
    benchmarkedModels: 0,
    winner: null,
    changed: false,
    costUsd: 0,
    written: false,
    note: dryRun
      ? "requirements-only (no benchmark exists) — nothing to run, nothing to write"
      : "requirements-only (no benchmark exists) — NOT benchmark-proven; left on the ensemble default",
  };
}

/** The real HTTP impl the per-tool benchmarks get, before the budget guard wraps it. */
const defaultFetchImpl: FetchImpl = async (url, init) => {
  const resp = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    ok: resp.ok,
    status: resp.status,
    json: () => resp.json(),
    text: () => resp.text(),
  };
};

function abortResult(
  opts: UpdateAllOptions,
  ledger: SpendLedger,
  modelsScanned: number,
  reason: string,
  partial?: {
    tools: ToolOutcome[];
    estimatedUsd: number;
    ensemble: UpdateAllResult["ensemble"];
    freePool: UpdateAllResult["freePool"];
  },
): UpdateAllResult {
  const result: UpdateAllResult = {
    ok: false,
    mode: opts.mode,
    dryRun: opts.dryRun,
    budgetUsd: opts.budgetUsd,
    estimatedUsd: partial?.estimatedUsd ?? 0,
    spentUsd: ledger.spentUsd,
    modelsScanned,
    modelsQualified: 0,
    modelsBenchmarked: 0,
    toolsUpdated: 0,
    tools: partial?.tools ?? [],
    ensemble: partial?.ensemble ?? null,
    freePool: partial?.freePool ?? null,
    aborted: reason,
    reportPath: "",
    summary: "",
  };
  result.reportPath = writeReport(result, opts);
  result.summary = reason;
  return result;
}

function buildSummary(r: UpdateAllResult): string {
  if (r.aborted !== null) return r.aborted;
  const proven = r.tools.filter((t) => t.gate === "benchmark-proven").length;
  const gated = r.tools.filter((t) => t.gate === "requirement-gated").length;
  const head = r.dryRun ? "dry-run — nothing sent, nothing written" : `${r.mode} refresh complete`;
  return (
    `${head}: ${r.modelsScanned} scanned / ${r.modelsQualified} qualified / ` +
    `${r.modelsBenchmarked} benchmarked, ${proven} benchmark-proven + ${gated} requirement-gated tool(s), ` +
    `${r.toolsUpdated} tool(s) updated, ` +
    (r.dryRun
      ? `worst-case estimate $${r.estimatedUsd.toFixed(4)} (cap $${r.budgetUsd.toFixed(2)}), $0 spent`
      : `$${r.spentUsd.toFixed(4)} spent of the $${r.budgetUsd.toFixed(2)} cap`)
  );
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`
  );
}

export function renderUpdateAllReport(r: UpdateAllResult, opts: UpdateAllOptions): string {
  const L: string[] = [];
  L.push(`# Model pipeline — \`--update-all\` (${r.mode})`);
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push(`Profile: \`${opts.profileName}\`  ·  Settings: \`${opts.settingsPath}\``);
  L.push("");
  L.push(r.aborted !== null ? `## ABORTED\n\n${r.aborted}` : `## Result\n\n${r.summary}`);
  L.push("");
  L.push("## Spend");
  L.push("");
  L.push("| | USD |");
  L.push("|---|---|");
  L.push(`| Cap (\`--budget-usd\`) | $${r.budgetUsd.toFixed(2)} |`);
  L.push(`| Worst-case pre-flight estimate | $${r.estimatedUsd.toFixed(4)} |`);
  L.push(`| **Actually spent** | **$${r.spentUsd.toFixed(4)}** |`);
  L.push("");
  if (r.mode === "free") {
    L.push(
      "Free mode is **$0 by construction**: `free_only` is published to the config before " +
        "any benchmark runs, so every runner's own chokepoint refuses a model that is not " +
        "zero-cost *before* the request leaves the process.",
    );
    L.push("");
  }
  L.push("## Tools — how each model was gated");
  L.push("");
  L.push(
    "**benchmark-proven** = a model ran that tool's golden dataset and passed it. " +
      "**requirement-gated** = the model was only checked against the tool's hard " +
      "requirements (cost / context / output / params); *no benchmark exists for that " +
      "tool yet*, so nothing about its task quality has been demonstrated.",
  );
  L.push("");
  L.push("| Tool | Phase | Gate | Benchmark | Qualified | Benchmarked | Winner | Written | Spend | Note |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const t of r.tools) {
    L.push(
      `| \`${t.tool}\` | ${t.phase} | ${t.gate === "benchmark-proven" ? "**benchmark-proven**" : "requirement-gated"} | ` +
        `${t.benchmark ?? "—"} | ${t.qualifiedModels} | ${t.benchmarkedModels} | ` +
        `${t.winner ? `\`${t.winner}\`` : "—"} | ${t.written ? "yes" : "no"} | ` +
        `$${t.costUsd.toFixed(4)} | ${t.note} |`,
    );
  }
  L.push("");
  L.push("## Ensemble");
  L.push("");
  L.push(
    r.ensemble === null
      ? "_not reached_"
      : `${r.ensemble.written ? "**written**" : "not written"} — ${r.ensemble.note}` +
          (r.ensemble.picks.length > 0 ? `\n\n${r.ensemble.picks.map((p, i) => `${i + 1}. \`${p}\``).join("\n")}` : ""),
  );
  L.push("");
  if (r.freePool !== null) {
    L.push("## free_models pool");
    L.push("");
    L.push(`${r.freePool.written ? "**written**" : "not written"} — ${r.freePool.note}`);
    if (r.freePool.pool.length > 0) {
      L.push("");
      for (const id of r.freePool.pool) L.push(`- \`${id}\``);
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}

function writeReport(r: UpdateAllResult, opts: UpdateAllOptions): string {
  const path = join(opts.mainRoot, "reports", "update-all", `${stamp()}-update-all.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderUpdateAllReport(r, opts), "utf-8");
  return path;
}
