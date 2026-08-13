#!/usr/bin/env node
/**
 * Benchmark CLI entry point.
 *
 * Usage:
 *   node dist/benchmark.js [--include MODEL_ID]... [--dry-run] [--report PATH]
 *
 * Flow:
 *   1. Build ground truth from fixtures/*.ts
 *   2. Fetch OpenRouter `/api/v1/models?category=programming`
 *   3. Apply the cost + capability filter → candidates
 *   4. Add explicit `--include MODEL_ID` baselines (bypass the filter)
 *   5. For each model, call OpenRouter with the fixtures + strict JSON schema
 *   6. Score each result against ground truth
 *   7. Emit a markdown report under reports/benchmark/<ts>-results.md
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withUsageContext } from "../usage-history.js";
import { buildGroundTruth, BENCHMARK_KEYWORDS } from "./ground-truth.js";
import {
  DEFAULT_CRITERIA,
  buildBenchmarkRoster,
  assertModelsUnderPriceCap,
  assertPaidBenchmarkAllowed,
  setPaidBenchmarksAllowed,
  rankByQualityIndex,
  resolveFreePool,
  freeSuffixOnly,
  fetchProgrammingModels,
  type OpenRouterModel,
  type QualifiedModel,
} from "./discover.js";
import { runBenchmarkOnModel, keywordPromptChars, type RunOutcome } from "./runner.js";
import { recordGeneralKeywordPasses } from "./validated.js";
import { scoreRun, type ModelScore } from "./score.js";
import { renderReport, renderJson } from "./report.js";
import {
  applyEnsembleSlotToSettings,
  applyFreePoolToSettings,
  applyPicksToSettings,
  applyToolModelToSettings,
  loadCachedReport,
  passingFreePoolIds,
  pickTopN,
  pickEnsembleByPriceCeiling,
  pickMassScoutModel,
  updateFreeDefaultProfile,
  updateEnsembleDefaultProfile,
  updateMassScoutDefaultProfile,
  renderEnsembleBlock,
  ENSEMBLE_SLOTS,
  type CachedReport,
  type CachedResult,
  type EnsembleSlot,
  type PickedModel,
} from "./pick.js";
import { runUpdateAll, estimateWorkloadCostUsd, type EnsembleSweepRun, type ToolBenchmarkRun } from "./update-all.js";
import { ASSUMED_MAX_OUTPUT_TOKENS } from "./budget.js";
import type { BenchmarkWorkload } from "./workload-types.js";
import { runSecurityTriageBenchmark } from "./security-triage/index.js";
import { runSearchExistingBenchmark } from "./search-existing/index.js";
import { runCodeAuditBenchmark } from "./code-task/index.js";
import { runScanFolderBenchmark } from "./scan-folder/index.js";
import { runCheckSpecsBenchmark } from "./check-specs/index.js";
import {
  planEnsembleRotation,
  planToolReplacements,
  renderEnsembleRotationSection,
} from "../model-qualification/auto-replace.js";
import {
  assessModelById,
  renderAssessmentText,
} from "../model-qualification/assess.js";
import {
  runCheckModelHealth,
  renderModelHealthText,
  compactStamp,
} from "../model-qualification/drift.js";
import {
  runDiscoverNewArrivals,
  renderNewArrivalsText,
} from "../model-qualification/new-arrivals.js";
import { resolveProjectMainRoot } from "../project-root.js";
import {
  getConfigDir,
  getSettingsPath,
  loadSettings,
  resolveProfile,
  setActiveFreeOnly,
  setAllowPaidModels,
  profileFreeModels,
  FREE_POOL_SEED,
  getEnsemblePriceCeiling,
} from "../config.js";
import { recordBenchmarkSuccess, recordBenchmarkFailure } from "../default-profiles-state.js";
import { poolFingerprint, type CatalogPriceSnapshot } from "../default-profiles.js";
import { toCatalogPriceSnapshot } from "../model-reconcile.js";

import { parseArgs, type CliOptions } from "./cli-args.js";

function resolveApiKey(): string {
  const k = process.env.OPENROUTER_API_KEY || process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
  if (!k) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Export it in your shell, or set the plugin option 'openrouter_api_key' via Claude Code's /plugin configure.",
    );
  }
  return k;
}

function resolveFixturesDir(): string {
  // __dirname for ES modules
  const here = dirname(fileURLToPath(import.meta.url));
  // When bundled to dist/benchmark.js, fixtures sit at ../src/benchmark/fixtures
  // When running from src/benchmark/index.ts (unbundled), they sit alongside
  // as ./fixtures. Try both.
  const candidates = [
    join(here, "fixtures"),
    join(here, "..", "src", "benchmark", "fixtures"),
    join(here, "..", "..", "src", "benchmark", "fixtures"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "file-01.ts"))) return c;
  }
  throw new Error(`Could not locate benchmark fixtures. Tried:\n  ${candidates.join("\n  ")}`);
}

function resolveMainRoot(): string {
  // Single source of truth — see project-root.ts (CLAUDE_PROJECT_DIR verbatim →
  // cwd; no git). Anchors benchmark reports in the main project dir.
  return resolveProjectMainRoot();
}

// ── The single machine-readable contract (P1 zero-token model pipeline) ──────
//
// EVERY path through this CLI ends with EXACTLY ONE line on stdout:
//
//     [OK] <summary>. Report: <abs path>          (exit 0)
//     [FAILED] <reason>                           (exit non-zero)
//
// The caller (a slash command) prints that line verbatim and is done — it never
// parses stderr, never picks a message template, never judges whether the run
// worked. Before P1 the commands' prose asked the AGENT to do all three.

interface CliResult {
  ok: boolean;
  /** One line, no trailing period — finalLine adds the punctuation. */
  summary: string;
  /** The artifact the user should read, when the phase wrote one. */
  reportPath?: string;
  /** Exit code override. Default: 0 when ok, 1 otherwise. */
  code?: number;
}

function finalLine(r: CliResult): string {
  const tag = r.ok ? "[OK]" : "[FAILED]";
  return r.reportPath ? `${tag} ${r.summary}. Report: ${r.reportPath}` : `${tag} ${r.summary}`;
}

/**
 * Does this invocation make a PAID OpenRouter call? Everything listed here is
 * free: --dry-run stops before the first call; --check-health / --new-arrivals /
 * --assess-model / --adopt hit only the PUBLIC catalog (no key); --from-cache
 * reads the JSON sidecar. --auto-replace is deliberately NOT gated: on a healthy
 * ledger it runs zero benchmarks, so demanding a key it may never use would be a
 * false prerequisite (and when it DOES run one, resolveApiKey reports the miss).
 */
function needsApiKey(opts: CliOptions): boolean {
  if (opts.dryRun || opts.fromCache || opts.checkHealth || opts.newArrivals) return false;
  if (opts.assessModel !== null || opts.adoptModel !== null) return false;
  if (opts.autoReplace) return false;
  return true;
}

/**
 * Flag-combination validation. Runs BEFORE preflight, because a usage error is true
 * regardless of the environment: `--apply-free-pool P` with no `--bench-free-pool` is
 * wrong whether or not an API key is present, and reporting "OPENROUTER_API_KEY not
 * set" for it would send the caller off fixing the wrong thing.
 *
 * Every rule here is "flag X is meaningless without flag Y" — each would otherwise be
 * a SILENT no-op, which is the failure class we refuse (fail fast, never quietly do
 * nothing).
 */
function validateCombinations(opts: CliOptions): void {
  if (opts.apply && !opts.autoReplace) {
    throw new Error("--apply requires --auto-replace");
  }
  if (
    opts.applyProfile !== null &&
    opts.pickTopN === null &&
    !opts.codeTask &&
    !opts.scanFolder &&
    !opts.checkSpecs
  ) {
    // --code-task, --scan-folder and --check-specs are the legitimate single-winner
    // consumers of --apply-profile: each produces ONE winner (not a top-N ensemble),
    // which it writes into that profile's `tool_models.<tool>`. Everything else needs
    // --pick-top-n to have anything to write.
    throw new Error(
      "--apply-profile requires --pick-top-n (or --code-task / --scan-folder / --check-specs, which write their single winner into tool_models.code_task / tool_models.scan_folder / tool_models.check_against_specs)",
    );
  }
  if (opts.fromCache && opts.pickTopN === null) {
    throw new Error("--from-cache requires --pick-top-n (no point loading the cache otherwise).");
  }
  if (opts.applyFreePool !== null && !opts.benchFreePool) {
    // The pool it writes is "the ':free' models that PASSED" — which only exists when
    // the free pool was the thing benchmarked.
    throw new Error("--apply-free-pool requires --bench-free-pool");
  }
  if (opts.adoptModel === null && (opts.adoptInto !== null || opts.adoptProfile !== null)) {
    throw new Error("--adopt-into / --adopt-profile require --adopt <MODEL_ID>");
  }
  if (opts.adoptModel !== null && opts.adoptInto === null) {
    throw new Error(`--adopt requires --adopt-into <${ENSEMBLE_SLOTS.join("|")}|tool:NAME>`);
  }
}

/**
 * Prerequisite self-check. The CLI decides what it needs and refuses itself —
 * the slash commands used to make the AGENT probe $OPENROUTER_API_KEY and branch
 * on the result, which is judgment (and tokens) spent re-deriving something the
 * process can check in a microsecond.
 */
function preflight(opts: CliOptions): void {
  if (!needsApiKey(opts)) return;
  if (!process.env.OPENROUTER_API_KEY && !process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY not set — export it in your shell, or set the plugin option " +
        "'openrouter_api_key' via /plugin configure llm-externalizer",
    );
  }
}

/** Well-known JSON sidecar every run writes; --from-cache and --pick-top-n read it. */
function benchmarkCachePath(): string {
  // getConfigDir() — NOT homedir() — so LLM_EXT_CONFIG_DIR is honored. Identical to
  // ~/.llm-externalizer in production; in tests it is what keeps a CLI run that
  // WRITES settings from ever touching the developer's real config.
  return join(getConfigDir(), "benchmark-results.json");
}

