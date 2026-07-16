/**
 * Benchmark CLI argument surface — the PURE, side-effect-free half of the CLI.
 *
 * Split out of index.ts (P1 zero-token model pipeline) because index.ts RUNS the
 * benchmark at import time (its last statement calls main()), so parseArgs could
 * not be unit-tested without launching a sweep. The flag defaults are now the
 * spend/runtime bounds the slash-command prose used to ask the AGENT to apply by
 * hand, so they need real tests — hence this module.
 */

import { DEFAULT_CRITERIA } from "./discover.js";
import { DEFAULT_BUDGET_USD } from "./budget.js";

export interface CliOptions {
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
   *  top N (credit-saver — TRDD-WJND1N2W P2). Distinct from pickTopN, which caps
   *  RESULTS after the paid run; this caps the paid run's INPUT. Explicit
   *  --include baselines are never capped.
   *
   *  DEFAULTS TO 15 (DEFAULT_QUALIFYING_TOP_N) — a CODE default, not prose. It
   *  used to be null here while the slash command told the AGENT to "add
   *  --qualifying-top-n 15 unless the user asked for an exhaustive sweep", which
   *  meant a spend/runtime bound depended on an LLM remembering to apply it. Pass
   *  --no-qualifying-cap for the opt-in exhaustive sweep (null = benchmark every
   *  qualifying candidate, still quality-ordered). */
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
  /** Opt-in to benchmarking PAID (non-free) models. Default false — a paid
   *  candidate refuses the run without it ($0 spent). Free/$0 pools are
   *  unaffected. USER cost-safety directive (TRDD-8b6b3646). */
  allowPaidModelsTests: boolean;
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
  /** Run the code_task CODE-AUDIT benchmark instead of the keyword task (P2b). */
  codeTask: boolean;
  /** Explicit model id(s) to assess in --code-task mode (variadic — any non-flag
   *  tokens following the flag). When empty, the benchmark auto-discovers the
   *  same-or-cheaper candidate pool. */
  codeTaskModels: string[];
  /** Run the scan_folder MASS-SEARCH benchmark instead of the keyword task (P2c). */
  scanFolder: boolean;
  /** Explicit model id(s) to assess in --scan-folder mode (variadic — any non-flag
   *  tokens following the flag). When empty, the benchmark auto-discovers the
   *  same-or-cheaper candidate pool. */
  scanFolderModels: string[];
  /** Run the check_against_specs SPEC-ADHERENCE benchmark instead of the keyword task (P2d). */
  checkSpecs: boolean;
  /** Explicit model id(s) to assess in --check-specs mode (variadic — any non-flag
   *  tokens following the flag). When empty, the benchmark auto-discovers the
   *  same-or-cheaper candidate pool. */
  checkSpecsModels: string[];
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
  /** With --bench-free-pool: rewrite this profile's `free_models` list to exactly
   *  the ':free' models that PASSED the sweep (best meanF1 first). The scripted
   *  replacement for hand-editing the pool. CLI-only writer. */
  applyFreePool: string | null;
  /** Adopt ONE model id into the config (the scripted new-arrival path). */
  adoptModel: string | null;
  /** Where --adopt puts it: an ensemble slot, or `tool:<name>`. */
  adoptInto: string | null;
  /** Profile --adopt writes to. Default: the active profile. */
  adoptProfile: string | null;
  /** Run the WHOLE refresh in one command (P3): discover → requirement-gate →
   *  benchmark → rank + write → report. Zero decisions left to a human or an agent. */
  updateAll: boolean;
  /** What --update-all is allowed to spend money on.
   *
   *  DEFAULTS TO "free" — the single most important cost-safety property of this CLI.
   *  A bare `--update-all` CANNOT spend a cent: it sweeps only zero-cost models, under
   *  the free_only chokepoint. Money is at risk ONLY when the operator TYPES --paid or
   *  --both, and even then it is capped by --budget-usd. (Commit 31ce212 fixed a defect
   *  that drained $17.67 in an hour; a spend-by-default flag would invite the sequel.) */
  updateMode: UpdateModeFlag;
  /** HARD spend cap for --update-all, in USD (P4). Enforced twice: a pre-flight estimate
   *  aborts before the first call, and budget.ts reserves each call before sending it. */
  budgetUsd: number;
}

