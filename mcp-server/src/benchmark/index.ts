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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withUsageContext } from "../usage-history.js";
import { buildGroundTruth, BENCHMARK_KEYWORDS } from "./ground-truth.js";
import {
  DEFAULT_CRITERIA,
  buildBenchmarkRoster,
  rankByQualityIndex,
  resolveFreePool,
  fetchProgrammingModels,
  type QualifiedModel,
} from "./discover.js";
import { runBenchmarkOnModel, type RunOutcome } from "./runner.js";
import { scoreRun, type ModelScore } from "./score.js";
import { renderReport, renderJson } from "./report.js";
import {
  applyPicksToSettings,
  applyToolModelToSettings,
  loadCachedReport,
  pickTopN,
  renderEnsembleBlock,
  type CachedResult,
  type PickedModel,
} from "./pick.js";
import { runSecurityTriageBenchmark } from "./security-triage/index.js";
import { runSearchExistingBenchmark } from "./search-existing/index.js";
import { planToolReplacements } from "../model-qualification/auto-replace.js";
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
  loadSettings,
  resolveProfile,
  setActiveFreeOnly,
  FREE_POOL_SEED,
} from "../config.js";

interface CliOptions {
  includeIds: string[];
  dryRun: boolean;
  reportPath: string | null;
  jsonPath: string | null;
  reasoningEffort: "low" | "medium" | "high" | undefined;
  seed: number | undefined;
  /** Sort surviving results by meanF1 desc + cost asc, print top N. */
  pickTopN: number | null;
  /** PRE-benchmark candidate cap: after quality-ranking the auto-discovered
   *  candidates by their catalog codex/design-arena indexes, benchmark only the
   *  top N (credit-saver — TRDD-WJND1N2W P2). null = no cap (benchmark all,
   *  still quality-ordered). Distinct from pickTopN, which caps RESULTS after
   *  the paid run; this caps the paid run's INPUT. Explicit --include baselines
   *  are never capped. */
  qualifyingTopN: number | null;
  /** After picking, mutate ~/.llm-externalizer/settings.yaml so this
   *  profile name's `model`/`second_model`/`third_model` become the
   *  three winners. Atomic write (tmp + rename); existing other profiles
   *  preserved verbatim. */
  applyProfile: string | null;
  /** Don't run the benchmark — pick top-N from the most recent cached
   *  results at ~/.llm-externalizer/benchmark-results.json. Useful for
   *  re-applying a fresh selection without burning more API calls. */
  fromCache: boolean;
  /** Minimum meanF1 a model must hit to be eligible for top-N. Default
   *  0.95 — anything lower indicates the keyword classifier flunked. */
  minMeanF1: number;
  /** Run the security_scan TRIAGE benchmark instead of the keyword task. */
  securityTriage: boolean;
  /** Explicit model id(s) to assess in --security-triage mode (repeatable).
   *  When empty, the triage benchmark auto-discovers the candidate pool. */
  triageModels: string[];
  /** Run the search_existing_implementations benchmark instead of the keyword task. */
  searchExisting: boolean;
  /** Explicit model id(s) to assess in --search-existing mode (variadic — any
   *  non-flag tokens following the flag). When empty, the benchmark
   *  auto-discovers the same-or-cheaper candidate pool. */
  searchExistingModels: string[];
  /** Ignore the per-model-per-day cache (currently only --security-triage). */
  force: boolean;
  /** Assess one model against EVERY tool's per-tool requirements (no LLM call). */
  assessModel: string | null;
  /** Self-check the CONFIGURED model(s) for presence/cost-drift/regression (no LLM call). */
  checkHealth: boolean;
  /** Autodiscover models that newly appeared in the catalog since last run (no LLM call). */
  newArrivals: boolean;
  /** With --new-arrivals, report only arrivals that meet ≥1 tool's requirements. */
  qualifyingOnly: boolean;
  /** Auto-fill the candidate set from the active profile's free pool (TRDD-f1510055).
   *  Resolves to the active profile's `free_models` if set; falls back to
   *  `FREE_POOL_SEED`. Adds each id to `includeIds` (keyword mode) or
   *  `triageModels` (security-triage mode). Lets the user benchmark the free
   *  pool with one flag instead of N `--include` invocations. */
  benchFreePool: boolean;
  /** Run the cross-tool auto-replacement planner (TRDD-828238b5 A7): for every
   *  benchmarked tool, check the ledger health of its incumbent and (when degraded
   *  or --force) run that tool's benchmark to surface the best same-or-cheaper
   *  replacement. ADVISORY by default — prints + writes a report, writes nothing. */
  autoReplace: boolean;
  /** With --auto-replace, ACTUALLY adopt each changed recommendation by writing
   *  the per-tool `tool_models` entry to ~/.llm-externalizer/settings.yaml (the
   *  SOLE writer path; the MCP surface never writes). Requires --auto-replace. */
  apply: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    includeIds: [],
    dryRun: false,
    reportPath: null,
    jsonPath: null,
    reasoningEffort: undefined,
    seed: undefined,
    pickTopN: null,
    qualifyingTopN: null,
    applyProfile: null,
    fromCache: false,
    minMeanF1: 0.95,
    securityTriage: false,
    triageModels: [],
    searchExisting: false,
    searchExistingModels: [],
    force: false,
    assessModel: null,
    checkHealth: false,
    newArrivals: false,
    qualifyingOnly: false,
    benchFreePool: false,
    autoReplace: false,
    apply: false,
  };
  // Consume the value that must follow a value-taking flag. If the flag is the
  // last token, or the next token is itself a flag, fail fast — silently
  // swallowing the trailing flag would push e.g. "--dry-run" into includeIds
  // and never set dryRun, which is data corruption from the user's POV.
  const takeValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--include") {
      opts.includeIds.push(takeValue(a, i));
      i++;
    } else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--report") {
      opts.reportPath = takeValue(a, i);
      i++;
    } else if (a === "--json") {
      opts.jsonPath = takeValue(a, i);
      i++;
    } else if (a === "--reasoning") {
      const eff = takeValue(a, i);
      i++;
      if (eff !== "low" && eff !== "medium" && eff !== "high") {
        throw new Error(`--reasoning must be low|medium|high, got ${eff}`);
      }
      opts.reasoningEffort = eff;
    } else if (a === "--seed") {
      opts.seed = parseInt(takeValue(a, i), 10);
      i++;
    } else if (a === "--pick-top-n") {
      const n = parseInt(takeValue(a, i), 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--pick-top-n must be a positive integer, got ${n}`);
      }
      opts.pickTopN = n;
      i++;
    } else if (a === "--qualifying-top-n") {
      const n = parseInt(takeValue(a, i), 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--qualifying-top-n must be a positive integer, got ${n}`);
      }
      opts.qualifyingTopN = n;
      i++;
    } else if (a === "--apply-profile") {
      opts.applyProfile = takeValue(a, i);
      i++;
    } else if (a === "--from-cache") {
      opts.fromCache = true;
    } else if (a === "--min-f1") {
      const f = parseFloat(takeValue(a, i));
      if (!Number.isFinite(f) || f < 0 || f > 1) {
        throw new Error(`--min-f1 must be 0..1, got ${f}`);
      }
      opts.minMeanF1 = f;
      i++;
    } else if (a === "--security-triage") {
      opts.securityTriage = true;
    } else if (a === "--search-existing") {
      // Variadic: consume every following non-flag token as a model id, so
      // `--search-existing a/b c/d` assesses exactly those two; with no trailing
      // tokens the benchmark auto-discovers the same-or-cheaper candidate pool.
      opts.searchExisting = true;
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts.searchExistingModels.push(argv[i + 1]);
        i++;
      }
    } else if (a === "--model") {
      opts.triageModels.push(takeValue(a, i));
      i++;
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--assess-model") {
      opts.assessModel = takeValue(a, i);
      i++;
    } else if (a === "--check-health") {
      opts.checkHealth = true;
    } else if (a === "--new-arrivals") {
      opts.newArrivals = true;
    } else if (a === "--qualifying-only") {
      opts.qualifyingOnly = true;
    } else if (a === "--bench-free-pool") {
      opts.benchFreePool = true;
    } else if (a === "--auto-replace") {
      opts.autoReplace = true;
    } else if (a === "--apply") {
      opts.apply = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      "llm-ext-benchmark — score OpenRouter models on a TypeScript-AST classification task.",
      "",
      "Usage:",
      "  llm-ext-benchmark [--include MODEL_ID]... [--dry-run] [--report PATH]",
      "                   [--reasoning low|medium|high] [--seed N]",
      "",
      "Flags:",
      "  --include ID      Add a model ID that bypasses the cost filter (repeatable).",
      "                    Use this to benchmark the current production ensemble.",
      "  --dry-run | -n    Print the resolved roster and exit; no API calls made.",
      "  --report PATH     Write the markdown report to PATH (default: auto-timestamped).",
      "  --json PATH       Write the machine-readable JSON sidecar to PATH.",
      "                    Always also written to ~/.llm-externalizer/benchmark-results.json.",
      "  --reasoning EFF   Pass reasoning.effort to each model. Default: model default.",
      "  --seed N          Fixed seed (models that support it will respect it).",
      "  --pick-top-n N    After scoring, sort survivors by meanF1 desc + total cost",
      "                    asc and print the top N (typically 3) as a settings.yaml",
      "                    ensemble block. Survivors must hit --min-f1 (default 0.95).",
      "  --qualifying-top-n N",
      "                    BEFORE benchmarking, quality-rank the auto-discovered",
      "                    candidates by their OpenRouter codex + design-arena code",
      "                    indexes and benchmark only the top N (credit-saver; caps the",
      "                    paid run's INPUT, vs --pick-top-n which caps the OUTPUT).",
      "                    --include baselines are never capped.",
      "  --apply-profile P Mutate ~/.llm-externalizer/settings.yaml so profile P's",
      "                    model/second_model/third_model are the top-N picks. Atomic",
      "                    (tmp + rename); other profiles preserved verbatim. Requires",
      "                    --pick-top-n.",
      "  --from-cache      Skip benchmarking; pick straight from the cached results",
      "                    at ~/.llm-externalizer/benchmark-results.json. Useful for",
      "                    re-applying a fresh selection without burning more calls.",
      "  --min-f1 F        Threshold a model must hit (default 0.95) to be eligible",
      "                    for top-N. 0..1.",
      "",
      "Free-pool sweep (TRDD-f1510055):",
      "  --bench-free-pool Auto-fill the candidate set from the active profile's",
      "                    free_models list (or the bundled FREE_POOL_SEED if the",
      "                    profile doesn't pin one). Equivalent to repeating --include",
      "                    once per pool entry. Refuses to run if any pool id is not",
      "                    a ':free' model — the flag is a cost-safety chokepoint.",
      "                    Composes with --security-triage (fills --model instead).",
      "",
      "security_scan TRIAGE benchmark (separate task — verdict adjudication):",
      "  --security-triage Run the security_scan triage benchmark instead of the",
      "                    keyword task. Scores model(s) on the golden dataset via",
      "                    the real judge pipeline and recommends the best",
      "                    same-or-cheaper passer. Writes a report under",
      "                    reports/security-triage-benchmark/.",
      "  --model ID        Assess this specific model (repeatable). Without it the",
      "                    triage benchmark auto-discovers same-or-cheaper candidates.",
      "  --force           Ignore the per-model-per-day cache and re-run.",
      "",
      "search_existing_implementations benchmark (separate task — duplicate-impl match):",
      "  --search-existing [ID...]",
      "                    Run the search_existing_implementations benchmark instead",
      "                    of the keyword task. Drives the REAL search-existing",
      "                    pipeline over a golden fixture codebase and scores it",
      "                    DETERMINISTICALLY (micro precision/recall/F1 over the known",
      "                    duplicate locations — no LLM judge), recommending the best",
      "                    same-or-cheaper passer. Pass explicit model id(s) after the",
      "                    flag to assess exactly those; with none, auto-discovers the",
      "                    same-or-cheaper candidate pool. Writes a report under",
      "                    reports/search-existing-benchmark/. Composes with --force.",
      "  Pass gate: micro-F1 >= 0.85 AND micro-recall >= 0.85 AND coverage >= 0.90.",
      "  Never auto-selects a pricier model. ADVISORY only — never edits config.",
      "",
      "Cross-tool auto-replacement (TRDD-828238b5 A7 — the writer path):",
      "  --auto-replace    For every benchmarked tool (security_scan,",
      "                    search_existing_implementations), check its incumbent",
      "                    model's health against the durable ledger and, when",
      "                    degraded (or with --force), run that tool's benchmark to",
      "                    surface the best same-or-cheaper replacement. On a",
      "                    healthy ledger no benchmark runs. ADVISORY by default —",
      "                    prints + writes a report under reports/auto-replace/,",
      "                    changes NOTHING.",
      "  --apply           With --auto-replace, ACTUALLY adopt each changed",
      "                    recommendation by writing the per-tool `tool_models`",
      "                    entry to ~/.llm-externalizer/settings.yaml (atomic). This",
      "                    is the SOLE writer path — the MCP `check_tool_replacements`",
      "                    tool is read-only and never writes. Requires",
      "                    --auto-replace. Run `reset` afterwards to pick up the",
      "                    change. --force re-runs benchmarks even on a healthy",
      "                    ledger. Honors free_only (zero-spend on the free pool).",
      "",
      "Cross-tool requirements assessment (free — no LLM call, no API key):",
      "  --check-health    Self-check the CONFIGURED model(s) of the active profile",
      "                    for catalog presence / cost drift / requirements",
      "                    regression. Free (no LLM call). Writes a report under",
      "                    reports/model-health/. No benchmark is run.",
      "  --assess-model ID Report which LLM tools model ID meets the per-tool",
      "                    REQUIREMENTS for (cost/context/output/params), and which",
      "                    of those tools ALSO need a benchmark pass before",
      "                    assignment. Makes one public OpenRouter catalog fetch.",
      "                    Does NOT run any benchmark (use --security-triage for",
      "                    security_scan's benchmark gate).",
      "  --new-arrivals    Autodiscover models that newly appeared in the catalog",
      "                    since the last run, each assessed against every tool's",
      "                    requirements. Free (no LLM call). Writes a report under",
      "                    reports/model-arrivals/. Add --qualifying-only to list",
      "                    only arrivals that fit >=1 tool.",
      "  Pass gate: zero under-flags on critical (judge-manipulation + visible-taint)",
      "  cases AND aggregate score >= 0.5. Never auto-selects a pricier model.",
      "  Fail-safe (error/timeout) cases are excluded from scoring; a run with",
      "  >15% errored calls is INCONCLUSIVE (degraded provider) — re-run later.",
      "",
      "Criteria applied to candidates (non-baseline):",
      `  - category = ${DEFAULT_CRITERIA.category}`,
      `  - context_length >= ${DEFAULT_CRITERIA.minContextTokens.toLocaleString()}`,
      `  - max_completion_tokens >= ${DEFAULT_CRITERIA.minOutputTokens.toLocaleString()}`,
      `  - structured_outputs or response_format supported`,
      `  - reasoning or include_reasoning supported`,
      `  - $/M in <  ${DEFAULT_CRITERIA.maxInputDollarsPerMillion.toFixed(2)}   (strictly less)`,
      `  - $/M out <  ${DEFAULT_CRITERIA.maxOutputDollarsPerMillion.toFixed(2)}   (strictly less)`,
      `  - :free tier excluded`,
      "",
      "API key resolution order: OPENROUTER_API_KEY env, then $CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY.",
    ].join("\n"),
  );
}

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

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);

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
      const resolved = resolveProfile(s.active, active);
      setActiveFreeOnly(resolved.freeOnly);
      activeFreeModels = resolved.freeModels;
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
  // security-triage → opts.triageModels; search-existing/auto-replace → searchExistingModels.
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

  // --apply is meaningless on its own — it is the writer toggle for the
  // --auto-replace planner. Gate it exactly like --apply-profile gates on
  // --pick-top-n: fail fast rather than silently no-op'ing.
  if (opts.apply && !opts.autoReplace) {
    throw new Error("--apply requires --auto-replace");
  }

  // --auto-replace routes to the cross-tool auto-replacement planner — for every
  // benchmarked tool it checks the incumbent's ledger health and (when degraded
  // or --force) runs that tool's benchmark to recommend the best same-or-cheaper
  // replacement. ADVISORY unless --apply is also passed (the sole writer path).
  if (opts.autoReplace) {
    return runAutoReplacePhase(opts);
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

  if (opts.applyProfile !== null && opts.pickTopN === null) {
    throw new Error("--apply-profile requires --pick-top-n");
  }

  // --from-cache: skip the benchmark entirely, pick straight from the
  // most recent JSON sidecar. The default cache lives at
  // ~/.llm-externalizer/benchmark-results.json (always written by a
  // fresh run, see step 9 below).
  if (opts.fromCache) {
    const cachePath = join(homedir(), ".llm-externalizer", "benchmark-results.json");
    const cache = loadCachedReport(cachePath);
    console.error(`[benchmark] --from-cache: using ${cachePath} (${cache.results.length} models, run at ${cache.timestamp}).`);
    if (opts.pickTopN === null) {
      throw new Error("--from-cache requires --pick-top-n (no point loading the cache otherwise).");
    }
    return runPickPhase(cache.results, opts);
  }

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
    return 0;
  }

  const apiKey = resolveApiKey();
  const roster: Array<{ model: QualifiedModel; isBaseline: boolean }> = [
    ...candidates.map((m) => ({ model: m, isBaseline: false })),
    ...baselines.map((m) => ({ model: m, isBaseline: true })),
  ];

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
  const cacheJsonPath = join(homedir(), ".llm-externalizer", "benchmark-results.json");
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

  // --pick-top-n (with optional --apply-profile) — re-uses the cached
  // JSON we just wrote. Parse it instead of mirroring report.ts's
  // renderJson shape inline; one source of truth.
  if (opts.pickTopN !== null) {
    const cache = loadCachedReport(cacheJsonPath);
    return runPickPhase(cache.results, opts);
  }
  return 0;
}

