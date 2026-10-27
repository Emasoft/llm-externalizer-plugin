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
import { BENCH_LOCK_PATH_ENV, releaseOwnBenchLockOnExit } from "../bench-lock.js";
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
  type ModelCriteria,
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
  writeDynamicProfileSection,
  renderEnsembleBlock,
  ENSEMBLE_SLOTS,
  type CachedReport,
  type CachedResult,
  type EnsembleSlot,
  type PickedModel,
} from "./pick.js";
import { paymentErrorCertainty } from "./free-mode.js";
import { registeredTools } from "../model-qualification/registry.js";
import { readCandidates, clearCandidates } from "../dynamic-candidates.js";
import { bookDailySpend } from "./daily-spend.js";
import { runUpdateAll, estimateWorkloadCostUsd, type EnsembleSweepRun, type ToolBenchmarkRun } from "./update-all.js";
import {
  ASSUMED_MAX_OUTPUT_TOKENS,
  SpendLedger,
  makeBudgetedGlobalFetch,
  type ModelPrice,
  type PriceLookup,
} from "./budget.js";
import type { BenchmarkWorkload } from "./workload-types.js";
import { runSecurityTriageBenchmark } from "./security-triage/index.js";
import { runScoutAccuracyBenchmark } from "./scout-accuracy.js";
import { runSearchExistingBenchmark } from "./search-existing/index.js";
import { runCodeAuditBenchmark } from "./code-task/index.js";
import { runScanFolderBenchmark } from "./scan-folder/index.js";
import { runCheckSpecsBenchmark } from "./check-specs/index.js";
import {
  runDescribeBenchmark,
  runSemDedupBenchmark,
  runSummarizeBenchmark,
  runTopicsBenchmark,
} from "./text-tools/index.js";
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
import { defaultOutputDir } from "../project-root.js";
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
  DEFAULT_PROFILE_NAME,
  isDynamicProfileName,
  resolveGroups,
  effectiveProfileName,
  type Profile,
  type ResolvedRoute,
} from "../config.js";
import {
  recordBenchmarkSuccess,
  recordBenchmarkFailure,
  recordDynamicBenchmarkAt,
  updateDynamicProfileRecord,
} from "../default-profiles-state.js";
import { poolFingerprint, type CatalogPriceSnapshot } from "../default-profiles.js";
import { toCatalogPriceSnapshot } from "../model-reconcile.js";
// TRDD-C9SXX7HO (D2): the 'local' dynamic profile's only inputs — a probe of
// well-known local server ports, never the OpenRouter catalog.
import { discoverLocalLlmServices } from "../local_discovery/scan.js";
import { buildLocalProfileSection, localEndpointFingerprint } from "../local-profile.js";

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
    !opts.checkSpecs &&
    !opts.summarizeBenchmark &&
    !opts.topicsBenchmark &&
    !opts.semDedupBenchmark &&
    !opts.describeBenchmark
  ) {
    // --code-task, --scan-folder, --check-specs and the four text-tool benchmark flags
    // are the legitimate single-winner consumers of --apply-profile: each produces ONE
    // winner (not a top-N ensemble), which it writes into that profile's
    // `tool_models.<tool>`. Everything else needs --pick-top-n to have anything to write.
    throw new Error(
      "--apply-profile requires --pick-top-n (or --code-task / --scan-folder / --check-specs / --summarize-benchmark / --topics-benchmark / --sem-dedup-benchmark / --describe-benchmark, which write their single winner into tool_models.<tool>)",
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
  if (!settings) return null; // the phase reports a missing/unreadable settings file
  // P6b-fix2 B-1 (row99: `active:` reinstated, TRDD-G6XT3AY9) — the TARGET
  // profile: `--profile` when given, else `active:` in settings.yaml, else
  // the built-in default. See benchmarkTargetProfile's own doc comment.
  const profileName = benchmarkTargetProfile(opts.profile);
  const target = settings.profiles[profileName];
  if (!target) return null;
  if (!resolveProfile(profileName, target).freeOnly) return null;
  return {
    ok: false,
    code: 2,
    summary:
      `--update-all --${opts.updateMode} refused: profile '${profileName}' has free_only: true, which means it must never spend. ` +
      `Run --update-all (free, $0), or turn off free_only in ${getSettingsPath()} first — that is a deliberate decision, not a flag override`,
  };
}

/**
 * The profile a write in THIS CLI targets (P6b-fix2 B-1).
 *
 * `llm-ext-benchmark` runs as its own process. 5502ca5/c1646e6 (TRDD-G6XT3AY9,
 * 14.1.0) reinstated the settings.yaml `active:` key as the live
 * default-profile pointer, so it is back IN this resolution: the explicit
 * `--profile`/queue argument wins when given, else `active:` via
 * config.ts's effectiveProfileName() — the same resolver cli/main.ts uses —
 * else the built-in DEFAULT_PROFILE_NAME when settings can't be loaded at
 * all. GENERATED sections (`free`/`paid`) are still written only by the
 * dynamic maintainer (under the settings write lock, with the generated
 * marker and a backup of any hand-authored section); this function only
 * decides WHICH profile name a write targets, not who is allowed to write it.
 */
function benchmarkTargetProfile(explicit: string | null | undefined): string {
  // row99 fix-queue (14.1.0 reinstated `active:`, TRDD-G6XT3AY9): mirrors
  // cli/main.ts's own precedence exactly -- `--profile` (explicit) wins,
  // else `active:` in settings.yaml via effectiveProfileName(), the ONE
  // resolver every other reader (validateSettings, boot, settings
  // show/status, and now this benchmark CLI) agrees on -- no second copy of
  // the precedence rule. `active:` was previously excluded on purpose
  // (p14.1-c2 review, 5502ca5 item 3a, when `active:` was still the RETIRED
  // disk key); 5502ca5/c1646e6 reinstated it as the live default-profile
  // pointer, so that exclusion no longer applies. Settings unreadable here
  // falls back to DEFAULT_PROFILE_NAME -- main() already refuses to dispatch
  // any phase that reads the resolved profile when settings cannot be
  // loaded (settingsIndependentPhase), so this fallback is only ever reached
  // by a phase that never uses it for real work.
  return benchmarkTargetProfileOrNull(explicit) ?? DEFAULT_PROFILE_NAME;
}

/**
 * The profile UNREADABLE-settings-safe resolver (row99 fix-queue item 5,
 * S5): same precedence as benchmarkTargetProfile above, but returns null
 * instead of silently falling back to DEFAULT_PROFILE_NAME when
 * settings.yaml can't be loaded. main()'s generatedRefusal computation uses
 * this for --update-all / --auto-replace --apply / --adopt so an unreadable
 * settings.yaml reaches the REAL settings-unreadable refusal further down
 * (or runUpdateAllPhase's own check) instead of benchmarkTargetProfile's
 * 'free' fallback wrongly tripping the GENERATED-profile refusal (fail-fast
 * rule: no fallback that hides which check actually failed).
 */
function benchmarkTargetProfileOrNull(explicit: string | null | undefined): string | null {
  if (explicit) return explicit;
  const s = loadSettings();
  return s ? effectiveProfileName(s) : null;
}

/**
 * The profile whose `free_only` governs this run's COST GATE (P6b-fix3 S-2').
 *
 * `setActiveFreeOnly` decides which candidates the runner is allowed to bill
 * for, so it must name the profile the command actually WRITES — otherwise two
 * flags have to agree and nothing enforces it. Before this, main published
 * `benchmarkTargetProfile(opts.profile)` for every phase, so
 * `--code-task-benchmark --apply-profile ens` with no `--profile` published
 * `profiles.free`'s `free_only: true`: runner.ts skipped every non-zero-cost
 * candidate and the phase reported "no eligible same-or-cheaper passer, so
 * nothing was written to 'ens'" — a silent no-op that looked like a verdict.
 * Pre-P6b this happened to work for anyone whose disk `active:` named a
 * non-free_only profile, which is why it surfaced only now.
 *
 * Order mirrors the write targets: `--apply-profile` when set, then the
 * populators' own name (they also set the flag themselves once their phase
 * starts — this makes main agree with them rather than publishing `free`'s
 * gate while populating `paid`), else the general target.
 *
 * Exported for `generated-profile-writes.test.ts`: the value it returns is
 * consumed by `setActiveFreeOnly` deep inside a sweep that needs the network, so
 * the resolution itself is the only part a hermetic test can observe.
 */
export function costGateProfile(opts: CliOptions): string {
  if (opts.applyProfile) return opts.applyProfile;
  if (opts.populateDefaultProfile) return opts.populateDefaultProfile;
  // P6c tidy (fix-queue item 51): --apply-free-pool and --adopt are each their own
  // write target too (416/417 below resolve them the same way for their own
  // generated-profile refusal) — costGateProfile used to fall through to the
  // general target for both, publishing the WRONG profile's free_only when
  // neither --apply-profile nor --populate-default-profile was also set. Harmless
  // today (--adopt only reads the public no-auth catalog; --apply-free-pool is $0
  // by construction) but the gate should still name the profile actually written.
  if (opts.applyFreePool) return opts.applyFreePool;
  if (opts.adoptModel) return benchmarkTargetProfile(opts.adoptProfile ?? opts.profile);
  return benchmarkTargetProfile(opts.profile);
}

/**
 * Refuse a command that would write a GENERATED section, BEFORE it writes
 * anything (P6b-fix2 B-1).
 *
 * The writers in pick.ts throw for a dynamic name, which is the right last line
 * of defence but the wrong user experience: `--update-all` writes the ensemble,
 * THEN the free pool, so a throw at the second writer left settings.yaml
 * half-updated and the run dead with a stack trace. Refusing here — in the same
 * usage-error phase as refuseUnsafeUpdateAll, before preflight — means nothing
 * has been written when the user is told, and the exit is a clean code 2.
 */
function refuseGeneratedProfileTarget(command: string, profileName: string): CliResult | null {
  if (!isDynamicProfileName(profileName)) return null;
  return {
    ok: false,
    code: 2,
    summary:
      `${command} refused: '${profileName}' is a GENERATED dynamic profile — llm-ext owns that section and ` +
      `writes it only through the dynamic-profile maintainer. Use ` +
      `'llm-ext-benchmark --populate-default-profile ${profileName}' instead, or pass --profile <name> ` +
      `to target a static profile`,
  };
}

// row99 fix-queue / fail-fast (CLAUDE.md "no fallback that hides a failure"):
// main()'s settings/profile resolution used to swallow an unreadable
// settings.yaml or an unresolvable active profile and run the sweep anyway
// ("best-effort on bad settings"). That is only safe for the handful of
// phases below that never read the resolved free_only / free pool / target
// profile before returning — everything else (the default keyword sweep,
// --auto-replace, --security-triage/--search-existing/--code-task/
// --scan-folder/--check-specs, the four text-tool benchmarks, and a bare
// --bench-free-pool) MUST fail fast instead of dispatching on a wrong or
// default free_only value. Exemptions, each verified by reading the phase
// it routes to:
//   --dry-run          — every dry-run branch (the 9 sub-task ones and the
//                         default sweep's own) returns before `freeOnly` is
//                         read anywhere downstream.
//   --update-all        — runUpdateAllPhase() calls loadSettings()/
//                         resolveProfile() itself and fails fast on its own
//                         (see the settings/settings.profiles[profileName]
//                         check at the top of that function).
//   --populate-default-profile — routes to its own free/local/paid writers,
//                         none of which take main()'s freeOnly/activeFreeModels.
//   --assess-model, --check-health, --new-arrivals — doc'd "free": a public,
//                         no-auth OpenRouter catalog fetch only, no freeOnly
//                         or allow_paid_models read.
//   --from-cache         — reads the JSON sidecar off disk, no network, no
//                         freeOnly read.
//   --adopt              — assessModelById() + applyToolModelToSettings/
//                         applyEnsembleSlotToSettings write the target
//                         profile directly; does not consume main()'s
//                         resolved freeOnly/activeFreeModels.
function settingsIndependentPhase(opts: CliOptions): boolean {
  return (
    opts.dryRun ||
    opts.updateAll ||
    opts.populateDefaultProfile !== null ||
    opts.assessModel !== null ||
    opts.checkHealth ||
    opts.newArrivals ||
    opts.fromCache ||
    opts.adoptModel !== null
  );
}

// row99 fix-queue item 3: `--dry-run` is exempt above so the 9 sub-task
// benchmarks' AND the default sweep's OWN dry-run branch (the "print the
// plan, spend $0" short-circuits inside/around runKeywordSweep) can still
// run on a broken settings file — but their REAL (non-dry-run) run DOES read
// the resolved freeOnly/activeFreeModels and would refuse for the exact
// cause `settingsFailureCause` names. The other 7 exemptions are exempt
// unconditionally — --update-all etc. never read main()'s resolved value
// even for real, so a broken settings.yaml does not predict a refusal for
// them and this must return false for those, dry-run or not.
export function dryRunWouldMaskRefusal(opts: CliOptions, settingsFailureCause: string | null): boolean {
  // settingsIndependentPhase already reads every one of the 7 exemption
  // flags plus opts.dryRun and nothing else (no closures, no I/O), so
  // asking it the same question with dry-run forced off is exactly this
  // function's 7-condition check, with one source of truth (kept as ONE
  // list rather than a hand-copied second one that could drift).
  //
  // Exported (review of 43e3694, S3) so a unit test can call it directly
  // with a real EXEMPT, NON-write command's parsed opts (e.g. --check-health
  // --dry-run) and prove the false branch — no CLI code path actually
  // reaches this function for those commands (they dispatch unconditionally,
  // never consulting opts.dryRun), so a CLI-spawn test could never exercise
  // that branch; see settings-resolution-failfast.test.ts's replacement for
  // former case (j), which was vacuous for the same reason.
  return opts.dryRun && settingsFailureCause !== null && !settingsIndependentPhase({ ...opts, dryRun: false });
}

/**
 * The remedy clause for "active profile 'X' is not configured" (row99
 * fix-queue item 4, S4). A GENERATED name ('free'/'paid'/'local') really
 * does populate itself the moment any llm-ext command runs — "run any
 * llm-ext command once" is true advice for it. A STATIC `active:` name that
 * simply isn't defined in settings.yaml never auto-generates, so the same
 * remedy would be a false promise; name the real problem instead.
 */
function notConfiguredRemedy(activeName: string): string {
  return isDynamicProfileName(activeName)
    ? "run any llm-ext command once to generate the free/paid/local sections"
    : "the profile named by active: (or --profile) does not exist in settings.yaml";
}

/**
 * The refusal for "settings.yaml itself could not be loaded" (review of
 * 43e3694, S2). Used by BOTH the write-phase guard (--update-all /
 * --auto-replace --apply / --adopt, before any catalog fetch) and the
 * sweep's own unreadable-settings branch further down in main() — one text,
 * one place to fix. The remedy used to also recommend --dry-run alongside
 * --check-health/--assess-model, but a WRITE command's own --dry-run is
 * refused by this SAME guard (settings-resolution-failfast.test.ts case (j):
 * `--update-all --dry-run` on unreadable settings still refuses outright) —
 * recommending it here is wrong advice for exactly the callers that reach
 * this helper, so it is dropped from the shared text rather than kept for
 * the one caller where it happens to hold.
 */
function unreadableSettingsRefusal(settingsPath: string): CliResult {
  return {
    ok: false,
    code: 2,
    summary: `settings.yaml unreadable or invalid at ${settingsPath} — refusing to run (no cost-mode fallback; fix the file, or use a settings-independent command such as --check-health/--assess-model)`,
  };
}

async function main(): Promise<CliResult> {
  const opts = parseArgs(process.argv);
  // Say WHY this process exists, first line of its log. When a bench child is
  // auto-spawned (free-pool transition, model reconcile, default-profile
  // population) the parent exports LLM_EXT_AUTO_BENCH_REASON, and this is the
  // only place it is ever read back: without it the log shows a benchmark
  // nobody can attribute, and three call sites were computing a reason that
  // reached no reader at all.
  const autoBenchReason = process.env.LLM_EXT_AUTO_BENCH_REASON;
  if (autoBenchReason) {
    process.stderr.write(`[llm-externalizer] benchmark started automatically — reason: ${autoBenchReason}\n`);
  }
  // Publish the paid-benchmark opt-in for the whole process, so every phase's
  // assertPaidBenchmarkAllowed chokepoint sees it (USER cost-safety directive).
  setPaidBenchmarksAllowed(opts.allowPaidModelsTests);
  // Usage errors first, environment second — see validateCombinations.
  validateCombinations(opts);
  // C2b-wire (TRDD-OE27RD7I): the ONLY argv default-profiles-runner.ts's
  // spawnDetachedDetector ever spawns this script with. Cheap, read-only
  // fingerprint check (never a benchmark, never a settings.yaml write) — runs
  // before every other phase's write-guards/catalog fetch below and exits
  // directly, exactly like the sub-task --dry-run short-circuit further down
  // exits before spending anything.
  if (opts.detectProfileChanges !== null) {
    const { detectProfileChanges } = await import("../profile-detector.js");
    await detectProfileChanges(opts.detectProfileChanges, { log: (m) => process.stderr.write(m) });
    process.exit(0);
  }
  // P6b-fix2 B-1: every command that WRITES a profile section refuses a
  // generated one here — before preflight, before the catalog fetch, before the
  // sweep, and above all before the first of its several writes.
  //
  // P6b-fix3 N-3: this now runs BEFORE refuseUnsafeUpdateAll. DEFAULT_PROFILE_NAME
  // is `free`, so on a shipped config `--update-all --paid` hit the free_only
  // refusal first and was told to "turn off free_only in settings.yaml" — advice
  // to hand-edit a GENERATED section the maintainer overwrites on the next
  // dispatch, about a profile the user never named. The generated-target refusal
  // is the true and actionable one for that command, so it speaks first; the
  // free_only refusal below is still reached for every STATIC target.
  //
  // P6b-fix3 S-1': `--apply-profile <name>` is in the chain. It is the write
  // target of five phases (the four tool-model benchmarks and the top-N pick)
  // and was absent, so `--apply-profile free` ran the WHOLE sweep — billable on
  // a paid profile — and only then took pick.ts's throw. Nothing was
  // half-written, but the money was already spent: "before any write" has to
  // mean before the spend that produces the thing to write.
  // getConfigDir()'s M8 path-traversal guard can THROW (not just return
  // null) for a LLM_EXT_CONFIG_DIR outside home/tmp — benchmarkTargetProfile's
  // `active:` fallback and the settingsPath/costGateProfile resolution below
  // both reach it. Unguarded, that would reject main() with a stack trace
  // instead of the one-line [FAILED] refusal every other config-level
  // problem in this function produces (see the module-bootstrap comment on
  // why a rejection is NOT equivalent: it still prints one final line, but
  // at exit code 1, not the 2 every other refusal here uses, and only after
  // a stack trace to stderr).
  let generatedRefusal: CliResult | null;
  try {
    // review of 43e3694 (S1): the real question a WRITE phase (--update-all,
    // --auto-replace --apply, --adopt) needs answered is "can settings.yaml
    // itself be loaded", independent of whether the profile NAME came from
    // settings or from an explicit --profile/--adopt-profile flag.
    // benchmarkTargetProfileOrNull returns an explicit name immediately
    // without ever calling loadSettings(), so checking "is the TARGET null"
    // missed `--adopt x --adopt-profile mystatic` on an unreadable
    // settings.yaml (target = 'mystatic', never null) — main() fell through
    // to the write phase and reached assessModelById's catalog fetch, which
    // then threw uncaught instead of a clean [FAILED] refusal.
    const settingsUnreadable = loadSettings() === null;
    const updateAllTarget = opts.updateAll ? benchmarkTargetProfileOrNull(opts.profile) : null;
    const autoReplaceApplyTarget =
      opts.autoReplace && opts.apply ? benchmarkTargetProfileOrNull(opts.profile) : null;
    const adoptTarget = opts.adoptModel ? benchmarkTargetProfileOrNull(opts.adoptProfile ?? opts.profile) : null;
    // Refuse HERE, before refuseGeneratedProfileTarget below (which a
    // resolved-or-explicit target trivially passes, since
    // isDynamicProfileName(null-ish) is never true) and before any later
    // settings read, so no write path can slip past the generated-profile
    // guard on unreadable settings, and --adopt in particular never reaches
    // assessModelById's catalog fetch further down.
    if (settingsUnreadable && (opts.updateAll || (opts.autoReplace && opts.apply) || opts.adoptModel !== null)) {
      return unreadableSettingsRefusal(getSettingsPath());
    }
    generatedRefusal =
      (opts.applyProfile ? refuseGeneratedProfileTarget("--apply-profile", opts.applyProfile) : null) ??
      (updateAllTarget ? refuseGeneratedProfileTarget("--update-all", updateAllTarget) : null) ??
      (autoReplaceApplyTarget
        ? refuseGeneratedProfileTarget("--auto-replace --apply", autoReplaceApplyTarget)
        : null) ??
      (opts.applyFreePool ? refuseGeneratedProfileTarget("--apply-free-pool", opts.applyFreePool) : null) ??
      (adoptTarget ? refuseGeneratedProfileTarget("--adopt", adoptTarget) : null);
  } catch (err) {
    // review-followup (row99): NOT "settings.yaml unreadable or invalid" —
    // loadSettings() itself already reports that case by returning null
    // rather than throwing (see the `!s` branch below). What actually throws
    // here in practice is getConfigDir()'s M8 path-traversal guard, which is
    // a LLM_EXT_CONFIG_DIR location problem, not a YAML syntax problem; a
    // message claiming the wrong cause sends the caller to edit a file that
    // was never broken.
    //
    // row99 fix-queue item 1 (S1): name ONLY LLM_EXT_CONFIG_DIR here — the
    // dropped clause ("or use a settings-independent command such as
    // --check-health/--assess-model/--dry-run") was wrong advice for exactly
    // those three commands, since this same catch runs for EVERY phase (see
    // the second occurrence of this message further down): on a bad
    // LLM_EXT_CONFIG_DIR, --check-health itself would be told to run
    // --check-health.
    return {
      ok: false,
      code: 2,
      summary: `settings/config could not be resolved: ${err instanceof Error ? err.message : String(err)} — refusing to run (no cost-mode fallback; fix LLM_EXT_CONFIG_DIR)`,
    };
  }
  if (generatedRefusal !== null) return generatedRefusal;
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
  // Row 92 fix-queue: mirrors _activeFreeOnly (still published below for the
  // out-of-scope subsystems that read it — judge.ts, scout.ts, cli.ts), but the
  // keyword sweep below now takes it as an explicit parameter instead of reading
  // the global from inside runner.ts's cost gate.
  //
  // Fail-fast settings/profile resolution (row99 fix-queue). Previously this
  // caught any error and silently ran the sweep on `freeOnly = true` /
  // `activeFreeModels = []` regardless of WHY resolution failed — a
  // "best-effort on bad settings" fallback that CLAUDE.md's fail-fast rule
  // forbids: the code must work as intended or exit with an error, never
  // paper over a broken config and dispatch anyway.
  //
  // `freeOnly` is typed WITHOUT an initializer: every leaf below either
  // assigns it from a successfully-resolved profile or `return`s a non-zero
  // CliResult first, so tsc's definite-assignment analysis proves there is no
  // reachable read of an unset value — see settingsIndependentPhase's doc
  // comment for exactly which flags are exempt and why. Each branch here
  // assigns-or-returns directly (no separate "did resolution fail?" flag
  // joined back afterwards) because tsc cannot correlate two independently
  // assigned variables across sibling branches — an earlier version used a
  // shared `resolutionError` string checked in a second `if` after this one
  // and tsc could not see that "resolutionError set" and "freeOnly unset"
  // always coincide, even though they logically do.
  let freeOnly: boolean;
  // row99 fix-queue item 2: getSettingsPath() (-> getConfigDir()'s M8
  // path-traversal guard) and costGateProfile() (-> benchmarkTargetProfile's
  // own loadSettings() fallback) can both THROW, not just fail informatively
  // — guarded together so a throw here refuses with the same one-line
  // [FAILED], code 2, as every other config-level refusal in this function,
  // instead of rejecting main() (module bootstrap: exit 1, stack trace on
  // stderr — see the comment on the generatedRefusal try above).
  let settingsPath: string;
  let s: ReturnType<typeof loadSettings>;
  let activeName: string;
  try {
    settingsPath = getSettingsPath();
    s = loadSettings();
    // P6b-fix2 B-1 (row99: `active:` reinstated, TRDD-G6XT3AY9): the profile
    // this RUN targets. With no --profile that is now `active:` in
    // settings.yaml via config.ts's effectiveProfileName() when set, else the
    // built-in default — benchmarkTargetProfile's own doc comment has the
    // full precedence. The difference from a bare `--profile <static>` is that
    // it publishes THAT profile's free_only to the cost chokepoint instead of
    // the resolved default's.
    // P6b-fix3 S-2': the profile this run WRITES, which for --apply-profile and
    // the populators is not benchmarkTargetProfile — see costGateProfile.
    activeName = costGateProfile(opts);
  } catch (err) {
    // review-followup (row99): same reasoning as the generatedRefusal catch
    // above — this is almost always getConfigDir()'s M8 path guard, not a
    // YAML problem, so the message must not name settings.yaml specifically.
    //
    // row99 fix-queue item 1 (S1): this IS the "second try" that runs for
    // EVERY phase, including --check-health/--assess-model/--dry-run — see
    // the comment on the generatedRefusal catch above for why the dropped
    // clause was actively wrong advice here.
    return {
      ok: false,
      code: 2,
      summary: `settings/config could not be resolved: ${err instanceof Error ? err.message : String(err)} — refusing to run (no cost-mode fallback; fix LLM_EXT_CONFIG_DIR)`,
    };
  }
  // row99 fix-queue item 3: recorded ONLY when resolution genuinely failed
  // AND the run is proceeding anyway because it's exempt (settingsIndependentPhase).
  // A --dry-run of a phase that DOES read freeOnly/activeFreeModels for real
  // (the 9 sub-task benchmarks + the default keyword sweep — see
  // settingsIndependentPhase's own doc comment) reads this to warn honestly
  // that dropping --dry-run would refuse; the other 7 exempt flags never read
  // the resolved profile even in their real run, so their own dry-run branch
  // (if any) must NOT consult this — see dryRunWouldMaskRefusal below.
  let settingsFailureCause: string | null = null;
  const active = s ? s.profiles[activeName] : undefined;
  if (s && active) {
    let resolved: ReturnType<typeof resolveProfile> | null = null;
    let resolveErrorMessage: string | null = null;
    try {
      // Publish the master switch for this separate benchmark process, so
      // assertPaidBenchmarkAllowed's getAllowPaidModels() check (USER D4) is
      // correct here too — a paid benchmark is refused unless allow_paid_models
      // is true, regardless of --allow-paid-models-tests. Absent ⟺ false (free).
      setAllowPaidModels(s.allow_paid_models === true);
      resolved = resolveProfile(activeName, active);
    } catch (err) {
      resolveErrorMessage = err instanceof Error ? err.message : String(err);
    }
    if (resolved) {
      setActiveFreeOnly(resolved.freeOnly);
      freeOnly = resolved.freeOnly;
      // Read the pool UNCONDITIONALLY, not via resolved.freeModels — that one is
      // gated on the per-profile `free_only`, so for anyone whose free mode comes
      // from the top-level allow_paid_models switch it is [] and --bench-free-pool
      // silently fell back to the hardcoded FREE_POOL_SEED, benchmarking stale
      // seed ids instead of the pool actually in use. $0 is still guaranteed
      // downstream by resolveFreePool's non-$0 fail-fast, so widening the source
      // here cannot admit a priced model.
      activeFreeModels = profileFreeModels(active);
    } else if (!settingsIndependentPhase(opts)) {
      return {
        ok: false,
        code: 2,
        summary: `profile '${activeName}' in ${settingsPath} could not be resolved: ${resolveErrorMessage} — refusing to run (no cost-mode fallback; fix the file, or use a settings-independent command such as --check-health/--assess-model/--dry-run)`,
      };
    } else {
      // Reached only by a settings-independent phase (never reads freeOnly
      // below) — just what makes the assignment definite for tsc. row99
      // item 3: record WHY, so a --dry-run of a phase whose real run DOES
      // read freeOnly can say so honestly instead of printing a clean [OK].
      freeOnly = true;
      // review-followup (row99): match the "not configured" branch's remedy
      // suffix below, so both settingsFailureCause messages read the same way.
      settingsFailureCause = `profile '${activeName}' in ${settingsPath} could not be resolved: ${resolveErrorMessage} — fix the file, or pass --profile <name>`;
    }
  } else if (!settingsIndependentPhase(opts)) {
    // review of 43e3694 (S2): the unreadable-settings case shares
    // unreadableSettingsRefusal with the write-phase guard above — one
    // text, one place to fix.
    if (!s) return unreadableSettingsRefusal(settingsPath);
    // An upgraded install can have a settings.yaml that predates the
    // free/paid/local generated sections (nothing has run yet to write
    // them), so the remedy is not just "the name is wrong" — and "run any
    // llm-ext command once" is only true advice for a GENERATED name (see
    // notConfiguredRemedy's own doc comment).
    return {
      ok: false,
      code: 2,
      summary: `active profile '${activeName}' is not configured in ${settingsPath} — refusing to run (no cost-mode fallback; ${notConfiguredRemedy(activeName)}, or pass --profile <name>)`,
    };
  } else {
    // Reached only by a settings-independent phase — see comment above.
    freeOnly = true;
    settingsFailureCause = !s
      ? `settings.yaml unreadable or invalid at ${settingsPath}`
      : `active profile '${activeName}' is not configured in ${settingsPath} — ${notConfiguredRemedy(activeName)}, or pass --profile <name>`;
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
    } else if (opts.summarizeBenchmark) {
      for (const id of pool) {
        if (!opts.summarizeBenchmarkModels.includes(id)) opts.summarizeBenchmarkModels.push(id);
      }
    } else if (opts.topicsBenchmark) {
      for (const id of pool) {
        if (!opts.topicsBenchmarkModels.includes(id)) opts.topicsBenchmarkModels.push(id);
      }
    } else if (opts.semDedupBenchmark) {
      for (const id of pool) {
        if (!opts.semDedupBenchmarkModels.includes(id)) opts.semDedupBenchmarkModels.push(id);
      }
    } else if (opts.describeBenchmark) {
      for (const id of pool) {
        if (!opts.describeBenchmarkModels.includes(id)) opts.describeBenchmarkModels.push(id);
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
  // dynamic profile ('free' | 'paid') and nothing else.
  if (opts.populateDefaultProfile !== null) {
    return runPopulateDefaultProfilePhase(opts);
  }

  // --dry-run for the NINE sub-task benchmarks (TRDD-ZZV1XL3C). It lives HERE,
  // above the dispatch, because this is the single chokepoint every sub-task
  // phase routes through — one implementation instead of nine, and a tenth
  // benchmark added later inherits it by construction rather than by remembering.
  //
  // WHY IT MUST PRECEDE THE DISPATCH: each runXPhase() fetches the catalog and
  // starts calling models. Measured 2026-08-29 (TRDD-29VF8RWK): `--code-task
  // --dry-run` billed real money because the flag reached no phase. A plan-only
  // mode implemented INSIDE the phases would have to be honoured nine times and
  // would regress the moment someone adds the tenth.
  //
  // Zero HTTP calls of any kind: the roster is reported from the argv the user
  // supplied. When they named no models the roster is genuinely not known yet —
  // it is auto-discovered from the live catalog — so this says exactly that
  // rather than fetching it, because "prints the plan and spends NOTHING" is the
  // contract and a catalog fetch is still a call.
  const subTaskDryRun: ReadonlyArray<readonly [boolean, string, readonly string[]]> = [
    [opts.securityTriage, "security-triage", opts.triageModels],
    [opts.scoutAccuracy, "scout-accuracy", []],
    [opts.searchExisting, "search-existing", opts.searchExistingModels],
    [opts.codeTask, "code-task", opts.codeTaskModels],
    [opts.scanFolder, "scan-folder", opts.scanFolderModels],
    [opts.checkSpecs, "check-specs", opts.checkSpecsModels],
    [opts.summarizeBenchmark, "text-summarize", opts.summarizeBenchmarkModels],
    [opts.topicsBenchmark, "text-topics", opts.topicsBenchmarkModels],
    [opts.semDedupBenchmark, "text-sem-dedup", opts.semDedupBenchmarkModels],
    [opts.describeBenchmark, "text-describe", opts.describeBenchmarkModels],
  ];
  if (opts.dryRun) {
    const active = subTaskDryRun.find(([on]) => on);
    if (active) {
      const [, task, models] = active;
      console.log(`[dry-run] benchmark: ${task}`);
      if (models.length > 0) {
        console.log(`[dry-run] roster (${models.length} explicit): ${models.join(", ")}`);
      } else {
        console.log(
          "[dry-run] roster: auto-discovered from the live OpenRouter catalog at run time — " +
            "not resolved here, because resolving it is itself a request. Name model id(s) " +
            `after --${task === "security-triage" ? "security-triage --model" : task} to see an exact roster.`,
        );
      }
      // row99 fix-queue item 3: this phase's REAL run reads freeOnly/
      // activeFreeModels (via runXPhase(opts, freeOnly, ...) below) — a
      // dry-run must not look clean when dropping --dry-run would refuse.
      if (dryRunWouldMaskRefusal(opts, settingsFailureCause)) {
        console.log(`the real run would refuse: ${settingsFailureCause}`);
      }
      return {
        ok: true,
        summary: `dry run — ${task} plan printed, no API calls made, $0 spent`,
      };
    }
  }

  // --security-triage routes to the security_scan triage benchmark — a wholly
  // separate task (verdict adjudication, not keyword classification) that reuses
  // the security_scan judge pipeline and gates auto-selection on a pass.
  if (opts.securityTriage) {
    return runSecurityTriagePhase(opts);
  }

  // --scout-accuracy routes to the scout-accuracy benchmark (TRDD-FKAR9VPK D2):
  // probes cheap paid models on the positional fixture and writes the STATIC
  // 'scouting' profile the mass-scout CLI's require gate reads. Zero survivors
  // exits non-zero with the per-candidate best accuracy for retuning.
  if (opts.scoutAccuracy) {
    return runScoutAccuracyPhase(opts);
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

  // The four text-tool benchmark flags route to the summarize/topics/sem_deduplicate/
  // describe single-call benchmarks — each a wholly separate task (concept recall /
  // budget compliance / JSON validity against a hand-curated corpus, not keyword
  // classification), scored deterministically with no LLM judge.
  if (opts.summarizeBenchmark) {
    return runTextToolPhase("summarize", opts.summarizeBenchmarkModels, opts);
  }
  if (opts.topicsBenchmark) {
    return runTextToolPhase("topics", opts.topicsBenchmarkModels, opts);
  }
  if (opts.semDedupBenchmark) {
    return runTextToolPhase("sem_deduplicate", opts.semDedupBenchmarkModels, opts);
  }
  if (opts.describeBenchmark) {
    return runTextToolPhase("describe", opts.describeBenchmarkModels, opts);
  }

  // --auto-replace routes to the cross-tool auto-replacement planner — for every
  // benchmarked tool it checks the incumbent's ledger health and (when degraded
  // or --force) runs that tool's benchmark to recommend the best same-or-cheaper
  // replacement. ADVISORY unless --apply is also passed (the sole writer path).
  if (opts.autoReplace) {
    return runAutoReplacePhase(opts, freeOnly);
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

  const sweep = await runKeywordSweep(opts, freeOnly);
  if (sweep.dryRun) {
    // row99 fix-queue item 3: the default sweep's real run reads freeOnly —
    // see dryRunWouldMaskRefusal's doc comment.
    if (dryRunWouldMaskRefusal(opts, settingsFailureCause)) {
      console.log(`the real run would refuse: ${settingsFailureCause}`);
    }
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
export async function runKeywordSweep(
  opts: CliOptions,
  // Row 92 fix-queue: the cost-safety gate (runner.ts) now takes free_only as an
  // explicit RunnerOptions field instead of a module global — every caller of this
  // sweep resolves its OWN profile's free_only and passes it straight through.
  freeOnly: boolean,
  // P4: --update-all passes a BUDGETED fetch so every keyword call is reserved against
  // the run's spend cap before it is sent. Undefined elsewhere → plain global fetch,
  // i.e. production behavior for every pre-existing caller is byte-for-byte unchanged.
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
  // P5 §2.5 requirement 1/2: when supplied (and `fetchImpl` is not already a budgeted
  // wrapper the caller built itself), every paid call in this sweep is reserved before
  // it is sent and its ACTUAL cost is booked via `ledger`'s `onBook` the moment the
  // response returns — replacing the old post-sweep lump booking, which lost every
  // in-flight call's spend on a mid-sweep crash. Also used below to stop the sweep once
  // the ledger trips (requirement 2), regardless of which of the two params wrapped it.
  ledger?: SpendLedger,
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
  // D0 (TRDD-AL8GIZYA, plan item 2a): discover.ts's DEFAULT_CRITERIA only
  // mirrors the ceiling's DEFAULT (import-cycle leaf-module constraint), so
  // this settings-aware caller must swap in the real, resolved ceiling —
  // same pattern as runPopulatePaidDefaultProfile below — or raising
  // profiles.paid.selection.price_ceiling_usd_per_million would never admit
  // pricier auto-discovered candidates into the keyword sweep.
  const sweepCeiling = getEnsemblePriceCeiling(loadSettings());
  const sweepCriteria: ModelCriteria = {
    ...DEFAULT_CRITERIA,
    maxInputDollarsPerMillion: sweepCeiling,
    maxOutputDollarsPerMillion: sweepCeiling,
  };
  const { candidates: discovered, baselines } = buildBenchmarkRoster(
    categoryModels,
    sweepCriteria,
    opts.includeIds,
    baselineLookup,
    sweepCeiling,
  );
  // Quality-rank the auto-discovered candidates by their catalog codex/design-
  // arena indexes (best first), then optionally restrict to --qualifying-top-n,
  // so the paid keyword benchmark spends its budget on the most-promising
  // candidates first (TRDD-WJND1N2W P2). Baselines (explicit --include) are
  // never reordered or capped — the user asked for those by name.
  const ranked = rankByQualityIndex(discovered);
  // WHY benchFreePool forces 0: --bench-free-pool parks the resolved $0 pool in
  // includeIds (baselines), but buildBenchmarkRoster still auto-discovers PAID
  // candidates from the category=programming list; those made
  // assertPaidBenchmarkAllowed refuse the whole free-pool run ("paid benchmarks
  // are off"). Same remedy runEnsembleSweep uses in free mode: topN 0 empties the
  // auto-discovered list so the roster is exactly the free pool.
  const effectiveTopN = opts.benchFreePool ? 0 : opts.qualifyingTopN;
  const candidates = effectiveTopN !== null ? ranked.slice(0, effectiveTopN) : ranked;
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

  // Global price-cap fail-fast on the AUTO-DISCOVERED candidates only, before
  // any send. USER 2026-09-18 "no, manual is manual" (TRDD-DS6OM3KX): a
  // baseline named explicitly via --include is manual and must NOT be
  // refused for price — only auto-picked candidates are gated. Candidates
  // were already dropped by filterModels via sweepCriteria above, so this is
  // a fail-fast net, not the primary filter.
  assertModelsUnderPriceCap(candidates, sweepCeiling);
  // The keyword sweep is the DEFAULT paid benchmark, so it needs the opt-in too:
  // a paid candidate/baseline without --allow-paid-models-tests refuses, $0 spent.
  assertPaidBenchmarkAllowed(roster.map((r) => r.model));

  // Per-call price lookup for the budgeted fetch below, built from the roster's own
  // catalog prices — no second price source, so the guard can never disagree with
  // what the roster itself already knows a model costs.
  const priceById = new Map<string, ModelPrice>(
    roster.map((r) => [
      r.model.id,
      { inputDollarsPerMillion: r.model.inputDollarsPerMillion, outputDollarsPerMillion: r.model.outputDollarsPerMillion },
    ]),
  );
  const priceOf: PriceLookup = (id) => priceById.get(id);
  // Only wrap here when the caller did not already hand us a budgeted fetch (the
  // --update-all path wraps its own ledger before calling in) — this is what makes
  // requirement 1 real: every paid call now reserves-then-records through `ledger`
  // instead of the sweep reporting one lump sum after it returns.
  const effectiveFetch = fetchImpl ?? (ledger ? makeBudgetedGlobalFetch(ledger, priceOf) : undefined);

  const results = new Map<
    string,
    { model: QualifiedModel; outcome: RunOutcome; score: ModelScore | null; isBaseline: boolean }
  >();

  // Sequential rather than parallel — the benchmark is small, and serialising
  // avoids stacking up rate-limit hits on a single OpenRouter account.
  let skippedForSpendCap = 0;
  for (const { model, isBaseline } of roster) {
    if (ledger?.tripped) {
      // The spend cap tripped on an earlier call this sweep (requirement 2 — for the
      // 'paid' default profile the ledger's cap IS the day's remaining budget, so this
      // is exactly "dailyRemainingUsd() reached 0 mid-run"). The in-flight call that
      // tripped it already finished; every remaining candidate is skipped WITHOUT
      // being sent and recorded as a skip (not a network error) so the report/CLI can
      // say how many were skipped and why.
      skippedForSpendCap++;
      console.error(`[benchmark]   SKIP  ${model.id} — spend cap reached (${ledger.tripped})`);
      results.set(model.id, {
        model,
        outcome: {
          modelId: model.id,
          ok: false,
          error: `spend cap reached: ${ledger.tripped} — skipped, not sent`,
          latencyMs: 0,
        },
        score: null,
        isBaseline,
      });
      continue;
    }
    console.error(`[benchmark] Running ${model.id} …`);
    const outcome = await runBenchmarkOnModel(model, truth.keywords, truth.fixtures, {
      apiKey,
      freeOnly,
      httpReferer: "https://github.com/Emasoft/llm-externalizer-plugin",
      xTitle: "llm-externalizer-benchmark",
      reasoningEffort: opts.reasoningEffort,
      seed: opts.seed,
      fetchImpl: effectiveFetch,
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
  if (skippedForSpendCap > 0) {
    console.error(`[benchmark] spend cap reached — skipped ${skippedForSpendCap} remaining candidate(s), not sent.`);
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
  // D4 review F2: the scope is the sweep's own COST MODE — this shared record
  // point serves main()'s plain benchmark (any profile via --profile, including
  // 'paid'), update-all's ensemble phase, and auto-replace; the caller-passed
  // freeOnly is the one signal all three agree on. A paid sweep skips certain-402
  // rows (the key's credit, not the model); a free sweep records them (the model
  // stopped being free).
  recordGeneralKeywordPasses(parsed.results, timestamp, freeOnly ? "free" : "paid");

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
  // P6b-fix2 B-1 (row99: `active:` reinstated, TRDD-G6XT3AY9): the target is
  // --profile, else `active:` in settings.yaml, else the built-in default —
  // see benchmarkTargetProfile's own doc comment. main() has already refused
  // a generated target before any work ran.
  const profileName = benchmarkTargetProfile(opts.profile);
  if (!settings || !settings.profiles[profileName]) {
    return {
      ok: false,
      code: 2,
      summary: `--update-all needs the profile '${profileName}' in ${settingsPath}, but it is not configured`,
    };
  }
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
      // review of 43e3694 (S5): NO mainRoot override here — update-all's
      // report used to ALWAYS resolve one (resolveMainRoot()), which made
      // writeReport's defaultOutputDir(opts.mainRoot) treat it as an
      // explicit override and skip the LLM_EXT_OUTPUT_DIR env check every
      // real run takes, while --auto-replace's own defaultOutputDir() call
      // (no argument) always honoured it — two commands disagreeing on the
      // same env var. mainRoot is now optional in UpdateAllOptions and left
      // unset here, so the real CLI honours LLM_EXT_OUTPUT_DIR exactly like
      // auto-replace; only a test that injects mainRoot directly still gets
      // an override.
      onProgress: (m) => console.error(`[update-all] ${m}`),
    },
    {
      fetchCatalog: () => fetchProgrammingModels(),
      describeEnsembleWorkload: describeKeywordWorkload,
      runEnsembleSweep: async ({ models, restrictToModels, fetchImpl, topN, freeOnly }) => {
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
        const sweep = await runKeywordSweep(sweepOpts, freeOnly, fetchImpl);
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
          case "text-summarize": {
            const r = await runSummarizeBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          case "text-topics": {
            const r = await runTopicsBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          case "text-sem-dedup": {
            const r = await runSemDedupBenchmark(common);
            return toolRun(r.recommendedModelId, r.changed, r.selection.eligible.length, r.costUsd, r.reportPath);
          }
          case "text-describe": {
            const r = await runDescribeBenchmark(common);
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
  // Row 92 fix-queue: freeOnly is now an explicit required param (matches
  // runKeywordSweep's own signature) — each populate-* caller below already knows
  // its own free_only synchronously (it just called setActiveFreeOnly with it), so
  // there is no reason to route it back through the global for THIS sweep.
  // Optional ledger (P5 §2.5): the 'paid' profile call site passes one so every call
  // this sweep makes books incrementally instead of in one post-sweep lump. Other
  // callers (the free profile) pass none — unaffected, $0 either way.
  runSweep: (sweepOpts: CliOptions, freeOnly: boolean, ledger?: SpendLedger) => Promise<SweepOutcome>;
}

const defaultPopulateDefaultProfileDeps: PopulateDefaultProfileDeps = {
  fetchCatalog: () => fetchProgrammingModels(),
  runSweep: (sweepOpts, freeOnly, ledger) => runKeywordSweep(sweepOpts, freeOnly, undefined, ledger),
};


/**
 * Per-tool model map for a dynamic profile's generated section (design §1.2
 * `tool_models`). No per-command benchmark exists yet for most tools (addendum
 * M), so every registered tool head is the SAME general-ranking pick — this is
 * a NAMED simplification, not silent: the report states it per tool, and each
 * tool upgrades to its own head the day a per-command benchmark exists for it.
 */
function buildToolModels(headModelId: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tool of registeredTools()) map[tool] = headModelId;
  return map;
}

/**
 * `--populate-default-profile NAME` phase. Unlike --update-all (which writes the
 * effective profile plus every registered tool), this sweeps and writes EXACTLY the
 * requested machine-managed profile — 'free', 'paid' or 'local' — and nothing else.
 * `name` is already validated to be one of the three (cli-args.ts's
 * isDynamicProfileName gate) by the time this runs.
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
  // TRDD-C9SXX7HO (D2): 'local' takes neither `deps` (no catalog fetch, no
  // keyword sweep) — it is a local-port probe, not a benchmark, so it is
  // routed here BEFORE the paid call, which would otherwise treat "not free"
  // as "must be paid" and run the OpenRouter pipeline against it.
  if (name === "local") {
    return runPopulateLocalDefaultProfile(settingsPath);
  }
  return runPopulatePaidDefaultProfile(opts, settingsPath, name, deps);
}

/**
 * The 'local' dynamic profile (TRDD-C9SXX7HO): $0, no benchmark, no
 * OpenRouter catalog. Probes the well-known local LLM server ports
 * (local_discovery/scan.ts) and writes exactly what is found — this is why
 * it does not call decideDynamicProfile/setActiveFreeOnly/runSweep at all,
 * unlike its free/paid siblings: there is no price to rank or prune by, and
 * ranking/pruning it by catalog price is exactly what the card forbids.
 *
 * The SAME function backs both `--populate-default-profile local` and the
 * change detector's updater: default-profiles-runner.ts's
 * populateDefaultProfile spawns this exact CLI mode for `local` too (it does
 * not know or care which caller asked).
 */
async function runPopulateLocalDefaultProfile(settingsPath: string): Promise<CliResult> {
  const services = await discoverLocalLlmServices();
  const next = buildLocalProfileSection(services);
  const result = writeDynamicProfileSection(settingsPath, "local", () => next, {
    notify: (msg) => process.stderr.write(`${msg}\n`),
  });
  // `local` has no separate catalog-based maintainer pass to bank this the
  // way free/paid's `maintainOneDynamicProfile` does on every decide — this
  // populate IS the only writer, so it must bank the fingerprint itself, or
  // profile-detector.ts's local detector would compare every future probe
  // against a baseline that never moves (a permanent false "changed").
  //
  // fix-queue 95b/96(4): `lastMaintainedAt` is what `settings status`
  // actually renders ("Dynamic profile 'local' maintained as of ..." vs
  // "not yet maintained" -- index.ts, dynRecord?.lastMaintainedAt) -- this
  // used to stamp only `lastBenchmarkAt`, a DIFFERENT field free/paid's own
  // maintainer writes for a real catalog benchmark, so `settings status`
  // kept saying "not yet maintained" even right after a successful populate.
  // Both fields are stamped by the SAME probe, never a benchmark: `local`
  // has no catalog to benchmark against, only well-known ports to probe
  // (discoverLocalLlmServices above) -- `lastBenchmarkAt` stays for
  // profile-detector.ts's fingerprint-comparison use, `lastMaintainedAt` is
  // the one `settings status` reads.
  updateDynamicProfileRecord("local", (prev) => ({
    lastBenchmarkAt: Date.now(),
    lastMaintainedAt: Date.now(),
    poolFingerprint: localEndpointFingerprint(services),
    modelIds: next.free_models ?? [],
    failCount: 0,
    modelSpecFingerprints: prev?.modelSpecFingerprints,
  }));
  const providerCount = next.providers?.length ?? 0;
  return {
    ok: true,
    summary:
      providerCount > 0
        ? `populate-default-profile local: wrote 'local' (changed=${result.changed}) — ` +
          `${next.model} (+${providerCount - 1} more endpoint(s) in providers)`
        : "populate-default-profile local: no local endpoint detected — 'local' left unpopulated",
  };
}

/**
 * The 'free' dynamic profile: ONE sweep of the zero-cost pool, under the SAME
 * free_only chokepoint --bench-free-pool / --update-all --free already rely on
 * (setActiveFreeOnly + the runner's own runtime guard) — provably $0, never
 * the paid path. The profile is written with the passing pool, best-first:
 * `free` uses freeModels[0] as its head and the rest as the rotation chain
 * (mode: remote), or freeModels[0..2] as the ensemble slots under mode
 * remote-ensemble — see resolveProfile in config.ts. One pool, one profile;
 * P6c-a retired the separate ensemble name that used to share this sweep.
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
  let freeProfile: Profile | undefined;
  try {
    const settings = loadSettings();
    freeProfile = settings?.profiles?.free;
    if (freeProfile) {
      const pool = profileFreeModels(freeProfile);
      if (pool.length > 0) configured = pool;
    }
  } catch {
    /* settings not loadable — FREE_POOL_SEED is still a valid $0 seed */
  }

  // p14.1-c2c, D6a: resolved ONCE, before readCandidates() below, so the SAME
  // lookup both (a) is the routing readCandidates()/pruneUnroutedFreeCandidates
  // prunes the queue against (see dynamic-candidates.ts's readCandidates
  // docstring — this call site now supplies its own instead of letting
  // readCandidates re-derive it) and (b) drives routeServedFreeIds'
  // catalog-lookup bypass right below. One source, one resolveGroups() call,
  // never two disagreeing views of the same profile's routes. readCandidates
  // now REQUIRES a real routesFor function (3c/3e review of 51a100c +
  // 93cc031: the old `null` opt-out silently re-enabled fix-queue row 82) —
  // an always-empty lookup is the correct "no free profile yet" value here.
  // D6a: one resolveGroups() call; routesFor drives both (a) the queue
  // pruning in readCandidates and (b) routeServedFreeIds' catalog-lookup
  // bypass below. An id is route-served-free when ANY group serving it is a
  // free provider (two accounts of one free provider are both $0).
  const routesFor = freeProfile ? resolveGroups(freeProfile).routesFor : (): ResolvedRoute[] => [];

  // Benchmark configured ∪ queued (design §2.4): a candidate the maintainer
  // discovered since the last sweep is judged alongside what's already live,
  // so the ranking reflects newcomers rather than waiting for a second pass.
  const queue = readCandidates(routesFor);
  const queuedIds = queue.free.map((e) => e.id);
  const configuredSet = new Set(configured);
  const candidateIds = [...configured, ...queuedIds.filter((id) => !configuredSet.has(id))];

  // TRDD-38QAM06E root cause 2: resolveFreePool classifies ONLY against the live
  // OpenRouter catalog, so an id served by a `providers[]` route to a DIFFERENT
  // provider (e.g. b.ai's glm-5.3-flash, bound via BAI_PRESET_API) is absent from
  // that catalog and gets rejected outright — even though the route is $0 by
  // construction (ApiPreset.isFreeProvider) and never billable, and is re-pinned
  // below regardless of the sweep outcome. default-profiles.ts's
  // decideDynamicProfile writes the `providers[]` binding into the SAME patch
  // that queues the routed id, so by the time this runs `freeProfile.providers`
  // already carries the route for any queued/configured id that legitimately
  // needs one — this reads that existing route (never re-derives pricing per-id
  // against a second catalog) and excludes route-served ids from the OpenRouter
  // $0 check entirely, so resolveFreePool only ever judges ids it can price.
  const routeServedFreeIds = new Set<string>();
  for (const id of candidateIds) {
    if (routesFor(id).some((r) => r.isFreeProvider)) routeServedFreeIds.add(id);
  }
  const catalogCandidateIds = candidateIds.filter((id) => !routeServedFreeIds.has(id));

  const catalog = await deps.fetchCatalog();
  const { pool: discoveredPool, rejected } = resolveFreePool(catalogCandidateIds, catalog, {
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
    sweep = await deps.runSweep(sweepOpts, true);
  } catch (err) {
    recordBenchmarkFailure("free", Date.now());
    throw err;
  }
  // Verdicts land in the general keyword-sweep ledger EVERY run (pass or fail
  // per model) — validatedModelsForTool (§1.3's resolveModelChain fallback
  // filter) reads it, so a model that just failed cannot re-enter a tool's
  // chain until it passes again.
  recordGeneralKeywordPasses(sweep.results);
  const passing = passingFreePoolIds(sweep.results);
  if (passing.length === 0) {
    recordBenchmarkFailure("free", Date.now());
    clearCandidates("free", queuedIds); // judged (all failed) — don't re-benchmark forever
    return {
      ok: false,
      code: 2,
      summary:
        "--populate-default-profile free: no ':free' model passed the sweep — 'free' profile left unchanged",
      reportPath: sweep.reportPath || undefined,
    };
  }

  // D5 (TRDD-90DM5YHO): the generated b.ai prepend + binding is GONE. The b.ai
  // route is the user's own `providers` group (seeded once by the
  // bai-reserved-seed migration step, never regenerated), and its model rides
  // a reserved slot read by getEnsembleModels — llm-ext no longer writes
  // either into the generated section, so this sweep ranks ONLY the
  // benchmarked OpenRouter ':free' ids it measured. The old comment block
  // here explained why the pin had to live in free_models[0] with its route;
  // that whole mechanism (and the ensemble_pins half-read it depended on) is
  // deleted in this slice.
  const pool = passing;
  const next: Profile = {
    // WHY: validateProfile (config.ts) rejects a free_only remote-ensemble with
    // fewer than 2 members, and the generated section carries no reserved
    // slots. A sweep where one model passes must therefore write "remote",
    // else every command fails the settings check (TRDD-2GIA66AK).
    mode: pool.length >= 2 ? "remote-ensemble" : "remote",
    api: "openrouter-remote",
    api_key: "$OPENROUTER_API_KEY",
    free_only: true,
    free_models: pool,
    // The tool heads stay on the benchmarked OpenRouter winner: `passing` is
    // what this sweep actually measured.
    tool_models: buildToolModels(passing[0]),
    // Under free_only these three are IGNORED — resolveProfile rebuilds them from
    // the pool. Written anyway so `settings show` and a human reading the file
    // see the same three models the runtime will serve.
    model: pool[0],
  };
  if (pool[1]) next.second_model = pool[1];
  if (pool[2]) next.third_model = pool[2];

  // P6b-fix2 S-9: the benchmark child REPLACES the whole section with its own
  // result, so it ignores what is currently there — but it takes the same
  // patch-function shape, so the decision is still applied under the writer's
  // lock rather than against a document parsed before it.
  const result = writeDynamicProfileSection(settingsPath, "free", () => next, {
    notify: (msg) => process.stderr.write(`${msg}\n`),
  });
  const fingerprint = poolFingerprint(qualifyingPool);
  recordBenchmarkSuccess("free", fingerprint, passing, Date.now());
  // P6b-fix B3: the DYNAMIC keyspace gets the benchmark clock too, and only
  // that — the maintainer owns the fingerprints (see recordDynamicBenchmarkAt).
  // Without this, `settings status` and the maintainer's own carry-forward had
  // no lastBenchmarkAt for a dynamic profile at all: this child recorded
  // exclusively into the legacy keyspace, which nothing on the dynamic path reads.
  // P6b-fix2 N-6: this is reached only on the SUCCESS path, so the dynamic
  // record's lastBenchmarkAt means "last SUCCESSFUL population", never "last
  // run" — the four failure paths bank a cooldown via recordBenchmarkFailure
  // instead and deliberately leave this clock alone.
  recordDynamicBenchmarkAt("free", Date.now());
  clearCandidates("free", queuedIds); // judged this sweep, pass or fail — don't re-queue forever

  return {
    ok: true,
    summary:
      `populate-default-profile free: wrote ${passing.length} model(s) to 'free' ` +
      `(changed=${result.changed}) — ${passing.join(", ")}`,
    reportPath: sweep.reportPath || undefined,
  };
}

/**
 * The 'paid' dynamic profile: PAID.
 * Bounded by the SAME worst-case pre-flight estimate + abort that --update-all's
 * paid phase uses (see update-all.ts::runUpdateAll, the "PRE-FLIGHT COST
 * ESTIMATE" step) — computed here over the same requirement-gated,
 * quality-ranked candidate roster runKeywordSweep itself builds (discover.ts's
 * qualify + rankByQualityIndex), so the estimate and the actual roster can
 * never disagree about which models are in play. No second budget system:
 * this reuses update-all.ts's own estimateWorkloadCostUsd.
 */
async function runPopulatePaidDefaultProfile(
  opts: CliOptions,
  settingsPath: string,
  name: "paid",
  deps: PopulateDefaultProfileDeps,
): Promise<CliResult> {
  setActiveFreeOnly(false);

  // `paid` absorbed the retired ensemble/mass-scout profiles (design §1.2 + P5
  // spec item 4): ONE sweep produces the full dynamic `paid` section (top-3
  // ensemble slots, the full ranked pool, and every tool head including
  // mass_scout) in one write.
  // readCandidates now requires a routesFor function (3c/3e, D6a); only
  // queue.paid is read below (the lookup only affects .free pruning), so an
  // always-empty function is correct here — this call never had free-profile
  // routing in scope.
  const queue = readCandidates((): ResolvedRoute[] => []);
  const queuedIds = queue.paid.map((e) => e.id);

  const catalog = await deps.fetchCatalog();
  // USER 2026-09-18 "one ceiling, <=": discover.ts cannot import config.ts
  // (import-cycle leaf-module constraint), so DEFAULT_CRITERIA only mirrors
  // the ceiling's DEFAULT value. This IS the settings-aware caller -- swap in
  // the real, settings-resolved ceiling instead of the fixed $1.00 candidate
  // gate the old DEFAULT_CRITERIA used, so raising
  // ensemble_price_ceiling_usd_per_million actually admits pricier candidates.
  const discoveryCeiling = getEnsemblePriceCeiling(loadSettings());
  const priceCriteria: ModelCriteria = {
    ...DEFAULT_CRITERIA,
    maxInputDollarsPerMillion: discoveryCeiling,
    maxOutputDollarsPerMillion: discoveryCeiling,
  };
  const { candidates: discovered } = buildBenchmarkRoster(catalog, priceCriteria, queuedIds, catalog, discoveryCeiling);
  const ranked = rankByQualityIndex(discovered);
  const candidates = opts.qualifyingTopN !== null ? ranked.slice(0, opts.qualifyingTopN) : ranked;
  if (candidates.length === 0) {
    // Always banked under 'paid' — success is ALSO always banked under 'paid'
    // below, so a single key holds this profile's cooldown/fingerprint state.
    // Splitting success under one key and failure under another would let a
    // successful run never clear an old cooldown, or vice versa — a real
    // state-corruption bug caught in review (it was reachable while three
    // retired names all routed here).
    recordBenchmarkFailure("paid", Date.now());
    return {
      ok: false,
      code: 2,
      summary: `--populate-default-profile ${name}: no candidate model met the requirement gate — nothing to benchmark`,
    };
  }
  // The candidate set the picker will select from — banked on success as the
  // drift-detection baseline for the 'paid' profile.
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
    // Always banked under 'paid' — success is ALSO always banked under 'paid'
    // below, so a single key holds this profile's cooldown/fingerprint state.
    // Splitting success under one key and failure under another would let a
    // successful run never clear an old cooldown, or vice versa — a real
    // state-corruption bug caught in review (it was reachable while three
    // retired names all routed here).
    recordBenchmarkFailure("paid", Date.now());
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
      summary: `dry-run — would sweep ${candidates.length} candidate(s) for the 'paid' default profile; worst case $${estimatedUsd.toFixed(4)}, nothing sent, nothing written`,
    };
  }

  // Crash-safe incremental spend booking (design §2.5, requirement 1): every paid
  // call this sweep makes books its ACTUAL cost into daily-spend.json the moment
  // SpendLedger.record() runs (via `onBook`), so a sweep that crashes mid-way still
  // leaves every completed call's spend on disk — replacing the old post-sweep lump
  // `bookDailySpend(sum of results)`, which booked nothing on a crash. `opts.budgetUsd`
  // is already this run's cap — for the 'paid' profile specifically,
  // default-profiles-runner.ts pre-caps it to the day's remaining budget before
  // spawning this process, so the ledger tripping below IS "the daily cap was reached
  // mid-run" (requirement 2). A MANUAL run (`--populate-default-profile paid` typed
  // by the user) is not pre-capped there — its ledger still books into
  // daily-spend.json but is bounded by --budget-usd alone, because the user asked
  // for it explicitly (requirement 3, unchanged from before).
  let sweep: SweepOutcome;
  try {
    // Constructed INSIDE the try: SpendLedger's constructor throws on a non-finite
    // or negative capUsd, and every other failure path here banks a 'paid' cooldown
    // (see the comment below) — building it outside would let a malformed
    // opts.budgetUsd skip that invariant on this one path (review finding).
    const ledger = new SpendLedger(opts.budgetUsd, { onBook: bookDailySpend });
    sweep = await deps.runSweep(opts, false, ledger);
  } catch (err) {
    // Always banked under 'paid' — success is ALSO always banked under 'paid'
    // below, so a single key holds this profile's cooldown/fingerprint state.
    // Splitting success under one key and failure under another would let a
    // successful run never clear an old cooldown, or vice versa — a real
    // state-corruption bug caught in review (it was reachable while three
    // retired names all routed here).
    recordBenchmarkFailure("paid", Date.now());
    throw err;
  }
  // D4 (D3c-2 review F1): the certain-402 no-verdict skip is PAID-scope — on
  // the paid sweep a 402 is the key's credit; on the free sweep it means the
  // model stopped being free and the ledger must record the fail verdict.
  recordGeneralKeywordPasses(sweep.results, new Date().toISOString(), "paid");

    const ceiling = getEnsemblePriceCeiling(loadSettings());
    const picks3 = pickEnsembleByPriceCeiling(sweep.results, { priceCeilingUsdPerM: ceiling, topN: 3 });
    if (picks3.length === 0) {
      // Always banked under 'paid' — success is ALSO always banked under 'paid'
    // below, so a single key holds this profile's cooldown/fingerprint state.
    // Splitting success under one key and failure under another would let a
    // successful run never clear an old cooldown, or vice versa — a real
    // state-corruption bug caught in review (it was reachable while three
    // retired names all routed here).
    recordBenchmarkFailure("paid", Date.now());
      clearCandidates("paid", queuedIds);
      return {
        ok: false,
        code: 2,
        summary: `--populate-default-profile ${name}: no candidate cleared the $${ceiling.toFixed(2)}/1M price ceiling — 'paid' profile left unchanged`,
        reportPath: sweep.reportPath || undefined,
      };
    }
    // The FULL ranked, ceiling-qualified pool (not just the top 3) — this is
    // `paid_models`, the fallback chain every tool walks past its tool_models
    // head (design §1.3's resolveModelChain).
    const fullPool = pickEnsembleByPriceCeiling(sweep.results, { priceCeilingUsdPerM: ceiling, topN: candidates.length });

    // mass_scout NEVER gets a ':free' id and pickMassScoutModel enforces that by
    // throwing rather than silently falling back — best-effort here: a throw
    // just means mass_scout keeps the general-ranking head like every other
    // tool (buildToolModels's addendum-M simplification), not a failed write.
    // TRDD-FKAR9VPK D6: the mass-scout DISPATCH model comes from the 'scouting'
    // profile / scout-accuracy ledger — this slot is no longer the mass-scout
    // dispatch head (it stays written by the paid maintainer).
    let massScoutModelId: string | undefined;
  try {
    massScoutModelId = pickMassScoutModel(sweep.results).modelId;
  } catch {
    massScoutModelId = undefined;
  }
  const toolModels = buildToolModels(picks3[0].modelId);
  if (massScoutModelId) toolModels.mass_scout = massScoutModelId;

  // TRDD-FDI9NYAS D3c-2 (D2 report Item 9): a sweep row that failed with a
  // CERTAIN payment error is the key's credit, not the model — the id was
  // never judged. Keep every previously-written paid_models id whose row was
  // a certain-402, in its previous relative order (after the freshly ranked
  // pool), so one broke key cannot silently shrink the serving pool its
  // users depend on. model/second/third stay benchmark picks: an unjudged id
  // never heads the chain.
  const certain402Ids = new Set(
    sweep.results
      .filter((r) => r.ok === false && paymentErrorCertainty(r.error ?? "") === "certain")
      .map((r) => r.modelId),
  );

  const next: Profile = {
    // WHY: validateProfile (config.ts) rejects a non-free remote-ensemble
    // without second_model, and rejects second_model/third_model outside
    // remote-ensemble for dynamic profiles. second_model is set only when
    // picks3[1] exists, so the mode must follow it, else a one-pick sweep
    // writes a section the settings check rejects (TRDD-2GIA66AK).
    mode: picks3[1] ? "remote-ensemble" : "remote",
    api: "openrouter-remote",
    api_key: "$OPENROUTER_API_KEY",
    model: picks3[0].modelId,
    paid_models: fullPool.map((p) => p.modelId),
    tool_models: toolModels,
  };
  if (picks3[1]) next.second_model = picks3[1].modelId;
  if (picks3[2]) next.third_model = picks3[2].modelId;

  // P6b-fix2 S-9: same shape as the `free` child above — a full replacement,
  // decided under the writer's own lock. The patch reads the section ON DISK
  // INSIDE the lock (that is what currentSection is for), so the retention
  // above can never race a concurrent maintainer write.
  const result = writeDynamicProfileSection(settingsPath, "paid", (current) => {
    const previous = current?.paid_models;
    const fresh = next.paid_models;
    if (previous && previous.length > 0 && fresh) {
      const freshSet = new Set(fresh);
      const unjudged = previous.filter((id) => certain402Ids.has(id) && !freshSet.has(id));
      if (unjudged.length > 0) next.paid_models = [...fresh, ...unjudged];
    }
    return next;
  }, {
    notify: (msg) => process.stderr.write(`${msg}\n`),
  });
  recordBenchmarkSuccess(
    "paid",
    poolFingerprint(qualifyingPool),
    fullPool.map((p) => p.modelId),
    Date.now(),
  );
  // P6b-fix B3, same as the `free` child above: the benchmark clock, never the
  // fingerprint — the maintainer is the single producer of that.
  // P6b-fix2 N-6: success path only — "last SUCCESSFUL population", not "last
  // run" (see the same note at the `free` child above).
  recordDynamicBenchmarkAt("paid", Date.now());
  clearCandidates("paid", queuedIds);

    return {
    ok: true,
    summary:
      `populate-default-profile ${name}: wrote 'paid' (changed=${result.changed}) — ` +
      `${picks3.map((p) => p.modelId).join(", ")} (+${fullPool.length - picks3.length} more in paid_models)`,
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
 * --scout-accuracy phase (TRDD-FKAR9VPK D2): run the scout-accuracy benchmark
 * and write the STATIC 'scouting' profile. Zero survivors -> non-zero exit
 * with the per-candidate best accuracy (the retune diagnostic).
 */
async function runScoutAccuracyPhase(opts: CliOptions): Promise<CliResult> {
  console.error("[scout-accuracy] mass-scout scouting-profile benchmark");
  let result;
  try {
    result = await runScoutAccuracyBenchmark({
      force: opts.force,
      budgetUsd: opts.budgetUsd,
      onProgress: (m) => process.stderr.write(`[scout-accuracy] ${m}\n`),
    });
  } catch (err) {
    return {
      ok: false,
      code: 2,
      summary: `scout-accuracy failed: ${(err as Error).message}`,
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      code: 2,
      summary: result.summaryLine,
      reportPath: result.jsonReportPath,
    };
  }
  if (result.previousHeadModelId) {
    console.error(
      `[scout-accuracy] replaced existing scouting profile (previous model: ${result.previousHeadModelId})`,
    );
  }
  process.stdout.write(`recommended_model=${result.survivors[0]?.id ?? ""}\n`);
  return {
    ok: true,
    summary: result.summaryLine,
    reportPath: result.jsonReportPath,
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

/** The four text-tool benchmark orchestrators, keyed by tool — one dispatch table
 *  instead of four near-identical phase functions (see runTextToolPhase below). */
const TEXT_TOOL_RUNNERS: Record<
  "summarize" | "topics" | "sem_deduplicate" | "describe",
  (opts: {
    models?: string[];
    force?: boolean;
    onProgress?: (m: string) => void;
  }) => ReturnType<typeof runSummarizeBenchmark>
> = {
  summarize: runSummarizeBenchmark,
  topics: runTopicsBenchmark,
  sem_deduplicate: runSemDedupBenchmark,
  describe: runDescribeBenchmark,
};

/**
 * --summarize-benchmark / --topics-benchmark / --sem-dedup-benchmark /
 * --describe-benchmark phase: assess model(s) on one text-tool's hand-curated
 * corpus (dataset.ts) and recommend the best same-or-cheaper passer. Scoring is
 * DETERMINISTIC: concept recall / character-budget compliance / JSON validity
 * against a hand-authored answer key (score.ts), with NO LLM judge anywhere.
 * Writes JSON + markdown under reports/text-tools-benchmark/<tool>/.
 *
 * ADVISORY by default. With `--apply-profile P` it ALSO persists the winner into
 * P's `tool_models.<tool>` via applyToolModelToSettings — the same atomic,
 * CLI-only writer --auto-replace --apply uses, which MUST NEVER be reachable from
 * an MCP handler (see the guardrail comment at pick.ts:234). One function shared
 * by all four tools — they differ only in which corpus and registry key they use,
 * both of which are already parameterized in bench-runner.ts / registry.ts.
 */
async function runTextToolPhase(
  tool: "summarize" | "topics" | "sem_deduplicate" | "describe",
  models: string[],
  opts: CliOptions,
): Promise<CliResult> {
  const label = tool.replace(/_/g, "-");
  console.error(`[${label}] ${tool} text-tool model benchmark`);
  const runner = TEXT_TOOL_RUNNERS[tool];
  const result = await runner({
    models: models.length > 0 ? models : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[${label}] ${m}`),
  });
  console.error("");
  console.error(`[${label}] ${result.summaryLine}`);
  console.error(`[${label}] spend: $${result.costUsd.toFixed(6)}`);
  console.error(`[${label}] json:   ${result.jsonReportPath}`);
  // stdout carries the machine-grep-able recommendation line.
  process.stdout.write(`recommended_model=${result.recommendedModelId}\n`);

  const base = `${label} benchmark done — recommended ${result.recommendedModelId} (changed=${result.changed}), spend $${result.costUsd.toFixed(6)}`;

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
    const r = applyToolModelToSettings(getSettingsPath(), opts.applyProfile, tool, result.recommendedModelId);
    console.error(`[${label}] applied ${opts.applyProfile}::tool_models.${tool}: ${r.oldModelId || "—"}  →  ${r.newModelId}`);
    console.error(`[${label}] Run the \`reset\` MCP tool or restart Claude Code to pick up the new model.`);
    return {
      ok: true,
      summary: `${base} — applied to '${opts.applyProfile}'::tool_models.${tool}; run \`reset\` to reload`,
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
async function runAutoReplacePhase(opts: CliOptions, freeOnly: boolean): Promise<CliResult> {
  console.error("[auto-replace] cross-tool auto-replacement planner");
  // P6b-fix2 B-1: the planner resolves each tool's INCUMBENT from a profile, and
  // --apply below WRITES to one. They must be the same profile or the
  // recommendation is about a model the write does not touch — the planner's
  // default reader keys on `active:` on its own (row99: `active:` is the
  // live default-profile pointer again, TRDD-G6XT3AY9), so it is named
  // explicitly here with the same rule every write target uses.
  const targetProfile = benchmarkTargetProfile(opts.profile);
  const { findings, reportMarkdown } = await planToolReplacements({
    profileName: targetProfile,
    candidateModels: opts.searchExistingModels.length > 0 ? opts.searchExistingModels : undefined,
    force: opts.force,
    onProgress: (m) => console.error(`[auto-replace] ${m}`),
  });

  // ENSEMBLE half (P1). planToolReplacements only covers tools that own a per-tool
  // selector benchmark; the ensemble slots serve every OTHER tool and had no
  // automated verdict at all — the agent was asked to eyeball "is this 404
  // persistent?". planEnsembleRotation answers that with the ledger's code
  // threshold (assessModelPersistence), so no judgment happens up here.
  // P6b-fix3 B-1': the ensemble half names the SAME profile as the tool half and
  // as --apply's write target. It had no profile parameter at all, so it read the
  // `active:` key on its own — on the shipped config that is "free", which made
  // `--auto-replace --apply --profile ens` take both the rotation verdict
  // (rotationNeeded) and the re-pick arity (topN = ensemble.slots.length, which
  // applyPicksToSettings turns into the written profile's `mode`) from
  // `profiles.free`'s slot health, then write them into `profiles.ens`.
  const ensemble = planEnsembleRotation({ profileName: targetProfile });
  const fullReport = reportMarkdown + "\n" + renderEnsembleRotationSection(ensemble);

  // Persist the advisory report (always — same posture as every other phase).
  // row99c SF6: was join(resolveProjectMainRoot(), "reports", "auto-replace", ...)
  // — a second, un-approved report root outside <project>/reports/llm-externalizer/
  // (USER write-roots rule, 2026-09-18; see project-root.ts's own doc comment).
  // defaultOutputDir() is the single source of truth for that root; route
  // through it instead of hand-rolling resolveProjectMainRoot()+"reports" again.
  const reportPath = join(defaultOutputDir(), "auto-replace", `${compactStamp()}-auto-replace.md`);
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

  // --apply: adopt every changed recommendation, into the SAME profile the
  // planner above resolved the incumbents from — otherwise the write targets a
  // model no health verdict was taken about.
  const settingsPath = getSettingsPath();
  // P6b-fix2 B-1: --profile, else the built-in default. Reading the disk
  // `active:` here pointed --apply's tool_models writes at the generated
  // `free` section on every default install.
  const profileName = targetProfile;
  {
    const settings = loadSettings();
    if (!settings || !settings.profiles[profileName]) {
      return {
        ok: false,
        code: 3,
        summary: `--apply failed: profile '${profileName}' is not configured in ${settingsPath}.`,
        reportPath,
      };
    }
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
    const sweep = await runKeywordSweep(sweepOpts, freeOnly);
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
  // P6b-fix2 B-1: --adopt-profile, then --profile, then the built-in default.
  // The old fallback was the disk `active:` key, which the shipped config sets
  // to the generated 'free' section.
  const profileName = benchmarkTargetProfile(opts.adoptProfile ?? opts.profile);

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

export function buildReportPath(): string {
  // Fix-queue item 29: an isolated run (LLM_EXT_CONFIG_DIR set — every hermetic
  // test, and any CI invocation that wants $0-safe isolation) must never write
  // outside the sandbox it was given. resolveMainRoot() falls back to
  // process.cwd() when CLAUDE_PROJECT_DIR is unset, so a benchmark spawned with
  // cwd = the real repo (the common case for a subprocess test) wrote its
  // markdown report straight into the live repo's reports/benchmark/ even
  // though the run itself was fully isolated otherwise. getConfigDir() already
  // honors LLM_EXT_CONFIG_DIR (see benchmarkCachePath above, same reasoning) —
  // route through it whenever the caller opted into isolation, so an isolated
  // config dir also isolates the report.
  //
  // Write-roots rule (2026-09-18): the non-isolated (production) branch used
  // to join resolveMainRoot() + "reports"/"benchmark" directly, landing at
  // <project-root>/reports/benchmark/ — OUTSIDE every USER-approved write
  // root. Route it through defaultOutputDir() instead (the single approved
  // exception root, <project-root>/reports/llm-externalizer/) and nest
  // "benchmark" under that.
  const reportDir = process.env.LLM_EXT_CONFIG_DIR
    ? join(getConfigDir(), "reports", "benchmark")
    : join(defaultOutputDir(), "benchmark");
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMin);
  const tz = `${offsetSign}${pad(Math.floor(offsetAbs / 60))}${pad(offsetAbs % 60)}`;
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${tz}`;
  return join(reportDir, `${ts}-model-comparison.md`);
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
  // Item 66 — arm the lock release FIRST, before anything that can throw.
  // A detached auto-bench child is handed the lock its parent claimed (and
  // stamped with THIS pid via commitBenchLock); until now nothing deleted that
  // file when the run finished, so every completed population left a lock
  // behind — the P6d dogfood finding. Armed here rather than inside main()
  // because a throw during argv parsing is itself an exit path that must
  // release. Absent env var = a hand-run benchmark, which owns no lock and so
  // must never delete one.
  const ownedLockPath = process.env[BENCH_LOCK_PATH_ENV];
  if (ownedLockPath) releaseOwnBenchLockOnExit(ownedLockPath);
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