/** `--free` (default) | `--paid` | `--both`. */
export type UpdateModeFlag = "free" | "paid" | "both";

/** Code default for the pre-benchmark candidate cap (see CliOptions.qualifyingTopN).
 *  15 ≈ 15 min / well under $0.10 for a keyword sweep — the bound the command's
 *  prose used to ask the agent to apply by hand. */
export const DEFAULT_QUALIFYING_TOP_N = 15;

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    includeIds: [],
    dryRun: false,
    allowPaidModelsTests: false,
    reportPath: null,
    jsonPath: null,
    reasoningEffort: undefined,
    seed: undefined,
    pickTopN: null,
    qualifyingTopN: DEFAULT_QUALIFYING_TOP_N,
    applyProfile: null,
    fromCache: false,
    minMeanF1: 0.95,
    securityTriage: false,
    triageModels: [],
    searchExisting: false,
    searchExistingModels: [],
    codeTask: false,
    codeTaskModels: [],
    scanFolder: false,
    scanFolderModels: [],
    checkSpecs: false,
    checkSpecsModels: [],
    force: false,
    assessModel: null,
    checkHealth: false,
    newArrivals: false,
    qualifyingOnly: false,
    benchFreePool: false,
    autoReplace: false,
    apply: false,
    applyFreePool: null,
    adoptModel: null,
    adoptInto: null,
    adoptProfile: null,
    updateAll: false,
    updateMode: "free",
    budgetUsd: DEFAULT_BUDGET_USD,
  };
  // The mode flags are mutually exclusive: `--free --paid` has no coherent meaning, and
  // silently letting the last one win would decide — without saying so — whether the run
  // can spend money. That is exactly the class of silent decision this CLI exists to kill.
  let modeFlag: UpdateModeFlag | null = null;
  let budgetSeen = false;
  const setMode = (m: UpdateModeFlag): void => {
    if (modeFlag !== null && modeFlag !== m) {
      throw new Error(`--free, --paid and --both are mutually exclusive (got --${modeFlag} and --${m})`);
    }
    modeFlag = m;
    opts.updateMode = m;
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
    } else if (a === "--no-qualifying-cap") {
      // Opt-in exhaustive sweep: benchmark EVERY qualifying candidate. Explicit,
      // because it is the slow/expensive shape — the capped sweep is the default.
      opts.qualifyingTopN = null;
    } else if (a === "--apply-free-pool") {
      opts.applyFreePool = takeValue(a, i);
      i++;
    } else if (a === "--adopt") {
      opts.adoptModel = takeValue(a, i);
      i++;
    } else if (a === "--adopt-into") {
      opts.adoptInto = takeValue(a, i);
      i++;
    } else if (a === "--adopt-profile") {
      opts.adoptProfile = takeValue(a, i);
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
    } else if (a === "--allow-paid-models-tests") {
      opts.allowPaidModelsTests = true;
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
    } else if (a === "--code-task") {
      // Variadic, exactly like --search-existing: `--code-task a/b c/d` assesses
      // those two; with no trailing tokens the benchmark auto-discovers the
      // same-or-cheaper candidate pool.
      opts.codeTask = true;
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts.codeTaskModels.push(argv[i + 1]);
        i++;
      }
    } else if (a === "--scan-folder") {
      // Variadic, exactly like --code-task: `--scan-folder a/b c/d` assesses those
      // two; with no trailing tokens the benchmark auto-discovers the
      // same-or-cheaper candidate pool.
      opts.scanFolder = true;
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts.scanFolderModels.push(argv[i + 1]);
        i++;
      }
    } else if (a === "--check-specs") {
      // Variadic, exactly like --scan-folder: `--check-specs a/b c/d` assesses those
      // two; with no trailing tokens the benchmark auto-discovers the same-or-cheaper
      // candidate pool.
      opts.checkSpecs = true;
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts.checkSpecsModels.push(argv[i + 1]);
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
    } else if (a === "--update-all") {
      opts.updateAll = true;
    } else if (a === "--free") {
      setMode("free");
    } else if (a === "--paid") {
      setMode("paid");
    } else if (a === "--both") {
      setMode("both");
    } else if (a === "--budget-usd") {
      const rawBudget = takeValue(a, i);
      i++;
      const v = parseFloat(rawBudget);
      // A non-positive or non-finite cap is not "unlimited", it is a typo. Refusing it
      // is the whole point: a cap you cannot trust is worse than no cap, because it
      // reads like protection. (Use --free for a genuinely $0 run.)
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`--budget-usd must be a positive USD amount, got '${rawBudget}'`);
      }
      opts.budgetUsd = v;
      budgetSeen = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  // A mode/budget flag with no --update-all is a SILENT NO-OP — the user typed a
  // cost-safety instruction that would be ignored. That is the one failure mode a
  // spend cap can never have, so it is a usage error, not a shrug.
  if (!opts.updateAll && (modeFlag !== null || budgetSeen)) {
    throw new Error("--free / --paid / --both / --budget-usd only apply to --update-all");
  }
  return opts;
}