/**
 * --security-triage phase: assess model(s) on the security_scan triage golden
 * dataset and recommend the best same-or-cheaper passer. Writes its own JSON +
 * markdown report under reports/security-triage-benchmark/.
 */
async function runSecurityTriagePhase(opts: CliOptions): Promise<number> {
  console.error("[triage] security_scan triage model benchmark");
  const result = await runSecurityTriageBenchmark({
    models: opts.triageModels.length > 0 ? opts.triageModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[triage] ${m}`),
  });
  console.error("");
  console.error(`[triage] ${result.summaryLine}`);
  console.error(`[triage] recommended: ${result.recommendedModelId} (changed=${result.changed})`);
  console.error(`[triage] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[triage] report: ${result.mdReportPath}`);
  console.error(`[triage] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);
  return 0;
}

/**
 * --search-existing phase: assess model(s) on the search_existing_implementations
 * golden fixture dataset and recommend the best same-or-cheaper passer. Scored
 * DETERMINISTICALLY (precision/recall/F1 over the known duplicate locations — no
 * LLM judge). Writes its own JSON + markdown report under
 * reports/search-existing-benchmark/. ADVISORY only — never edits config.
 */
async function runSearchExistingPhase(opts: CliOptions): Promise<number> {
  console.error("[search-existing] search_existing_implementations model benchmark");
  const result = await runSearchExistingBenchmark({
    models: opts.searchExistingModels.length > 0 ? opts.searchExistingModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[search-existing] ${m}`),
  });
  console.error("");
  console.error(`[search-existing] ${result.summaryLine}`);
  console.error(`[search-existing] recommended: ${result.recommendedModelId} (changed=${result.changed})`);
  console.error(`[search-existing] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[search-existing] report: ${result.reportPath}`);
  console.error(`[search-existing] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);
  return 0;
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
async function runAutoReplacePhase(opts: CliOptions): Promise<number> {
  console.error("[auto-replace] cross-tool auto-replacement planner");
  const { findings, reportMarkdown } = await planToolReplacements({
    candidateModels: opts.searchExistingModels.length > 0 ? opts.searchExistingModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[auto-replace] ${m}`),
  });

  // Persist the advisory report (always — same posture as every other phase).
  const reportPath = join(resolveProjectMainRoot(), "reports", "auto-replace", `${compactStamp()}-auto-replace.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, reportMarkdown, "utf-8");

  console.error("");
  for (const f of findings) {
    const verdict = !f.ranBenchmark
      ? "healthy — no benchmark"
      : f.changed
        ? `RECOMMEND ${f.incumbentModelId} -> ${f.recommendedModelId}`
        : `keep ${f.incumbentModelId}`;
    console.error(`[auto-replace] ${f.tool} (${f.benchmark}): ${verdict}`);
  }
  const recommended = findings.filter((f) => f.changed);
  console.error(
    `[auto-replace] ${findings.length} tool(s) checked, ` +
      `${findings.filter((f) => f.degraded).length} degraded, ` +
      `${recommended.length} replacement(s) recommended.`,
  );
  console.error(`[auto-replace] report: ${reportPath}`);

  if (!opts.apply) {
    // ADVISORY default — surfaced for the operator to adopt deliberately.
    console.error(
      "[auto-replace] ADVISORY only — nothing written. Re-run with --apply to adopt the recommendation(s).",
    );
    process.stdout.write(`recommended_replacements=${recommended.length}\n`);
    return 0;
  }

  // --apply: adopt every changed recommendation. The incumbent profile name is
  // the active profile (the planner resolved incumbents from it). Resolve it
  // here so the writer targets the same profile the health verdict came from.
  const settingsPath = join(homedir(), ".llm-externalizer", "settings.yaml");
  let profileName: string;
  try {
    const settings = loadSettings();
    if (!settings || !settings.active) {
      throw new Error(
        "--apply needs an active profile in ~/.llm-externalizer/settings.yaml, but none is configured.",
      );
    }
    profileName = settings.active;
  } catch (err) {
    console.error(`[auto-replace] --apply failed: ${(err as Error).message}`);
    return 3;
  }

  if (recommended.length === 0) {
    console.error("[auto-replace] --apply: no changed recommendation to adopt — nothing written.");
    return 0;
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
      console.error(`[auto-replace] --apply failed on ${f.tool}: ${(err as Error).message}`);
      return 3;
    }
  }
  console.error("[auto-replace] Run the `reset` MCP tool or restart Claude Code to pick up the new tool model(s).");
  process.stdout.write(`applied_replacements=${recommended.length}\n`);
  return 0;
}

/**
 * --assess-model: report which LLM tools a candidate model meets the per-tool
 * REQUIREMENTS for (TRDD-f45eeaa0). Free — no LLM call, no token cost; makes one
 * public OpenRouter catalog fetch (no API key needed). Does NOT run any
 * benchmark (that's each tool's own gate; for security_scan use --security-triage).
 */
async function runAssessModelPhase(modelId: string): Promise<number> {
  console.error(
    `[assess] assessing ${modelId} against every LLM tool's requirements …`,
  );
  const assessment = await assessModelById(modelId);
  process.stdout.write(renderAssessmentText(assessment) + "\n");
  return 0;
}

/**
 * --check-health: self-check the CONFIGURED model(s) of the active profile for
 * catalog presence, cost drift, and requirements regression (TRDD-828238b5 A2).
 * Free — no LLM call; one public catalog fetch + a JSON diff vs the seeded
 * baseline. Writes a report under reports/model-health/ and prints a summary.
 * Exit 1 when any configured model is critical (deprecated/removed).
 */
async function runCheckHealthPhase(): Promise<number> {
  console.error(`[check-health] checking the active profile's configured model(s) …`);
  const { report, reportPath } = await runCheckModelHealth();
  process.stdout.write(renderModelHealthText(report) + "\n");
  process.stdout.write(`\nReport: ${reportPath}\n`);
  return report.summary.critical > 0 ? 1 : 0;
}

/**
 * --new-arrivals: autodiscover models that newly appeared in the OpenRouter
 * catalog since the last run (TRDD-828238b5 A4). Free — no LLM call; one public
 * catalog fetch diffed against the seeded snapshot, each new id assessed against
 * every per-tool requirements gate. Writes a report under reports/model-arrivals/
 * and prints a summary. Report-only — always exit 0 (informational).
 */
async function runNewArrivalsPhase(opts: CliOptions): Promise<number> {
  console.error(`[new-arrivals] diffing the live catalog against the last snapshot …`);
  const { report, reportPath } = await runDiscoverNewArrivals({
    qualifyingOnly: opts.qualifyingOnly,
  });
  process.stdout.write(renderNewArrivalsText(report) + "\n");
  process.stdout.write(`\nReport: ${reportPath}\n`);
  return 0;
}

/** Shared by --from-cache and the post-benchmark --pick-top-n branch. */
function runPickPhase(results: readonly CachedResult[], opts: CliOptions): number {
  const topN = opts.pickTopN;
  if (topN === null) return 0;
  let picks: PickedModel[];
  try {
    picks = pickTopN(results, { topN, minMeanF1: opts.minMeanF1, requireSchema: true });
  } catch (err) {
    console.error(`[benchmark] pick failed: ${(err as Error).message}`);
    return 2;
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

  if (opts.applyProfile !== null) {
    const settingsPath = join(homedir(), ".llm-externalizer", "settings.yaml");
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
      console.error(`[benchmark] --apply-profile failed: ${(err as Error).message}`);
      return 3;
    }
  }
  return 0;
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
withUsageContext({ tool: "cli:benchmark", params: "" }, () =>
  main().catch((err) => {
    console.error("[benchmark] fatal:", err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }),
);