/**
 * A CONFIG-level refusal that, like a usage error, is true regardless of the
 * environment — so it must fire BEFORE the API-key preflight.
 *
 * A `free_only` profile is the user saying "this configuration must NEVER spend".
 * --paid / --both would turn that guard off for the duration of the run, letting a CLI
 * flag silently overrule a standing config-level zero-spend guarantee. We refuse.
 *
 * WHY BEFORE preflight: reporting "OPENROUTER_API_KEY not set" for this would send the
 * caller off fixing the wrong thing — their key is not the problem, their *request* is.
 * That is exactly the ordering bug P1 fixed for --apply-free-pool, and it is a bug here
 * for the same reason. (Cost-safety lineage: 31ce212 — money left a real account because
 * a layer assumed it was allowed to spend.)
 */
function refuseUnsafeUpdateAll(opts: CliOptions): CliResult | null {
  if (!opts.updateAll || opts.updateMode === "free") return null;
  const settings = loadSettings();
  if (!settings || !settings.active) return null; // the phase reports a missing profile
  const active = settings.profiles[settings.active];
  if (!active) return null;
  if (!resolveProfile(settings.active, active).freeOnly) return null;
  return {
    ok: false,
    code: 2,
    summary:
      `--update-all --${opts.updateMode} refused: profile '${settings.active}' has free_only: true, which means it must never spend. ` +
      `Run --update-all (free, $0), or turn off free_only in ${getSettingsPath()} first — that is a deliberate decision, not a flag override`,
  };
}

async function main(): Promise<CliResult> {
  const opts = parseArgs(process.argv);
  // Publish the paid-benchmark opt-in for the whole process, so every phase's
  // assertPaidBenchmarkAllowed chokepoint sees it (USER cost-safety directive).
  setPaidBenchmarksAllowed(opts.allowPaidModelsTests);
  // Usage errors first, environment second — see validateCombinations.
  validateCombinations(opts);
  // Config-level refusals rank WITH usage errors, not with environment checks.
  const refusal = refuseUnsafeUpdateAll(opts);
  if (refusal !== null) return refusal;
  preflight(opts);

  // Airtight free_only cost-safety (TRDD-97ef8b63). The benchmark CLI runs as a
  // SEPARATE process from the MCP server, so it publishes the active profile's
  // free_only to config.ts itself — the runner then skips (records, never bills)
  // any non-':free' model. Free mode benchmarks the user's free pool ($0); to
  // benchmark a paid model, switch off free_only. Best-effort on bad settings.
  let activeFreeModels: readonly string[] = [];
  try {
    const s = loadSettings();
    const active = s?.profiles[s.active];
    if (s && active) {
      // Publish the master switch for this separate benchmark process, so
      // assertPaidBenchmarkAllowed's getAllowPaidModels() check (USER D4) is
      // correct here too — a paid benchmark is refused unless allow_paid_models
      // is true, regardless of --allow-paid-models-tests. Absent ⟺ false (free).
      setAllowPaidModels(s.allow_paid_models === true);
      const resolved = resolveProfile(s.active, active);
      setActiveFreeOnly(resolved.freeOnly);
      // Read the pool UNCONDITIONALLY, not via resolved.freeModels — that one is
      // gated on the per-profile `free_only`, so for anyone whose free mode comes
      // from the top-level allow_paid_models switch it is [] and --bench-free-pool
      // silently fell back to the hardcoded FREE_POOL_SEED, benchmarking stale
      // seed ids instead of the pool actually in use. $0 is still guaranteed
      // downstream by resolveFreePool's non-$0 fail-fast, so widening the source
      // here cannot admit a priced model.
      activeFreeModels = profileFreeModels(active);
    }
  } catch {
    /* settings not loadable — leave flag false; the phase reports any real error */
  }

  // --bench-free-pool (TRDD-f1510055; semantic + auto-discovering in TRDD-WJND1N2W P3b):
  // single-flag convenience that fills the candidate set from the active profile's free
  // pool (or FREE_POOL_SEED), RESOLVED against the live catalog so it is provably
  // zero-cost. A configured non-':free' id is admitted only when the catalog prices it
  // at exactly $0 — else it FAILS FAST here, before any run, because --bench-free-pool
  // can run WITHOUT a free_only profile, so the runtime chokepoint cannot be the only
  // guard. Auto-discovery then adds every structurally-qualified zero-cost model (incl.
  // no-suffix open-beta models like owl-alpha), ranked by the free quality indexes. The
  // resolved ids feed the existing pipeline: keyword → opts.includeIds (baselines);
  // security-triage → opts.triageModels; code-task → codeTaskModels;
  // search-existing/auto-replace → searchExistingModels.
  if (opts.benchFreePool) {
    const configured =
      activeFreeModels.length > 0 ? activeFreeModels : FREE_POOL_SEED;
    const source =
      activeFreeModels.length > 0
        ? `active profile's free_models (${configured.length})`
        : `FREE_POOL_SEED constant (${configured.length})`;
    // The catalog is the public, no-auth, $0 endpoint; fetch the FULL list (a
    // price-0 model may sit in any category) to verify + auto-discover.
    const freePoolCatalog = await fetchProgrammingModels();
    const { pool, autoDiscovered, rejected } = resolveFreePool(configured, freePoolCatalog, {
      autoDiscover: true,
      autoDiscoverTopN: opts.qualifyingTopN ?? 16,
    });
    if (rejected.length > 0) {
      throw new Error(
        `--bench-free-pool refuses to run: configured non-':free' id(s) ${JSON.stringify(rejected)} are NOT priced at $0 by the catalog (they would cost money) or are absent from it. A non-':free' free-pool entry must be a model OpenRouter currently prices at exactly $0. Fix the active profile's free_models list.`,
      );
    }
    console.error(
      `[benchmark] --bench-free-pool: ${pool.length} zero-cost model(s) from ${source}` +
        (autoDiscovered.length > 0
          ? ` + ${autoDiscovered.length} auto-discovered price-0 model(s) (e.g. ${autoDiscovered.slice(0, 3).join(", ")})`
          : "") +
        ".",
    );
    if (opts.securityTriage) {
      // Append (preserve any explicit --model the user passed alongside).
      for (const id of pool) {
        if (!opts.triageModels.includes(id)) opts.triageModels.push(id);
      }
    } else if (opts.codeTask) {
      // Append (preserve any explicit ids the user passed after --code-task).
      for (const id of pool) {
        if (!opts.codeTaskModels.includes(id)) opts.codeTaskModels.push(id);
      }
    } else if (opts.scanFolder) {
      // Append (preserve any explicit ids the user passed after --scan-folder).
      for (const id of pool) {
        if (!opts.scanFolderModels.includes(id)) opts.scanFolderModels.push(id);
      }
    } else if (opts.checkSpecs) {
      // Append (preserve any explicit ids the user passed after --check-specs).
      for (const id of pool) {
        if (!opts.checkSpecsModels.includes(id)) opts.checkSpecsModels.push(id);
      }
    } else if (opts.searchExisting || opts.autoReplace) {
      // Append (preserve any explicit ids the user passed after --search-existing).
      // --auto-replace forwards opts.searchExistingModels as its candidate pool,
      // so the same fill applies — benchmarking the free pool with one flag.
      for (const id of pool) {
        if (!opts.searchExistingModels.includes(id)) opts.searchExistingModels.push(id);
      }
    } else {
      // Append to includeIds — bypasses the cost filter so zero-cost models are
      // benchmarked even though the default cost / ':free'-excluded candidate
      // rules would otherwise drop them.
      for (const id of pool) {
        if (!opts.includeIds.includes(id)) opts.includeIds.push(id);
      }
    }
  }

  // --update-all routes to the ONE-COMMAND refresh (P3): discover → requirement-gate →
  // benchmark → rank + write → report, under the P4 hard spend cap. It runs FIRST
  // because it SUBSUMES the single-tool flags below — reaching this line with
  // --update-all set means the whole pipeline, not one benchmark.
  if (opts.updateAll) {
    return runUpdateAllPhase(opts);
  }

  // --populate-default-profile routes to the SINGLE-profile refresh: unlike
  // --update-all (which writes whatever settings.active happens to be, plus every
  // registered tool), this sweeps and writes EXACTLY the named machine-managed
  // default profile ('free' | 'ensemble' | 'mass-scout') and nothing else.
  if (opts.populateDefaultProfile !== null) {
    return runPopulateDefaultProfilePhase(opts);
  }

  // --security-triage routes to the security_scan triage benchmark — a wholly
  // separate task (verdict adjudication, not keyword classification) that reuses
  // the security_scan judge pipeline and gates auto-selection on a pass.
  if (opts.securityTriage) {
    return runSecurityTriagePhase(opts);
  }

  // --search-existing routes to the search_existing_implementations benchmark —
  // a wholly separate task (duplicate-implementation match, not keyword
  // classification) scored deterministically against a golden fixture codebase.
  if (opts.searchExisting) {
    return runSearchExistingPhase(opts);
  }

  // --code-task routes to the code_task CODE-AUDIT benchmark — a wholly separate
  // task (defect localization in real pre-fix snapshots of this repo's own code,
  // not keyword classification), scored deterministically with no LLM judge.
  if (opts.codeTask) {
    return runCodeTaskPhase(opts);
  }

  // --scan-folder routes to the scan_folder MASS-SEARCH benchmark — a wholly
  // separate task (a per-file MATCH/NO_MATCH verdict against a stated criterion,
  // not keyword classification), scored deterministically against a truth set
  // DERIVED from the corpus bytes, with no LLM judge.
  if (opts.scanFolder) {
    return runScanFolderPhase(opts);
  }

  // --check-specs routes to the check_against_specs SPEC-ADHERENCE benchmark — a wholly
  // separate task (a per-file CLEAN/VIOLATION verdict against a real project spec, not
  // keyword classification), scored deterministically against labels anchored in the real
  // commit that fixed the real violations, with no LLM judge.
  if (opts.checkSpecs) {
    return runCheckSpecsPhase(opts);
  }

  // --auto-replace routes to the cross-tool auto-replacement planner — for every
  // benchmarked tool it checks the incumbent's ledger health and (when degraded
  // or --force) runs that tool's benchmark to recommend the best same-or-cheaper
  // replacement. ADVISORY unless --apply is also passed (the sole writer path).
  if (opts.autoReplace) {
    return runAutoReplacePhase(opts);
  }

  // --adopt routes to the scripted adoption writer (the new-arrival path) — free
  // (a public catalog fetch to gate the id against per-tool requirements).
  if (opts.adoptModel !== null) {
    return runAdoptPhase(opts);
  }

  // --assess-model routes to the cross-tool requirements assessment — free (no
  // LLM call / no token cost; only a public OpenRouter catalog fetch, no key).
  if (opts.assessModel !== null) {
    return runAssessModelPhase(opts.assessModel);
  }

  // --check-health routes to the configured-model self-check — free (no LLM
  // call; only a public catalog fetch + a JSON diff vs the seeded baseline).
  if (opts.checkHealth) {
    return runCheckHealthPhase();
  }

  // --new-arrivals routes to catalog new-model autodiscovery — free (no LLM
  // call; one public catalog fetch diffed against the seeded snapshot).
  if (opts.newArrivals) {
    return runNewArrivalsPhase(opts);
  }

  // --from-cache: skip the benchmark entirely, pick straight from the most recent
  // JSON sidecar (always written by a fresh run — see runKeywordSweep).
  if (opts.fromCache) {
    const cachePath = benchmarkCachePath();
    const cache = loadCachedReport(cachePath);
    console.error(`[benchmark] --from-cache: using ${cachePath} (${cache.results.length} models, run at ${cache.timestamp}).`);
    return runPickPhase(cache.results, opts);
  }

  const sweep = await runKeywordSweep(opts);
  if (sweep.dryRun) {
    return {
      ok: true,
      summary: `dry-run — ${sweep.candidates} candidate(s) + ${sweep.baselines} baseline(s) would run; no API call made, $0 spent`,
    };
  }

  const notes: string[] = [];
  if (opts.applyFreePool !== null) {
    // Scripted free-pool maintenance: the pool BECOMES the set of ':free' models
    // that actually passed, best first. Only ':free' ids are eligible — a $0
    // open-beta model with no ':free' suffix is benchmarkable but cannot be pinned
    // into free_models (config.ts rejects it under free_only), so it is filtered
    // out here rather than blowing up the writer.
    const passing = sweep.results
      .filter((r) => r.ok && r.pass === true && r.schemaCompliant !== false && r.modelId.endsWith(":free"))
      .sort((a, b) => (b.meanF1 ?? 0) - (a.meanF1 ?? 0) || a.latencyMs - b.latencyMs)
      .map((r) => r.modelId);
    if (passing.length === 0) {
      return {
        ok: false,
        code: 2,
        summary: "--apply-free-pool: no ':free' model passed the sweep — free_models left unchanged",
        reportPath: sweep.reportPath,
      };
    }
    const w = applyFreePoolToSettings(getSettingsPath(), opts.applyFreePool, passing);
    console.error(
      `[benchmark] free_models(${w.profileName}): ${w.oldPool.length} → ${w.newPool.length} — ${w.newPool.join(", ")}`,
    );
    notes.push(`free_models(${w.profileName})=${w.newPool.length}`);
  }

  if (opts.pickTopN !== null) {
    return runPickPhase(sweep.results, opts, sweep.reportPath, notes);
  }
  return {
    ok: true,
    summary: [`${sweep.passers}/${sweep.total} model(s) passed`, ...notes].join(", "),
    reportPath: sweep.reportPath,
  };
}