export function printHelp(): void {
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
      "  --allow-paid-models-tests",
      "                    Opt-in to benchmarking PAID (non-free) models. Without it,",
      "                    a paid candidate refuses the run ($0 spent). Paid models are",
      "                    also hard-capped at $1.25/1M on input AND output.",
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
      `                    paid run's INPUT, vs --pick-top-n which caps the OUTPUT).`,
      `                    DEFAULT ${DEFAULT_QUALIFYING_TOP_N} — the bound is a code default, not a flag you`,
      "                    must remember. --include baselines are never capped.",
      "  --no-qualifying-cap",
      "                    Opt in to the EXHAUSTIVE sweep: benchmark every qualifying",
      "                    candidate (slower, costs more). Removes the default cap.",
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
      "THE WHOLE REFRESH IN ONE COMMAND (P3) — zero decisions left to you or an agent:",
      "  --update-all      discover -> requirement-gate -> benchmark -> rank + write -> report.",
      "                    Fetches the live catalog, applies each tool's requirements from",
      "                    the registry, runs every tool that HAS a benchmark, and writes",
      "                    the winners: the ensemble (model/second/third), each",
      "                    tool_models.<tool>, and the free_models pool. Atomic. CLI-only.",
      "                    Ends with ONE [OK]/[FAILED] line + a report path.",
      "",
      "  --free            DEFAULT. Sweep only ZERO-COST models. Provably $0 — the free_only",
      "                    chokepoint refuses a priced model BEFORE the request is sent, so a",
      "                    bare `--update-all` cannot spend a cent. Also performs the",
      "                    FREE-MODELS SEARCH: discovers zero-cost models from the live",
      "                    catalog, verifies them, and REWRITES free_models (no hand-editing).",
      "  --paid            Sweep the PRICED catalog. Spends real money, hard-capped below.",
      "  --both            The free phase, then the paid phase, on ONE shared budget.",
      `  --budget-usd X    HARD spend cap for --paid/--both. Default $${DEFAULT_BUDGET_USD.toFixed(2)}.`,
      "                    Enforced TWICE: (1) a worst-case pre-flight estimate ABORTS the run",
      "                    before the first call if it exceeds the cap (and prints the exact",
      "                    --budget-usd that would authorize it); (2) every single call is",
      "                    reserved against the cap before it is sent, so the cap cannot be",
      "                    crossed by a call we chose to make. --dry-run prints the full plan",
      "                    and the estimate and spends NOTHING.",
      "",
      "Free-pool sweep (TRDD-f1510055):",
      "  --bench-free-pool Auto-fill the candidate set from the active profile's",
      "                    free_models list (or the bundled FREE_POOL_SEED if the",
      "                    profile doesn't pin one). Equivalent to repeating --include",
      "                    once per pool entry. Refuses to run if any pool id is not",
      "                    a ':free' model — the flag is a cost-safety chokepoint.",
      "                    Composes with --security-triage (fills --model instead).",
      "  --apply-free-pool P",
      "                    With --bench-free-pool: after the sweep, REWRITE profile P's",
      "                    `free_models` list to exactly the ':free' models that PASSED",
      "                    (best meanF1 first). Atomic. The scripted replacement for",
      "                    hand-editing the pool. Fails (exit 2) if none passed.",
      "",
      "Adoption — write ONE model into the config (the scripted new-arrival path):",
      "  --adopt ID        Adopt model ID into the config after checking it against the",
      "                    per-tool REQUIREMENTS gate (a free public catalog fetch; the",
      "                    id must exist and fit what it is adopted into, else exit 2).",
      "  --adopt-into T    Where: `model` | `second_model` | `third_model` | `tool:<name>`.",
      "                    second/third are refused unless the profile is remote-ensemble",
      "                    (those keys are ignored otherwise — a silent no-op).",
      "  --adopt-profile P Profile to write. Default: the active profile.",
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
      "code_task CODE-AUDIT benchmark (separate task — defect localization):",
      "  --code-task [ID...]",
      "                    Run the code_task code-audit benchmark instead of the",
      "                    keyword task. Drives the REAL code_task pipeline over a",
      "                    corpus of VERBATIM pre-fix snapshots from this repo's own",
      "                    git history (every defect really shipped and was really",
      "                    fixed) plus never-fixed clean files, and scores it",
      "                    DETERMINISTICALLY: precision/recall/F1 on localizing the",
      "                    defect by FUNCTION NAME — no LLM judge. Pass explicit model",
      "                    id(s) after the flag to assess exactly those; with none,",
      "                    auto-discovers the same-or-cheaper candidate pool. Writes a",
      "                    report under reports/code-task-benchmark/. Composes with",
      "                    --force.",
      "  Pass gate: macro-F1 >= 0.50 AND micro-recall >= 0.50 AND <= 1 failed case.",
      "  Never auto-selects a pricier model. ADVISORY unless --apply-profile P is",
      "  given, which writes the winner into P's `tool_models.code_task` (CLI-only).",
      "",
      "scan_folder MASS-SEARCH benchmark (separate task — per-file MATCH/NO_MATCH):",
      "  --scan-folder [ID...]",
      "                    Run the scan_folder mass-search benchmark instead of the",
      "                    keyword task. Drives the REAL scan_folder pipeline (one LLM",
      "                    call per file) over twelve files copied VERBATIM from this",
      "                    repo's own src/, asking three questions whose true MATCH set",
      "                    is DERIVED mechanically from the corpus bytes — not",
      "                    hand-listed — and scores it DETERMINISTICALLY:",
      "                    precision/recall/F1 over the per-file verdicts, no LLM judge.",
      "                    Pass explicit model id(s) after the flag to assess exactly",
      "                    those; with none, auto-discovers the same-or-cheaper candidate",
      "                    pool. Writes a report under reports/scan-folder-benchmark/.",
      "                    Composes with --force.",
      "  Pass gate: micro-F1 >= 0.85 AND micro-recall >= 0.85 AND coverage >= 0.90.",
      "  Never auto-selects a pricier model. ADVISORY unless --apply-profile P is",
      "  given, which writes the winner into P's `tool_models.scan_folder` (CLI-only).",
      "",
      "check_against_specs SPEC-ADHERENCE benchmark (separate task — per-file CLEAN/VIOLATION):",
      "  --check-specs [ID...]",
      "                    Run the check_against_specs spec-adherence benchmark instead",
      "                    of the keyword task. Drives the REAL check_against_specs",
      "                    pipeline (one LLM call per file) over this repo's own shipped",
      "                    TESTING.md and thirteen VERBATIM git snapshots — four of them",
      "                    the exact pre-fix bytes a real cost-safety commit replaced,",
      "                    each sitting next to its own fixed twin — and scores it",
      "                    DETERMINISTICALLY: precision/recall/F1 over the per-file",
      "                    CLEAN/VIOLATION verdicts, no LLM judge. The cited rule and the",
      "                    severity are reported but NOT graded (that would need a judge).",
      "                    Pass explicit model id(s) after the flag to assess exactly",
      "                    those; with none, auto-discovers the same-or-cheaper candidate",
      "                    pool. Writes a report under reports/check-specs-benchmark/.",
      "                    Composes with --force.",
      "  Pass gate: micro-F1 >= 0.80 AND micro-recall >= 0.70 AND coverage >= 0.90.",
      "  Never auto-selects a pricier model. ADVISORY unless --apply-profile P is given,",
      "  which writes the winner into P's `tool_models.check_against_specs` (CLI-only).",
      "",
      "Cross-tool auto-replacement (TRDD-828238b5 A7 — the writer path):",
      "  --auto-replace    For every benchmarked tool (security_scan,",
      "                    search_existing_implementations, code_task, scan_folder,",
      "                    check_against_specs),",
      "                    check its incumbent",
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