/** What a keyword sweep produced. `dryRun` short-circuits before any paid call. */
export interface SweepOutcome {
  dryRun: boolean;
  candidates: number;
  baselines: number;
  results: CachedResult[];
  reportPath: string;
  passers: number;
  total: number;
}

/**
 * The keyword-classification sweep: discover → rank → cap → run → score → report →
 * JSON cache. Extracted from main() so the ENSEMBLE-ROTATION path can re-use it
 * (runAutoReplacePhase --apply): a rotation must re-benchmark before it re-picks,
 * and re-implementing the sweep there would be a second source of truth for the
 * roster rules.
 */
async function runKeywordSweep(
  opts: CliOptions,
  // P4: --update-all passes a BUDGETED fetch so every keyword call is reserved against
  // the run's spend cap before it is sent. Undefined elsewhere → plain global fetch,
  // i.e. production behavior for every pre-existing caller is byte-for-byte unchanged.
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<SweepOutcome> {
  const fixturesDir = resolveFixturesDir();
  const truth = buildGroundTruth(fixturesDir, BENCHMARK_KEYWORDS);

  console.error(`[benchmark] Ground truth built from ${truth.fixtures.length} files, ${truth.allFunctions.length} top-level functions.`);
  for (let i = 0; i < 3; i++) {
    console.error(`  kw${i + 1} "${truth.keywords[i]}": ${truth.keywordFunctions[i].length} expected matches`);
  }
  console.error(`  noise: ${truth.noiseFunctions.length}`);

  console.error("[benchmark] Fetching OpenRouter model list …");
  // Fetch the category-filtered list for candidates and the full list for
  // baseline lookups: baselines may be outside the programming category
  // (e.g. x-ai/grok-4.1-fast is classified under general-purpose models
  // but is still in the production ensemble).
  const [categoryModels, allModels] = await Promise.all([
    fetchProgrammingModels(DEFAULT_CRITERIA.category),
    opts.includeIds.length > 0 ? fetchProgrammingModels() : Promise.resolve([]),
  ]);
  console.error(
    `[benchmark] ${categoryModels.length} models in category=${DEFAULT_CRITERIA.category}` +
      (allModels.length > 0 ? `; ${allModels.length} total for baseline lookup` : ""),
  );

  // buildBenchmarkRoster filters the candidate pool and looks up
  // baselines in the baseline pool (which may be broader).
  const baselineLookup = allModels.length > 0 ? allModels : categoryModels;
  const { candidates: discovered, baselines } = buildBenchmarkRoster(
    categoryModels,
    DEFAULT_CRITERIA,
    opts.includeIds,
    baselineLookup,
  );
  // Quality-rank the auto-discovered candidates by their catalog codex/design-
  // arena indexes (best first), then optionally restrict to --qualifying-top-n,
  // so the paid keyword benchmark spends its budget on the most-promising
  // candidates first (TRDD-WJND1N2W P2). Baselines (explicit --include) are
  // never reordered or capped — the user asked for those by name.
  const ranked = rankByQualityIndex(discovered);
  const candidates = opts.qualifyingTopN !== null ? ranked.slice(0, opts.qualifyingTopN) : ranked;
  console.error(`[benchmark] Roster: ${candidates.length} candidate(s), ${baselines.length} baseline(s).`);
  for (const m of candidates) {
    console.error(`  CAND  ${m.id.padEnd(40)} ctx=${m.contextTokens}  in=$${m.inputDollarsPerMillion.toFixed(3)}  out=$${m.outputDollarsPerMillion.toFixed(3)}`);
  }
  for (const m of baselines) {
    console.error(`  BASE  ${m.id.padEnd(40)} ctx=${m.contextTokens}  in=$${m.inputDollarsPerMillion.toFixed(3)}  out=$${m.outputDollarsPerMillion.toFixed(3)}`);
  }

  if (opts.dryRun) {
    console.error("[benchmark] --dry-run: roster only, exiting before any API call.");
    return {
      dryRun: true,
      candidates: candidates.length,
      baselines: baselines.length,
      results: [],
      reportPath: "",
      passers: 0,
      total: 0,
    };
  }

  const apiKey = resolveApiKey();
  const roster: Array<{ model: QualifiedModel; isBaseline: boolean }> = [
    ...candidates.map((m) => ({ model: m, isBaseline: false })),
    ...baselines.map((m) => ({ model: m, isBaseline: true })),
  ];

  // Global price-cap fail-fast on the FULL roster before any send. Candidates
  // were already dropped by filterModels; baselines (explicit --include) are the
  // ones this catches — the user's cap now overrides the old "explicit includes
  // are never capped" behaviour: an over-$1.25/1M include refuses the run, $0 spent.
  assertModelsUnderPriceCap(roster.map((r) => r.model));
  // The keyword sweep is the DEFAULT paid benchmark, so it needs the opt-in too:
  // a paid candidate/baseline without --allow-paid-models-tests refuses, $0 spent.
  assertPaidBenchmarkAllowed(roster.map((r) => r.model));

  const results = new Map<
    string,
    { model: QualifiedModel; outcome: RunOutcome; score: ModelScore | null; isBaseline: boolean }
  >();

  // Sequential rather than parallel — the benchmark is small, and serialising
  // avoids stacking up rate-limit hits on a single OpenRouter account.
  for (const { model, isBaseline } of roster) {
    console.error(`[benchmark] Running ${model.id} …`);
    const outcome = await runBenchmarkOnModel(model, truth.keywords, truth.fixtures, {
      apiKey,
      httpReferer: "https://github.com/Emasoft/llm-externalizer-plugin",
      xTitle: "llm-externalizer-benchmark",
      reasoningEffort: opts.reasoningEffort,
      seed: opts.seed,
      fetchImpl,
    });
    let score: ModelScore | null = null;
    if (outcome.ok) {
      score = scoreRun(outcome, truth);
      // Inside the `if (outcome.ok)` branch, so the outcome is always OK here.
      console.error(
        `[benchmark]   OK — pass=${score.pass}  meanF1=${(score.meanF1 * 100).toFixed(1)}%  ${outcome.inputTokens} in / ${outcome.outputTokens} out tok  ${outcome.latencyMs.toFixed(0)}ms`,
      );
    } else {
      console.error(`[benchmark]   ERR — ${outcome.error}`);
    }
    results.set(model.id, { model, outcome, score, isBaseline });
  }

  const reportPath = opts.reportPath ?? buildReportPath();
  const timestamp = new Date().toISOString();
  const reportInput = {
    timestamp,
    truth,
    rosterCandidates: candidates,
    rosterBaselines: baselines,
    results,
  };

  const markdown = renderReport(reportInput);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown, "utf-8");
  console.error(`[benchmark] Report: ${reportPath}`);

  // JSON sidecar. Always write to the well-known cache path
  // (~/.llm-externalizer/benchmark-results.json) so downstream commands
  // like /llm-externalizer:llm-externalizer-change-model can pick it up
  // without needing to be told where. --json PATH adds a second copy at
  // the user-chosen location.
  const json = renderJson(reportInput);
  const cacheJsonPath = benchmarkCachePath();
  mkdirSync(dirname(cacheJsonPath), { recursive: true });
  writeFileSync(cacheJsonPath, json, "utf-8");
  console.error(`[benchmark] JSON cache: ${cacheJsonPath}`);
  if (opts.jsonPath) {
    mkdirSync(dirname(opts.jsonPath), { recursive: true });
    writeFileSync(opts.jsonPath, json, "utf-8");
    console.error(`[benchmark] JSON (user-path): ${opts.jsonPath}`);
  }

  // Summary for easy grep-ing
  const passers = [...results.values()].filter((r) => r.score?.pass).length;
  console.error(`[benchmark] ${passers}/${results.size} models passed.`);

  // Hand back the results by re-parsing the sidecar we just wrote, rather than
  // mirroring report.ts's renderJson shape inline — one source of truth for the
  // CachedResult shape that --pick-top-n / --from-cache also consume.
  const parsed = JSON.parse(json) as CachedReport;

  // Mirror this run's rows into the rank-0 ACCUMULATING ledger. The sidecar above
  // is a whole-file SNAPSHOT — every sweep overwrites it — so on its own it lets a
  // later ':free'-only run silently revoke a paid model's IRON RULE validation for
  // every rank-0 tool. Recorded from `parsed.results` (not `results`) so the ledger
  // and the sidecar can never disagree about a row's shape.
  recordGeneralKeywordPasses(parsed.results, timestamp);

  return {
    dryRun: false,
    candidates: candidates.length,
    baselines: baselines.length,
    results: parsed.results,
    reportPath,
    passers,
    total: results.size,
  };
}

/**
 * --update-all phase (P3 + P4): the WHOLE refresh as one command.
 *
 * This function is deliberately thin — it only RESOLVES the environment (which profile,
 * which settings file, which free pool, how many ensemble slots) and hands the real
 * pipeline to update-all.ts. Every DECISION (which models qualify, which tools to
 * benchmark, what to write, when to abort on cost) lives there, in code, tested.
 * Nothing here is left for an agent to judge.
 */
async function runUpdateAllPhase(opts: CliOptions): Promise<CliResult> {
  const settingsPath = getSettingsPath();
  const settings = loadSettings();
  if (!settings || !settings.active) {
    return {
      ok: false,
      code: 2,
      summary: `--update-all needs an active profile in ${settingsPath}, but none is configured`,
    };
  }
  const profileName = settings.active;
  const resolved = resolveProfile(profileName, settings.profiles[profileName]);

  // Re-pick exactly as many ensemble slots as the profile ALREADY runs (never a
  // hard-coded 3): applyPicksToSettings derives `mode` from the pick count, so picking
  // 3 on a single-model `remote` profile would silently promote it to remote-ensemble —
  // a config change nobody asked for. Same rule as the P1 rotation path.
  const currentSlots = [resolved.model, resolved.secondModel, resolved.thirdModel].filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  ).length;
  const ensembleTopN = opts.pickTopN ?? Math.max(1, currentSlots);

  const result = await runUpdateAll(
    {
      mode: opts.updateMode,
      budgetUsd: opts.budgetUsd,
      dryRun: opts.dryRun,
      settingsPath,
      profileName,
      configuredFreeModels: resolved.freeModels.length > 0 ? resolved.freeModels : FREE_POOL_SEED,
      qualifyingTopN: opts.qualifyingTopN,
      ensembleTopN,
      force: opts.force,
      mainRoot: resolveMainRoot(),
      onProgress: (m) => console.error(`[update-all] ${m}`),
    },
    {
      fetchCatalog: () => fetchProgrammingModels(),
      describeEnsembleWorkload: describeKeywordWorkload,
      runEnsembleSweep: async ({ models, restrictToModels, fetchImpl, topN }) => {
        // Reuse the ONE sweep implementation (runKeywordSweep). In FREE mode the roster
        // must be EXACTLY the resolved zero-cost pool: qualifyingTopN=0 empties the
        // auto-discovered (paid) candidate list, and the pool rides in as --include
        // baselines, which bypass the cost filter. Anything else would hand the sweep
        // paid candidates that the free_only chokepoint then has to skip one by one.
        const sweepOpts: CliOptions = {
          ...opts,
          includeIds: restrictToModels ? [...models] : [...opts.includeIds],
          qualifyingTopN: restrictToModels ? 0 : opts.qualifyingTopN,
          dryRun: false,
          fromCache: false,
          pickTopN: topN,
        };
        const sweep = await runKeywordSweep(sweepOpts, fetchImpl);
        let picks: PickedModel[] = [];
        let pickError: string | null = null;
        try {
          picks = pickTopN(sweep.results, {
            topN,
            minMeanF1: opts.minMeanF1,
            requireSchema: true,
          });
        } catch (err) {
          // Surface the shortage; update-all leaves the ensemble ALONE rather than
          // writing a half-picked one. No silent fallback.
          pickError = (err as Error).message;
        }
        const run: EnsembleSweepRun = {
          picks,
          pickError,
          passingFreeIds: passingFreePoolIds(sweep.results),
          modelsRun: sweep.total,
          passers: sweep.passers,
          costUsd: 0, // real spend is booked per-call by the budgeted fetch, not here
          reportPath: sweep.reportPath,
        };
        return run;
      },
      runToolBenchmark: async ({ tool, benchmark, models, fetchImpl, force, onProgress }) => {
        const common = { models, force, fetchImpl, onProgress };
        switch (benchmark) {
          case "security-triage": {
            const r = await runSecurityTriageBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.mdReportPath);
          }
          case "search-existing": {
            const r = await runSearchExistingBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          case "code-task": {
            const r = await runCodeAuditBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          case "scan-folder": {
            const r = await runScanFolderBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          case "check-specs": {
            const r = await runCheckSpecsBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          default:
            // A registry benchmark id with no runner here is a WIRING BUG, not a
            // condition to tolerate — a silently-skipped tool would report as if it
            // had been swept. Fail loudly.
            throw new Error(
              `--update-all: tool '${tool}' declares benchmark '${benchmark}' in the registry, but no runner is wired for it.`,
            );
        }
      },
    },
  );

  return {
    ok: result.ok,
    code: result.ok ? 0 : 2,
    summary: result.summary,
    reportPath: result.reportPath,
  };
}

function toolRun(
  recommendedModelId: string,
  changed: boolean,
  eligibleCount: number,
  costUsd: number,
  reportPath: string,
): ToolBenchmarkRun {
  return { recommendedModelId, changed, eligibleCount, costUsd, reportPath };
}

/**
 * The keyword/ensemble sweep's workload, for the P4 pre-flight estimate. It lives here
 * (not in update-all.ts) because fixture resolution is this module's job. The prompt
 * size is computed by the RUNNER's own builders (keywordPromptChars), so it cannot
 * drift from what actually goes on the wire.
 */
function describeKeywordWorkload(): BenchmarkWorkload {
  const truth = buildGroundTruth(resolveFixturesDir(), BENCHMARK_KEYWORDS);
  return {
    tool: "ensemble",
    benchmark: "keyword-classification",
    callsPerModel: 1, // one shot per model, by design (the benchmark measures it AS-IS)
    promptCharsPerModel: keywordPromptChars(truth.keywords, truth.fixtures),
    // This is the ONE request in the pipeline that declares no max_tokens — see
    // ASSUMED_MAX_OUTPUT_TOKENS for why an assumption is unavoidable here, and why a
    // wrong one can cost at most a single call's over-run (the ledger trips on it).
    maxOutputTokensPerCall: ASSUMED_MAX_OUTPUT_TOKENS,
  };
}

/**
 * `--populate-default-profile NAME` — the DEPS this phase drives: the live OpenRouter
 * catalog and the keyword sweep, both injectable so the phase is testable offline
 * (same seam shape as UpdateAllDeps in update-all.ts). Production uses the real
 * fetch + the real runKeywordSweep; a test injects a canned catalog and canned
 * CachedResult[] so no network call and no fixture load ever happens.
 */
export interface PopulateDefaultProfileDeps {
  fetchCatalog: () => Promise<OpenRouterModel[]>;
  runSweep: (sweepOpts: CliOptions) => Promise<SweepOutcome>;
}

const defaultPopulateDefaultProfileDeps: PopulateDefaultProfileDeps = {
  fetchCatalog: () => fetchProgrammingModels(),
  runSweep: (sweepOpts) => runKeywordSweep(sweepOpts),
};

/**
 * `--populate-default-profile NAME` phase. Unlike --update-all (which writes whatever
 * `settings.active` happens to be, plus every registered tool), this sweeps and writes
 * EXACTLY the one named machine-managed default profile — 'free' | 'ensemble' |
 * 'mass-scout' — and nothing else. `name` is already validated to be one of the three
 * (cli-args.ts's isDefaultProfileName gate) by the time this runs.
 */
export async function runPopulateDefaultProfilePhase(
  opts: CliOptions,
  deps: PopulateDefaultProfileDeps = defaultPopulateDefaultProfileDeps,
): Promise<CliResult> {
  const name = opts.populateDefaultProfile;
  if (name === null) {
    // Unreachable from the CLI (main() only calls this once opts.populateDefaultProfile
    // is set) — a defensive fail-fast so a future caller of this exported function
    // cannot get a silent no-op instead of a clear error.
    throw new Error("runPopulateDefaultProfilePhase called without --populate-default-profile");
  }
  const settingsPath = getSettingsPath();
  if (name === "free") {
    return runPopulateFreeDefaultProfile(opts, settingsPath, deps);
  }
  return runPopulatePaidDefaultProfile(opts, settingsPath, name, deps);
}

/**
 * The 'free' default profile: sweeps ONLY the zero-cost pool, under the SAME free_only
 * chokepoint --bench-free-pool / --update-all --free already rely on (setActiveFreeOnly
 * + the runner's own runtime guard) — provably $0, never the paid path.
 */
async function runPopulateFreeDefaultProfile(
  opts: CliOptions,
  settingsPath: string,
  deps: PopulateDefaultProfileDeps,
): Promise<CliResult> {
  setActiveFreeOnly(true);

  // Seed the pool from the 'free' default profile's OWN current free_models (so a
  // re-run refreshes what it already owns), falling back to FREE_POOL_SEED — same
  // fallback --bench-free-pool uses when the active profile pins nothing.
  let configured: readonly string[] = FREE_POOL_SEED;
  try {
    const settings = loadSettings();
    const freeProfile = settings?.profiles?.free;
    if (freeProfile) {
      const pool = profileFreeModels(freeProfile);
      if (pool.length > 0) configured = pool;
    }
  } catch {
    /* settings not loadable — FREE_POOL_SEED is still a valid $0 seed */
  }

  const catalog = await deps.fetchCatalog();
  const { pool: discoveredPool, rejected } = resolveFreePool(configured, catalog, {
    autoDiscover: true,
    autoDiscoverTopN: opts.qualifyingTopN ?? 16,
  });
  if (rejected.length > 0) {
    return {
      ok: false,
      code: 2,
      summary:
        `--populate-default-profile free refuses to run: configured non-':free' id(s) ${JSON.stringify(rejected)} ` +
        `are NOT priced at $0 by the live catalog (they would cost money) or are absent from it — fix the ` +
        `'free' profile's free_models list`,
    };
  }
  // Same reasoning as --update-all's free phase (see runUpdateAllPhase): the runtime
  // send-time chokepoint (assertFreeOnlyModel) admits ONLY ':free'-suffixed ids, so a
  // zero-cost id lacking that suffix must be dropped here, before it reaches the sweep.
  const freeIds = freeSuffixOnly(discoveredPool);
  if (freeIds.length === 0) {
    recordBenchmarkFailure("free", Date.now());
    return {
      ok: false,
      code: 2,
      summary:
        "--populate-default-profile free: the live catalog currently offers no zero-cost ':free' model " +
        "that meets the structural bar (structured output / context / output length) — nothing to benchmark",
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      summary: `dry-run — would sweep ${freeIds.length} zero-cost ':free' model(s) for the 'free' default profile; $0, nothing written`,
    };
  }

  // The candidate set the picker actually selected `passing` from — banked on
  // success as the drift-detection baseline, so a later check compares apples
  // to apples (see poolFingerprint's docstring in default-profiles.ts).
  const freeIdSet = new Set(freeIds);
  const qualifyingPool: CatalogPriceSnapshot[] = toCatalogPriceSnapshot(catalog).filter((m) =>
    freeIdSet.has(m.id),
  );

  // Bypass the normal cost filter exactly like --bench-free-pool: the resolved pool
  // rides in as --include baselines (qualifyingTopN: 0 empties the auto-discovered
  // candidate list), and free_only (set above) is the guard that keeps this $0.
  const sweepOpts: CliOptions = {
    ...opts,
    includeIds: freeIds,
    qualifyingTopN: 0,
    dryRun: false,
    fromCache: false,
  };
  let sweep: SweepOutcome;
  try {
    sweep = await deps.runSweep(sweepOpts);
  } catch (err) {
    recordBenchmarkFailure("free", Date.now());
    throw err;
  }
  const passing = passingFreePoolIds(sweep.results);
  if (passing.length === 0) {
    recordBenchmarkFailure("free", Date.now());
    return {
      ok: false,
      code: 2,
      summary: "--populate-default-profile free: no ':free' model passed the sweep — 'free' profile left unchanged",
      reportPath: sweep.reportPath || undefined,
    };
  }
  const w = updateFreeDefaultProfile(settingsPath, passing);
  recordBenchmarkSuccess("free", poolFingerprint(qualifyingPool), w.newPool, Date.now());
  return {
    ok: true,
    summary: `populate-default-profile free: wrote ${w.newPool.length} model(s) to '${w.profileName}' — ${w.newPool.join(", ")}`,
    reportPath: sweep.reportPath || undefined,
  };
}

/**
 * The 'ensemble' / 'mass-scout' default profiles: PAID. Bounded by the SAME worst-case
 * pre-flight estimate + abort that --update-all's paid phase uses (see
 * update-all.ts::runUpdateAll, the "PRE-FLIGHT COST ESTIMATE" step) — computed here over
 * the same requirement-gated, quality-ranked candidate roster runKeywordSweep itself
 * builds (discover.ts's qualify + rankByQualityIndex), so the estimate and the actual
 * roster can never disagree about which models are in play. No second budget system:
 * this reuses update-all.ts's own estimateWorkloadCostUsd.
 */
async function runPopulatePaidDefaultProfile(
  opts: CliOptions,
  settingsPath: string,
  name: "ensemble" | "mass-scout",
  deps: PopulateDefaultProfileDeps,
): Promise<CliResult> {
  setActiveFreeOnly(false);

  const catalog = await deps.fetchCatalog();
  const { candidates: discovered } = buildBenchmarkRoster(catalog, DEFAULT_CRITERIA, [], catalog);
  const ranked = rankByQualityIndex(discovered);
  const candidates = opts.qualifyingTopN !== null ? ranked.slice(0, opts.qualifyingTopN) : ranked;
  if (candidates.length === 0) {
    recordBenchmarkFailure(name, Date.now());
    return {
      ok: false,
      code: 2,
      summary: `--populate-default-profile ${name}: no candidate model met the requirement gate — nothing to benchmark`,
    };
  }
  // The candidate set the picker will select from — banked on success (and
  // reused, unchanged, whichever of ensemble/mass-scout actually writes) as
  // the drift-detection baseline for THIS profile name.
  const qualifyingPool: CatalogPriceSnapshot[] = candidates.map((c) => ({
    id: c.id,
    inputDollarsPerMillion: c.inputDollarsPerMillion,
    outputDollarsPerMillion: c.outputDollarsPerMillion,
  }));

  const workload = describeKeywordWorkload();
  let estimatedUsd = 0;
  for (const m of candidates) {
    estimatedUsd += estimateWorkloadCostUsd(workload, {
      inputDollarsPerMillion: m.inputDollarsPerMillion,
      outputDollarsPerMillion: m.outputDollarsPerMillion,
    });
  }
  console.error(
    `[populate-default-profile] ${name}: worst-case estimate $${estimatedUsd.toFixed(4)} over ${candidates.length} candidate(s) (cap $${opts.budgetUsd.toFixed(2)}).`,
  );
  if (estimatedUsd > opts.budgetUsd) {
    // ABORT BEFORE SPENDING A CENT — same rule and same message shape as
    // --update-all's pre-flight abort (runUpdateAll), so the fix is always the same
    // typed decision: raise --budget-usd, shrink --qualifying-top-n, or go --free.
    recordBenchmarkFailure(name, Date.now());
    return {
      ok: false,
      code: 2,
      summary:
        `--populate-default-profile ${name}: WORST-CASE pre-flight estimate $${estimatedUsd.toFixed(4)} exceeds the ` +
        `$${opts.budgetUsd.toFixed(2)} cap — nothing was sent, $0 spent. This bound assumes every call emits its ` +
        `full max_tokens, so real spend is typically far lower. To proceed: --budget-usd ${Math.ceil(estimatedUsd * 100) / 100} ` +
        `(authorizes the worst case), or shrink the sweep with --qualifying-top-n N`,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      summary: `dry-run — would sweep ${candidates.length} candidate(s) for the '${name}' default profile; worst case $${estimatedUsd.toFixed(4)}, nothing sent, nothing written`,
    };
  }

  let sweep: SweepOutcome;
  try {
    sweep = await deps.runSweep(opts);
  } catch (err) {
    recordBenchmarkFailure(name, Date.now());
    throw err;
  }

  if (name === "ensemble") {
    const ceiling = getEnsemblePriceCeiling(loadSettings());
    const picks = pickEnsembleByPriceCeiling(sweep.results, { priceCeilingUsdPerM: ceiling });
    if (picks.length === 0) {
      recordBenchmarkFailure(name, Date.now());
      return {
        ok: false,
        code: 2,
        summary: `--populate-default-profile ensemble: no candidate cleared the $${ceiling.toFixed(2)}/1M price ceiling — 'ensemble' profile left unchanged`,
        reportPath: sweep.reportPath || undefined,
      };
    }
    updateEnsembleDefaultProfile(settingsPath, picks);
    recordBenchmarkSuccess(
      name,
      poolFingerprint(qualifyingPool),
      picks.map((p) => p.modelId),
      Date.now(),
    );
    return {
      ok: true,
      summary: `populate-default-profile ensemble: wrote ${picks.length} model(s) — ${picks.map((p) => p.modelId).join(", ")}`,
      reportPath: sweep.reportPath || undefined,
    };
  }

  // 'mass-scout' — pickMassScoutModel throws (never returns a ':free' id) rather
  // than silently falling back; surface that as a normal [FAILED] outcome.
  let pick: PickedModel;
  try {
    pick = pickMassScoutModel(sweep.results);
  } catch (err) {
    recordBenchmarkFailure(name, Date.now());
    return {
      ok: false,
      code: 2,
      summary: `--populate-default-profile mass-scout: ${(err as Error).message}`,
      reportPath: sweep.reportPath || undefined,
    };
  }
  const w = updateMassScoutDefaultProfile(settingsPath, pick);
  recordBenchmarkSuccess(name, poolFingerprint(qualifyingPool), [w.newModelId], Date.now());
  return {
    ok: true,
    summary: `populate-default-profile mass-scout: wrote '${w.newModelId}'`,
    reportPath: sweep.reportPath || undefined,
  };
}

/**
 * --security-triage phase: assess model(s) on the security_scan triage golden
 * dataset and recommend the best same-or-cheaper passer. Writes its own JSON +
 * markdown report under reports/security-triage-benchmark/.
 */
async function runSecurityTriagePhase(opts: CliOptions): Promise<CliResult> {
  console.error("[triage] security_scan triage model benchmark");
  const result = await runSecurityTriageBenchmark({
    models: opts.triageModels.length > 0 ? opts.triageModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[triage] ${m}`),
  });
  console.error("");
  console.error(`[triage] ${result.summaryLine}`);
  console.error(`[triage] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[triage] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);
  return {
    ok: true,
    summary: `triage benchmark done — recommended ${result.recommendedModelId} (changed=${result.changed}), spend $${result.costUsd.toFixed(6)}`,
    reportPath: result.mdReportPath,
  };
}

/**
 * --search-existing phase: assess model(s) on the search_existing_implementations
 * golden fixture dataset and recommend the best same-or-cheaper passer. Scored
 * DETERMINISTICALLY (precision/recall/F1 over the known duplicate locations — no
 * LLM judge). Writes its own JSON + markdown report under
 * reports/search-existing-benchmark/. ADVISORY only — never edits config.
 */
async function runSearchExistingPhase(opts: CliOptions): Promise<CliResult> {
  console.error("[search-existing] search_existing_implementations model benchmark");
  const result = await runSearchExistingBenchmark({
    models: opts.searchExistingModels.length > 0 ? opts.searchExistingModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[search-existing] ${m}`),
  });
  console.error("");
  console.error(`[search-existing] ${result.summaryLine}`);
  console.error(`[search-existing] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[search-existing] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);
  return {
    ok: true,
    summary: `search-existing benchmark done — recommended ${result.recommendedModelId} (changed=${result.changed}), spend $${result.costUsd.toFixed(6)}`,
    reportPath: result.reportPath,
  };
}

/**
 * --code-task phase: assess model(s) on the code_task CODE-AUDIT corpus and
 * recommend the best same-or-cheaper passer. The corpus is VERBATIM pre-fix
 * snapshots from this repo's own git history (no fabricated code — every defect
 * really shipped and was really fixed) plus never-fixed clean files, and scoring
 * is DETERMINISTIC: precision/recall/F1 on localizing the defect by FUNCTION
 * NAME, with NO LLM judge anywhere. Writes JSON + markdown under
 * reports/code-task-benchmark/.
 *
 * ADVISORY by default. With `--apply-profile P` it ALSO persists the winner into
 * P's `tool_models.code_task` via applyToolModelToSettings — the same atomic,
 * CLI-only writer --auto-replace --apply uses, which MUST NEVER be reachable
 * from an MCP handler (see the guardrail comment at pick.ts:258).
 */
async function runCodeTaskPhase(opts: CliOptions): Promise<CliResult> {
  console.error("[code-task] code_task code-audit model benchmark");
  const result = await runCodeAuditBenchmark({
    models: opts.codeTaskModels.length > 0 ? opts.codeTaskModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[code-task] ${m}`),
  });
  console.error("");
  console.error(`[code-task] ${result.summaryLine}`);
  console.error(`[code-task] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[code-task] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);

  const base = `code-task benchmark done — recommended ${result.recommendedModelId} (changed=${result.changed}), spend $${result.costUsd.toFixed(6)}`;

  if (opts.applyProfile === null) {
    return { ok: true, summary: `${base} — ADVISORY (pass --apply-profile P to adopt it)`, reportPath: result.reportPath };
  }

  // The winner is only worth writing when the gate actually produced a passer:
  // with an empty eligible set the "recommendation" is just the incumbent kept
  // in place, and rewriting tool_models to the value it already resolves to
  // would masquerade as an adoption. Say so instead of quietly no-op'ing.
  if (result.selection.eligible.length === 0) {
    return {
      ok: true,
      summary: `${base} — no eligible same-or-cheaper passer, so nothing was written to '${opts.applyProfile}'`,
      reportPath: result.reportPath,
    };
  }

  try {
    const r = applyToolModelToSettings(
      getSettingsPath(),
      opts.applyProfile,
      "code_task",
      result.recommendedModelId,
    );
    console.error(
      `[code-task] applied ${opts.applyProfile}::tool_models.code_task: ${r.oldModelId || "—"}  →  ${r.newModelId}`,
    );
    console.error("[code-task] Run the `reset` MCP tool or restart Claude Code to pick up the new model.");
    return {
      ok: true,
      summary: `${base} — applied to '${opts.applyProfile}'::tool_models.code_task; run \`reset\` to reload`,
      reportPath: result.reportPath,
    };
  } catch (err) {
    // Exit 3 on a write failure, matching every other writer path in this CLI.
    return {
      ok: false,
      code: 3,
      summary: `--apply-profile failed: ${(err as Error).message}`,
      reportPath: result.reportPath,
    };
  }
}

/**
 * --scan-folder phase: assess model(s) on the scan_folder MASS-SEARCH corpus and
 * recommend the best same-or-cheaper passer. The corpus is twelve files copied
 * VERBATIM from this repo's own `scripts/llm-ext/src/` (no fabricated code), and each
 * query's true MATCH set is DERIVED from those bytes by a mechanical rule at run
 * time rather than hand-listed — so the expected answer cannot drift from the
 * corpus. Scoring is DETERMINISTIC: precision/recall/F1 over the per-file
 * MATCH/NO_MATCH verdicts, with NO LLM judge anywhere. Writes JSON + markdown
 * under reports/scan-folder-benchmark/.
 *
 * ADVISORY by default. With `--apply-profile P` it ALSO persists the winner into
 * P's `tool_models.scan_folder` via applyToolModelToSettings — the same atomic,
 * CLI-only writer --auto-replace --apply uses, which MUST NEVER be reachable from
 * an MCP handler (see the guardrail comment at pick.ts:234).
 */
async function runScanFolderPhase(opts: CliOptions): Promise<CliResult> {
  console.error("[scan-folder] scan_folder mass-search model benchmark");
  const result = await runScanFolderBenchmark({
    models: opts.scanFolderModels.length > 0 ? opts.scanFolderModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[scan-folder] ${m}`),
  });
  console.error("");
  console.error(`[scan-folder] ${result.summaryLine}`);
  console.error(`[scan-folder] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[scan-folder] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);

  const base = `scan-folder benchmark done — recommended ${result.recommendedModelId} (changed=${result.changed}), spend $${result.costUsd.toFixed(6)}`;

  if (opts.applyProfile === null) {
    return { ok: true, summary: `${base} — ADVISORY (pass --apply-profile P to adopt it)`, reportPath: result.reportPath };
  }

  // The winner is only worth writing when the gate actually produced a passer:
  // with an empty eligible set the "recommendation" is just the incumbent kept in
  // place, and rewriting tool_models to the value it already resolves to would
  // masquerade as an adoption. Say so instead of quietly no-op'ing.
  if (result.selection.eligible.length === 0) {
    return {
      ok: true,
      summary: `${base} — no eligible same-or-cheaper passer, so nothing was written to '${opts.applyProfile}'`,
      reportPath: result.reportPath,
    };
  }

  try {
    const r = applyToolModelToSettings(
      getSettingsPath(),
      opts.applyProfile,
      "scan_folder",
      result.recommendedModelId,
    );
    console.error(
      `[scan-folder] applied ${opts.applyProfile}::tool_models.scan_folder: ${r.oldModelId || "—"}  →  ${r.newModelId}`,
    );
    console.error("[scan-folder] Run the `reset` MCP tool or restart Claude Code to pick up the new model.");
    return {
      ok: true,
      summary: `${base} — applied to '${opts.applyProfile}'::tool_models.scan_folder; run \`reset\` to reload`,
      reportPath: result.reportPath,
    };
  } catch (err) {
    // Exit 3 on a write failure, matching every other writer path in this CLI.
    return {
      ok: false,
      code: 3,
      summary: `--apply-profile failed: ${(err as Error).message}`,
      reportPath: result.reportPath,
    };
  }
}

/**
 * --check-specs phase: assess model(s) on the check_against_specs SPEC-ADHERENCE corpus
 * and recommend the best same-or-cheaper passer. The spec is this repo's own shipped
 * `scripts/llm-ext/TESTING.md` and the corpus is thirteen VERBATIM git snapshots of real files
 * (no fabricated code): four are the exact pre-fix bytes commit 31ce212 replaced because
 * they really violated that spec — a defect that drained a real OpenRouter balance — and
 * three of those four sit right next to their own fixed twin, which is what makes the
 * corpus impossible to pass by pattern-matching vocabulary. Scoring is DETERMINISTIC:
 * precision/recall/F1 over the per-file CLEAN/VIOLATION verdicts, with NO LLM judge
 * anywhere. Violation CONTENT (the cited rule, the severity) is reported but deliberately
 * NOT graded — grading it needs a judge. Writes JSON + markdown under
 * reports/check-specs-benchmark/.
 *
 * ADVISORY by default. With `--apply-profile P` it ALSO persists the winner into P's
 * `tool_models.check_against_specs` via applyToolModelToSettings — the same atomic,
 * CLI-only writer --auto-replace --apply uses, which MUST NEVER be reachable from an MCP
 * handler (see the guardrail comment at pick.ts:234).
 */
async function runCheckSpecsPhase(opts: CliOptions): Promise<CliResult> {
  console.error("[check-specs] check_against_specs spec-adherence model benchmark");
  const result = await runCheckSpecsBenchmark({
    models: opts.checkSpecsModels.length > 0 ? opts.checkSpecsModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[check-specs] ${m}`),
  });
  console.error("");
  console.error(`[check-specs] ${result.summaryLine}`);
  console.error(`[check-specs] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[check-specs] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);

  const base = `check-specs benchmark done — recommended ${result.recommendedModelId} (changed=${result.changed}), spend $${result.costUsd.toFixed(6)}`;

  if (opts.applyProfile === null) {
    return {
      ok: true,
      summary: `${base} — ADVISORY (pass --apply-profile P to adopt it)`,
      reportPath: result.reportPath,
    };
  }

  // The winner is only worth writing when the gate actually produced a passer: with an
  // empty eligible set the "recommendation" is just the incumbent kept in place, and
  // rewriting tool_models to the value it already resolves to would masquerade as an
  // adoption. Say so instead of quietly no-op'ing.
  if (result.selection.eligible.length === 0) {
    return {
      ok: true,
      summary: `${base} — no eligible same-or-cheaper passer, so nothing was written to '${opts.applyProfile}'`,
      reportPath: result.reportPath,
    };
  }

  try {
    const r = applyToolModelToSettings(
      getSettingsPath(),
      opts.applyProfile,
      "check_against_specs",
      result.recommendedModelId,
    );
    console.error(
      `[check-specs] applied ${opts.applyProfile}::tool_models.check_against_specs: ${r.oldModelId || "—"}  →  ${r.newModelId}`,
    );
    console.error("[check-specs] Run the `reset` MCP tool or restart Claude Code to pick up the new model.");
    return {
      ok: true,
      summary: `${base} — applied to '${opts.applyProfile}'::tool_models.check_against_specs; run \`reset\` to reload`,
      reportPath: result.reportPath,
    };
  } catch (err) {
    // Exit 3 on a write failure, matching every other writer path in this CLI.
    return {
      ok: false,
      code: 3,
      summary: `--apply-profile failed: ${(err as Error).message}`,
      reportPath: result.reportPath,
    };
  }
}

/**
 * --auto-replace phase: the cross-tool auto-replacement planner (TRDD-828238b5
 * A7). For every benchmarked tool it aggregates the durable model-health ledger
 * for that tool's incumbent and — when degraded, or when --force is set — runs
 * the tool's (advisory) benchmark to recommend the best same-or-cheaper passer.
 * On a healthy/empty ledger NO benchmark runs and every recommendation is "keep
 * the incumbent".
 *
 * Writes the advisory markdown report under reports/auto-replace/. This is the
 * ONLY surface that may WRITE the recommendation back: with --apply, each
 * changed=true finding is adopted by writing the per-tool `tool_models` entry to
 * ~/.llm-externalizer/settings.yaml via applyToolModelToSettings (the CLI/cron-
 * only writer behind the read-only-MCP guardrail). Exit 3 on any write failure.
 */
async function runAutoReplacePhase(opts: CliOptions): Promise<CliResult> {
  console.error("[auto-replace] cross-tool auto-replacement planner");
  const { findings, reportMarkdown } = await planToolReplacements({
    candidateModels: opts.searchExistingModels.length > 0 ? opts.searchExistingModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[auto-replace] ${m}`),
  });

  // ENSEMBLE half (P1). planToolReplacements only covers tools that own a per-tool
  // selector benchmark; the ensemble slots serve every OTHER tool and had no
  // automated verdict at all — the agent was asked to eyeball "is this 404
  // persistent?". planEnsembleRotation answers that with the ledger's code
  // threshold (assessModelPersistence), so no judgment happens up here.
  const ensemble = planEnsembleRotation();
  const fullReport = reportMarkdown + "\n" + renderEnsembleRotationSection(ensemble);

  // Persist the advisory report (always — same posture as every other phase).
  const reportPath = join(resolveProjectMainRoot(), "reports", "auto-replace", `${compactStamp()}-auto-replace.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, fullReport, "utf-8");

  console.error("");
  for (const f of findings) {
    const verdict = !f.ranBenchmark
      ? "healthy — no benchmark"
      : f.changed
        ? `RECOMMEND ${f.incumbentModelId} -> ${f.recommendedModelId}`
        : `keep ${f.incumbentModelId}`;
    console.error(`[auto-replace] ${f.tool} (${f.benchmark}): ${verdict}`);
  }
  for (const s of ensemble.slots) {
    console.error(
      `[auto-replace] ensemble.${s.slot} (${s.modelId}): ${s.verdict.persistentlyBroken ? "BROKEN" : "healthy"} — ${s.verdict.reason}`,
    );
  }
  const recommended = findings.filter((f) => f.changed);
  console.error(
    `[auto-replace] ${findings.length} tool(s) checked, ` +
      `${findings.filter((f) => f.degraded).length} degraded, ` +
      `${recommended.length} replacement(s) recommended; ` +
      `${ensemble.brokenSlots.length}/${ensemble.slots.length} ensemble slot(s) persistently broken.`,
  );
  console.error(`[auto-replace] report: ${reportPath}`);

  const scope =
    `${findings.length} tool(s) checked, ${recommended.length} replacement(s) recommended; ` +
    `${ensemble.brokenSlots.length}/${ensemble.slots.length} ensemble slot(s) broken`;

  if (!opts.apply) {
    // ADVISORY default — surfaced for the operator to adopt deliberately.
    console.error(
      "[auto-replace] ADVISORY only — nothing written. Re-run with --apply to adopt the recommendation(s).",
    );
    process.stdout.write(`recommended_replacements=${recommended.length}\n`);
    return { ok: true, summary: `advisory — ${scope}; nothing written`, reportPath };
  }

  // --apply: adopt every changed recommendation. The incumbent profile name is
  // the active profile (the planner resolved incumbents from it). Resolve it
  // here so the writer targets the same profile the health verdict came from.
  const settingsPath = getSettingsPath();
  let profileName: string;
  try {
    const settings = loadSettings();
    if (!settings || !settings.active) {
      throw new Error(
        `--apply needs an active profile in ${settingsPath}, but none is configured.`,
      );
    }
    profileName = settings.active;
  } catch (err) {
    return { ok: false, code: 3, summary: `--apply failed: ${(err as Error).message}`, reportPath };
  }

  if (recommended.length === 0 && !ensemble.rotationNeeded) {
    console.error("[auto-replace] --apply: no changed recommendation to adopt — nothing written.");
    return { ok: true, summary: `no changed recommendation to adopt — ${scope}; nothing written`, reportPath };
  }

  console.error("");
  for (const f of recommended) {
    try {
      const r = applyToolModelToSettings(settingsPath, profileName, f.tool, f.recommendedModelId);
      console.error(
        `[auto-replace] applied ${profileName}::tool_models.${f.tool}: ` +
          `${r.oldModelId || "—"}  →  ${r.newModelId}`,
      );
    } catch (err) {
      return { ok: false, code: 3, summary: `--apply failed on ${f.tool}: ${(err as Error).message}`, reportPath };
    }
  }

  // Ensemble rotation. Gated on the CODE threshold — a healthy ensemble never
  // triggers a (paid) sweep, so `--auto-replace --apply` on a healthy machine is
  // still free. When it DOES fire we must re-benchmark before re-picking: picking
  // from a stale cache would re-select the very model the ledger just condemned.
  let rotated = 0;
  if (ensemble.rotationNeeded) {
    // Re-pick exactly as many models as the profile ALREADY runs, not a hard-coded 3:
    // applyPicksToSettings derives `mode` from the pick count, so re-picking 3 on a
    // single-model `remote` profile would silently promote it to `remote-ensemble` —
    // a config change the user never asked for. slots.length is ≥1 here (rotation
    // needs a broken slot), and an explicit --pick-top-n still wins.
    const topN = opts.pickTopN ?? ensemble.slots.length;
    console.error(
      `[auto-replace] ensemble rotation: ${ensemble.brokenSlots.map((s) => `${s.slot}=${s.modelId}`).join(", ")} — ` +
        `running a fresh keyword sweep, then re-picking the top ${topN} (the profile's current slot count).`,
    );
    // Reuse the ONE sweep implementation. --bench-free-pool parked the resolved
    // free pool in searchExistingModels for this phase (see main), so forward it
    // as --include baselines — under free_only those are the only models the
    // runner will actually bill (it skips every non-free id).
    const sweepOpts: CliOptions = {
      ...opts,
      includeIds: [...opts.includeIds, ...opts.searchExistingModels],
      dryRun: false,
      fromCache: false,
      pickTopN: topN,
    };
    const sweep = await runKeywordSweep(sweepOpts);
    let picks: PickedModel[];
    try {
      picks = pickTopN(sweep.results, { topN, minMeanF1: opts.minMeanF1, requireSchema: true });
    } catch (err) {
      // No silent fallback: leaving a broken model in place and SAYING so beats
      // quietly re-applying a stale/degraded ensemble.
      return {
        ok: false,
        code: 2,
        summary: `ensemble rotation failed — ${(err as Error).message} (settings unchanged)`,
        reportPath: sweep.reportPath || reportPath,
      };
    }
    try {
      const r = applyPicksToSettings(settingsPath, profileName, picks);
      rotated = picks.length;
      console.error(
        `[auto-replace] rotated ${profileName}: ${r.oldEnsemble.model} → ${r.newEnsemble.model}` +
          (r.newEnsemble.second_model ? `, ${r.oldEnsemble.second_model ?? "—"} → ${r.newEnsemble.second_model}` : "") +
          (r.newEnsemble.third_model ? `, ${r.oldEnsemble.third_model ?? "—"} → ${r.newEnsemble.third_model}` : ""),
      );
    } catch (err) {
      return {
        ok: false,
        code: 3,
        summary: `ensemble rotation write failed: ${(err as Error).message}`,
        reportPath: sweep.reportPath || reportPath,
      };
    }
  }

  console.error("[auto-replace] Run the `reset` MCP tool or restart Claude Code to pick up the new model(s).");
  process.stdout.write(`applied_replacements=${recommended.length}\n`);
  process.stdout.write(`rotated_ensemble_slots=${rotated}\n`);
  return {
    ok: true,
    summary: `applied ${recommended.length} tool replacement(s) and rotated ${rotated} ensemble slot(s) on '${profileName}' — run \`reset\` to reload`,
    reportPath,
  };
}

/**
 * --adopt: the SCRIPTED new-arrival adoption path (P1). `--new-arrivals` used to
 * end with "if it wins, edit ~/.llm-externalizer/settings.yaml by hand" — a manual
 * step the agent had to narrate every single time. Now: gate the id on the per-tool
 * REQUIREMENTS registry (a free public catalog fetch — an id that fits nothing is
 * refused, exit 2), then write it atomically into the requested slot / tool_models
 * entry. CLI-only writer; the MCP surface stays read-only.
 */
async function runAdoptPhase(opts: CliOptions): Promise<CliResult> {
  const modelId = opts.adoptModel as string;
  const target = opts.adoptInto as string; // validateCombinations guarantees both are set
  const settingsPath = getSettingsPath();
  let profileName = opts.adoptProfile;
  if (profileName === null) {
    const settings = loadSettings();
    if (!settings || !settings.active) {
      throw new Error(
        `--adopt needs a profile: none given via --adopt-profile and no active profile in ${settingsPath}`,
      );
    }
    profileName = settings.active;
  }

  console.error(`[adopt] assessing ${modelId} against every LLM tool's requirements …`);
  const assessment = await assessModelById(modelId); // throws when the id is not in the catalog

  if (target.startsWith("tool:")) {
    const tool = target.slice("tool:".length);
    const fit = assessment.tools.find((t) => t.tool === tool);
    if (!fit) {
      throw new Error(
        `--adopt-into tool:${tool} — '${tool}' is not a registered LLM-using tool. ` +
          `Registered: ${assessment.tools.map((t) => t.tool).join(", ")}.`,
      );
    }
    if (!fit.meetsRequirements) {
      return {
        ok: false,
        code: 2,
        summary: `${modelId} does not meet ${tool}'s requirements (${fit.disqualifyReason ?? "unspecified"}) — settings unchanged`,
      };
    }
    const r = applyToolModelToSettings(settingsPath, profileName, tool, modelId);
    process.stdout.write(`adopted_model=${modelId}\n`);
    return {
      ok: true,
      summary:
        `adopted ${modelId} into ${profileName}::tool_models.${tool} (was ${r.oldModelId || "unset"})` +
        (fit.benchmark ? `; NOTE ${tool} also has a '${fit.benchmark}' benchmark gate` : "") +
        " — run `reset` to reload",
    };
  }

  if (!(ENSEMBLE_SLOTS as readonly string[]).includes(target)) {
    throw new Error(
      `--adopt-into must be one of ${ENSEMBLE_SLOTS.join(", ")} or tool:<name>, got '${target}'`,
    );
  }
  // An ensemble slot serves EVERY tool that has no per-tool override, so the bar is
  // "fits at least one tool's requirements" — a model that fits nothing would break
  // every call routed to it, and that is exactly the write we refuse.
  if (assessment.qualifiedCount < 1) {
    return {
      ok: false,
      code: 2,
      summary: `${modelId} meets no LLM tool's requirements (0/${assessment.totalTools}) — settings unchanged`,
    };
  }
  const r = applyEnsembleSlotToSettings(settingsPath, profileName, target as EnsembleSlot, modelId);
  process.stdout.write(`adopted_model=${modelId}\n`);
  return {
    ok: true,
    summary:
      `adopted ${modelId} into ${profileName}::${r.slot} (was ${r.oldModelId || "unset"}); ` +
      `fits ${assessment.qualifiedCount}/${assessment.totalTools} tool(s) — run \`reset\` to reload`,
  };
}

/**
 * --assess-model: report which LLM tools a candidate model meets the per-tool
 * REQUIREMENTS for (TRDD-f45eeaa0). Free — no LLM call, no token cost; makes one
 * public OpenRouter catalog fetch (no API key needed). Does NOT run any
 * benchmark (that's each tool's own gate; for security_scan use --security-triage).
 */
async function runAssessModelPhase(modelId: string): Promise<CliResult> {
  console.error(
    `[assess] assessing ${modelId} against every LLM tool's requirements …`,
  );
  const assessment = await assessModelById(modelId);
  process.stdout.write(renderAssessmentText(assessment) + "\n");
  return {
    ok: true,
    summary: `${modelId} meets the requirements of ${assessment.qualifiedCount}/${assessment.totalTools} LLM tool(s)`,
  };
}

/**
 * --check-health: self-check the CONFIGURED model(s) of the active profile for
 * catalog presence, cost drift, and requirements regression (TRDD-828238b5 A2).
 * Free — no LLM call; one public catalog fetch + a JSON diff vs the seeded
 * baseline. Writes a report under reports/model-health/ and prints a summary.
 * Exit 1 when any configured model is critical (deprecated/removed).
 */
async function runCheckHealthPhase(): Promise<CliResult> {
  console.error(`[check-health] checking the active profile's configured model(s) …`);
  const { report, reportPath } = await runCheckModelHealth();
  console.error(renderModelHealthText(report));
  const s = report.summary;
  // A CRITICAL model (deprecated / removed from the catalog) is a FAILURE of the
  // configuration, not of this command — but it must exit non-zero so a cron or a
  // caller can act on it without reading the report.
  return s.critical > 0
    ? {
        ok: false,
        code: 1,
        summary: `${s.critical} configured model(s) are CRITICAL (deprecated/removed), ${s.warn} warn, ${s.ok} ok`,
        reportPath,
      }
    : {
        ok: true,
        summary: `configured models: ${s.ok} ok, ${s.warn} warn, 0 critical`,
        reportPath,
      };
}

/**
 * --new-arrivals: autodiscover models that newly appeared in the OpenRouter
 * catalog since the last run (TRDD-828238b5 A4). Free — no LLM call; one public
 * catalog fetch diffed against the seeded snapshot, each new id assessed against
 * every per-tool requirements gate. Writes a report under reports/model-arrivals/
 * and prints a summary. Report-only — always exit 0 (informational).
 */
async function runNewArrivalsPhase(opts: CliOptions): Promise<CliResult> {
  console.error(`[new-arrivals] diffing the live catalog against the last snapshot …`);
  const { report, reportPath } = await runDiscoverNewArrivals({
    qualifyingOnly: opts.qualifyingOnly,
  });
  console.error(renderNewArrivalsText(report));
  return {
    ok: true,
    summary: `${report.summary.total} new arrival(s), ${report.summary.qualifying} qualify for ≥1 tool` +
      (report.summary.qualifying > 0
        ? " — adopt one with `--adopt <ID> --adopt-into <slot|tool:NAME>`"
        : ""),
    reportPath,
  };
}

/** Shared by --from-cache and the post-benchmark --pick-top-n branch. */
function runPickPhase(
  results: readonly CachedResult[],
  opts: CliOptions,
  reportPath?: string,
  notes: string[] = [],
): CliResult {
  const topN = opts.pickTopN;
  if (topN === null) return { ok: true, summary: "nothing to pick", reportPath };
  let picks: PickedModel[];
  try {
    picks = pickTopN(results, { topN, minMeanF1: opts.minMeanF1, requireSchema: true });
  } catch (err) {
    // No silent fallback: surface the shortage and leave the config alone.
    return { ok: false, code: 2, summary: `pick failed: ${(err as Error).message}`, reportPath };
  }
  console.error(`[benchmark] Top ${topN} survivors (sorted by meanF1 desc, then cost asc):`);
  for (const p of picks) {
    console.error(
      `  ${p.modelId.padEnd(42)}  meanF1=${(p.meanF1 * 100).toFixed(1)}%  cost=$${p.actualCost.toFixed(4)}  ` +
        `in/$M=$${p.inputDollarsPerMillion.toFixed(3)}  out/$M=$${p.outputDollarsPerMillion.toFixed(3)}  ` +
        `lat=${p.latencyMs.toFixed(0)}ms`,
    );
  }
  const profileName = opts.applyProfile ?? "remote-ensemble-autoselected";
  const block = renderEnsembleBlock(profileName, picks);
  console.error("");
  console.error("# settings.yaml block (paste under `profiles:`):");
  process.stdout.write(block);

  const ids = picks.map((p) => p.modelId).join(", ");
  if (opts.applyProfile !== null) {
    const settingsPath = getSettingsPath();
    try {
      const result = applyPicksToSettings(settingsPath, opts.applyProfile, picks);
      console.error("");
      console.error(`[benchmark] Applied to ${settingsPath}::${opts.applyProfile}:`);
      console.error(`  model:        ${result.oldEnsemble.model}  →  ${result.newEnsemble.model}`);
      if (result.newEnsemble.second_model || result.oldEnsemble.second_model) {
        console.error(`  second_model: ${result.oldEnsemble.second_model ?? "—"}  →  ${result.newEnsemble.second_model ?? "—"}`);
      }
      if (result.newEnsemble.third_model || result.oldEnsemble.third_model) {
        console.error(`  third_model:  ${result.oldEnsemble.third_model ?? "—"}  →  ${result.newEnsemble.third_model ?? "—"}`);
      }
      console.error("[benchmark] Run the `reset` MCP tool or restart Claude Code to pick up the new ensemble.");
    } catch (err) {
      return { ok: false, code: 3, summary: `--apply-profile failed: ${(err as Error).message}`, reportPath };
    }
    return {
      ok: true,
      summary: [`applied top-${topN} to '${opts.applyProfile}': ${ids} — run \`reset\` to reload`, ...notes].join(", "),
      reportPath,
    };
  }
  return {
    ok: true,
    summary: [`top-${topN} picks: ${ids} (not applied — pass --apply-profile P to write them)`, ...notes].join(", "),
    reportPath,
  };
}

function buildReportPath(): string {
  const root = resolveMainRoot();
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMin);
  const tz = `${offsetSign}${pad(Math.floor(offsetAbs / 60))}${pad(offsetAbs % 60)}`;
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${tz}`;
  return join(root, "reports", "benchmark", `${ts}-model-comparison.md`);
}

// Install a usage-history context so every per-model OpenRouter call made by
// runBenchmarkOnModel is logged under `cli:benchmark` with a shared op-id.
//
// This is also where the ONE machine-readable final line is emitted and where the
// exit code is set. Both were broken before P1: main()'s resolved code was simply
// DISCARDED (only an exception exited non-zero), so `--pick-top-n` finding too few
// survivors, or an --apply-profile write failing, still exited 0 — a caller could
// not tell success from failure without parsing stderr prose, which is precisely
// why the slash commands asked an AGENT to read stderr and pick a message.
//
// process.exitCode (not process.exit) so buffered stdout is flushed first.
//
// Guarded on "am I the process entry point": this module also exports
// runPopulateDefaultProfilePhase (with an injectable-deps seam, like update-all.ts's
// runUpdateAll) so its picker/budget logic can be unit-tested with a stubbed catalog +
// sweep — no network, no fixtures, no real argv parsing. Without this guard, merely
// IMPORTING index.ts under a test runner would unconditionally parse the test runner's
// own argv and kick off a real run (main() was always "runs at import time" by design —
// that's why cli-args.ts was split out; this guard extends the same testability
// property to the phases index.ts now also exports).
//
// Deliberately NOT an env-var flag (e.g. process.env.VITEST): cli-contract.test.ts
// spawns dist/benchmark.js via spawnSync with `env: { ...process.env, … }`, which
// inherits VITEST=true from the parent test process into the CHILD — an env guard would
// make the real bundled CLI silently no-op under every one of those (already-passing)
// subprocess tests. import.meta.url vs argv[1] is immune to that: it is true only when
// THIS file is the actual process entry point (`node dist/benchmark.js`), never when a
// test merely imports it in-process or spawns it as a child with an inherited env.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  withUsageContext({ tool: "cli:benchmark", params: "" }, () =>
    main().then(
      (result) => {
        process.stdout.write(finalLine(result) + "\n");
        process.exitCode = result.code ?? (result.ok ? 0 : 1);
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // The stack is diagnostic noise for the caller; keep it on stderr only.
        if (err instanceof Error && err.stack) console.error("[benchmark] fatal:", err.stack);
        process.stdout.write(finalLine({ ok: false, summary: msg }) + "\n");
        process.exitCode = 1;
      },
    ),
  );
}
