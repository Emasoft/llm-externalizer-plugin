#!/usr/bin/env node
/**
 * LLM Externalizer — MCP Server for LLMs via OpenAI-compatible APIs
 *
 * Supports both local models (LM Studio, Ollama, vLLM) and remote models
 * via OpenRouter. Model and profile configuration is user-only — edit
 * ~/.llm-externalizer/settings.yaml and call the 'reset' tool to reload.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  statSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { extname, join, basename, dirname, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { buildReviewPlan } from "./review-plan.js";
import {
  composeRuleInstructions,
  matchRuleForFile,
  resolveRulesLayers,
} from "./review-rules.js";
import { parseDiffMode, resolveDiffScope, type DiffScope } from "./diff-scope.js";
import { gateFailureMessage, gateLLMResponse } from "./response-gate.js";
import {
  GROUP_HEADER_RE,
  GROUP_FOOTER_RE,
  parseFileGroups,
  hasNamedGroups,
  autoGroupByHeuristic,
} from "./grouping.js";

import {
  MASS_SCOUT_TOOL_NAMES,
  dispatchMassScoutTool,
} from "./mass_scouting/mcp-tools.js";
import { safeReadJson } from "./safe-body.js";
import { buildTools } from "./tools/definitions.js";
import {
  runClusterSynonyms,
  type ClusterSynonymsHooks,
  type ClusterSynonymsInvocation,
} from "./cluster/cluster_synonyms_main.js";
import type { Phase1RawLlmCall } from "./cluster/phase1_batch.js";
import { makePreflightHook } from "./cluster/preflight_benchmark.js";
// session-summary (TRDD-T4MZ8YQR P5). The pipeline (transcript reader,
// chunker, model-select, driver) is frozen from P1-P4; this file only wires
// it to a real model call + real filesystem paths. resolveTranscriptPath /
// defaultCheckpointPath are CLI-surface plumbing, kept OUT of session_summary/
// on purpose (see session-summary-resolve.ts's own header).
import { summarizeSession, DEFAULT_CHUNK_TIMEOUT_MS, type CallModelFn, type ChunkEvent } from "./session_summary/driver.js";
import { untilDoneBackoffMs, looksQuotaCapped } from "./session_summary/until-done.js";
import { formatSizeReport } from "./session_summary/size-report.js";
import { classifyContextOverflow } from "./session_summary/chunker.js";
import { selectModels } from "./session_summary/model-select.js";
import { resolveTranscriptPath, defaultCheckpointPath } from "./session-summary-resolve.js";
// Provider layer (B1 Phase 5a/5b, TRDD-63314265). These modules import NOTHING
// from index.ts — the mutable backend/profile state they need is handed to them
// through the `providerDeps` seam object built below.
import { fetchWithTimeout, RetryDeadlineError, failureText, failureOf } from "./provider/http.js";
import {
  detectLMStudio,
  clearLMStudioProbeCache,
} from "./provider/lmstudio.js";
import {
  chatCompletionJSON,
  chatCompletionWithRetry,
  EXTRACT_PATHS_SCHEMA,
  type JSONCompletionResult,
  type SimpleCompletionOptions,
} from "./provider/completion.js";
// TRDD-OE27RD7I 14.1-C2 §0: profileChain drives the profile's OWN model
// chain (never a foreign profile's) for the single-model completion path --
// see chatCompletionWithProfileFallback below, its only caller.
import {
  profileChain,
  ProfileExhaustedError,
  dynamicProfileRetryLaterMessage,
} from "./profile-fallback.js";
import {
  type BackendConfig,
  type ChatMessage,
  type CompletionDeps,
  type ModelInfo,
  type ReasoningEffortSetting,
  type StreamingResult,
} from "./provider/types.js";
import {
  rateLimitedParallel,
  signalRateLimitHit,
  signalSuccess,
  type ProgressFn,
} from "./rate-limiter.js";
import { fileURLToPath as fileUrlToPath_cs } from "node:url";

// ── File reading / grouping / scanning helpers ───────────────────────
// These pure (stateless) helpers were extracted to ./scan-pipeline.ts so the
// search_existing_implementations pipeline can import them without pulling in
// this file's top-level main() side effects. resolveDefaultMaxTokens stays
// here because it reads getCurrentBackend()/openRouterModelCache (stateful).
import {
  detectLang,
  fenceBackticks,
  sanitizeInputPath,
  readFileAsCodeBlock,
  scanForSecrets,
  scanFilesForSecrets,
  redactSecrets,
  type RegexRedactOpts,
  parseRedactRegex,
  buildPreInstructions,
  resolvePrompt,
  readAndGroupFiles,
  resolveAnswerMode,
  walkDir,
  extractLocalImports,
  BREVITY_RULES,
  FILE_FORMAT_EXAMPLE,
  codeTaskSystemPrompt,
} from "./scan-pipeline.js";
import {
  runSearchExistingImplementations,
  type SeiDeps,
} from "./search-existing/core.js";
import {
  runCheckAgainstSpecs,
  type CheckSpecsDeps,
} from "./check-specs/core.js";
import {
  runScanFolder,
  type ScanFolderDeps,
} from "./scan-folder/core.js";
import {
  runCodeTask,
  type CodeTaskDeps,
} from "./code-task/core.js";
import {
  runDescribe,
  runSemDeduplicate,
  runSummarize,
  runTopics,
  type TextToolsDeps,
} from "./text-tools/core.js";

import type { RetryClock } from "./provider/http.js";

/**
 * Resolve max output tokens for the current model.
 * Uses the model's actual max_completion_tokens from OpenRouter metadata.
 * For reasoning models, this includes the thinking token budget, so it must
 * be the full value — we don't include thinking tokens in the saved output,
 * but they still count against this limit.
 * Falls back to context_length if max_completion_tokens is unavailable.
 */
function resolveDefaultMaxTokens(): number {
  // T2.7 — snapshot once, read consistently
  const backend = getCurrentBackend();
  if (backend.type === "openrouter" && backend.model) {
    const match = openRouterModelCache.find(
      (m) => m.id === backend.model,
    );
    if (match?.top_provider?.max_completion_tokens)
      return match.top_provider.max_completion_tokens;
    if (match?.context_length) return match.context_length;
  }
  return FALLBACK_CONTEXT_LENGTH;
}

// ── Profile-based settings (~/.llm-externalizer/settings.yaml) ───────
// YAML settings file with named profiles, persists across reinstalls.
// Stores per-provider configuration (openrouter, lmstudio, ollama) with
// a single `active` field to switch between them.
// Env vars override settings when present (non-empty).

import {
  type Settings,
  type ResolvedProfile,
  type Profile,
  API_PRESETS,
  isLocalUrl,
  type ResolvedRoute,
  validateSettings,
  settingsLevelErrors,
  resolveProfile,
  loadSettings,
  ensureSettingsExist,
  getSettingsPath,
  getConfigDir,
  generateDefaultSettings,
  isInvalidOnlyBecauseUnpopulated,
  setActiveFreeOnly,
  setActiveRouting,
  setAllowPaidModels,
  getAllowPaidModels,
  shouldForceFreeMode,
  HIGH_QUALITY_MODEL_DEFAULTS,
  buildHighQualityProvider,
  highQualityScanRefusal,
  type HighQualityRequest,
  formatResolvedProfileLines,
  formatActiveProfileSummary,
  formatProfilesList,
  effectiveProfileName,
  isDynamicProfileName,
  type DynamicProfileName,
  DEFAULT_PROFILE_NAME,
  unpopulatedDefaultProfile,
  PLACEHOLDER_MODEL_ID,
  billableForRoute,
  getEnsemblePriceCeiling,
  resolveGroups,
  hasNoTextProfile,
} from "./config.js";
import { readCachedModelPrice } from "./catalog-cache.js";
import { writeDynamicProfileSection, migrateProfileSections, migrateSettingsTo141 } from "./benchmark/pick.js";
import {
  getProfileMigrationStamp,
  stampProfileMigrationDone,
  isMigrationStepApplied,
  markMigrationStepApplied,
} from "./default-profiles-state.js";
// P6b item 1 (design §2.1/§3.3): the dynamic free/paid gate. D2: this file
// no longer runs the maintainer at all -- every profile update happens in a
// detached child (default-profiles-runner.ts's requestProfileUpdate /
// spawnDetachedDetector, profile-detector.ts).
import { dynamicProfileGate, regenerateInvalidMarkedSection } from "./dynamic-maintainer.js";
// C2b-wire + D2: the detached DETECTOR (fired at the end of every dispatch on
// a dynamic profile, never awaited) and the background update a command
// requests when its profile has no working model (never awaited either).
import { spawnDetachedDetector, requestProfileUpdate } from "./default-profiles-runner.js";
// recordRequest moved with the completion layer (B1 Phase 5b) — the per-request
// usage line is written where the request is actually made (provider/completion.ts
// + provider/lmstudio.ts), so index.ts only sets up the usage CONTEXT here.
import {
  calibratedOutputTokens,
  withUsageContext,
  summarizeParams,
} from "./usage-history.js";
import { installUsageRule } from "./rule-install.js";
import { resolveEnsembleModelLimits } from "./ensemble-limits.js";
import { benchmarkFailedModels, benchmarkPassedModels } from "./benchmark/security-triage/index.js";
import { buildCheckImportsExtractMessages } from "./check-imports/prompt.js";
import { compareFilesSystemPrompt } from "./compare-files/prompt.js";
import { isFreeSuffixModelId, paymentErrorCertainty } from "./benchmark/free-mode.js";
import { IRON_RULE_REFUSAL_PREFIX, profileUpdateCanValidate } from "./benchmark/validated.js";
import { applyFreePoolToSettings, addProfileToSettings } from "./benchmark/pick.js";
import {
  discoverLocalLlmServices,
  detectInstalledClis,
  detectSystemInfo,
  formatDiscoveredServices,
  buildProfileForService,
} from "./local_discovery/scan.js";
import {
  reconcileModelsBeforeWork,
  readLastReconcileMs,
  writeLastReconcileMs,
  type ReconcileConfigured,
} from "./model-reconcile.js";
// P6c-a item 5: catalogForReconcile / CatalogPriceSnapshot / loadCachedReport /
// getEnsemblePriceCeiling / getProfileRecord / populateDefaultProfile /
// describeOutcome / defaultProfileLogPath / PopulationOutcome / readModelEvents /
// assessModelPersistence were imported here for maybeEnsureDefaultProfileReady
// ALONE. That function is gone with the retired machine-owned names, and so are
// its imports — the dynamic maintainer owns every one of those reads now.
import { getActiveBillableForModel } from "./config.js";
import { getDynamicProfileRecord } from "./default-profiles-state.js";
import { readCandidates } from "./dynamic-candidates.js";
import {
  AllFreeModelsExhaustedError,
  approvedFreePoolFromSettings,
  callWithFreeRotation,
  combinedFreeModelEvidence,
  classifyUnavailable,
  filterFreeModels,
  getCooldownStore,
  isUnusable,
  logRotation,
  orderByAvailability,
  selectFreeEnsembleModels,
  type RotationCandidate,
  type RotationHooks,
} from "./free-rotation.js";
import {
  fetchOpenRouterModelInfo,
  formatModelInfoMarkdown,
  formatModelInfoTable,
  formatModelInfoJson,
} from "./or-model-info.js";

import { clearEndpointFlavorCache } from "./provider/endpoint-flavor.js";

// Settings path (cross-platform, see config.ts)
const SETTINGS_FILE = getSettingsPath();

// Whether settings are valid (configured by user). If false, all tools except
// discover return an error asking the user to configure settings.yaml.
let settingsValid = false;
let settingsError = "";

/**
 * Whether boot should proceed despite `validation` (validateSettings on the
 * active profile) having FAILED, because the failure is exactly the
 * self-healing "not benchmarked yet" placeholder state of a machine-owned
 * dynamic profile ('free' | 'paid') — never a genuine misconfiguration.
 * Extracted as a pure
 * function (used by the module-load boot IIFE below, which is otherwise hard
 * to unit-test directly) so the decision itself is independently testable.
 */
export function shouldBootDespiteInvalidActiveProfile(
  activeName: string,
  activeProfile: Profile | undefined,
): boolean {
  // isInvalidOnlyBecauseUnpopulated, NOT isUnpopulatedDefaultProfile: the
  // caller DISCARDS the entire error list when this returns true, so the
  // question has to be "are ALL the errors population errors?" and not "is this
  // profile a placeholder?". Keyed on the profile, one self-healing condition
  // suppressed every other rule — a YAML typo in `providers:` booted silently
  // and reported "has not been benchmarked yet".
  return (
    activeProfile !== undefined &&
    isInvalidOnlyBecauseUnpopulated(activeName, activeProfile)
  );
}

/**
 * The ONE verdict "is this settings document usable right now" that boot,
 * reloadSettingsFromDisk, overrideActiveProfile and applyNewSettings must all
 * compute identically (P6c-a2b: fix-queue review S1 + 57). validateSettings'
 * result, THEN the self-healing unpopulated-placeholder exemption
 * (shouldBootDespiteInvalidActiveProfile) -- but the exemption only ever
 * answers a PER-PROFILE question and DISCARDS the whole error list on
 * `true`, so it must never be asked when validateSettings failed for a
 * SETTINGS-level reason it cannot see (S1: a hand-authored section under a
 * RESERVED dynamic name -- config.ts's reservedDynamicProfileNameError).
 * Checking `settingsLevelErrors(settings)` here, once, is what makes EVERY
 * settings-level refusal survive the exemption at every call site instead of
 * only at the one path (profile-migration.test.ts's direct validateSettings()
 * call) that never exercised the exemption at all.
 *
 * Four callers used to answer "is this configured" four different ways --
 * three duplicated the exemption inline (and all three missed the same S1
 * gap), and applyNewSettings answered a WEAKER question entirely: "does the
 * active profile object exist", never validateSettings' actual verdict (57).
 * That let a reload of a document validateSettings had genuinely rejected
 * report itself CONFIGURED, because an invalid profile is still an object.
 * One function, so all four can no longer drift into disagreeing answers.
 *
 * Row 75 (fix-queue): the exemption used to be carved out ONLY for the
 * reserved-name refusal above -- when the active profile was still a
 * placeholder AND validateSettings failed for some OTHER settings-level
 * reason (e.g. appendCapErrors), that OTHER error was still discarded by
 * `shouldBootDespiteInvalidActiveProfile`'s "true -> ignore the whole list"
 * behaviour. That gap is now closed: `settingsLevelErrors` covers every
 * settings-level error validateSettings can produce, so the exemption is
 * carved out ONLY when none of them apply -- no settings-level error is
 * ever discarded through this path anymore.
 */
function evaluateSettingsValidity(
  settings: Settings,
): { valid: boolean; error: string; exempt: boolean } {
  const validation = validateSettings(settings);
  if (validation.valid) return { valid: true, error: "", exempt: false };
  const name = effectiveProfileName(settings);
  const profile = settings.profiles[name];
  // Row 75: never let the per-profile exemption see (and silently discard)
  // ANY settings-level refusal -- ask it only when validateSettings genuinely
  // has none of its own (settingsLevelErrors covers both the reserved-name
  // refusal and the paid_benchmark_daily_cap_usd check).
  const hasSettingsLevelError = settingsLevelErrors(settings).length > 0;
  const exempt =
    !hasSettingsLevelError && shouldBootDespiteInvalidActiveProfile(name, profile);
  return { valid: exempt, error: exempt ? "" : validation.errors.join("; "), exempt };
}

// ── Profile-based startup ────────────────────────────────────────────
// Load settings.yaml, validate active profile, resolve to concrete values.
// ensureSettingsExist() generates default settings.yaml on first run.

let activeSettings: Settings = (() => {
  try {
    const loaded = ensureSettingsExist();
    // P6c-a item 3 (addendum K): the ONE-TIME pre-14.0.0 migration runs HERE —
    // at boot, before validateSettings below and therefore long before the
    // dispatch maintainer. Order is load-bearing twice over: a section it
    // ADOPTS must already carry the generated marker when the maintainer first
    // looks at it (otherwise the maintainer backs the same section up a second
    // time), and validateSettings' reserved-name refusal must not fire on the
    // very file the migration is about to fix.
    //
    // Never throws (see migrateProfileSections); a no-op after its first
    // successful pass, so this costs one state-file read per boot thereafter.
    const migration = migrateProfileSections(getSettingsPath(), {
      notify: (msg) => process.stderr.write(`${msg}\n`),
      readStamp: getProfileMigrationStamp,
      writeStamp: stampProfileMigrationDone,
    });
    // D0 (TRDD-AL8GIZYA): the 14.1.0 migration list runs right after the
    // pre-14.0.0 one, for the same two reasons — a step must see MARKED
    // dynamic sections (writeDynamicProfileSection's per-key generated-key
    // merge assumes that), and a settings-level refusal it fixes (E-D3) must
    // not fire on the very file this migration is about to correct.
    const migration141 = migrateSettingsTo141(getSettingsPath(), {
      notify: (msg) => process.stderr.write(`${msg}\n`),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    if (migration.alreadyDone && migration141.applied.length === 0) return loaded;
    // Re-read: either migration may have deleted, adopted, regenerated or
    // rewritten a section, and `loaded` is the document as it was BEFORE
    // both ran.
    return loadSettings() ?? loaded;
  } catch (err) {
    settingsError = `Failed to load settings: ${err instanceof Error ? err.message : String(err)}\n\nSettings file: ${SETTINGS_FILE}`;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return generateDefaultSettings();
  }
})();
// Publish the master paid-spend switch to config.ts the instant settings load, so
// getAllowPaidModels() is correct for any early reader (tool-schema gen, the boot
// force-free publish in main(), the paid-benchmark guard). Absent ⟺ false = the
// safe/free posture (USER: "only free models are viable, everything free by default").
setAllowPaidModels(activeSettings.allow_paid_models === true);

let activeResolved: ResolvedProfile | null = (() => {
  // effectiveProfileName(), not the raw `activeSettings.active` read: this
  // IIFE runs at module-import time, BEFORE cli/main.ts's guaranteed
  // overrideActiveProfile(profileOverride ?? DEFAULT_PROFILE_NAME) call
  // (item 2) -- its result is a transient best-effort guess, always
  // superseded a moment later. Using the same helper here keeps this guess
  // consistent with everything downstream instead of re-deriving
  // "omitted -> free" locally.
  const targetName = effectiveProfileName(activeSettings);
  // P6c-a2b (fix-queue review S1 + 57): evaluateSettingsValidity is the ONE
  // verdict boot/reloadSettingsFromDisk/overrideActiveProfile/applyNewSettings
  // all compute identically now -- see its docblock. Before this, each of the
  // three call sites re-derived "is this exempt" inline (and all three missed
  // the same S1 gap: a settings-level refusal getting discarded by the
  // per-profile placeholder exemption). One call here means this IIFE cannot
  // silently re-diverge from the other three the way it did before.
  const verdict = evaluateSettingsValidity(activeSettings);
  if (!verdict.valid) {
    settingsError = `${verdict.error}\n\nSettings file: ${SETTINGS_FILE}`;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return null;
  }
  if (verdict.exempt) {
    // A machine-owned dynamic profile ('free' | 'paid') that has never been
    // benchmarked yet is EXPECTED to fail validateProfile
    // (an empty pool / a placeholder model id genuinely cannot serve a
    // request) — that is not a user misconfiguration, it is the self-healing
    // "not populated yet" state. Booting anyway lets the dispatch pre-flight's
    // dynamic maintainer populate it on first real use. Gating boot here on
    // validateProfile's verdict would
    // send every fresh install into NOT CONFIGURED with no path forward. A
    // genuinely misconfigured user profile (any other invalid shape) still
    // falls through to the NOT CONFIGURED branch above, unchanged.
    process.stderr.write(
      `[llm-externalizer] '${targetName}' has not been benchmarked yet — it will populate on first use.\n`,
    );
  }
  settingsValid = true;
  const profile = activeSettings.profiles[targetName];
  const resolved = resolveProfile(targetName, profile);
  // Log auth status on startup so users can verify env vars are picked up
  if (resolved.authToken) {
    process.stderr.write(
      `[llm-externalizer] Auth: token resolved (${resolved.authToken.length} chars)\n`,
    );
  } else {
    const preset = API_PRESETS[profile.api];
    const envRef = preset?.isLocal
      ? profile.api_token || preset.defaultAuthEnv
      : profile.api_key || preset?.defaultAuthEnv;
    if (envRef?.startsWith("$")) {
      process.stderr.write(
        `[llm-externalizer] ⚠ Auth: ${envRef} is NOT set in the environment\n`,
      );
    }
  }
  // Publish free_only to config.ts so the pure subsystem spend sites
  // (judge/scout/benchmark) enforce the cost-safety guard (TRDD-97ef8b63).
  setActiveFreeOnly(resolved.freeOnly);
  // Same chokepoint for route-aware billability (item 1/A1): the pure spend
  // sites derive a model's REAL billable status (routed elsewhere, e.g. b.ai,
  // vs the primary backend) instead of hardcoding `true` (OpenRouter-only
  // assumption that breaks once a model is routed to a non-billable provider).
  setActiveRouting(resolved.routesFor, !resolved.isLocal && !resolved.isFreeProvider);
  // free-pool-auto-bench.ts retired (P6b item 6): this used to fire an
  // unconditional auto-bench at MODULE BOOT, on every invocation including
  // pure status/meta commands (discover/reset/get_settings are NOT skipped
  // here — this runs before dispatchCallToolInner's RECONCILE_SKIP_TOOLS
  // gate even exists for this call), which is how a `settings status` run
  // could spawn a detached child nobody asked for. Population is now the
  // dynamic maintainer's job (dynamic-maintainer.ts's maintainDynamicProfiles,
  // wired at dispatch time and correctly skipped for read-only tools) for
  // 'free'/'paid' — the only profiles this codebase ever populates, and it
  // needs no boot-time kick. P6c-a retired the legacy placeholder trio and
  // maybeEnsureDefaultProfileReady's lazy path along with them; a STATIC
  // profile is never rewritten (Rule 5), so there is nothing else to start.
  return resolved;
})();

/**
 * Test-only accessor for the module-load boot outcome. `settingsValid` /
 * `activeResolved` are private by design (module state, not a public API) —
 * this exists solely so a test can dynamically re-import index.ts against a
 * controlled settings.yaml (via vi.resetModules()) and assert whether boot
 * treated an unpopulated default profile as bootable (Task 1's boot gate)
 * without duplicating the decision logic in the test.
 */
export function __getBootStateForTests(): {
  settingsValid: boolean;
  activeResolved: boolean;
} {
  return { settingsValid, activeResolved: activeResolved !== null };
}

// WHY (TRDD-G6XT3AY9): `active:` is a live selector again -- there is no more
// "raw disk value vs effective value" distinction to snapshot at boot (that
// bookkeeping existed only to feed the P6 deprecation notice, now deleted).
// cli/main.ts's default-profile resolution (`profileOverride ??
// effectiveProfileName(...)`) and display paths (settings show/status) both
// just need the CURRENT in-memory settings, so one plain accessor replaces
// the old raw-snapshot + getter pair.
export function getActiveSettings(): Settings {
  return activeSettings;
}

/** Was the currently-effective profile chosen by an explicit `--profile`
 *  flag, or by the default (no flag given)? Set by overrideActiveProfile's
 *  `source` argument; cli/main.ts is the only caller that passes it. */
let profileSelectionSource: "flag" | "default" = "default";
export function getProfileSelectionSource(): "flag" | "default" {
  return profileSelectionSource;
}

const DEFAULT_OPENROUTER_RPS = 5; // conservative default if balance can't be determined
const DEFAULT_MAX_IN_FLIGHT_REMOTE = 200; // safety cap on total concurrent requests

// Fixed sampling temperature for all models (not user-configurable). Low value
// keeps analysis deterministic and reduces hallucination on code-review tasks.
// (Max-output-tokens fallback is handled separately in resolveDefaultMaxTokens(),
// which requests the model's full context window so output is never artificially
// truncated.)
const DEFAULT_TEMPERATURE = 0.1;

// Appended to ALL system prompts to prevent verbose output that wastes tokens and causes truncation.
// BREVITY_RULES and FILE_FORMAT_EXAMPLE now live in scan-pipeline.ts (imported
// above) so extracted tool cores — which import ZERO from index.ts — can build
// their real system prompts from the same single source.

// codeTaskSystemPrompt now lives in scan-pipeline.ts (imported above), next to
// the BREVITY_RULES / FILE_FORMAT_EXAMPLE it embeds. WHY it moved: the code_task
// BENCHMARK must send byte-for-byte the SAME system prompt the server sends, and
// it cannot import from index.ts (this module runs main() at import time). One
// definition, two importers — a copy would drift the day either is edited.
// Per-LLM-request timeout. Reasoning models (Qwen, etc.) need extended time for thinking.
// The MCP tool-call timeout is inactivity-based, kept alive by heartbeat — no hard cap needed.
// Default: profile timeout (300s). Extended dynamically when reasoning tokens are flowing.
let SOFT_TIMEOUT_MS = (activeResolved?.timeout ?? 300) * 1000;
let FALLBACK_CONTEXT_LENGTH = activeResolved?.contextWindow || 100000;
const MODEL_CACHE_TTL_MS = 3600_000; // 1 hour TTL for OpenRouter model list cache

// ── Request-shaping layer — moved out (B1 Phase 5b, TRDD-63314265) ───
// The reasoning-effort ladder (MODEL_REASONING_CACHE + DEFAULT_REASONING_EFFORT
// + reasoningLadderForModel + the rejection recorder), the per-model
// supported_parameters filter (MODEL_SUPPORTED_PARAMS + FILTERABLE_REQUEST_FIELDS
// + FILTER_WARN_SEEN), and the LLM_EXT_DUMP_REQUESTS audit hook now live in
// ./provider/completion.ts, next to the ONLY three functions that ever touched
// them (chatCompletionSimple / chatCompletionJSON / chatCompletionWithRetry).
// They were verified to have zero readers outside those three, so each cache
// still has exactly ONE owning module — no forked state.
// Per-model request-body overrides live in ./request-overrides.ts (B1 Phase 1);
// completion.ts imports `applyModelOverrides` from there directly.

// ── Backend configuration ────────────────────────────────────────────
// Tracks which backend (local or OpenRouter) is currently active.
// Built from the resolved profile. Mutable — profile switching updates this.

// T2.7 — Snapshot-and-swap pattern. BackendConfig is treated as immutable
// (readonly fields). On reload, a NEW BackendConfig object is built and the
// module-level `currentBackend` reference is replaced in one synchronous
// assignment (single assignment is atomic in JS). Handlers that read more
// than one field MUST snapshot via `getCurrentBackend()` once at the top
// of scope so a mid-flight reload cannot interleave fields from two
// different backends in the same logical operation.
//
// `__version` is monotonic across the process lifetime. Loggers / audits
// can use it to attribute requests to a specific reload generation.
// BackendConfig moved to ./provider/types.ts (B1 Phase 5) — imported above.

// Monotonic reload counter. Incremented every time currentBackend is replaced.
let RELOAD_VERSION = 0;

/** Build a BackendConfig from the active resolved profile */
function makeBackendFromProfile(
  resolved: ResolvedProfile,
  modelOverride?: string,
): BackendConfig {
  const isRemote = resolved.protocol === "openrouter_api";
  return {
    type: isRemote ? "openrouter" : "local",
    // Endpoint-derived, deliberately NOT `isRemote`. A non-local preset that is
    // free by nature (and whose URL was not redirected away from the host the
    // preset vouches for) cannot bill; everything else remote can.
    billable: !resolved.isLocal && !resolved.isFreeProvider,
    // D2 split: the transport-strategy question ("is this endpoint remote,
    // for retry/backoff purposes") is separate from billability — see
    // BackendConfig.isLocal's doc comment.
    isLocal: resolved.isLocal,
    baseUrl: resolved.url,
    apiKey: resolved.authToken,
    model: modelOverride || resolved.model,
    __version: ++RELOAD_VERSION,
  };
}

let currentBackend: BackendConfig = activeResolved
  ? makeBackendFromProfile(activeResolved)
  // No active profile: a localhost placeholder, which cannot bill.
  // isLocal: true — a bare localhost placeholder before any profile
  // resolves, per its own comment above (cannot bill).
  : { type: "local", billable: false, isLocal: true, baseUrl: "http://localhost:1234", apiKey: "", model: "", __version: ++RELOAD_VERSION };

/**
 * Snapshot accessor — returns the current backend reference in one read.
 * Callers MUST destructure / capture via `const backend = getCurrentBackend()`
 * at the top of any scope that touches multiple fields, so a mid-flight
 * reload (watchFile callback) cannot interleave fields from two backends.
 * The returned object is immutable (readonly fields).
 */
function getCurrentBackend(): BackendConfig {
  return currentBackend;
}

// The LM Studio native-API probe cache moved to ./provider/lmstudio.ts with the
// detector that owns it (B1 Phase 5); `clearLMStudioProbeCache` is imported above.

// ── Explicit settings reload ─────────────────────────────────────────
// There is NO file watcher and no poller — one lived here and was deliberately
// removed (see the note further down: "It is GONE… Do not reintroduce a
// module-scope timer, watcher, or open handle"). A manual edit to settings.yaml
// therefore does NOT propagate on its own: it is picked up by the next process,
// or in-process only via `reset` / `--profile`, which call this.

/**
 * Reload settings from disk. Returns true if settings changed and were applied.
 *
 * T2.7 — All new backend state is built into LOCAL variables first, then
 * applied via a single atomic assignment. Intermediate state is never
 * exposed to other handlers. Any caller mid-flight that snapshotted
 * `getCurrentBackend()` will keep its consistent view; new callers will
 * see the new backend via the next `getCurrentBackend()` call.
 */
/**
 * P6b-fix4 Q2: the outcome of a reload, WITH the reason it failed.
 *
 * It used to be a bare boolean, and every caller dropped it — so a rejected
 * document (invalid, or unparseable) left the process judging its stale
 * in-memory copy with no way for the caller to say why, and the only trace was a
 * `⚠` line on stderr that the tool's own output then buried.
 */
export interface SettingsReloadResult {
  ok: boolean;
  /** Empty when ok; otherwise the rejection, ready to quote to the user. */
  error: string;
}

function reloadSettingsFromDisk(): SettingsReloadResult {
  // The parse lives in exactly one place (config.ts's loadSettings) so no
  // top-level key can be dropped here — this function used to hand-rebuild
  // the Settings object from three known keys, which silently discarded any
  // other key on every hot-reload (see the incident this used to document).
  const freshSettings = loadSettings();
  if (!freshSettings) {
    const parseError = "settings.yaml could not be parsed";
    // Say that the EDIT was ignored, not just that a read failed. loadSettings
    // warns on a parse throw but is silent when the file merely parses to a
    // non-object, and either way it cannot know a reload was in progress —
    // without this line the user edits settings.yaml, nothing changes, and
    // nothing explains why.
    process.stderr.write(
      `[llm-externalizer] ⚠ settings.yaml could not be parsed — ignoring change, keeping the previous settings.\n`,
    );
    return { ok: false, error: parseError };
  }
  // WHY (TRDD-G6XT3AY9): preserve the profile THIS invocation is currently
  // using (set at module init, or by cli/main.ts's overrideActiveProfile)
  // across a settings.yaml edit -- a hot reload must not silently switch
  // profiles mid-invocation (Phase 5 design (e) site 7) just because the user
  // edited `active:` on disk while the process was running. `active:` is a
  // live selector for a NEW invocation, not for one already under way.
  const newSettings: Settings = { ...freshSettings, active: effectiveProfileName(activeSettings) };

  // Validate before applying — through evaluateSettingsValidity (P6c-a2b: fix-
  // queue 57 + review S1), the SAME verdict boot/overrideActiveProfile/
  // applyNewSettings compute. This used to re-derive the unpopulated-default-
  // profile exemption inline, missing S1's reserved-name-refusal guard the
  // same way boot did; and applyNewSettings, further down, used to answer a
  // WEAKER question of its own ("does the active profile object exist")
  // instead of trusting this verdict, so a reload the caller had judged
  // exempt-but-invalid could still report itself CONFIGURED for a reason this
  // function had already rejected -- or vice versa. Routing all four through
  // ONE function removes that gap: this is not "stricter than boot", it is
  // the identical predicate boot uses, so a fresh-install unpopulated `free`
  // stays exempt (CONFIGURED) here exactly as it does at boot.
  {
    const verdict = evaluateSettingsValidity(newSettings);
    if (!verdict.valid) {
      process.stderr.write(
        `[llm-externalizer] ⚠ settings.yaml change rejected: ${verdict.error}\n`,
      );
      return { ok: false, error: verdict.error };
    }
  }

  // applyNewSettings always returns true ("the swap was applied"), so there is
  // no error shape to translate here.
  applyNewSettings(newSettings);
  return { ok: true, error: "" };
}


/** Section names regenerated inline in this process (at most once each). */
const inlineRegeneratedThisProcess = new Set<string>();

/**
 * WHY (TRDD-5Q79QZM7): the dispatch gate answers NOT CONFIGURED to every
 * command BEFORE the dynamic maintainer -- the only code that backs up and
 * regenerates a marked generated section that fails validateProfile -- can run
 * (the 2026-10-22 outage). So the same repair (regenerateInvalidMarkedSection,
 * shared with the maintainer) runs inline, once per section per process, when
 * the profile this call uses (free/paid) itself fails validation, and settings
 * are re-evaluated. MEASURED 2026-10-28 on the real broken 2026-10-22 file: the
 * one-model free ensemble itself is now fixed at boot by a migration (reserved
 * slot), so today this path serves other validation failures of a marked
 * section; a missing credential, invalid user-owned keys and unmarked sections
 * are NOT repaired. Returns "" when settings became valid; otherwise one line
 * saying the repair was attempted and why it did not help.
 */
function repairInvalidActiveGeneratedProfile(): string {
  const effective = effectiveProfileName(activeSettings);
  if (effective !== "free" && effective !== "paid") return "";
  // The profile the call will use: overrideActiveProfile (--profile) rewrites
  // activeSettings.active, and effectiveProfileName reads it. The shared repair
  // only acts when THIS profile itself fails validateProfile, so an error that
  // belongs to another profile (classifier, scouting) never triggers a rewrite.
  if (inlineRegeneratedThisProcess.has(effective)) {
    return `Inline repair of '${effective}' was already done once in this process and the section is invalid again; not repeating it.`;
  }
  const current = activeSettings.profiles[effective];
  if (!current) return "";
  let outcome: ReturnType<typeof regenerateInvalidMarkedSection>;
  try {
    outcome = regenerateInvalidMarkedSection({
      name: effective,
      settingsPath: getSettingsPath(),
      current,
      nowMs: Date.now(),
    });
  } catch (err) {
    return `Inline repair of '${effective}' was attempted and failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (outcome.kind === "not-applicable") {
    return `Inline repair of '${effective}' was not applicable (the profile itself passes validation, is unmarked, or the only problem is a missing credential).`;
  }
  if (outcome.kind === "user-keys-invalid") {
    return `Inline repair of '${effective}' was refused: ${outcome.errors.join("; ")} (user-owned keys are never regenerated).`;
  }
  if (outcome.kind === "regenerated") {
    // Latch: a section that stays invalid must not rewrite itself (and add a
    // backup) on every call of this process.
    inlineRegeneratedThisProcess.add(effective);
    process.stderr.write(
      `[llm-externalizer] '${effective}' was invalid (${outcome.errors.join("; ")}) — backed it up to ${outcome.backupPath} and regenerated it.\n`,
    );
  }
  const reload = reloadSettingsFromDisk();
  if (!reload.ok) {
    return `Inline repair of '${effective}' was attempted (${outcome.kind}) but settings are still invalid: ${reload.error}`;
  }
  return "";
}

/**
 * Test-only accessor for reloadSettingsFromDisk -- same "private by design"
 * convention as __getBootStateForTests (see its docblock): lets a test drive
 * the REAL reload path, not a hand-rolled reimplementation of it, after
 * writing a new settings.yaml under the config dir a freshly-imported
 * index.ts is already pointed at.
 */
export function __reloadSettingsFromDiskForTests(): SettingsReloadResult {
  return reloadSettingsFromDisk();
}

/**
 * T2.7 atomic swap, extracted so `reloadSettingsFromDisk` (settings.yaml
 * edited on disk) and `overrideActiveProfile` (CLI `--profile` flag) publish
 * the SAME in-memory state through the SAME sequence — one source of truth
 * for "what does switching the active profile actually update". Caller MUST
 * have already validated `newSettings` (e.g. via `validateSettings`) when
 * `newSettings.active` is non-empty; this function itself never throws on a
 * bad profile — it just falls into the "no active profile configured" branch.
 *
 * Builds all replacement state in LOCAL variables first; nothing is
 * published to module-level state until every value is ready. Always
 * returns true — "the swap was applied", not "the resulting profile is
 * valid" (an empty/misconfigured active profile is itself a valid state to
 * apply, e.g. `active: ""`).
 */
function applyNewSettings(newSettings: Settings): boolean {
  let nextResolved: ResolvedProfile | null = null;
  let nextBackend: BackendConfig | null = null;
  let nextValid = false;
  let nextErr = "";

  // 57 (fix-queue review): settingsValid must track evaluateSettingsValidity's
  // verdict -- the SAME one boot/reloadSettingsFromDisk/overrideActiveProfile
  // already computed before deciding to call this function at all -- never
  // "does the active profile object merely exist". Presence alone let a
  // reload of a document the validator had genuinely rejected report itself
  // CONFIGURED, because an invalid profile is still an object; and it could
  // never reproduce the exemption boot legitimately relies on for a fresh
  // install's placeholder either. The presence guard stays FIRST so
  // `active: ""` (a documented valid state: "no active profile configured",
  // never reached by any current caller but part of this function's
  // contract) still short-circuits to nextErr exactly as before, rather than
  // being silently re-validated against the DEFAULT_PROFILE_NAME fallback
  // effectiveProfileName() would otherwise substitute for it.
  if (newSettings.active && newSettings.profiles[newSettings.active]) {
    const profile = newSettings.profiles[newSettings.active];
    const verdict = evaluateSettingsValidity(newSettings);
    if (verdict.valid) {
      nextResolved = resolveProfile(newSettings.active, profile);
      nextBackend = makeBackendFromProfile(nextResolved);
      nextValid = true;
    } else {
      nextErr = verdict.error;
    }
  } else {
    nextErr = "No active profile configured";
  }

  // T2.7 — Atomic swap section. Each assignment is a single JS statement
  // (atomic between event-loop ticks). The order matters: assign
  // currentBackend LAST so a handler that just snapshotted via
  // getCurrentBackend() and is about to read activeSettings sees a
  // coherent pair.
  activeSettings = newSettings;
  activeResolved = nextResolved;
  // Route-aware billability chokepoint (item 1/A1): keep it in lockstep
  // with activeResolved on EVERY reload, not just boot — a stale route map
  // here would let getActiveBillableForModel answer for the PREVIOUS
  // profile after a live settings reload (mass_scout CLI / scout / judge
  // all read it). Invalid settings (nextResolved null) => empty route map
  // + non-billable, the fail-safe defaults (mirrors makeBackendFromProfile's
  // placeholder).
  setActiveRouting(
    nextResolved?.routesFor ?? ((): ResolvedRoute[] => []),
    nextResolved ? !nextResolved.isLocal && !nextResolved.isFreeProvider : false,
  );
  // Publish the master switch BEFORE recomputing free state so a flipped
  // allow_paid_models takes effect on this reload (clean toggle).
  setAllowPaidModels(newSettings.allow_paid_models === true);
  // Re-publish free state on every reload so the subsystem guard tracks the live
  // profile (TRDD-97ef8b63). publishFreeState recomputes the master-switch force
  // (a clean toggle) AND re-publishes the chokepoint = free_only OR sticky
  // auto-free (preserved across reload — a low-balance session stays free even if
  // the user edits an unrelated key; the wallet is still empty) OR the master
  // switch. null resolved (invalid settings) → not free.
  publishFreeState();
  // free-pool-auto-bench.ts retired (P6b item 6, see the boot-IIFE comment
  // above for the full rationale) — an OFF→ON transition on a dynamic
  // profile is now picked up by the maintainer on the NEXT dispatch (the
  // reload path itself is not a tool dispatch, so it must not spawn work).
  settingsValid = nextValid;
  settingsError = nextErr;
  if (nextValid) {
    cachedRateLimitConfig = null; rateLimitCacheTime = 0;
    openRouterCacheTime = 0;
    // LM Studio detection cache is keyed by baseUrl — if the new backend
    // points at a different baseUrl, the old cache entry is harmless; if
    // it points at the SAME baseUrl, the cached probe result is still
    // valid. We only clear when explicitly told to (via `reset`).
  }
  SOFT_TIMEOUT_MS = (nextResolved?.timeout ?? 300) * 1000;
  FALLBACK_CONTEXT_LENGTH = nextResolved?.contextWindow || 100000;
  // FINAL atomic publish — replace currentBackend in one synchronous statement.
  // After this line, all new getCurrentBackend() calls see the new backend.
  // In-flight callers that snapshotted before this line keep the old one.
  if (nextBackend) currentBackend = nextBackend;
  // No post-reload notification: the CLI resolves tool descriptions fresh on
  // every invocation, so there is no long-lived client to tell about a backend
  // switch (the MCP tools/list_changed hook this replaced had no other caller).
  return true;
}

// P6c-a / TRDD-C9SXX7HO (D2): the old private name→shape switch (a
// `unpopulatedDynamicProfileStub` wrapper around a "free" ? ... : "paid"
// ternary) is GONE — config.ts's `unpopulatedDefaultProfile` is now the ONE
// per-profile table for this, so index.ts calls it directly at the one call
// site below rather than keeping a second copy that would need its own
// `local` arm and could drift from config.ts's.

/**
 * CLI global `--profile <name>` flag: override which settings.yaml profile
 * THIS invocation uses. Reuses the SAME profile map already loaded into
 * `activeSettings` at module init (config.ts's `resolveProfile` /
 * `validateSettings` are the single profile-resolution source — this does
 * not re-implement resolution) and the SAME atomic-swap sequence a
 * settings.yaml edit goes through. Never reads or writes settings.yaml
 * for a STATIC profile: the override is in-memory only and vanishes when
 * the process exits, exactly like every other per-call override (output_dir,
 * free, …). The one exception is `name` naming a DYNAMIC profile
 * ('free'/'paid') absent from settings.yaml -- see the first-run branch below.
 *
 * Must be called AFTER activeSettings is loaded (module init — always true,
 * since this function is only reachable once the module has finished
 * loading) and BEFORE boot()/dispatchCallTool() so getCurrentBackend() and
 * activeResolved reflect the override for the whole invocation.
 *
 * `source` records whether `name` came from an explicit `--profile` flag or
 * the implicit default (cli/main.ts is the only caller that passes it) --
 * read back by getProfileSelectionSource() for settings show/status.
 */
export function overrideActiveProfile(
  name: string,
  source: "flag" | "default" = "default",
): { ok: true } | { ok: false; error: string } {
  profileSelectionSource = source;
  // WHY (TRDD-OE27RD7I 0a regression fix): a COMPLETELY empty profiles map
  // (first run, or a hand-edit that wiped the map to `{}`) has no existing
  // profile for `active:` to meaningfully dangle a reference to -- the
  // G6XT3AY9 dangling-`active:` error is for "used to resolve, now doesn't
  // among real profiles", not for a config file that has never been
  // populated. So when nothing exists yet and the caller did not pin this
  // exact name with an explicit --profile flag, resolve to the built-in
  // default BEFORE the self-heal/dangling checks below judge the raw
  // (possibly garbage) `active:` value -- matches the pre-G6XT3AY9 behaviour
  // this exact first-run scenario always had, and keeps profile.test.ts's
  // "P6 item 2" self-heal case true without weakening case 4's dangling-
  // active-among-real-profiles error (untouched: that scenario's profiles
  // map is non-empty).
  // PF-04: `hasNoTextProfile`, not an empty map: the migration adds the classifier `or-jev` to a file with no profile, and a classifier or scouting profile is not "the user has profiles" for the text-profile self-heal.
  if (source === "default" && hasNoTextProfile(activeSettings.profiles)) {
    name = DEFAULT_PROFILE_NAME;
  }
  if (!activeSettings.profiles[name] && isDynamicProfileName(name)) {
    // First run on a settings.yaml with no free/paid section yet (item 2):
    // persist an unpopulated, marked section through the existing writer
    // (design §2.6) instead of failing "unknown profile" -- the profile then
    // self-heals like every other machine-owned default on first real use.
    try {
      writeDynamicProfileSection(
        getSettingsPath(),
        name,
        // P6b-fix2 S-9: the writer now takes the decision as a function of the
        // section it finds under the lock. This caller only creates a section
        // that is absent, and a section another process created in the
        // meantime is a REAL one — keep it rather than stamp a stub over it.
        (currentSection) => currentSection ?? unpopulatedDefaultProfile(name),
        { notify: (msg) => process.stderr.write(`${msg}\n`) },
      );
      const reloaded = loadSettings();
      if (reloaded) activeSettings = { ...activeSettings, profiles: reloaded.profiles };
    } catch (err) {
      // Never silently swallow -- but also never let a write failure (e.g.
      // an unwritable config dir) hide the ORIGINAL "unknown profile"
      // diagnostic; fall through to the normal error below with this
      // failure appended for context.
      process.stderr.write(
        `[llm-externalizer] failed to create the '${name}' profile: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  const available = Object.keys(activeSettings.profiles);
  if (!activeSettings.profiles[name]) {
    // WHY (TRDD-G6XT3AY9 amendment): the dangling-`active:` error now fires
    // HERE, at selection time, not in validateSettings -- and only when the
    // raw `active:` value is what actually got selected (source === "default"
    // means no --profile was given; `name === activeSettings.active` means
    // it resolved to the key's raw value, not the "missing -> free" fallback).
    // A --profile typo keeps the ordinary "unknown profile" wording; only the
    // settings.yaml defect gets the message naming the key and the value.
    const error =
      source === "default" && activeSettings.active === name
        ? `settings.yaml 'active: ${name}' names a profile that does not exist. ` +
          `Available: ${available.join(", ") || "(none)"}`
        : `unknown profile '${name}'. Available profiles: ${available.join(", ") || "(none)"}`;
    return { ok: false, error };
  }
  const newSettings: Settings = { ...activeSettings, active: name };
  // evaluateSettingsValidity (P6c-a2b: fix-queue 57 + review S1) is the SAME
  // verdict boot/reloadSettingsFromDisk/applyNewSettings compute -- see its
  // docblock. This used to re-derive the self-healing exemption inline (a
  // machine-owned default profile that has never been benchmarked yet is
  // EXPECTED to fail validateProfile -- refusing the override here would turn
  // "no --profile" into a hard failure on every invocation until the
  // maintainer or a manual benchmark populates it), missing the same S1 gap
  // boot and reload did: a settings-level refusal getting silently discarded
  // by that exemption.
  const verdict = evaluateSettingsValidity(newSettings);
  if (!verdict.valid) {
    return { ok: false, error: verdict.error };
  }
  applyNewSettings(newSettings);
  return { ok: true };
}

// The settings.yaml file-watcher lived here. It polled every 5s so a
// long-lived MCP server would pick up manual edits without a restart.
//
// It is GONE, and its removal is load-bearing, not cleanup: `watchFile` runs at
// MODULE SCOPE, so merely importing this file registered a 5-second poller that
// keeps Node's event loop alive forever. A server never noticed. A CLI hangs —
// `llm-ext --help` printed its output and then sat there until killed. Do not
// reintroduce a module-scope timer, watcher, or open handle in this file.
//
// Nothing is lost: every CLI invocation is a fresh process that reads
// settings.yaml at boot, which is strictly fresher than a 5s poll.

// ── OpenRouter model list cache ──────────────────────────────────────

interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
  top_provider?: { max_completion_tokens?: number; context_length?: number };
}

let openRouterModelCache: OpenRouterModelInfo[] = [];
let openRouterCacheTime = 0; // epoch ms when cache was last populated

async function fetchOpenRouterModels(): Promise<OpenRouterModelInfo[]> {
  const now = Date.now();
  // Return cached if still fresh
  if (
    openRouterModelCache.length > 0 &&
    now - openRouterCacheTime < MODEL_CACHE_TTL_MS
  ) {
    return openRouterModelCache;
  }

  if (!activeResolved) throw new Error("No active profile");
  const res = await fetchWithTimeout(`${activeResolved.url}/v1/models`, {
    headers: { Authorization: `Bearer ${activeResolved.authToken}` },
  });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = await safeReadJson<{ data?: unknown }>(res);
  if (!Array.isArray(data.data)) {
    throw new Error(
      "OpenRouter /models returned unexpected shape (data is not an array)",
    );
  }
  openRouterModelCache = data.data as OpenRouterModelInfo[];
  openRouterCacheTime = now;
  return openRouterModelCache;
}

// ── OpenRouter rate-limit detection ──────────────────────────────────
// RPS (requests per second) != concurrency. RPS controls how many NEW requests
// can be started each second. Multiple requests run in-flight simultaneously.
// OpenRouter formula: $1 balance ≈ 1 RPS, capped at 500.
//
// Detection priority:
//   1. Profile explicit max_rps override
//   2. /api/v1/key → rate_limit.requests (if > 0)
//   3. /api/v1/key → derive from limit_remaining (available balance)
//   4. /api/v1/credits → derive from total_credits - total_usage (needs mgmt key)
//   5. Conservative default (DEFAULT_OPENROUTER_RPS)

interface RateLimitConfig {
  rps: number;       // max new requests per second
  maxInFlight: number; // max concurrent requests (safety cap)
}

let cachedRateLimitConfig: RateLimitConfig | null = null;
let rateLimitCacheTime = 0;

/** Derive RPS from dollar balance: $1 = 1 RPS, min 1, max 500 */
function balanceToRps(balance: number): number {
  if (!isFinite(balance) || balance <= 0) return DEFAULT_OPENROUTER_RPS;
  return Math.min(500, Math.max(1, Math.floor(balance)));
}

/** Parse interval string like "10s", "1m", "60s" into milliseconds. Defaults to 1000ms. */
function parseIntervalMs(interval?: string): number {
  if (!interval) return 1000;
  const match = interval.match(/^(\d+)(s|m|ms)?$/i);
  if (!match) return 1000;
  const n = parseInt(match[1], 10);
  const unit = (match[2] || "s").toLowerCase();
  if (unit === "ms") return n;
  if (unit === "m") return n * 60_000;
  return n * 1000; // seconds
}

async function getRateLimitConfig(): Promise<RateLimitConfig> {
  // Local mode: sequential, no rate limiting needed
  if (!activeResolved || activeResolved.mode === "local") {
    return { rps: 1, maxInFlight: 1 };
  }

  const maxInFlight = DEFAULT_MAX_IN_FLIGHT_REMOTE;

  // Return cached value if fresh
  const now = Date.now();
  if (cachedRateLimitConfig && now - rateLimitCacheTime < MODEL_CACHE_TTL_MS) {
    return cachedRateLimitConfig;
  }

  let detectedRps = DEFAULT_OPENROUTER_RPS;

  if (activeResolved.protocol === "openrouter_api") {
    try {
      // Step 1: Query /api/v1/key for rate_limit and balance info
      const keyRes = await fetchWithTimeout(`${activeResolved.url}/v1/key`, {
        headers: { Authorization: `Bearer ${activeResolved.authToken}` },
      });
      if (keyRes.ok) {
        const body = (await keyRes.json()) as {
          data: {
            rate_limit?: { requests?: number; interval?: string; note?: string };
            is_free_tier?: boolean;
            limit?: number | null;
            usage?: number;
            limit_remaining?: number | null;
          };
        };

        const rl = body.data?.rate_limit;
        if (rl?.requests && rl.requests > 0) {
          // API returned explicit rate limit — use it
          const intervalMs = parseIntervalMs(rl.interval);
          // Normalize to per-second: e.g. 20 requests per 10s = 2 RPS
          detectedRps = Math.max(1, Math.floor(rl.requests / (intervalMs / 1000)));
          process.stderr.write(
            `[llm-externalizer] Rate limit: ${rl.requests} req/${rl.interval || "1s"} → ${detectedRps} RPS\n`,
          );
        } else if (body.data?.is_free_tier) {
          // Free tier: very limited
          detectedRps = 2;
          process.stderr.write("[llm-externalizer] Free tier detected → 2 RPS\n");
        } else if (
          body.data?.limit_remaining !== null &&
          body.data?.limit_remaining !== undefined &&
          body.data.limit_remaining > 0
        ) {
          // Derive from remaining balance: $1 ≈ 1 RPS
          detectedRps = balanceToRps(body.data.limit_remaining);
          process.stderr.write(
            `[llm-externalizer] Balance: $${body.data.limit_remaining.toFixed(2)} → ${detectedRps} RPS\n`,
          );
        } else if (body.data?.limit === null) {
          // Unlimited key — try /api/v1/credits for actual balance
          detectedRps = await queryCreditsForRps();
        }
      }
    } catch {
      // Non-fatal — fall through to default
    }
  }

  cachedRateLimitConfig = { rps: detectedRps, maxInFlight };
  rateLimitCacheTime = now;
  return cachedRateLimitConfig;
}

/** Fallback: query /api/v1/credits (requires management key). Returns RPS or default. */
async function queryCreditsForRps(): Promise<number> {
  if (!activeResolved) return DEFAULT_OPENROUTER_RPS;
  try {
    const res = await fetchWithTimeout(`${activeResolved.url}/v1/credits`, {
      headers: { Authorization: `Bearer ${activeResolved.authToken}` },
    });
    if (res.ok) {
      const body = await safeReadJson<{
        data: { total_credits?: number; total_usage?: number };
      }>(res);
      const credits = body.data?.total_credits ?? 0;
      const usage = body.data?.total_usage ?? 0;
      const balance = credits - usage;
      if (balance > 0) {
        const rps = balanceToRps(balance);
        process.stderr.write(
          `[llm-externalizer] Credits: $${balance.toFixed(2)} → ${rps} RPS\n`,
        );
        return rps;
      }
    }
    // 403 = not a management key, or other error — fall through
  } catch {
    // Non-fatal
  }
  return DEFAULT_OPENROUTER_RPS;
}


// ── Fuzzy model matching ─────────────────────────────────────────────
// Scores a query against model IDs so "gpt 4o" resolves to "openai/gpt-4o".

// ── Session-level token accounting ───────────────────────────────────
// Tracks cumulative tokens offloaded across all calls in this session.

const session = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalCost: 0, // Cumulative cost in USD from OpenRouter usage.cost
};

// ── OpenRouter credit-exhaustion bookkeeping ────────────────────────
// Session-level flag that flips to true the first time we hit a 402
// "Payment required" error. TRDD-OE27RD7I addendum 4 (USER, no exceptions:
// "no switching to free models ... must exist anymore"): llm-ext no longer
// switches ANYTHING on this flag. It survives only so highQualityScanRefusal
// (config.ts) can give an accurate refusal message ("credit is exhausted")
// instead of a generic one — pure observability, not a routing decision.
// Cleared only on process restart (no point re-probing a dead wallet for a
// message that only matters within this session).
let creditExhausted = false;

/** The profile's own pinned free_models, copied fresh. NOT an "auto-free
 *  engaged" pool anymore (TRDD-OE27RD7I addendum 4 deleted that mechanism
 *  outright) — this is just the static list a `free_only` profile, or the
 *  allow_paid_models master switch, already draws on. An empty list stays
 *  empty (no FREE_POOL_SEED substitute, Rule 5); FREE_POOL_SEED survives
 *  only as the seed the dynamic `free` benchmark starts FROM. */
export function resolveAutoFreePool(
  profileFreeModels: readonly string[],
): string[] {
  return [...profileFreeModels];
}

/** Which model to force for a single-model subsystem (security_scan /
 *  mass_scout) when the ACTIVE PROFILE is already in free mode — its own
 *  `free_only`, or the allow_paid_models master switch; never an automatic
 *  engagement (TRDD-OE27RD7I addendum 4). Those tools default to a PAID
 *  model and assert ':free' on it (getActiveFreeOnly), so under free mode an
 *  unset or paid `model` arg must be replaced with a ':free' one. Returns
 *  undefined to leave the caller's choice untouched (free mode off, or the
 *  caller already passed a ':free' model). Pure + offline-testable. */
export function resolveSubsystemFreeModel(
  freeActive: boolean,
  freePool: readonly string[],
  requestedModel: string,
): string | undefined {
  if (!freeActive) return undefined; // paid mode — caller's model stands
  if (requestedModel.trim().endsWith(":free")) return undefined; // already free
  // fix-queue 98(2): FREE_MODEL_ID deleted -- an empty in-profile pool is no
  // longer patched with a hard-coded id (Rule 5: never borrow outside the
  // selected profile). Returning undefined here leaves the caller's
  // (unset/paid) model untouched, which the mass-scout/security-scan
  // dispatch path already fails loudly on via its own getActiveFreeOnly
  // assertion downstream -- this is the "refuse" half of the rule, not a
  // silent pass-through.
  //
  // fix-queue P1 follow-up item 3: the assertion cited above is
  // assertFreeOnlyModel (config.ts) -- called as
  // `assertFreeOnlyModel(getActiveFreeOnly(), billable, opts.model)` right
  // before the OpenRouter request in mass_scouting/scout.ts:237 and
  // mass_scouting/cli.ts:1163. getActiveFreeOnly() is kept in sync with
  // isFreeModeActive() (profile free_only OR the allow_paid_models master
  // switch) by publishFreeState() (index.ts, called on boot + every
  // reload), so it fires for BOTH reasons free mode can be active here, not
  // just free_only -- confirmed by reading assertFreeOnlyModel's own body:
  // it throws whenever `freeOnly` is true and the resolved model is
  // billable and not free.
  return freePool[0];
}

// The MASTER SWITCH force-free flag (Settings.allow_paid_models=false).
// RECOMPUTED on every load/reload from the switch + backend, never latched —
// a clean toggle (unlike the deleted sticky auto-free engagement it used to
// sit beside). OR'd into isFreeModeActive(), so every free-routing decision
// already gated on "free_only OR master switch" honours it too, with no
// per-site latch.
let forceFreeByMasterSwitch = false;

/** Enumerate `profile`'s own model chain (profileChain) and return its
 *  first `:free`-suffixed entry, or undefined when it has none. Pure and
 *  offline: profileChain is a generator that never makes a request, so
 *  driving it to exhaustion here (never feeding it a failure) just reads
 *  the list it would walk, in the SAME order chatCompletionWithProfileFallback
 *  drives it in (fix-queue 98(2) — one definition of "the profile's chain",
 *  not a second copy that could disagree on order). */
function firstFreeIdInChain(profile: ResolvedProfile): string | undefined {
  const gen = profileChain(profile);
  try {
    let step = gen.next();
    while (!step.done) {
      // fix-queue P1 follow-up: a free_only profile (the built-in `free`
      // profile, or any profile marked free_only) is $0 by construction --
      // every chain entry is free even when a route-served id has no
      // `:free` suffix (the b.ai-only leg's first/only slot has none, e.g.
      // `env -u OPENROUTER_API_KEY`). The suffix test is a cost-safety gate
      // for a NON-free_only profile only, where a paid id could sit in the
      // chain -- applying it to a free_only profile produced a wrong
      // refusal of the one profile that is free by construction. Uses the
      // project's single suffix predicate (isFreeSuffixModelId), never a
      // second inline `.endsWith(":free")`.
      //
      // adversarial review follow-up (p14.1 r92/p1fu item 1): this trusts
      // profile.freeOnly with NO per-id check here on PURPOSE, because TWO
      // guards already sit downstream of it:
      //  1. Boot-time: dispatchCallToolInner refuses every tool except
      //     discover/reset/get_settings/profile/list_profiles/
      //     scan_local_llm_services while the `settingsValid` gate is false,
      //     and settingsValid is recomputed from validateSettings ->
      //     validateProfile's free_only pool check, which rejects a
      //     free_models entry that is neither `:free`-suffixed nor served
      //     by a non-billable `providers[]` route (billableForRoute) -- a
      //     profile mismarked free_only with a billable entry never
      //     becomes active at all.
      //  2. Per-request: resolveConnection, the "single point every
      //     request's model flows through" per its own doc comment, calls
      //     assertFreeOnlyModel(deps.isFreeOnly(), billable, model,
      //     route.isFreeProvider) on EVERY send -- billable computed from
      //     the model's OWN route (`!route.isLocal && !route.isFreeProvider`),
      //     so a billable id chosen here would still be refused before the
      //     wire even if guard 1 were somehow bypassed (e.g. a reload
      //     raced past validation).
      // See the "mismarked free_only profile" test in index.test.ts (guard
      // 1) -- guard 2's exact scenario (free_only, non-billable ROUTE,
      // non-suffix model) is already pinned by name in free-only.test.ts as
      // "ALLOWS any id from a free-by-nature provider" (assertFreeOnlyModel(
      // true, false, "glm-5.3-flash", true)), read directly rather than
      // inferred from the file existing.
      //
      // row 100: a chain entry served by a NON-BILLABLE route (local, or a
      // free-by-nature provider) is free for this walk exactly like a
      // free_only entry is, even outside a free_only profile -- the `local`
      // dynamic profile is $0 by construction just like `free`, so its own
      // model must not need a `:free` suffix it will never carry. Reuses
      // billableForRoute (config.ts), the SAME decider resolveConnection's
      // `billable` uses, so this can never drift from what actually gets
      // billed; never a second inline `!route.isLocal` check.
      // D6a: the walk now yields (id, route) entries; the ENTRY's own route
      // is the one about to be used, so billability is judged on it — not on
      // the first-serving-group lookup, which under multi-group serving
      // could name a different account than the one about to send.
      const nonBillableRoute = !billableForRoute(
        step.value.route,
        !profile.isLocal && !profile.isFreeProvider,
      );
      if (profile.freeOnly || isFreeSuffixModelId(step.value.modelId) || nonBillableRoute) {
        return step.value.modelId;
      }
      step = gen.next();
    }
  } catch (err) {
    // profileChain throws ProfileExhaustedError once the walk is exhausted
    // (its own documented contract) -- that IS "no more entries", not a
    // real error to propagate; anything else is a genuine bug.
    if (!(err instanceof ProfileExhaustedError)) throw err;
  }
  return undefined;
}

/**
 * Decide which model (if any) to force for a given tool invocation.
 *
 * TRDD-OE27RD7I addendum 4 (USER, no exceptions) deleted the
 * balance-check-to-free switch, the credit-exhausted-session auto-fallback,
 * and the low-balance-threshold env override that used to tune it — no
 * cross-profile switch, no env opt-out, the selected profile is fixed for
 * the whole command. The ONLY override left: an explicit caller `free: true`,
 * which now resolves to the SELECTED profile's own first `:free` chain entry
 * (fix-queue 98(2) — never a hard-coded id outside the profile) and refuses
 * with a named remedy when it has none. Anything else proceeds through the
 * resolved profile's own chain unchanged (chatCompletionWithProfileFallback).
 */
function resolveModelOverride(
  freeRequested: boolean,
): string | undefined {
  if (!freeRequested) return undefined;
  // fix-queue 98(2): FREE_MODEL_ID deleted -- an explicit `free: true` no
  // longer pins one hard-coded id outside the selected profile (Rule 5, USER
  // addendum 4 "no exceptions"). It now resolves to THIS profile's own
  // first `:free` entry in its own chain order (profileChain, the same
  // walk chatCompletionWithProfileFallback drives) -- and refuses with a
  // named remedy when the profile has none, rather than silently borrowing
  // a model the profile never listed.
  if (!activeResolved) {
    throw new Error(
      "free flag: no resolved profile is active -- fix settings.yaml and retry",
    );
  }
  const freeId = firstFreeIdInChain(activeResolved);
  if (!freeId) {
    // fix-queue P1 follow-up: telling a caller already on a free_only
    // profile (e.g. the built-in `free` profile) to "use --profile free"
    // is a wrong remedy for its own refusal -- the only way a free_only
    // profile lands here is an EMPTY chain (firstFreeIdInChain accepts its
    // first entry unconditionally), so the fix is to populate that chain,
    // never to switch profiles.
    //
    // row 100: a validated `mode: local` profile's `model` field is
    // required (validateProfile rejects free_only+local, and a bare model
    // is required unless free_only) and firstFreeIdInChain's non-billable-
    // route branch (above) now accepts that head model unconditionally, so
    // a VALID local profile can never actually reach this branch -- there
    // is no separate "local" remedy to name here. Adversarial review of
    // this diff found an earlier version added one anyway with no fixture
    // that could reach it (validateProfile makes it unreachable); removed
    // rather than ship untested dead code.
    const remedy = activeResolved.freeOnly
      ? `profile '${activeResolved.name}' (free_only) has an empty model chain -- add a model to its pool`
      : `profile '${activeResolved.name}' has no ':free' model in its chain -- use --profile free, or add a ':free' model to this profile`;
    throw new Error(`free flag: ${remedy}`);
  }
  return freeId;
}

/**
 * The mass-scouting pre-flight (TRDD-542bdbef Phase 2 / TRDD-W9DK4L3N):
 * return the ':free' model to substitute for `requestedModel` when the
 * active profile is ALREADY in free mode — or `undefined` to leave the
 * caller's choice untouched (free mode inactive, or the caller already asked
 * for a ':free' model). No auto-engagement step (TRDD-OE27RD7I addendum 4
 * deleted it): isFreeModeActive()/activeFreePool() read only the profile's
 * own static free_only flag and the master switch now, never a
 * balance/402-triggered one.
 *
 * Extracted out of `dispatchCallToolInner`'s MASS_SCOUT_TOOL_NAMES branch so
 * it is the ONE place this decision is made; `llm-ext` catalog dispatch
 * below is the only caller. Kept as one exported decision so a second,
 * drifting copy never appears at another call site.
 */
export async function resolveMassScoutFreeModelOverride(
  requestedModel: string,
): Promise<string | undefined> {
  return resolveSubsystemFreeModel(
    isFreeModeActive(),
    activeFreePool(),
    requestedModel,
  );
}

// ── Active request tracking ─────────────────────────────────────────
// Tracks in-flight LLM requests so `reset` can wait for them to drain.
let _activeRequests = 0;
let _activeRequestsDrained: (() => void) | null = null;

/** Call before starting an LLM request */
function trackRequestStart(): void {
  _activeRequests++;
}

/** Call after an LLM request completes (success or error) */
function trackRequestEnd(): void {
  _activeRequests = Math.max(0, _activeRequests - 1);
  if (_activeRequests === 0 && _activeRequestsDrained) {
    _activeRequestsDrained();
    _activeRequestsDrained = null;
  }
}

/** Returns a promise that resolves when all active requests have completed */
function waitForRequestsDrained(timeoutMs: number = 120_000): Promise<void> {
  if (_activeRequests === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Timeout — resolve anyway to avoid hanging forever
      _activeRequestsDrained = null;
      resolve();
    }, timeoutMs);
    _activeRequestsDrained = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ── Session logging ─────────────────────────────────────────────────
// Each session gets a unique hash. Logs are JSONL files in llm_externalizer/logs/.
// Each entry records per-request tokens/cost and cumulative session totals.

const SESSION_ID = randomUUID().slice(0, 8);
const SESSION_START = new Date();

// Session logs live in ~/.llm-externalizer/logs/ so they persist across reinstalls/npx
const LOG_DIR = join(getConfigDir(), "logs");
const LOG_FILE = join(
  LOG_DIR,
  `session-${SESSION_ID}-${SESSION_START.toISOString().slice(0, 10)}.jsonl`,
);

interface LogEntry {
  timestamp: string;
  tool: string;
  model: string;
  status: "success" | "error" | "truncated";
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number; // Per-request cost in USD from OpenRouter (0 if not available)
  cumulative_tokens: number;
  cumulative_cost: number;
  file_path?: string;
  error?: string;
}

function writeLogEntry(entry: LogEntry): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never crash the MCP — silently ignore write failures
    process.stderr.write(`[llm-externalizer] Failed to write log entry\n`);
  }
}

// ── Live stats file for statusline consumption ──────────────────────
// Written atomically on every request so the statusline script can poll it.
const STATS_FILE = "/tmp/claude/llm-externalizer-stats.json";

function writeStatsFile(): void {
  try {
    mkdirSync("/tmp/claude", { recursive: true, mode: 0o700 });
    // T2.7 — snapshot backend once for atomic (model, type) tuple
    const backend = getCurrentBackend();
    const stats = {
      session_id: SESSION_ID,
      session_start: SESSION_START.toISOString(),
      updated: new Date().toISOString(),
      calls: session.calls,
      total_tokens: session.promptTokens + session.completionTokens,
      prompt_tokens: session.promptTokens,
      completion_tokens: session.completionTokens,
      total_cost: session.totalCost,
      model: backend.model ?? "",
      backend: backend.type,
    };
    // Atomic write: temp file + rename to prevent partial reads
    const tmpStats = STATS_FILE + ".tmp";
    writeFileSync(tmpStats, JSON.stringify(stats), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpStats, STATS_FILE);
  } catch {
    // Stats file must never crash the MCP
  }
}

/**
 * Log a completed request (success, error, or truncated).
 * Call AFTER recordUsage() so cumulative totals are up-to-date.
 */
function logRequest(opts: {
  tool: string;
  model: string;
  status: "success" | "error" | "truncated";
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    cost?: number;
  };
  filePath?: string;
  error?: string;
}): void {
  const promptTok = opts.usage?.prompt_tokens ?? 0;
  const completionTok = opts.usage?.completion_tokens ?? 0;
  const totalTok = opts.usage?.total_tokens ?? promptTok + completionTok;
  const cost = opts.usage?.cost ?? 0;

  writeLogEntry({
    timestamp: new Date().toISOString(),
    tool: opts.tool,
    model: opts.model,
    status: opts.status,
    prompt_tokens: promptTok,
    completion_tokens: completionTok,
    total_tokens: totalTok,
    cost,
    cumulative_tokens: session.promptTokens + session.completionTokens,
    cumulative_cost: session.totalCost,
    file_path: opts.filePath,
    error: opts.error,
  });
}

function recordUsage(usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  cost?: number;
}) {
  session.calls++;
  if (usage) {
    session.promptTokens += usage.prompt_tokens;
    session.completionTokens += usage.completion_tokens;
    // OpenRouter returns cost in USD in the usage object
    if (typeof usage.cost === "number") {
      session.totalCost += usage.cost;
    }
  }
  // Update the live stats file for the statusline to read
  writeStatsFile();
}

// Reject any header value containing control characters (CR, LF, NUL, etc.).
// A multi-line api_key — e.g. accidentally pasted as a YAML `>-` block or
// extracted from a PEM file via pbpaste — would otherwise smuggle additional
// headers into outbound requests when interpolated below.
function assertSafeHeaderValue(name: string, v: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: reject CR/LF/NUL etc. in header values (CR/LF injection defense, see comment above).
  if (/[\x00-\x1f\x7f]/.test(v)) {
    throw new Error(
      `Refusing to send ${name} containing control characters (CR/LF/etc.) — check your settings.yaml for a multi-line api_key.`,
    );
  }
  return v;
}

function apiHeaders(): Record<string, string> {
  // T2.7 — snapshot once. apiKey + type read consistently.
  const backend = getCurrentBackend();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (backend.apiKey)
    h["Authorization"] = `Bearer ${assertSafeHeaderValue("Authorization", backend.apiKey)}`;
  // OpenRouter requires HTTP-Referer and X-Title headers for ranking/attribution
  if (backend.type === "openrouter") {
    if (activeResolved?.httpReferer)
      h["HTTP-Referer"] = assertSafeHeaderValue("HTTP-Referer", activeResolved.httpReferer);
    if (activeResolved?.appName)
      h["X-Title"] = assertSafeHeaderValue("X-Title", activeResolved.appName);
  }
  return h;
}

/** Test-only export of routeHeaders (routeHeaders itself stays private/unexported,
 *  matching this file's "private by design" convention — see __getBootStateForTests
 *  above for the same pattern). Exists because the empty-authToken branch (no
 *  Authorization key at all) and the protocol-gated attribution headers were only
 *  ever exercised through a MOCK in connection.test.ts, never the real function. */
export function __routeHeadersForTests(route: ResolvedRoute): Record<string, string> {
  return routeHeaders(route);
}

/** Test-only exports of getEnsembleModels/activeFreePool --
 *  same "private by design" convention as __getBootStateForTests /
 *  __routeHeadersForTests above. TRDD-90DM5YHO P3: needed to unit-test the
 *  DYNAMIC-profile ensemble substitution (item 2) and Rule 5's static-profile
 *  refusal (item 4) directly, against a controlled settings.yaml + a fresh
 *  module re-import (mirrors route-headers.test.ts's loadFreshIndex).
 *  __engageAutoFreeForTests was deleted alongside engageAutoFree itself
 *  (TRDD-OE27RD7I addendum 4 -- no auto-free engagement left to drive). */
export function __getEnsembleModelsForTests(): Array<{
  id: string;
  maxOutput: number;
  maxInputLines: number;
  route?: ResolvedRoute;
}> {
  return getEnsembleModels();
}
export function __activeFreePoolForTests(): string[] {
  return activeFreePool();
}
// D3c-1 fix-up (TRDD-FDI9NYAS): same "private by design" convention as the
// exports above -- buildFreeRotationPool had no test-only export, so its own
// `benchmarkPassedModels() ∪ manualModels` union (the SERVING gate, distinct
// from getEnsembleModels' own copy of the same expression) could only be
// exercised indirectly through dispatchCallTool, where an EMPTY result
// silently falls back to chatCompletionWithProfileFallback's chain walk
// (ensembleStreaming's own "funded, non-ensemble, non-pool call" branch) --
// a different code path with no benchmark-pass requirement at all, which
// would prove the wrong thing. This calls the real function directly.
export function __buildFreeRotationPoolForTests(fileLineCount?: number): string[] {
  return buildFreeRotationPool(fileLineCount).map((m) => m.id);
}
/** The verdict classifyError gives a per-file failure. */
interface ErrorClassification {
  unrecoverable: boolean;
  serviceLevel: boolean;
  reason: string;
  /** Final for this file (never retried) yet still a FAILED outcome: the
   *  per-file loops must feed it to the "3 of the last 3 completions failed"
   *  window, which only the retried-then-exhausted path used to do. Set for a
   *  closed retry window (RetryDeadlineError). */
  countsAsFailure?: boolean;
}

/** Record one failed file outcome in the sliding window the per-file loops
 *  keep; true when the last three completions all failed. */
function recordFailedOutcome(recentOutcomes: boolean[]): boolean {
  recentOutcomes.push(false);
  return recentOutcomes.length >= 3 && recentOutcomes.slice(-3).every((v) => !v);
}
/** Test-only export of classifyError (TRDD w2-honest-402) -- same "private by
 *  design" convention as the exports above. Lets a test drive the REAL
 *  classifier with a REAL Error produced by a REAL HTTP 402 (via
 *  chatCompletionSimple against a local server), isolated from the unrelated
 *  retry/fallback policies chatCompletionWithRetry layers on top. */
export function __classifyErrorForTests(error: unknown): ErrorClassification {
  return classifyError(error);
}


/**
 * Test-only export of the round-C item-4 single-model abort guard — same
 * "private by design" convention as __classifyErrorForTests above.
 */
export function __ensureNotServiceAbortForTests(resp: StreamingResult): StreamingResult {
  return ensureNotServiceAbort(resp);
}

/**
 * Headers for ONE route of a multi-provider profile — its own key, its own
 * attribution. Deliberately NOT apiHeaders(), which reads the primary backend:
 * using that for a routed model would send the wrong vendor's credential.
 *
 * The OpenRouter attribution headers are keyed off the ROUTE's protocol, so a
 * b.ai route does not get HTTP-Referer/X-Title (meaningless there), and an
 * OpenRouter route still does even when the profile's primary is b.ai.
 */
function routeHeaders(route: ResolvedRoute): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (route.authToken)
    h["Authorization"] = `Bearer ${assertSafeHeaderValue("Authorization", route.authToken)}`;
  if (route.protocol === "openrouter_api") {
    if (activeResolved?.httpReferer)
      h["HTTP-Referer"] = assertSafeHeaderValue("HTTP-Referer", activeResolved.httpReferer);
    if (activeResolved?.appName)
      h["X-Title"] = assertSafeHeaderValue("X-Title", activeResolved.appName);
  }
  return h;
}

// ── Provider seam (B1 Phase 5a/5b, TRDD-63314265) ────────────────────
// The provider modules (connection.ts, lmstudio.ts, http.ts, completion.ts) must
// not import index.ts, so the backend/profile state they need is handed to them
// through this ONE object. EVERY stateful field is a FUNCTION, not a captured
// value, for two independent reasons:
//
//   1. RELOAD. `currentBackend`, `activeResolved` and `SOFT_TIMEOUT_MS` are all
//      reassigned on a settings reload. A value captured here at module-init
//      would pin the provider layer to the pre-reload generation forever, and
//      the `reset` tool would silently keep talking to the old endpoint/model.
//   2. TDZ. Several fields read state declared LATER in this file than this
//      object literal; the arrow defers the read to call time.
//
// `getFreeModelId()` / `engageAutoFree()` were deleted from CompletionDeps here
// (TRDD-OE27RD7I 14.1-C2c-ENV): completion.ts never called either (see that
// file's own module comment). FREE_MODEL_ID itself is ALSO gone now
// (fix-queue 98(2)) -- resolveModelOverride's only remaining caller resolves
// the selected profile's own chain instead, and classifyError never
// referenced the constant.
// Grep gate: both are 0 hits in src outside a comment or a test asserting absence.
const providerDeps: CompletionDeps = {
  getBackend: () => getCurrentBackend(),
  apiHeaders: () => apiHeaders(),
  // Read through activeResolved on EVERY call, never captured — a settings
  // reload replaces the profile, and a stale route table would keep sending to
  // the provider the user just removed.
  routeForModel: (model: string) => activeResolved?.routeForModel(model) ?? null,
  routeHeaders: (route) => routeHeaders(route),
  getSoftTimeoutMs: () => SOFT_TIMEOUT_MS,
  isFreeOnly: () => activeResolved?.freeOnly ?? false,
  isLMStudioProvider: () => activeResolved?.protocol === "lmstudio_api",
  // TRDD-FDI9NYAS D3b: read through activeResolved on EVERY call, same reload
  // reason as routeForModel above — a stale manualModels set would keep
  // exempting an id from a profile the user just switched away from.
  isManualModel: (model: string) => activeResolved?.manualModels?.has(model) ?? false,
  // TRDD-FDI9NYAS D3c: reads the on-disk catalog cache synchronously (no live
  // fetch per send) — see readCachedModelPrice's own doc for why this file,
  // not the in-memory openRouterModelCache (which is only warm after a call
  // that happened to list models; the disk cache is kept warm by the
  // detached per-dispatch detector regardless of what the current command is).
  getModelPricePerMillion: (model: string) => readCachedModelPrice(model),
  // Read through loadSettings-backed activeSettings on EVERY call, same
  // reload-safety reason as isManualModel above.
  getEnsemblePriceCeilingUsd: () => getEnsemblePriceCeiling(activeSettings),
  defaultTemperature: DEFAULT_TEMPERATURE,
  getDefaultMaxTokens: () => resolveDefaultMaxTokens(),
  getActiveProtocol: () => activeResolved?.protocol ?? "openai_api",
};

// The completion layer — chatCompletionSimple / chatCompletionJSON /
// chatCompletionWithRetry, the reasoning ladder, the supported-params filter and
// the SERVICE_HEALTH circuit breaker — moved to ./provider/completion.ts
// (B1 Phase 5b). resolveConnection() → ./provider/connection.ts; fetchWithTimeout /
// fetchWithRetry429 / computeBackoffMs / sanitizeProviderError → ./provider/http.ts;
// the LM Studio native block → ./provider/lmstudio.ts; the OpenAI-compat wire types
// → ./provider/types.ts. All four are called with `providerDeps`.

// ── Progress reporting ───────────────────────────────────────────────
// This used to emit MCP `notifications/progress` to keep a long-lived client
// connection from timing out. There is no client any more — but the need it
// served is REAL and got worse: `mass_scout` / `security_scan` run for tens of
// minutes, and a CLI that prints nothing for that long is indistinguishable
// from a hang (a caller will kill it). So the same seam now writes to STDERR,
// which keeps STDOUT clean for the machine-readable report path.

// ProgressFn type moved to ./rate-limiter.ts (B1 Phase 2b, TRDD-63314265) —
// imported above; it lives with the rateLimitedParallel executor that consumes it.

function makeProgressFn(enabled: boolean): ProgressFn | undefined {
  if (!enabled) return undefined;
  return (progress: number, total: number, message?: string) => {
    // Fire-and-forget — progress reporting must never block or throw.
    try {
      const pct = total > 0 ? ` (${Math.round((progress / total) * 100)}%)` : "";
      process.stderr.write(
        `[llm-externalizer] progress ${progress}/${total}${pct}${message ? ` — ${message}` : ""}\n`,
      );
    } catch {
      /* stderr closed — nothing useful to do */
    }
  };
}

async function listModelsRaw(): Promise<ModelInfo[]> {
  // T2.7 — snapshot for atomic baseUrl read
  const backend = getCurrentBackend();
  const res = await fetchWithTimeout(`${backend.baseUrl}/v1/models`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
  const data = await safeReadJson<{ data: ModelInfo[] }>(res);
  return data.data;
}

function getContextLength(model: ModelInfo): number {
  // LM Studio uses context_length, vLLM uses max_model_len, fall back to env/100k
  return model.context_length ?? model.max_model_len ?? FALLBACK_CONTEXT_LENGTH;
}

/**
 * Record usage, log the request, and return a minimal footer.
 * Token/cost details are NOT sent to the caller — they go to the
 * session log file and the live stats file for the statusline instead.
 */
function formatFooter(
  resp: StreamingResult,
  toolName: string,
  filePath?: string,
): string {
  recordUsage(resp.usage);

  // Log the request to the session log file
  logRequest({
    tool: toolName,
    model: resp.model,
    status: resp.truncated ? "truncated" : "success",
    usage: resp.usage,
    filePath,
  });

  // Body already carries a specific label for non-success finish reasons
  // (TRUNCATED / EMPTY RESPONSE / BLOCKED / UPSTREAM ERROR / INCOMPLETE) —
  // don't append a generic "partial result due to timeout" footer that
  // contradicts the actual cause. Only fall back to the generic footer
  // when the body is missing a label (e.g., older code paths or a real
  // network timeout surfaced directly by fetch).
  if (resp.truncated) {
    const hasLabel = /\*\*(TRUNCATED|EMPTY RESPONSE|BLOCKED|UPSTREAM ERROR|INCOMPLETE)\*\*/i.test(
      resp.content,
    );
    if (!hasLabel) {
      return "\n\n---\n⚠ Request did not complete cleanly (partial result or timeout).";
    }
  }
  return "";
}


// defaultOutputDir()/_resetDefaultOutputDirCache()/_testDefaultOutputDir() now
// live in project-root.ts (moved 2026-09-18) so security_scan/report.ts can
// reuse the SAME default report-root resolver without importing this whole
// CLI entrypoint module. Imported/re-exported below; the resolution-order
// doc comment that follows still describes the (unchanged) behavior.

// ── Response file output ────────────────────────────────────────────
// LLM responses are saved to timestamped .md files. The default lives
// under `<main-repo-root>/reports/llm-externalizer/` per the
// agent-reports-location rule (hyphen, not underscore — that matches
// the rule's `<component>` slug convention).
//
// Default resolution (highest precedence first):
//   1. LLM_EXT_OUTPUT_DIR  — explicit env override; absolute path wins all.
//   2. `<resolveProjectMainRoot()>/reports/llm-externalizer/` — the shared,
//      single-source project-root resolver (project-root.ts): CLAUDE_PROJECT_DIR
//      verbatim → cwd. Uses NO git, so reports NEVER land outside the MAIN
//      project dir — not in a subfolder repo, a worktree, an enclosing repo, or
//      the plugin cache (the prior code climbed to the git root, which scattered
//      reports). Cached after the first lookup.
//
// Per-call `output_dir` argument overrides this default unconditionally
// — the saveResponse() callers MUST forward it; if any of them drop
// the argument the override silently disappears (Issue #5 — fixed by
// threading the param through every callsite).

import { defaultOutputDir } from "./project-root.js";

/** Test-only: reset the cached default so a test that sets
 *  CLAUDE_PROJECT_DIR / LLM_EXT_OUTPUT_DIR mid-run gets the recomputed value. */
export { _resetDefaultOutputDirCache } from "./project-root.js";

/** Test-only re-export of the internal helper so default-output-dir.test.ts
 *  can verify the env-override / git-root / fallback chain without
 *  launching the full MCP server. */
export { _testDefaultOutputDir } from "./project-root.js";

// Canonical report-filename timestamp per the agent-reports-location rule:
//   %Y%m%d_%H%M%S%z — local time, GMT offset appended as compact ±HHMM (no colon).
// Example: 20260421_183012+0200. Never UTC, never ±HH:MM.
function canonicalTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  const Y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const D = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // getTimezoneOffset returns minutes WEST of UTC (Rome summer = -120), so
  // the GMT offset is its negation. East-of-UTC offsets are positive.
  const offMinutes = -date.getTimezoneOffset();
  const sign = offMinutes >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMinutes) / 60));
  const offM = pad(Math.abs(offMinutes) % 60);
  return `${Y}${M}${D}_${h}${m}${s}${sign}${offH}${offM}`;
}

function saveResponse(
  toolName: string,
  responseText: string,
  meta: { model: string; task?: string; inputFile?: string; groupId?: string },
  overrideFilename?: string,
  outputDir?: string,
): string {
  // Per-call override wins; falls back to the lazily-computed
  // <project-root>/reports/llm-externalizer/ default (resolveProjectMainRoot —
  // $CLAUDE_PROJECT_DIR, never a git root). Issue #5 traced many call sites
  // that silently dropped outputDir — fix is to thread it through every
  // saveResponse() in this file. This
  // function itself just respects whatever it's given.
  const dir = outputDir || defaultOutputDir();
  mkdirSync(dir, { recursive: true });

  const now = new Date();
  const ts = canonicalTimestamp(now);
  const shortId = randomUUID().slice(0, 6);
  // Slug format: <tool>[-group-<id>][-<src>]-<shortId> — everything after the ts is
  // joined by hyphens so the filename matches the rule's <ts±tz>-<slug>.<ext> shape.
  const srcPart = meta.inputFile ? `-${sanitizeFilename(meta.inputFile).replace(/\.md$/, "")}` : "";
  const groupPart = meta.groupId ? `-group-${meta.groupId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const filename = overrideFilename || `${ts}-${toolName}${groupPart}${srcPart}-${shortId}.md`;
  const filepath = join(dir, filename);

  const lines: string[] = [
    "# LLM Externalizer Response",
    "",
    `- **Tool**: \`${toolName}\``,
    `- **Model**: \`${meta.model}\``,
    `- **Timestamp**: ${now.toISOString()}`,
  ];
  if (meta.groupId) lines.push(`- **Group**: \`${meta.groupId}\``);
  if (meta.inputFile) lines.push(`- **Input file**: \`${meta.inputFile}\``);
  if (meta.task) lines.push(`- **Task**: ${meta.task}`);
  lines.push("", "---", "", responseText);

  // Atomic write: write to temp file, then rename — prevents partial/corrupt files on crash
  const tmpPath = filepath + ".tmp";
  try {
    writeFileSync(tmpPath, lines.join("\n"), "utf-8");
    renameSync(tmpPath, filepath);
  } catch (err) {
    // Clean up orphaned temp file on failure (disk full, permissions, etc.)
    try {
      unlinkSync(tmpPath);
    } catch {
      /* temp file may not exist */
    }
    throw new Error(
      `Failed to save response to ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return filepath;
}

// sanitizeProviderError() moved to ./provider/http.ts (B1 Phase 5b) — a stateless
// transform of an HTTP error body, and completion.ts (its only caller) is the one
// that formats the `API error <status> (<backend>): <sanitized>` messages that
// classifyError() below regex-matches. The status prefix stays OUTSIDE what the
// sanitizer returns, so those regexes are unaffected by the move.

// ── Error classification ────────────────────────────────────────────
// Distinguishes unrecoverable errors (abort batch) from recoverable ones (retry).

/** A chain-exhaustion cause as text, for the status regexes below. */
function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The provider-state line a failure carries, read from the error itself or from its wrapped cause (a profile cause is often a RetryDeadlineError, which failureOf already unwraps). */
function stateOf(e: unknown): string | undefined {
  // failureOf unwraps only ONE RetryDeadlineError; free-rotation can wrap one inside another.
  let source = e;
  while (source instanceof RetryDeadlineError) source = source.cause;
  return failureOf(source)?.providerState;
}

/** The distinct provider-state lines, first per model (the line names its model), at most 3. */
function distinctStates(states: Array<string | undefined>): string[] {
  // The line embeds its age, so the model (the text between "provider state for " and " as of ") is the key; the first line per model wins.
  const modelOf = (s: string) => s.replace(/^provider state for /, "").split(" as of ")[0];
  const byModel = new Map<string, string>();
  for (const s of states) if (s !== undefined && !byModel.has(modelOf(s))) byModel.set(modelOf(s), s);
  return [...byModel.values()].slice(0, 3);
}

/** `reason` with the provider-state lines appended in parentheses; byte-identical when there are none. */
function withStates(reason: string, states: Array<string | undefined>): string {
  const lines = distinctStates(states);
  return lines.length > 0 ? `${reason} (${lines.join(" | ")})` : reason;
}

/** Statuses no retry fixes for ANY request on a chain: 401/403 auth, 402 no
 *  credit, 404/410 dead model. Shared by classifyError and
 *  failDynamicProfile so both partition causes the same way (C5b). */
const SERVICE_LEVEL_STATUS_RE = /API error (401|402|403|404|410)\b/;
/** Every 4xx except the transient 408/429. */
const NON_TRANSIENT_4XX_RE = /API error 4(?!08\b|29\b)\d\d\b/;

/**
 * D2 (USER 2026-09-18) -- THE ONE PLACE that decides what a DYNAMIC profile
 * (free/paid/local) running out of models becomes. Every site where one runs
 * out calls this and throws what it returns: the chain walk
 * (chatCompletionWithProfileFallback), the free-pool rotation
 * (callSingleWithFreeRotation, chatCompletionJSONWithFreeRotation) and the
 * ensemble's "no slot answered" branch (ensembleStreaming) -- so every
 * per-file loop (robustPerFileProcess, runScanFolder,
 * runSearchExistingImplementations, batch_check) gets the verdict before
 * classifyError ever sees the error.
 *
 * USER: "the profile updating must happens in background, so no message is
 * needed, except if all models of the current profile are failing, in which
 * case the message should appear saying to retry later since the updating
 * process is underway and will be finished soon". But an update cannot fix
 * every failure, and then the actionable error wins (USER ~14:45, "Credit/key
 * error, no update"). First match wins:
 *
 *  1. KEY -- COORDINATOR DEFAULT (not a USER decision): every cause is a 401
 *     or a certain 402, and at least one is a 401, on ANY profile -> the key
 *     error, no update (an update would hit the same 401 and respawn on every
 *     command). Only the 401 causes are passed on, so classifyError cannot
 *     turn a 401 + 402 mix into the credit verdict.
 *  2. CREDIT -- USER: profile `paid` and EVERY cause a certain 402 (no
 *     credit) -> the credit verdict, no update (a paid benchmark would get
 *     402 too). A paid exhaustion mixing certain 402s with other failures
 *     falls through to 4 (USER point 4). On `free` a 402 means "no longer
 *     free", so an update IS the fix there. "Certain" is D1's
 *     paymentErrorCertainty, unchanged (its tightening is D4).
 *  3. REQUEST-SPECIFIC -- worker default keeping C5b/9000b8d-A: every cause a
 *     non-transient 4xx and at least one specific to THIS request (a 413 for
 *     an oversized file, a content-filter 400) -> that file fails, the batch
 *     goes on, no update: no model is broken, this request is unservable.
 *  4. UPDATE -- USER D2: make sure the profile's background update is
 *     running (requestProfileUpdate: SG2 lock + the item-8 respawn throttle)
 *     and fail with the retry-later message. When nothing can be started at
 *     all (the LLM_EXT_DISABLE_AUTO_RECONCILE opt-out, a spawn failure) the
 *     actionable error is returned instead: "an update is underway" would be
 *     false.
 * No cause at all (D1 B: no entry was ever tried) goes to 4.
 */
function failDynamicProfile(
  profileName: DynamicProfileName,
  causes: readonly unknown[],
  actionable: (causes: readonly unknown[]) => Error,
): Error {
  const texts = causes.map(causeText);
  const is401 = (m: string) => /API error 401\b/.test(m);
  const certain402 = (m: string) => paymentErrorCertainty(m) === "certain";
  if (texts.length > 0) {
    if (texts.some(is401) && texts.every((m) => is401(m) || certain402(m))) {
      return actionable(causes.filter((_, i) => is401(texts[i])));
    }
    if (profileName === "paid" && texts.every(certain402)) return actionable(causes);
    if (texts.every((m) => NON_TRANSIENT_4XX_RE.test(m)) && texts.some((m) => !SERVICE_LEVEL_STATUS_RE.test(m))) {
      return actionable(causes);
    }
  }
  // TRDD-VAORGKVF (COORDINATOR DEFAULT, not a USER ruling): an IRON RULE refusal is a $0 ledger verdict reached before anything is sent. The paid/free populate writes only the rank-0 keyword ledger (benchmark/index.ts recordGeneralKeywordPasses; measure r2 item 2), so for a tool ranked above 0 no update can cure it and "an update is underway" would be false. This EXTENDS the principle in the doc comment above ("an update cannot fix every failure, and then the actionable error wins"). Rank-0 tools, and any refusal whose tool name cannot be read from its text, fall through to the update branch.
  if (texts.length > 0 && texts.every((m) => m.startsWith(IRON_RULE_REFUSAL_PREFIX))) {
    const refusedTools = texts.map((m) => /is not validated for (\S+?)\. /.exec(m)?.[1]);
    if (refusedTools.every((t) => t !== undefined && !profileUpdateCanValidate(t))) return actionable(causes);
  }
  const update = requestProfileUpdate({ profile: profileName, log: (m) => process.stderr.write(m) });
  if (update.state === "unavailable") {
    process.stderr.write(`[llm-externalizer] '${profileName}' profile update not started — ${update.reason}\n`);
    return actionable(causes);
  }
  return new ProfileExhaustedError(profileName, "dynamic", causes);
}

function classifyError(error: unknown): ErrorClassification {
  const msg = error instanceof Error ? error.message : String(error);
  // The retry window closed (TRDD-YG72CYY7): final for this file, never
  // retried by the per-file loops (they would just re-run a five-minute
  // window). Not service-level: another file may still succeed. A chain
  // exhaustion carrying one as a cause is handled in its own branch below.
  if (error instanceof RetryDeadlineError) {
    return { unrecoverable: true, serviceLevel: false, reason: withStates(msg, [stateOf(error)]), countsAsFailure: true };
  }
  // YG72CYY7 D3: a verdict the HTTP layer stamped at the first failure (TLS, a spent ECONNREFUSED/504 budget) is
  // final for this file: the per-file loops must not re-run it. It is READ here, never re-derived; the reason
  // carries the distinct hints of ALL causes joined by " | " (not "; ", which the off-OpenRouter ECONNREFUSED hint contains itself) (a chain that ended on TLS for one model and a spent 504 for another shows both). Only a STATIC exhaustion counts: a dynamic one went through
  // failDynamicProfile before this point (7f87b85) and keeps its own branch below. "All causes" is literal, so a
  // cause with no verdict (a 402, a transient error) keeps today's classification.
  const finalFields =
    error instanceof ProfileExhaustedError
      ? error.kind === "static" && error.causes.length > 0
        ? error.causes.map((c) => (c instanceof RetryDeadlineError ? undefined : failureOf(c)))
        : []
      : [failureOf(error)];
  if (finalFields.length > 0 && finalFields.every((f) => f?.final !== undefined)) {
    const hint = [...new Set(finalFields.map((f) => f?.hint).filter(Boolean)), ...distinctStates(finalFields.map((f) => f?.providerState))].join(" | ");
    return { unrecoverable: true, serviceLevel: false, reason: msg + (hint ? ` (${hint})` : ""), countsAsFailure: true };
  }
  // A chain exhaustion is classified by WHY the chain ran out (its causes),
  // never by the exception type alone (fix-queue row 102, C5b). It used to
  // fall through to the catch-all "recoverable" default below, so every
  // per-file loop retried it: a caller-pinned model's deterministic 402 was
  // re-sent up to 3x per file and the batch still ended isError:false, and a
  // dynamic profile re-ran its whole announce/update/retry on every retry.
  //  - no cause at all (no entry was ever tried): no model can serve any
  //    file -- abort the batch at once with the exhaustion's own sentence,
  //    never a per-file retry (9000b8d follow-up B).
  //  - EVERY cause a service-level status (402 no credit, 401/403 auth or
  //    forbidden, 404/410 dead model -- any mix of only these): no file can
  //    succeed on this chain -- abort the batch. With a 402 among them the
  //    reason is the credit verdict a raw 402 gets below (the unpinned path,
  //    honest-402.test.ts Path 1), after the Rule's sentence, verbatim.
  //  - every cause a non-transient 4xx, with at least one specific to THIS
  //    request (a content-filter 400, a 413 for an oversized file): fail this
  //    file without a retry (it would fail identically), keep the batch. A
  //    402 in the mix does not abort (9000b8d follow-up A): a 402 is certain
  //    only for the provider route that returned it (USER: "skip to the next
  //    provider"), and the request-specific cause shows the chain was not
  //    simply out of credit everywhere.
  //  - any transient cause (429, 5xx, timeout, network): fall through to the
  //    recoverable default, unchanged.
  // Only the HTTP status is appended, never the provider's raw error text:
  // the pinned-model path deliberately speaks the exhaustion sentence, not a
  // second raw-error vocabulary (dispatch-reload.test.ts, C2a-FOLLOWUP item 2).
  if (error instanceof ProfileExhaustedError) {
    // D2: a "dynamic" exhaustion is the retry-later outcome -- failDynamicProfile
    // already decided the profile has no working model and started (or found)
    // its background update. No file can succeed on it now: abort the batch
    // with that one message, never a per-file retry.
    if (error.kind === "dynamic") return { unrecoverable: true, serviceLevel: true, reason: msg };
    const causes = error.causes.map(causeText);
    if (causes.length === 0) return { unrecoverable: true, serviceLevel: true, reason: msg };
    const lastStatus = /API error (\d{3})\b/.exec(causes[causes.length - 1] ?? "")?.[1];
    const every = (test: (m: string) => boolean) => causes.every(test);
    // D4 review F4: a credit cause is EXACTLY the USER template ("Provider X
    // report insufficient credits for using the Y model with this key.") —
    // the raw "API error 402" text moved to stderr, so the status regexes no
    // longer see it. paymentErrorCertainty is the ONE payment predicate both
    // classes share; its "certain" verdict is the 402 equivalent here.
    const isServiceLevelCause = (m: string) =>
      SERVICE_LEVEL_STATUS_RE.test(m) ||
      paymentErrorCertainty(m) === "certain" ||
      m.startsWith(IRON_RULE_REFUSAL_PREFIX); // TRDD-VAORGKVF: a refusal is final for every file
    if (every(isServiceLevelCause)) {
      const payment = causes.find((m) => paymentErrorCertainty(m) === "certain");
      // TRDD-VAORGKVF: precedence: a certain-payment cause wins (the credit verdict above); the first refusal text is appended only when no certain-payment cause exists, so its "Validate it: ..." remedy reaches the user and no "(HTTP undefined)" is printed (measure r1 item 5).
      const refusal = causes.find((m) => m.startsWith(IRON_RULE_REFUSAL_PREFIX));
      return {
        unrecoverable: true,
        serviceLevel: true,
        reason:
          payment !== undefined
            ? `${msg} — ${classifyError(new Error(payment)).reason}`
            : refusal !== undefined
              ? `${msg} — ${refusal}`
              : `${msg} (HTTP ${lastStatus})`,
      };
    }
    // A chain that ran out with a closed retry window among its causes
    // (TRDD-YG72CYY7): reached only after the dynamic and every-cause-service-
    // level verdicts above, so those keep deciding as before the clock existed
    // (a blanket early return made a dynamic exhaustion stop aborting the
    // batch). It is final for THIS file -- another file may still succeed, and
    // re-running a five-minute window per retry is the stall the clock exists
    // to end -- but it is a FAILED outcome, so the per-file loops must still
    // feed the "3 of the last 3 failed" abort (countsAsFailure).
    // WHY the deadline message is appended to `reason` (N5b): `msg` is only the
    // exhaustion sentence, so the per-file result never said that a retry
    // window closed (or when the provider asked to retry). Classification is
    // unchanged.
    // N5b/M1: every closed retry window is named, with its real cause (a lone
    // `deadline.message` is neutral and says neither which model nor what status).
    const deadlines = error.causes.filter((c): c is RetryDeadlineError => c instanceof RetryDeadlineError);
    if (deadlines.length > 0) {
      const detail = deadlines
        .map((d) => (d.cause !== undefined ? `${d.message} ${d.causeLabel} ${failureText(d)}` : d.message))
        .join("; ");
      return {
        unrecoverable: true,
        serviceLevel: false,
        reason: withStates(`${msg} — ${detail}`, error.causes.map(stateOf)),
        countsAsFailure: true,
      };
    }
    // Same equivalence for the 4xx fallback: a mixed exhaustion (credit
    // cause + a request-specific 413) must stay a per-FILE failure, not fall
    // through to the recoverable default (which would retry the whole walk
    // and trip the circuit breaker). "Certain" payment is the 402 equivalent.
    if (every((m) => NON_TRANSIENT_4XX_RE.test(m) || paymentErrorCertainty(m) === "certain")) {
      return { unrecoverable: true, serviceLevel: false, reason: `${msg} (HTTP ${lastStatus})` };
    }
  }
  // Service-level errors — abort the entire batch (retrying won't help)
  // Use specific "API error NNN" pattern to avoid false positives from file paths containing digits
  // TRDD-VAORGKVF: a raw IRON RULE refusal is final: every file in the batch runs the same tool on the same model, so every file would be refused identically. A raw refusal reaches here from the single-model ensemble and callModel paths; the multi-slot ensemble join was not traced.
  if (msg.startsWith(IRON_RULE_REFUSAL_PREFIX)) return { unrecoverable: true, serviceLevel: true, reason: msg };
  if (/API error 401\b/.test(msg))
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason: "Authentication failed (invalid API key)",
    };
  // D4 review F4: a credit cause is the USER template (no "API error 402"
  // token — the raw error moved to stderr), so the D1 payment predicate
  // catches what the status regex can't. Payment paths never misread a 429
  // (its own branch above), and a template without any payment wording is
  // never "certain".
  if (/API error 402\b/.test(msg) || paymentErrorCertainty(msg) === "certain") {
    // Credit exhausted. TRDD-OE27RD7I addendum 4 (USER, no exceptions: "no
    // switching to free models ... must exist anymore") -- this used to call
    // engageAutoFree() and, on success, report `unrecoverable: false` with a
    // "switching to free model" reason so the batch would carry on against a
    // substitute model it never asked for. That cross-profile borrow is
    // deleted outright, not reworked: creditExhausted still flips (read only
    // by highQualityScanRefusal's message-shaping, config.ts), but nothing
    // engages. Stop after one attempt and say the true reason -- serviceLevel:
    // true (index.ts's several near-identical per-file retry loops) aborts
    // the WHOLE batch, not just this file, since every remaining file on this
    // profile would hit the identical 402 for nothing.
    //
    // fix-queue 98(1) audit: a raw "API error 402" reaches this classifier
    // ONLY from a call that bypassed the profile chain walk by design (an
    // ensemble slot, the free-pool rotation) -- walkProfileChainOnce and a
    // pinned modelOverride both convert their 402 into ProfileExhaustedError,
    // which the branch above classifies by its causes into this same verdict.
    // D2: on a DYNAMIC profile those bypass sites now go through
    // failDynamicProfile when no model/slot answered, so a raw 402 arrives
    // here only when that function chose the actionable error (the credit or
    // key verdict, no update) -- or on a static profile. Either way this is
    // the TRUE final word. Do NOT gate it on activeResolved.dynamic: an
    // attempt to do so was reverted because it promised a recovery nothing
    // performs and silently dropped the abort-the-batch signal.
    creditExhausted = true;
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason:
        "Payment required (credit exhausted on OpenRouter) — add credits, or run with a " +
        "different --profile. llm-ext does not switch to free models automatically.",
    };
  }
  if (/API error 403\b/.test(msg))
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason: "Access forbidden",
    };
  // File-level errors — unrecoverable for this file, but should NOT abort the batch
  if (msg.includes("File not found") || msg.includes("ENOENT"))
    return { unrecoverable: true, serviceLevel: false, reason: msg };
  if (msg.includes("Git branch changed"))
    return { unrecoverable: true, serviceLevel: true, reason: msg };
  if (msg.includes("currently being processed"))
    return { unrecoverable: false, serviceLevel: false, reason: msg };
  // 429 rate limit — signal AIMD to halve RPS
  if (/API error 429\b/.test(msg) || /rate.?limit/i.test(msg)) {
    signalRateLimitHit();
    return { unrecoverable: false, serviceLevel: false, reason: msg };
  }
  // Everything else is recoverable (timeouts, 5xx, malformed responses)
  // YG72CYY7 inc 4: a raw provider-side 5xx (generic retries spent while the window is still open, or a static exhaustion of raw 5xx causes) gives up here. The per-file loops print this reason only when they give up (the retry path `continue`s without printing), so the line is appended once, at the end.
  return {
    unrecoverable: false,
    serviceLevel: false,
    reason: withStates(msg, error instanceof ProfileExhaustedError ? error.causes.map(stateOf) : [stateOf(error)]),
  };
}

// ── Adaptive rate limiter (AIMD) + parallel executor ─────────────────
// The AIMD limiter class, its shared module-level singleton + factory, the
// rate-limited parallel executor (rateLimitedParallel), and the ProgressFn
// type all live in ./rate-limiter.ts (B1 Phase 2b, TRDD-63314265) so ALL
// rate-limiting is one cohesive module. index.ts imports rateLimitedParallel
// + ProgressFn (above) and signals the shared singleton via the
// signalSuccess() / signalRateLimitHit() accessors. The singleton stays a TRUE
// singleton: it is a single module-level binding inside rate-limiter.ts.


// ── Batch helpers ───────────────────────────────────────────────────

interface FileProcessResult {
  filePath: string;
  success: boolean;
  reportPath?: string;
  backupPath?: string;
  error?: string;
  noChange?: boolean;
}

function sanitizeFilename(filePath: string): string {
  const base = basename(filePath);
  if (!base || base === "/") return "unknown";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ── Robust per-file processing ─────────────────────────────────────
// Shared function that processes each file independently with:
// - Rate-limited parallel execution (via rateLimitedParallel)
// - Per-file retry with exponential backoff
// - Circuit breaker (abort after 3 consecutive failures)
// - Progress reporting
// Used by all content tools when answer_mode=0 and max_retries > 1.

interface RobustPerFileOpts {
  task: string;
  maxRetries: number;
  redact?: boolean;
  regexRedact?: RegexRedactOpts | null;
  onProgress?: ProgressFn;
  ensemble: boolean;
  budgetBytes: number;
  language?: string;
  toolName: string;
  batchId?: string;
  modelOverride?: string;
  outputDir?: string;
}

interface RobustPerFileResult {
  results: FileProcessResult[];
  succeeded: FileProcessResult[];
  failed: FileProcessResult[];
  skipped: FileProcessResult[];
  aborted: boolean;
  abortReason: string;
}

async function robustPerFileProcess(
  files: string[],
  opts: RobustPerFileOpts,
): Promise<RobustPerFileResult> {
  const batchId = opts.batchId || randomUUID();
  const rlConfig = await getRateLimitConfig();
  const recentOutcomes: boolean[] = [];
  let aborted = false;
  let abortReason = "";
  let totalAttempts = 0;
  const maxTotalAttempts = files.length * 2;
  const maxRetries = Math.max(1, opts.maxRetries);

  const tasks = files.map((filePath, idx) => async () => {
    if (aborted) {
      return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (++totalAttempts > maxTotalAttempts) {
        aborted = true;
        abortReason = `Global retry budget exhausted (${maxTotalAttempts} total attempts)`;
      }
      if (aborted) {
        return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
      }
      try {
        const result = await processFileCheck(filePath, opts.task, {
          language: opts.language,
          maxTokens: resolveDefaultMaxTokens(),
          batchId,
          fileIndex: idx,
          redact: opts.redact,
          regexRedact: opts.regexRedact,
          onProgress: opts.onProgress,
          ensemble: opts.ensemble,
          maxBytes: opts.budgetBytes,
          modelOverride: opts.modelOverride,
          outputDir: opts.outputDir,
        });
        recentOutcomes.push(result.success);
        if (result.success) signalSuccess();
        if (opts.onProgress) {
          const completed = recentOutcomes.length;
          opts.onProgress(completed, files.length, `${opts.toolName}: ${completed}/${files.length} files done`);
        }
        return result;
      } catch (err) {
        const classified = classifyError(err);
        if (classified.unrecoverable) {
          if (classified.serviceLevel) {
            aborted = true;
            abortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
          }
          // A closed retry window is final for this file but still a failed
          // outcome (see the batch_check loop below).
          if (classified.countsAsFailure && recordFailedOutcome(recentOutcomes)) {
            aborted = true;
            abortReason = `3 of the last 3 completions failed. Last error: ${classified.reason}`;
          }
          return { filePath, success: false, error: classified.reason } as FileProcessResult;
        }
        if (attempt < maxRetries) {
          const delayMs = Math.pow(3, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        if (recordFailedOutcome(recentOutcomes)) {
          aborted = true;
          abortReason = `3 of the last 3 completions failed. Last error: ${classified.reason}`;
        }
        return { filePath, success: false, error: `Failed after ${maxRetries} retries: ${classified.reason}` } as FileProcessResult;
      }
    }
    return { filePath, success: false, error: "Unexpected retry loop exit" } as FileProcessResult;
  });

  const results = await rateLimitedParallel(tasks, rlConfig.rps, rlConfig.maxInFlight, opts.onProgress);
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success && r.error !== "Batch aborted");
  const skipped = results.filter((r) => r.error === "Batch aborted");

  return { results, succeeded, failed, skipped, aborted, abortReason };
}

/** Normalize input_files_paths: accept string|string[]|undefined, return string[] with no undefined/null/empty entries. */
function normalizePaths(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((p): p is string => typeof p === "string" && p.length > 0);
}

// ── Folder path resolution ─────────────────────────────────────────
// Shared logic for resolving folder_path to file paths. Used by tools
// that accept folder_path as an alternative to input_files_paths.

interface FolderResolveResult {
  files: string[];
  error?: string;
}

function resolveFolderPath(
  folderPath: string,
  opts?: {
    extensions?: string[];
    excludeDirs?: string[];
    useGitignore?: boolean;
    recursive?: boolean;
    followSymlinks?: boolean;
    maxFiles?: number;
    /** --preview reason channel — forwarded to walkDir (TRDD-SCLGL8T4). */
    onExcluded?: (path: string, reason: string) => void;
  },
): FolderResolveResult {
  // Path traversal protection — reject symlinks and normalize traversal sequences
  try {
    folderPath = sanitizeInputPath(folderPath);
  } catch (err) {
    return { files: [], error: `Invalid folder_path: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!existsSync(folderPath)) {
    return { files: [], error: `folder_path not found: ${folderPath}` };
  }
  if (!statSync(folderPath).isDirectory()) {
    return { files: [], error: `Not a directory: ${folderPath}` };
  }
  const files = walkDir(folderPath, {
    extensions: opts?.extensions,
    maxFiles: opts?.maxFiles ?? 2500,
    exclude: opts?.excludeDirs,
    useGitignore: opts?.useGitignore !== false,     // default true
    recursive: opts?.recursive !== false,            // default true
    followSymlinks: opts?.followSymlinks !== false,   // default true
    onExcluded: opts?.onExcluded,
  });
  if (files.length === 0) {
    const extInfo = opts?.extensions ? ` with extensions ${opts.extensions.join(", ")}` : "";
    return { files: [], error: `No matching files found in ${folderPath}${extInfo}` };
  }
  return { files };
}

// ── Cost-estimation deps (--estimate, task #187) ─────────────────────
// The estimator itself lives in ./estimate.ts and is pure; this factory is the
// ONE place its seams bind to the engine's real internals, so the estimate
// walks the SAME file resolution and the SAME model slots the run would use.
// It lives here (not in estimate.ts) because the internals it closes over —
// resolveFolderPath, getEnsembleModels, resolveDefaultMaxTokens, the model
// cache — are deliberately not exported.

/**
 * Warm the pricing source for an estimate. One GET /models (no completion, $0);
 * failure is swallowed — the estimate then degrades to tokens-only with a note,
 * which beats blocking a dry-run on a network blip.
 */
export async function warmEstimatePricing(): Promise<void> {
  try {
    await fetchOpenRouterModels();
  } catch {
    /* estimate degrades to tokens-only */
  }
}

export function buildEstimateDeps(): import("./estimate.js").EstimateDeps {
  return {
    resolveFiles(args, onExcluded) {
      // Mirror the tools' own input contract: diff modes win (TRDD-MNK2YNH0 —
      // resolution DELEGATED to git), then explicit input_files_paths, else
      // folder_path expands through the SAME walker the run would use
      // (gitignore, extensions, excluded dirs) — an estimate over a different
      // file set than the run's would be worse than none. `onExcluded` is the
      // --preview reason channel (TRDD-SCLGL8T4), threaded into that same
      // walker so preview can never drift from the real selection.
      try {
        const mode = parseDiffMode(args);
        if (mode) {
          return { files: resolveDiffScope(mode, process.cwd()).files };
        }
      } catch (err) {
        return { files: [], error: (err as Error).message };
      }
      const explicit = Array.isArray(args.input_files_paths)
        ? (args.input_files_paths as unknown[]).filter(
            (p): p is string => typeof p === "string" && p.length > 0,
          )
        : [];
      if (explicit.length > 0) return { files: explicit };
      if (typeof args.folder_path === "string" && args.folder_path.length > 0) {
        return resolveFolderPath(args.folder_path, {
          extensions: Array.isArray(args.extensions)
            ? (args.extensions as string[])
            : undefined,
          // `exclude_dirs` — the SAME name every real tool reads (scan_folder,
          // chat, batch_check…). This resolver briefly read `excluded_dirs`,
          // which made every dry-run/preview/rules pass resolve a DIFFERENT
          // file set than the run whenever a dir-exclusion was passed
          // (ultracode F6, 2026-08-05).
          excludeDirs: Array.isArray(args.exclude_dirs)
            ? (args.exclude_dirs as string[])
            : undefined,
          useGitignore: args.use_gitignore !== false,
          // Mirror the walk-shape knobs the real tools honor (ultracode F7):
          // an estimate walking the fixed 2500-file default while the run
          // honors a caller-set max_files (or non-recursive / no-symlinks)
          // counts the wrong files.
          recursive: typeof args.recursive === "boolean" ? args.recursive : undefined,
          followSymlinks:
            typeof args.follow_symlinks === "boolean" ? args.follow_symlinks : undefined,
          maxFiles:
            typeof args.max_files === "number" && args.max_files > 0
              ? args.max_files
              : undefined,
          onExcluded,
        });
      }
      return { files: [], error: "no input_files_paths or folder_path given" };
    },
    fileSizeBytes(path) {
      try {
        return statSync(path).size;
      } catch {
        return 0; // unreadable file costs nothing in the estimate; the run itself will fail loudly on it
      }
    },
    ensembleSlots(toolName) {
      // high_quality_scan bills a SINGLE premium model (hq.id, useEnsemble
      // false — see its dispatch case), never the cheap ensemble. Pricing it
      // against the ensemble under-quoted the one paid-by-design tool where
      // the budget gate matters most (ultracode F5, 2026-08-05).
      if (toolName === "high_quality_scan") {
        const hq = activeResolved?.highQualityModel ?? HIGH_QUALITY_MODEL_DEFAULTS;
        return [
          { id: hq.id, maxOutput: resolveEnsembleModelLimits(hq.id, undefined).maxOutput },
        ];
      }
      const ensemble = getEnsembleModels();
      if (ensemble.length > 0)
        return ensemble.map((m) => ({ id: m.id, maxOutput: m.maxOutput }));
      // Single-model mode: the backend's configured model with its default cap.
      const backend = getCurrentBackend();
      if (!backend.model) return [];
      return [{ id: backend.model, maxOutput: resolveDefaultMaxTokens() }];
    },
    pricingFor(modelId) {
      const m = openRouterModelCache.find((x) => x.id === modelId);
      if (!m?.pricing) return null;
      // OpenRouter pricing strings are USD per TOKEN ("0.000000435") — scale
      // to per-million so the arithmetic matches every other pricing site.
      const inp = Number(m.pricing.prompt);
      const out = Number(m.pricing.completion);
      if (!Number.isFinite(inp) || !Number.isFinite(out)) return null;
      return { inputUsdPerM: inp * 1_000_000, outputUsdPerM: out * 1_000_000 };
    },
    defaultMaxTokens() {
      return resolveDefaultMaxTokens();
    },
    calibratedOutputTokens(toolName, modelId) {
      // The output-EWMA sidecar (task #188) — self-calibrating EXPECTED line.
      return calibratedOutputTokens(toolName, modelId);
    },
  };
}

// fileIndex disambiguates files with the same basename processed in the same second
function batchReportFilename(
  toolName: string,
  _batchId: string,
  filePath: string,
  _fileIndex: number,
): string {
  const ts = canonicalTimestamp();
  const shortId = randomUUID().slice(0, 6);
  const srcName = sanitizeFilename(filePath).replace(/\.md$/, "");
  // Canonical filename: <ts±tz>-<slug>.<ext>
  return `${ts}-${toolName}-${srcName}-${shortId}.md`;
}

// The SERVICE_HEALTH circuit breaker (consecutive-failure tracker + exponential
// backoff) and the retry-on-truncation wrapper moved to ./provider/completion.ts
// (B1 Phase 5b). SERVICE_HEALTH is deliberately NOT exported from there: it had
// zero readers outside chatCompletionWithRetry, and a second module holding its
// own counter would make the breaker trip on only a subset of the failures.

// ── Ensemble streaming helper ────────────────────────────────────────
// Runs the same prompt on multiple models in parallel, combines results.
// When ensemble=false or backend is local, falls through to single-model call.

/**
 * True when EVERY LLM call must be served from the free pool: a `free_only`
 * profile, OR the allow_paid_models master switch forcing a remote profile
 * free. TRDD-OE27RD7I addendum 4 deleted the third, automatic arm this used
 * to OR in (sticky auto-free on a low balance / prior 402) — no cross-profile
 * switch, the selected profile's own static shape is the whole answer now.
 */
function isFreeModeActive(): boolean {
  return (activeResolved?.freeOnly ?? false) || forceFreeByMasterSwitch;
}

/**
 * Recompute the master-switch force-free flag from the live state. Called on boot
 * (main) and every reload, so flipping `allow_paid_models` in settings.yaml is a
 * clean toggle. Forces free for any REMOTE profile while paid is off; LOCAL
 * profiles are $0/offline and never forced.
 */
function recomputeForceFree(): void {
  forceFreeByMasterSwitch =
    activeResolved !== null &&
    shouldForceFreeMode(getAllowPaidModels(), activeResolved.mode, activeResolved.profileType);
}

/**
 * The pool to draw the free ensemble / rotation from, whichever way free mode
 * was entered: a `free_only` profile, or the master switch forcing one.
 * TRDD-OE27RD7I addendum 4 deleted the third way (sticky auto-free engaging
 * its own pool) outright, so there is no engaged-pool branch here anymore.
 * free_only returns the profile's own free_models unchanged (an empty list
 * stays empty — no FREE_POOL_SEED substitute, Rule 5); once P6 wires
 * decideDynamicProfile in, the maintainer keeps the dynamic free profile's
 * pool populated. A static profile with an empty pool is refused by this
 * function's second branch (below). FREE_POOL_SEED is only the seed the
 * dynamic free benchmark starts from.
 */
function activeFreePool(): string[] {
  if (activeResolved?.freeOnly) return resolveAutoFreePool(activeResolved.freeModels);
  // Forced-free via the master switch on a profile that is NOT free_only:
  // resolveProfile leaves activeResolved.freeModels EMPTY, so prefer the
  // persisted/curated free_models read from settings (approvedFreePoolFromSettings,
  // which reads the RAW configured list + reconcile's updates) before the static
  // seed -- the operator's own pool must win.
  const persisted = approvedFreePoolFromSettings();
  if (persisted.length > 0) return persisted;
  const pool = resolveAutoFreePool(activeResolved?.freeModels ?? []);
  // Rule 5 (Phase 5 sec (a) Site 2): a static profile forced free by
  // allow_paid_models:false with no persisted/configured pool no longer
  // gets a silent FREE_POOL_SEED substitute -- refuse loudly instead (D-A).
  // A dynamic `free` profile is not expected to reach this branch empty once
  // P6 wires decideDynamicProfile in and the maintainer keeps its pool
  // populated; until then this refusal can in principle fire for either case.
  if (pool.length === 0) {
    throw new Error(
      "free mode is active but the active profile defines no free models " +
        "(free_models: [] and no free-provider `providers:` binding). " +
        "Add free_models, or a `providers:` entry for a free provider (e.g. chat-b-ai-remote), " +
        "or set allow_paid_models: true.",
    );
  }
  return pool;
}

/**
 * Recompute force-free and re-publish the config.ts cost-safety chokepoint
 * (getActiveFreeOnly) so the pure subsystem spend sites (judge/scout/benchmark)
 * enforce ':free' whenever free mode is active for either reason — profile
 * free_only, or the master switch. Called on boot (main) and each reload.
 */
function publishFreeState(): void {
  recomputeForceFree();
  setActiveFreeOnly(isFreeModeActive());
}

/**
 * The APPROVED free pool as rotation candidates, in the user's preference order.
 *
 * "Approved" is exactly what filterFreeModels() means: benchmark-failed models
 * are dropped, sub-floor-context models are dropped. So rotation can only ever
 * land on a model the pipeline already vetted — never on an arbitrary free id.
 *
 * This builds the pool; it does NOT decide whether to USE it. Each call site
 * gates that itself, because the two gates differ: the ensemble paths rotate
 * only under free mode, while a ':free' modelOverride rotates even on a funded
 * profile (an explicit `free: true` call is a free call, and its one pinned model
 * hitting its daily cap should not be a hard failure). A paid call must never
 * reach this pool — that would spend money the user did not ask to spend.
 */
function buildFreeRotationPool(
  fileLineCount?: number,
  exclude: ReadonlySet<string> = new Set(),
): Array<RotationCandidate & { maxInputLines: number }> {
  if (!activeResolved || getCurrentBackend().type !== "openrouter") return [];
  // free_only pins its own pool. TRDD-OE27RD7I addendum 4 deleted the sticky
  // auto-free engaged pool this used to fall back to next; the remaining
  // funded-profile call site is the ':free' modelOverride path (an explicit
  // `free: true` call on a funded profile), which now draws straight on the
  // profile's own free_models via resolveAutoFreePool — never an
  // auto-engaged substitute.
  const pool = activeResolved.freeOnly
    ? activeResolved.freeModels
    : resolveAutoFreePool(activeResolved.freeModels);
  const catalogById = new Map(openRouterModelCache.map((cm) => [cm.id, cm]));
  const out: Array<RotationCandidate & { maxInputLines: number }> = [];
  // TRDD-FDI9NYAS D3c: rotation only draws on an AUTO-PICKED id once it has a
  // RECORDED PASS — union in manualModels first, or a static/manual pool's
  // own hand-listed ids (never benchmarked by design, D3b) would wrongly get
  // excluded too. "no model should be used unless it pass the benchmark".
  const approvedForServing = new Set([...benchmarkPassedModels(), ...(activeResolved.manualModels ?? [])]);
  for (const id of filterFreeModels(pool, catalogById, benchmarkFailedModels(), approvedForServing)) {
    if (exclude.has(id)) continue;
    // Cost-safety: mirrors assertFreeOnlyModel's contract at the point where the
    // rotation TARGET is chosen, so a router pseudo-model like `openrouter/free`
    // (priced $0, but with no ':free' suffix) can never enter the rotation and
    // blow up at send time — the exact failure that killed a 32-minute sweep.
    // isFreeSuffixModelId is THE definition of what the chokepoint admits; a
    // second inline copy of that rule is how the two drift apart.
    if (!isFreeSuffixModelId(id)) continue;
    const limits = resolveEnsembleModelLimits(
      id,
      catalogById.get(id)?.top_provider?.max_completion_tokens,
    );
    if (!fileLineCount || fileLineCount <= limits.maxInputLines) {
      out.push({ id, ...limits });
    }
  }
  return out;
}

// ── Auto model-reconcile (MCP side of the shared pre-flight) ────────────
// Assess dead/new OpenRouter models before a work tool runs, adopt free ($0),
// write settings, and fire the $0 benchmark on a class change. Throttled ≤1×/hr
// via a shared state file, so at most one catalog fetch per hour regardless of
// how many tools are called. Never throws into the tool (the shell swallows all).

/** Tools that do NOT send LLM requests — pure status/meta and the assessment
 *  machinery itself. They skip reconcile so:
 *   • `discover`/`reset`/`get_settings` stay instant (no catalog fetch);
 *   • the `or_model_info*` lookups match the CLI surface, whose `model-info`
 *     twin is explicitly skipped — a read-only query must not first rewrite
 *     settings and spawn a background benchmark;
 *   • `assess_model`/`check_model_health`/`discover_new_models` report on the
 *     config AS THE USER HAS IT — reconcile rewriting free_models one moment
 *     before a health check would make the report describe a config the user
 *     never saw (and they ARE the assessment layer; reconciling before them is
 *     the same circularity that keeps benchmark/index.ts main() unwired). */
const RECONCILE_SKIP_TOOLS = new Set([
  "discover",
  "reset",
  "get_settings",
  "profile",
  "list_profiles",
  "or_model_info",
  "or_model_info_json",
  "or_model_info_table",
  "assess_model",
  "check_model_health",
  "discover_new_models",
  // Local-service scan is its own configuration entry point — it must run
  // (and print a usable list) even before any profile is reconciled, and it
  // never sends an LLM request itself.
  "scan_local_llm_services",
]);

// WHY derived from the accepted-types table (tools/definitions.ts), not a second list: mass scouting takes its model from a
// scouting-type profile (D34), so the ACTIVE profile's pool gate and free-pool model injection must not apply to it.
let scoutingOnlyTools: ReadonlySet<string> | undefined;
export function isScoutingOnlyTool(name: string): boolean {
  scoutingOnlyTools ??= new Set(
    buildTools("").filter((t) => t.acceptedProfileTypes.length === 1 && t.acceptedProfileTypes[0] === "scouting").map((t) => t.name),
  );
  return scoutingOnlyTools.has(name);
}

// WHY one function (TRDD-CQSODQ78): the dispatch pre-flight and the CLI --estimate branch must agree on whether the selected dynamic profile may run. --estimate returns before dispatchCallTool, so without this shared check it priced a run the real command refuses (paid without allow_paid_models).
export function profileGateRefusal(toolName: string): ReturnType<typeof dynamicProfileGate> {
  if (RECONCILE_SKIP_TOOLS.has(toolName) || isScoutingOnlyTool(toolName)) return null;
  const effective = effectiveProfileName(activeSettings);
  return isDynamicProfileName(effective) ? dynamicProfileGate(effective, toolName, { settings: activeSettings }) : null;
}
async function runModelReconcile(): Promise<void> {
  await reconcileModelsBeforeWork({
    now: () => Date.now(),
    env: process.env,
    readLastRunMs: readLastReconcileMs,
    writeLastRunMs: writeLastReconcileMs,
    fetchCatalog: async () => {
      const cat = await fetchOpenRouterModels();
      const ids = new Set(cat.map((m) => m.id));
      const catalogById = new Map(cat.map((m) => [m.id, m]));
      const freeIds = cat.map((m) => m.id).filter(isFreeSuffixModelId);
      const freeQualified = filterFreeModels(freeIds, catalogById, benchmarkFailedModels());
      return { ids, freeQualified };
    },
    getConfigured: (): ReconcileConfigured | null => {
      if (!activeResolved || getCurrentBackend().type !== "openrouter") return null;
      const ensemble = [
        activeResolved.model,
        activeResolved.secondModel,
        activeResolved.thirdModel,
      ].filter((x): x is string => typeof x === "string" && x.length > 0);
      const toolModels = Object.values(activeResolved.toolModels ?? {}).filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
      // The PERSISTED pool, not activeResolved.freeModels: the resolver leaves the
      // latter empty on a paid profile, which would make every reconcile look like
      // a change and rewrite settings every hour. The raw settings value is what
      // applyFreePoolToSettings actually compares against.
      //
      // P6b-fix B2 — the NAME comes from the in-memory effective profile, the
      // same value the dispatch site branched on, NOT from a fresh
      // loadSettings() of the disk `active:` key. `overrideActiveProfile`
      // (--profile) only ever sets the in-memory name, while the shipped
      // default writes `active: "free"` to disk — so under `--profile
      // <anything static>` this legacy arm read "free", reconciled the DYNAMIC
      // free profile's pool, and wrote it back through a writer that takes no
      // settings.write.lock. That is precisely the "two decision engines racing
      // the same settings.yaml section" the dispatch branch claims to prevent,
      // and it also pinned `isStatic` to false for every static profile, so the
      // dead-id WARNING this line exists to produce never fired.
      const s = loadSettings();
      const sActiveName = effectiveProfileName(activeSettings);
      const rawFree = s ? s.profiles[sActiveName]?.free_models : undefined;
      const freePool = Array.isArray(rawFree)
        ? rawFree.filter((v): v is string => typeof v === "string")
        : [];
      // P4 hand-off (P6b item 1): the CLI's makeCliReconcileDeps already sets
      // this same expression (model-reconcile.ts:519) so a static profile's
      // dead ids get a WARNING instead of a silent rewrite (reconcileModels
      // BeforeWork's isStatic branch). This MCP-side literal never carried it
      // before, so the warning never fired here — wiring it now, mirroring
      // the CLI side exactly rather than re-deriving a second definition of
      // "static" that could drift from it.
      return { ensemble, freePool, toolModels, isStatic: !isDynamicProfileName(sActiveName) };
    },
    benchmarkFailed: () => benchmarkFailedModels(),
    benchmarkPassed: () => benchmarkPassedModels(),
    applyFreePool: (pool) => {
      try {
        const s = loadSettings();
        if (!s || !activeResolved) return false;
        // P6b-fix B2 — same in-memory effective name as getConfigured above,
        // plus a hard refusal for a dynamic one. `profiles.free`/`profiles.paid`
        // have exactly ONE writer, writeDynamicProfileSection, which holds
        // settings.write.lock, writes the generated marker and backs up a
        // hand-authored section first; this writer does none of those. Reaching
        // here with a dynamic name would mean the dispatch branch routed a
        // dynamic profile down the legacy arm, which is a wiring bug worth a
        // line rather than a silent lockless write.
        const reconcileProfileName = effectiveProfileName(activeSettings);
        if (isDynamicProfileName(reconcileProfileName)) {
          process.stderr.write(
            `[llm-externalizer] Model reconcile: refusing to write the generated '${reconcileProfileName}' ` +
              `profile from the legacy reconcile path — that section is maintained by the dynamic-profile ` +
              `maintainer under the settings write lock.\n`,
          );
          return false;
        }
        applyFreePoolToSettings(getSettingsPath(), reconcileProfileName, pool);
        // Update the in-memory pool the current run reads, so a later
        // activeFreePool()/resolveAutoFreePool() read sees the freshly-
        // reconciled list instead of the boot-time one. TRDD-OE27RD7I
        // addendum 4 deleted the sticky auto-free engaged-pool refresh this
        // used to also do here (engageAutoFree/autoFreePool no longer exist).
        activeResolved.freeModels = [...pool];
        return true;
      } catch (err) {
        process.stderr.write(
          `[llm-externalizer] Model reconcile: could not write free pool to settings: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        return false;
      }
    },
    // free-pool-auto-bench.ts retired (P6b item 6): this is the MCP-side
    // reconcile deps, reached now ONLY for a STATIC (non-'free'/'paid')
    // profile — the dispatch site skips runModelReconcile entirely for a
    // dynamic effective profile (see dispatchCallToolInner).
    //
    // DO NOT restore a real trigger here. The WHY is Rule 5, not a second
    // populator to defer to: a STATIC profile is the user's own document and
    // is NEVER rewritten by this codebase, so there is no benchmark for this
    // hook to launch. (It used to defer to the legacy trio's own lazy
    // population, which P6c-a retired; a reader who "fixes" the no-op on that
    // premise would reintroduce a second, separately-locked auto-bench racing
    // the maintainer over the SAME settings.yaml — the two-locks-one-file
    // hazard design §2.4's addendum calls out.) Mirrors the CLI-side stub in
    // model-reconcile.ts's makeCliReconcileDeps.
    launchFreeBench: () => {},
    log: (m) => process.stderr.write(m),
  });
}

/** D2 item 6: every free model the rotation tried has failed. On a DYNAMIC
 *  profile (the `free` one) that is "all models of the profile are failing":
 *  failDynamicProfile starts its background update and answers retry-later
 *  -- before D2 this path triggered no update at all (C5b "Row 27 free").
 *  A static free_only profile keeps the exhaustion as it was. */
function freeRotationExhausted(err: unknown): unknown {
  const name = activeResolved?.name;
  if (!(err instanceof AllFreeModelsExhaustedError) || name === undefined || !isDynamicProfileName(name)) return err;
  return failDynamicProfile(name, [new Error(err.lastDetail)], () => err);
}


/** The breaker verdict as a thrown error; callers branch on this type, not on the verdict wording. */
export class ServiceAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAbortError";
  }
}


/**
 * Round C item 4 (TRDD-YG72CYY7): the single-model paths have no ensemble slot
 * to convert a serviceAbort verdict (chatCompletionWithRetry RETURNS the
 * breaker's "SERVER ISSUE DETECTED..." abort as StreamingResult), so the
 * breaker text would become the model's answer. Convert it to a thrown error
 * here — the ensemble contract (ensemble slots convert the verdict via
 * resp.serviceAbort) keeps its returned verdict; only these callers wrap.
 * One implementation, four sites.
 */
function ensureNotServiceAbort(resp: StreamingResult): StreamingResult {
  if (resp.serviceAbort === true) throw new ServiceAbortError(resp.content || "circuit breaker abort");
  return resp;
}

/** One free-pool call with rotation, for the paths that have no ensemble slots
 *  (a ':free' modelOverride, ensemble:false, or a file too large for every
 *  ensemble primary). Throws AllFreeModelsExhaustedError only after every
 *  approved free model has actually been tried and failed (on a dynamic
 *  profile, what freeRotationExhausted turns it into). */
async function callSingleWithFreeRotation(
  primary: RotationCandidate,
  fallbacks: readonly RotationCandidate[],
  messages: ChatMessage[],
  options: Record<string, unknown>,
): Promise<StreamingResult> {
  try {
    // Round C item 4: the rotation hands a serviceAbort verdict straight back
    // (classifyUnavailable returns null on "server issue detected" — its
    // livelock guard), so the breaker text would surface as model content.
    return ensureNotServiceAbort(
      await callWithFreeRotation<StreamingResult>(
        primary,
        fallbacks,
        (model, maxOutput) =>
          chatCompletionWithRetry(
            messages,
            {
              ...options,
              model,
              maxTokens: Math.min(
                (options.maxTokens as number | undefined) ?? maxOutput,
                maxOutput,
              ),
            },
            providerDeps,
          ),
        {
          resultFailureDetail: (r) => (r.finishReason === "error" ? r.content : null),
          onRotate: logRotation,
          // The dispatch's shared clock: no candidate starts once it is closed.
          retryClock: options.retryClock as RetryClock | undefined,
        },
      ),
    );
  } catch (err) {
    throw freeRotationExhausted(err);
  }
}

/** chatCompletionJSON with free-pool rotation — check_imports' structured-output
 *  path, which calls the completion layer directly rather than through
 *  ensembleStreaming. chatCompletionJSON THROWS on an API error (its result shape
 *  carries no error content), so the rotation's catch path is the whole story
 *  here — no resultFailureDetail seam is needed. */
async function chatCompletionJSONWithFreeRotation(
  messages: ChatMessage[],
  options: Parameters<typeof chatCompletionJSON>[1],
): Promise<JSONCompletionResult> {
  // One retry clock for this whole dispatch (TRDD-YG72CYY7): every rotated
  // model shares one five-minute window instead of getting its own.
  const scoped = { ...options, retryClock: {} as RetryClock };
  const pool = isFreeModeActive() ? buildFreeRotationPool() : [];
  if (pool.length === 0) {
    return chatCompletionJSON(messages, scoped, providerDeps);
  }
  try {
    return await callWithFreeRotation<JSONCompletionResult>(
      pool[0],
      pool.slice(1),
      (model, maxOutput) =>
        chatCompletionJSON(
          messages,
          {
            ...scoped,
            model,
            maxTokens: Math.min(scoped.maxTokens ?? maxOutput, maxOutput),
          },
          providerDeps,
        ),
      {
        onRotate: logRotation,
        retryClock: scoped.retryClock,
      },
    );
  } catch (err) {
    throw freeRotationExhausted(err);
  }
}

/** One walk of `profileChain` over `profile`. Throws `ProfileExhaustedError`
 *  once the chain runs out (profileChain's own contract); never returns
 *  without either resolving or throwing. D2: walked exactly once per call --
 *  a dynamic profile's update runs in the background, never before a retry. */
async function walkProfileChainOnce(
  profile: ResolvedProfile,
  messages: ChatMessage[],
  options: SimpleCompletionOptions,
  deps: CompletionDeps,
  tool: string,
): Promise<StreamingResult> {
  const gen = profileChain(profile, tool);
  let next = gen.next();
  let lastErr: unknown;
  // Each failed entry's cause, as the generator would have collected it.
  const collected: unknown[] = [];
  while (!next.done) {
    const { modelId, route } = next.value;
    try {
      // D6a: the walk yields the entry's OWN serving group — a model served
      // by two groups is walked once per group, and each attempt must go to
      // the group being tried, not to routeForModel's first match.
      // Round C item 4: a serviceAbort verdict thrown here feeds the walk's
      // catch (recorded as the entry's cause), never returned as content.
      return ensureNotServiceAbort(
        await chatCompletionWithRetry(messages, { ...options, model: modelId, route }, deps),
      );
    } catch (err) {
      lastErr = err;
      // WHY the walk stops here and never reports the deadline to the generator
      // (only for a closed SHARED window: a call with a private clock, or one
      // model's own Retry-After refusal, is an ordinary failure of that entry and
      // the walk goes on): the shared clock is closed, so every later entry would throw a
      // zero-request RetryDeadlineError, and on a DYNAMIC profile the generator's
      // exhaustion goes to failDynamicProfile, which starts a background update
      // and aborts the batch as "retry later" for what is only one file running
      // out of time. "static" passes through chatCompletionWithProfileFallback
      // (it converts only "dynamic") and classifyError's deadline branch makes it
      // final for THIS file only. The earlier causes ride along for the record
      // only: that branch decides, so an earlier 401 or 402 does not abort the
      // batch here; the next file meets it again and the "3 of the last 3
      // failed" rule still stops a dead batch.
      // round C0a item 1 dropped the old `options.retryClock` test: this walk
      // always runs under the dispatcher's shared clock, and "shared" is now a
      // property of the error — only a genuinely closed SHARED window has
      // dispatchClosed true.
      if (err instanceof RetryDeadlineError && err.dispatchClosed) {
        throw new ProfileExhaustedError(profile.name, "static", [...collected, err]);
      }
      // failureText: a RetryDeadlineError's neutral message hides the network
      // code / payment wording its cause carries; the endpoint-dead and credit
      // tests below must read the cause.
      const msg = failureText(err);
      // ponytail: a single connection-refusal marks the endpoint dead for
      // the rest of THIS walk (addendum 2); the "one delayed retry before
      // marking dead, for a local runner restarting under load" ceiling is
      // a follow-up (0b), not this phase's job -- a bare substring match on
      // the common connection-failure codes is the whole classifier here.
      const isEndpointDead = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(msg);
      // D4 (design section 6): a CERTAIN payment error is the KEY's credit,
      // not the model — the walk marks `url + keyRef` dead and continues
      // with the SAME id's next group (a different key). keyRef is
      // secret-free, so it can ride the failure harmlessly. The cause text
      // names the group and model (the USER template; route.name falls back
      // to the preset name, which deriveGroupNames already guarantees).
      const isCreditDead =
        route !== undefined &&
        paymentErrorCertainty(msg) === "certain";
      // `error` rides on the exhaustion's `causes` so classifyError can key the
      // per-file loop's verdict on WHY the chain ran out, not just that it did.
      // D4: a credit failure's cause is EXACTLY the USER template naming the
      // group and model (D4 review F4 — no "(raw: …)" suffix); the raw
      // provider error goes to the stderr log line instead. Anything else
      // keeps the raw error verbatim.
      if (isCreditDead) {
        process.stderr.write(
          `[llm-externalizer] ${route?.name ?? "unknown"}: ${modelId} failed with: ${msg.split("\n")[0].slice(0, 200)}\n`,
        );
      }
      const causeError = isCreditDead
        ? new Error(
            `Provider ${route?.name ?? "unknown"} report insufficient credits for using the ${modelId} model with this key.`,
          )
        : err;
      collected.push(causeError);
      next = gen.next({
        kind: isEndpointDead ? "endpoint" : isCreditDead ? "credit" : "model",
        error: causeError,
      }); // throws ProfileExhaustedError once exhausted
    }
  }
  // profileChain always throws ProfileExhaustedError before ever yielding
  // `done: true` (see its own doc comment) -- this line is unreachable, kept
  // only so TypeScript sees every path return/throw.
  throw lastErr;
}

/**
 * The single-model completion call, driven through the ACTIVE profile's own
 * fallback chain (TRDD-OE27RD7I 14.1-C2 §0/§1). Replaces the deleted
 * cross-profile borrows (402 -> free, paid -> free) at the ONE place that
 * previously had no fallback left at all after C1 removed them: a funded,
 * non-ensemble, non-pool call used to recover via FREE_MODEL_ID on failure;
 * now it walks `profileChain(activeResolved)` -- the SAME profile's own
 * secondModel/thirdModel (STATIC) or written free/paid pool (DYNAMIC) --
 * and only gives up once every entry in ITS OWN list has failed.
 *
 * On a DYNAMIC exhaustion (free/paid/local) there is no update, no wait and
 * no second walk here any more (D2, USER 2026-09-18: "the profile updating
 * must happens in background"): failDynamicProfile decides between the
 * actionable error (credit / key / this request) and "start the background
 * update, answer retry later".
 *
 * Resolves the profile LAZILY, at the first real completion attempt (TRDD-
 * OE27RD7I 14.1-C2 §3b) -- an info tool that never calls this never pays for
 * (or fails on) a profile it doesn't need.
 *
 * Does NOT wrap every chatCompletionWithRetry call site: an explicit
 * modelOverride/pool/ensemble-selected model is the CALLER's deliberate
 * choice (see ensembleStreaming's own "rotating it could bill a second
 * model the user never asked for" comment) and must stay pinned, not be
 * silently walked to a different model in the chain.
 */
async function chatCompletionWithProfileFallback(
  messages: ChatMessage[],
  options: SimpleCompletionOptions,
  deps: CompletionDeps,
  tool = "default",
): Promise<StreamingResult> {
  if (!activeResolved) {
    // Same wording overrideActiveProfile's dangling-active error family
    // uses elsewhere -- a null activeResolved this late means selection
    // never ran or failed silently for a tool that DOES need a backend.
    throw new Error("no resolved profile is active -- fix settings.yaml and retry");
  }
  const profileName = activeResolved.name;
  try {
    return await walkProfileChainOnce(activeResolved, messages, options, deps, tool);
  } catch (err) {
    if (!(err instanceof ProfileExhaustedError) || err.kind !== "dynamic" || !isDynamicProfileName(profileName)) {
      throw err;
    }
    // D2: ONE walk, then the verdict. The actionable form is the static
    // exhaustion carrying the causes classifyError keys on (credit verdict,
    // key error, or this file only) -- the text the pre-D2 "exhausted again
    // after the update" path produced, unchanged.
    throw failDynamicProfile(profileName, err.causes, (causes) => new ProfileExhaustedError(profileName, "static", causes));
  }
}

async function ensembleStreaming(
  messages: ChatMessage[],
  callerOptions: {
    temperature?: number;
    maxTokens?: number;
    onProgress?: ProgressFn;
    modelOverride?: string; // skip ensemble, use this specific model
    // High-quality-scan knobs (TRDD-DBUSM55E). Forwarded via the {...options}
    // spread to the single-model path (modelOverride / no-ensemble branches);
    // the 3-model ensemble path also spreads them but high_quality_scan always
    // takes the modelOverride branch, so the ensemble is never affected.
    provider?: Record<string, unknown>;
    cache?: boolean;
    reasoning?: ReasoningEffortSetting;
  },
  ensemble: boolean,
  fileLineCount?: number,
): Promise<StreamingResult> {
  // T2.7 — snapshot once for the type gating below. The old
  // `backend.type !== "openrouter"` ensemble gate is GONE (D-L): the gate is
  // "every member has a route" now, so the snapshot itself is no longer read.
  const freeMode = isFreeModeActive();
  // One retry clock for this whole dispatch (TRDD-YG72CYY7): every rotated
  // model, chain entry and ensemble slot below spreads `options`, so all of
  // them share one five-minute window instead of getting a fresh one each.
  const options = { ...callerOptions, retryClock: {} as RetryClock };

  // Model override: skip the ensemble, use the specified model.
  //
  // A ':free' override STILL ROTATES — and the gate here is the OVERRIDE's own
  // ':free' suffix, NOT freeMode, on purpose: an explicit `free: true` call on a
  // FUNDED profile is still a free call, and it used to pin the single
  // FREE_MODEL_ID, so that model's daily cap was a hard failure while a whole
  // approved pool sat unused. A PAID override (high_quality_scan) is left exactly
  // as it was — rotating it could bill a second model the user never asked for,
  // which is the one thing rotation must never do.
  if (options.modelOverride) {
    if (isFreeSuffixModelId(options.modelOverride)) {
      const primaryLimits = resolveEnsembleModelLimits(options.modelOverride, undefined);
      const pool = buildFreeRotationPool(
        fileLineCount,
        new Set([options.modelOverride]),
      );
      return callSingleWithFreeRotation(
        { id: options.modelOverride, maxOutput: primaryLimits.maxOutput },
        pool,
        messages,
        options,
      );
    }
    // The pinned model IS the whole chain (no rotation, per the comment
    // above) -- so its failure is exhaustion, not a raw provider error.
    // Without this, a caller-pinned model that goes dead surfaced whatever
    // sanitizeProviderError produced (a raw "API error NNN" string), one
    // more error vocabulary alongside the chain-walk's own exhaustion
    // sentence for the exact same user-facing situation: no model in
    // "the profile" (here, a chain of exactly one) is answering.
    try {
      // Round C review H1: the breaker verdict is RETURNED by chatCompletionWithRetry, so only a throw here reaches the catch below instead of the scan report as model content.
      return ensureNotServiceAbort(
        await chatCompletionWithRetry(
          messages,
          { ...options, model: options.modelOverride },
          providerDeps,
        ),
      );
    } catch (err) {
      // Keep the real error as the cause: a 402 here must abort the whole
      // batch (classifyError), a 413 for this one file must not.
      // A breaker abort is no model failure: without its verdict the user reads "the models are all failing" for a provider outage (review M-A).
      // Typed check: callers branch on the error class, never on the verdict wording.
      throw new ProfileExhaustedError(
        activeResolved?.name ?? "unknown",
        "static",
        [err],
        err instanceof ServiceAbortError ? err.message : undefined,
      );
    }
  }

  // Single-model path: ensemble off, not remote-ensemble (and no reserved
  // slots — D-L), or no models configured. D-L (design §7): the old
  // `backend.type !== "openrouter"` gate is replaced by "every member has a
  // route" — a local/other-backend profile with reserved slots fans out to
  // them (each member's send rides its own serving group), and a member
  // without a route cannot be fanned out at all.
  const ensembleModels = getEnsembleModels();
  const everyMemberHasRoute =
    ensembleModels.length > 0 && ensembleModels.every((m) => m.route !== undefined);
  if (
    !ensemble ||
    ensembleModels.length === 0 ||
    !everyMemberHasRoute
  ) {
    // Free mode ONLY: one model at a time is still ONE model at a time —
    // rotation is failover, not ensembling — so a rate-limited free model hands
    // off to the next approved free one instead of failing the call. A funded
    // profile keeps its own model and its existing backoff.
    const pool = freeMode ? buildFreeRotationPool(fileLineCount) : [];
    if (pool.length > 0) {
      return callSingleWithFreeRotation(pool[0], pool.slice(1), messages, options);
    }
    // TRDD-OE27RD7I 14.1-C2 §0: funded, non-ensemble, non-pool call -- the
    // one path C1 left with NO fallback at all (the deleted 402->free borrow
    // was its only recovery). Walks the profile's OWN chain instead.
    return chatCompletionWithProfileFallback(messages, options, providerDeps);
  }

  // Filter models by file size limit
  const models = ensembleModels.filter(
    (m) => !fileLineCount || fileLineCount <= m.maxInputLines,
  );
  if (models.length === 0) {
    // Every ensemble primary is too small for this file. Under free mode the
    // approved pool may still hold a larger-context model BEYOND the top 3, so
    // rotate over the size-filtered pool before giving up on the file.
    const pool = freeMode ? buildFreeRotationPool(fileLineCount) : [];
    if (pool.length > 0) {
      return callSingleWithFreeRotation(pool[0], pool.slice(1), messages, options);
    }
    // TRDD-OE27RD7I 14.1-C2 §0: funded, non-ensemble, non-pool call -- the
    // one path C1 left with NO fallback at all (the deleted 402->free borrow
    // was its only recovery). Walks the profile's OWN chain instead.
    return chatCompletionWithProfileFallback(messages, options, providerDeps);
  }

  // Free-mode rate-limit fallback rotation (TRDD-8b6b3646 Phase 3). Free providers
  // all impose a DAILY request cap, so when a slot's model is rate/daily-limited we
  // rotate to the next APPROVED free model — the pool BEYOND the ensemble's top-3,
  // file-size-aware — rather than failing the slot. A shared atomic counter stops
  // two parallel slots grabbing the same fallback. Empty for non-free profiles.
  const primaryIds = new Set(models.map((m) => m.id));
  const rawFallbacks = freeMode ? buildFreeRotationPool(fileLineCount, primaryIds) : [];
  // Order the shared list ONCE, here — cooling models sink to the back but are
  // never removed (a wrong cooldown may only reorder attempts). It MUST be done
  // once for the whole call, not per slot: the slots share one index counter, so
  // two slots resolving the same index to different models would let both grab
  // the same model and starve another.
  const { fresh, deferred } = orderByAvailability(
    rawFallbacks,
    getCooldownStore(),
    Date.now(),
  );
  const fallbacks = [...fresh, ...deferred];
  let nextFallback = 0;
  const claimFallback = () => nextFallback++;

  // Single qualifying model AND no fallbacks to rotate to — no need to combine.
  if (models.length === 1 && fallbacks.length === 0) {
    // Round C item 4: the breaker's abort verdict must throw here, not return
    // as the model's content (the ensemble path converts its own).
    return ensureNotServiceAbort(
      await chatCompletionWithRetry(
        messages,
        {
          ...options,
          model: models[0].id,
          maxTokens: Math.min(
            options.maxTokens ?? models[0].maxOutput,
            models[0].maxOutput,
          ),
        },
        providerDeps,
      ),
    );
  }

  // Run all qualifying models in parallel — wait for ALL to finish.
  // The MCP timeout is configured by the user on the Claude Code side.
  // D5: each member's send rides the member's OWN serving group (`route`) —
  // resolveConnection uses `options.route ?? deps.routeForModel(model)`, so a
  // reserved slot pinned to a non-first group (or a multi-group model) reaches
  // the group the slot names, not routeForModel's first match.
  const results = await Promise.all(
    models.map(async (m) => {
      const callOne = (model: string, maxOutput: number) =>
        chatCompletionWithRetry(
          messages,
          {
            ...options,
            model,
            maxTokens: Math.min(options.maxTokens ?? maxOutput, maxOutput),
            route: m.route,
          },
          providerDeps,
        );
      // Free mode: rotate to another approved free model on a rate/daily-limit
      // error — and remember, across calls, which ones are spent.
      if (freeMode) {
        return callEnsembleSlotWithRotation(m, fallbacks, claimFallback, callOne, {
          // The dispatch's shared clock: the rotation ends as soon as the
          // window closes, instead of handing the next fallback to a call that
          // will make zero requests (TRDD-YG72CYY7).
          retryClock: options.retryClock,
        });
      }
      try {
        const resp = await callOne(m.id, m.maxOutput);
        // chatCompletionWithRetry RETURNS (does not throw) the circuit
        // breaker's abort verdict: taking its text as the model's answer would
        // count a "SERVER ISSUE DETECTED" notice as a successful slot. Only the
        // flagged verdict counts: a provider finish_reason=error reply (also
        // finishReason "error") is a truncated partial answer and stays a
        // successful slot, as before.
        const isError = resp.serviceAbort === true;
        return {
          model: m.id,
          content: isError ? `ERROR: ${resp.content}` : resp.content,
          usage: resp.usage,
          truncated: resp.truncated,
          error: isError,
        };
      } catch (err) {
        return {
          model: m.id,
          content: slotErrorContent(err),
          usage: undefined,
          truncated: false,
          error: true,
          cause: err,
        };
      }
    }),
  );

  // Separate successful from failed model responses
  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  // ALL models failed — propagate error
  if (succeeded.length === 0) {
    const errorSummary = failed.map((r) => `${r.model}: ${r.content}`).join("; ");
    const allFailed = new Error(`All ensemble models failed: ${errorSummary}`);
    // D2 items 10/11: no slot answered, so on a DYNAMIC profile every model of
    // the profile is failing (USER point 3.3: a reserved slot counts as a
    // working model -- none exists at runtime today, so "no slot answered" is
    // the whole test). Each slot's error is one cause; the actionable form is
    // this same error, which classifyError reads as before.
    const profileName = activeResolved?.name;
    // Selection (and its WHY) lives in pickEnsembleAllFailedError. The per-model
    // detail of `allFailed` is lost when something else is thrown (the static
    // exhaustion has a fixed message), so write it to stderr first.
    const surfaced = pickEnsembleAllFailedError(profileName ?? "unknown", failed, allFailed);
    if (surfaced !== allFailed) {
      // Capped at 1000 characters: slot text can hold a long partial reply.
      process.stderr.write(`[llm-externalizer] ${allFailed.message.slice(0, 1000)}\n`);
      // WHY thrown before the dynamic-profile branch: a closed retry window is
      // one file running out of time, not a profile with no working model, so it
      // must not start a background update or abort the batch as "retry later".
      // The walk and the rotation already end it file-level; classifyError's
      // deadline branch makes this one final for this file only.
      throw surfaced;
    }
    if (profileName !== undefined && isDynamicProfileName(profileName)) {
      throw failDynamicProfile(profileName, failed.map((r) => new Error(r.content)), () => surfaced);
    }
    throw surfaced;
  }

  // Some models failed — log warning, continue with successful ones
  if (failed.length > 0) {
    for (const f of failed) {
      // First line, 300 chars: a partial reply must not be dumped to stderr.
      const shortContent = (f.content.split("\n")[0] ?? "").slice(0, 300);
      process.stderr.write(
        `[llm-externalizer] Ensemble model unavailable: ${f.model} — ${shortContent}. Continuing with ${succeeded.length} model(s).\n`,
      );
    }
  }

  // Combine only successful model outputs
  const parts = succeeded.map((r) => `## Model: ${r.model}\n\n${r.content}`);
  if (failed.length > 0) {
    parts.push(`## Unavailable models\n\n${failed.map((r) => `- **${r.model}**: ${r.content}`).join("\n")}`);
  }
  const combined = parts.join("\n\n---\n\n");

  // Merge usage stats across successful models only
  const usage = {
    prompt_tokens: succeeded.reduce(
      (s, r) => s + (r.usage?.prompt_tokens ?? 0),
      0,
    ),
    completion_tokens: succeeded.reduce(
      (s, r) => s + (r.usage?.completion_tokens ?? 0),
      0,
    ),
    total_tokens: succeeded.reduce((s, r) => s + (r.usage?.total_tokens ?? 0), 0),
    cost: succeeded.reduce((s, r) => s + (r.usage?.cost ?? 0), 0),
  };

  const anyTruncated = succeeded.some((r) => r.truncated);

  return {
    content: combined,
    model: succeeded.map((r) => r.model).join(" + "),
    usage,
    finishReason: "stop",
    truncated: anyTruncated,
  };
}

// ── Core file processing functions ──────────────────────────────────
// Reusable logic shared by single-file tools and batch operations.

interface ProcessOptions {
  language?: string;
  maxTokens?: number;
  batchId?: string; // if set, uses batch-style report filenames
  fileIndex?: number; // disambiguates files with same basename in a batch
  redact?: boolean; // redact secrets before sending to LLM
  regexRedact?: RegexRedactOpts | null; // user-defined regex redaction
  onProgress?: ProgressFn; // MCP progress notifications to keep client alive
  ensemble?: boolean; // run on multiple models and combine results (default true)
  maxBytes?: number; // max file size in bytes (default: DEFAULT_MAX_PAYLOAD_BYTES)
  modelOverride?: string; // skip ensemble, use this specific model (e.g. free mode)
  outputDir?: string; // custom output directory for reports
  hqRequest?: HighQualityRequest; // high_quality_scan provider/reasoning/cache (TRDD-DBUSM55E)
}

async function processFileCheck(
  filePath: string,
  task: string,
  options: ProcessOptions = {},
): Promise<FileProcessResult> {
  if (!existsSync(filePath)) {
    return { filePath, success: false, error: `File not found: ${filePath}` };
  }
  const codeBlock = readFileAsCodeBlock(
    filePath,
    options.language,
    options.redact,
    options.maxBytes,
    options.regexRedact,
  );
  const lang = options.language || detectLang(filePath);
  // Derive line count from the already-read code block (avoid double file read)
  const fileLineCount = codeBlock.split("\n").length;
  const useEnsemble = options.ensemble !== false; // default true

  const perFileUserContent = `${buildPreInstructions(true, "read")}Task: ${task}\n\n${codeBlock}`;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: codeTaskSystemPrompt(lang),
    },
    {
      role: "user",
      // Kept in a variable: it is also the response gate's echo ground truth.
      content: perFileUserContent,
    },
  ];

  const resp = await ensembleStreaming(
    messages,
    {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: options.maxTokens ?? resolveDefaultMaxTokens(),
      onProgress: options.onProgress,
      modelOverride: options.modelOverride,
      // High-quality-scan knobs (TRDD-DBUSM55E). Only the high_quality_scan tool
      // sets options.hqRequest; for every other scan these are undefined → the
      // request is unchanged. reasoning is the validated config wire-string, cast
      // to the effort union here at the index.ts boundary (core.ts uses string).
      provider: options.hqRequest?.provider,
      cache: options.hqRequest?.cache,
      reasoning: options.hqRequest?.reasoning as ReasoningEffortSetting | undefined,
    },
    useEnsemble,
    fileLineCount,
  );

  const footer = formatFooter(resp, "code_task", filePath);

  // Shared response gate (TRDD-P4ULUV1R): empty AND echoed responses are
  // failures — "the model printed something" is not success.
  {
    const verdict = gateLLMResponse(resp.content, perFileUserContent);
    if (verdict !== null) {
      return { filePath, success: false, error: gateFailureMessage(verdict) };
    }
  }

  // Save report — use batch filename if batchId is set
  const filename = options.batchId
    ? batchReportFilename(
        "batch_check",
        options.batchId,
        filePath,
        options.fileIndex ?? 0,
      )
    : undefined;
  const reportPath = saveResponse(
    "code_task",
    resp.content + footer,
    { model: resp.model, task, inputFile: filePath },
    filename,
    options.outputDir,
  );

  return { filePath, success: true, reportPath };
}

// ── Tool definitions ─────────────────────────────────────────────────

// Dynamic limits block appended to each task tool description.
// Changes based on which backend is active (local = sequential, OpenRouter = parallel).
// Exported because the CLI renders `--help` from buildTools(limitsBlock()) —
// the descriptions are backend-dependent, so help must be built per invocation
// rather than baked in at build time.
export function limitsBlock(): string {
  // T2.7 — snapshot once for the type read (function returns a string)
  const backend = getCurrentBackend();
  const throughput =
    backend.type === "openrouter"
      ? "• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches."
      : "• SEQUENTIAL: 1 call at a time.";
  return (
    "\n\nLIMITS:\n" +
    throughput +
    "\n" +
    `• ${SOFT_TIMEOUT_MS / 1000}s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.`
  );
}

// Ensemble is always ON for remote backends, OFF for local — not user-configurable.
// This ensures every file is analyzed by both models when using OpenRouter.

// Write tools disabled: no current OpenRouter model can faithfully return files >3000 lines.
// grok-4.1-fast abbreviates (uses 10% of output budget); gemini-2.5-flash hits 65K output ceiling.
// Keep the implementation code intact — re-enable when a model with sufficient output capacity appears.
// Track which tools make LLM calls — used by `reset` to wait for in-flight requests
const LLM_TOOLS_SET = new Set([
  "chat", "code_task", "batch_check", "scan_folder", "high_quality_scan",
  "compare_files", "check_references", "check_imports",
  "check_against_specs", "search_existing_implementations",
  "cluster_synonyms",
]);

// Ensemble: run both models in parallel for thorough analysis, combine results.
// In remote-ensemble mode, model + second_model from the active profile are used.
// Per-model limits (maxOutput catalog-preferred, maxInputLines calibrated) live
// in ./ensemble-limits.ts — see resolveEnsembleModelLimits + getEnsembleModels.

// FREE_MODEL_ID (the fixed "poolside/laguna-m.1:free" constant this used to
// be) is DELETED (fix-queue 98(2)): its last consumer, the `free: true`
// per-call flag (resolveModelOverride above), now resolves to the SELECTED
// profile's own first ':free' chain entry instead of a hard-coded id outside
// the profile (Rule 5 / USER addendum 4, "no exceptions").

/** Build the display label for ensemble model name */
function ensembleModelLabel(useEnsemble: boolean): string {
  // T2.7 — snapshot once for atomic .model read
  const backend = getCurrentBackend();
  if (!useEnsemble || !activeResolved?.secondModel) return backend.model;
  const models = [backend.model, activeResolved.secondModel];
  if (activeResolved.thirdModel) models.push(activeResolved.thirdModel);
  return `ensemble: ${models.join(" + ")}`;
}

/**
 * The free-pool selection helpers (FREE_FLOOR_MIN_CONTEXT_TOKENS,
 * filterFreeModels, selectFreeEnsembleModels) moved to ./free-rotation.ts and are
 * re-exported below. WHY: the CLI surfaces (mass_scout, security_scan, the
 * benchmark) must resolve the SAME approved pool, and they cannot import index.ts
 * — it is the MCP server entry point. Leaving the filter here would have forced
 * either an import cycle or a second copy of the approval rules, and two copies of
 * "which free models are allowed" is exactly the kind of drift that bills money.
 */
export {
  FREE_FLOOR_MIN_CONTEXT_TOKENS,
  filterFreeModels,
  selectFreeEnsembleModels,
} from "./free-rotation.js";

/**
 * True when an error string indicates the model is UNAVAILABLE (now or for the
 * rest of the day) and a DIFFERENT model should be tried — the free ensemble
 * rotates on this (TRDD-8b6b3646 Phase 3). Free providers ALL impose a daily
 * request cap, so daily-limit phrasing is explicitly covered: retrying the SAME
 * model after a daily 429 would just fail until the quota resets.
 *
 * Delegates to free-rotation's classifier, which is the SINGLE source of truth —
 * it also has to decide HOW LONG the model stays out (a spent daily quota needs
 * a UTC-midnight cooldown, a transient 429 needs seconds), and two independent
 * phrase lists would inevitably drift apart.
 */
export function isModelUnavailableError(detail: string): boolean {
  return classifyUnavailable(detail) !== null;
}

/** One ensemble slot's outcome. `cause` is the thrown error, set only by the
 *  catches; an entry without one is a returned verdict or a free-path error
 *  value, not a thrown failure. */
export type EnsembleSlotEntry = {
  model: string;
  content: string;
  usage: StreamingResult["usage"];
  truncated: boolean;
  error: boolean;
  cause?: unknown;
};

/** The `content` of an ensemble slot that threw. A RetryDeadlineError keeps its
 *  neutral sentence AND names the real cause (N1): its message alone hides
 *  "API error 503 ...", so every consumer reading the slot text saw a defect-less
 *  timeout. Any other error reads exactly as before (failureText == message). */
function slotErrorContent(err: unknown): string {
  return err instanceof RetryDeadlineError && err.cause !== undefined
    ? `ERROR: ${err.message} ${err.causeLabel} ${failureText(err)}`
    : `ERROR: ${failureText(err)}`;
}

/** What ensembleStreaming throws when no slot answered. Pure: no classifyError
 *  call (it has side effects: creditExhausted, signalRateLimitHit).
 *  Returns a static ProfileExhaustedError when at least one failed slot ended
 *  in a closed retry window AND every other failed slot is one of: no cause,
 *  also a closed retry window, or a deterministic request error (non-transient
 *  4xx that is not service-level). Otherwise returns `allFailed`.
 *  round C0a item 2 (B2): "closed retry window" now means dispatchClosed TRUE
 *  only. A dispatchClosed-false RetryDeadlineError (a provider Retry-After
 *  refusal beyond an open window, or a private-clock deadline) is an ordinary
 *  rate-limit error here: it keeps `allFailed`, and on a DYNAMIC profile the
 *  all-causes-dispatchClosed-false case then goes through failDynamicProfile
 *  (the pre-F4 behaviour, deliberate — such a refusal is not "one file running
 *  out of time", so the batch must be aborted as "retry later" instead).
 *  WHY: classifyError treats a static exhaustion with a RetryDeadlineError
 *  cause as final for the file. A slot that failed on a deterministic request
 *  error will fail again, so retrying the file only re-runs the other slot's
 *  five-minute window. A 401/402/403/404/410 slot must keep reaching
 *  classifyError's batch-level verdict, and any other mix (e.g. a plain 503)
 *  may succeed on a retry, so those keep `allFailed`. */
export function pickEnsembleAllFailedError(
  profileName: string,
  failed: readonly EnsembleSlotEntry[],
  allFailed: Error,
): Error {
  const causes = failed.map((r) => r.cause);
  // round C0a item 2 (B2): only a genuinely closed SHARED window is a "closed
  // retry window". A dispatchClosed-false deadline is one slot's own open-window
  // stop (a provider Retry-After refusal or a private clock) — a plain rate-limit
  // error, so it keeps `allFailed` and, on a DYNAMIC profile, the caller then
  // reaches failDynamicProfile (pre-F4 behaviour, deliberate: such a refusal is
  // not "one file running out of time").
  const isDeadline = (c: unknown) => c instanceof RetryDeadlineError && c.dispatchClosed;
  // Only a thrown Error counts. NON_TRANSIENT_4XX_RE already skips 408/429; 413
  // and a provider context-overflow text are excluded here too: a size error
  // for one model does not make the file hopeless (another model may fit it).
  const isRequestError = (c: unknown) => {
    if (!(c instanceof Error)) return false;
    const text = failureText(c);
    return (
      NON_TRANSIENT_4XX_RE.test(text) &&
      !SERVICE_LEVEL_STATUS_RE.test(text) &&
      !/API error 413\b/.test(text) &&
      !classifyContextOverflow(text)
    );
  };
  if (!causes.some(isDeadline)) return allFailed;
  if (!causes.every((c) => c === undefined || isDeadline(c) || isRequestError(c))) return allFailed;
  return new ProfileExhaustedError(
    profileName,
    "static",
    causes.filter((c) => c instanceof Error),
  );
}
/** One ensemble slot with free-model fallback rotation (TRDD-8b6b3646 Phase 3).
 *  Tries `primary`; on an unavailable/rate-limit/daily-limit error it claims the
 *  next SHARED fallback (`claimFallback` = `idx = next++`, atomic in
 *  single-threaded JS, so parallel slots never grab the same one) and retries —
 *  until a model succeeds or every approved free model has been tried.
 *
 *  The rotation itself now lives in free-rotation.ts, which ALSO remembers across
 *  calls which models are spent — so a 50-file scan stops paying one 429 per file
 *  to re-discover that yesterday's primary is daily-capped. This wrapper only
 *  adapts the generic rotation to the ensemble slot's value shape (a failure
 *  arrives as `finishReason: "error"`, and an exhausted pool must come back as an
 *  error ENTRY, not a throw, so the other slots' results still survive).
 *
 *  `hooks` is the test seam: pass `{ store: memoryRotationStore() }` to keep a
 *  unit test off the real ~/.llm-externalizer registry. */
export async function callEnsembleSlotWithRotation(
  primary: { id: string; maxOutput: number },
  fallbacks: ReadonlyArray<{ id: string; maxOutput: number }>,
  claimFallback: () => number,
  callOne: (model: string, maxOutput: number) => Promise<StreamingResult>,
  hooks: RotationHooks<StreamingResult> = {},
): Promise<EnsembleSlotEntry> {
  let attempted = primary.id;
  try {
    const resp = await callWithFreeRotation<StreamingResult>(
      primary,
      fallbacks,
      callOne,
      {
        ...hooks,
        onAttempt: (id) => {
          attempted = id;
          hooks.onAttempt?.(id);
        },
        resultFailureDetail: (r) => (r.finishReason === "error" ? r.content : null),
        onRotate: hooks.onRotate ?? logRotation,
      },
      claimFallback,
    );
    return {
      model: attempted,
      content: resp.content,
      usage: resp.usage,
      truncated: resp.truncated,
      error: resp.finishReason === "error",
    };
  } catch (err) {
    if (err instanceof AllFreeModelsExhaustedError) {
      // Report the LAST model actually attempted, so the ensemble's
      // "Unavailable models" section names something real.
      const last = err.tried[err.tried.length - 1] ?? primary.id;
      return { model: last, content: `ERROR: ${err.message}`, usage: undefined, truncated: false, error: true, cause: err };
    }
    // `attempted`, not primary.id: a non-availability error is rethrown from
    // whichever model was CURRENT — naming the primary would pin a fallback's
    // 400 on a model that never produced it. `cause` carries the thrown error
    // so ensembleStreaming can tell a closed retry window from other failures.
    return { model: attempted, content: slotErrorContent(err), usage: undefined, truncated: false, error: true, cause: err };
  }
}

/** Build ensemble model list from the active profile's model + second_model + third_model.
 *  D5 (TRDD-90DM5YHO, design §2.3): `members = reservedSlots` first, in written
 *  order, at most 2; the remaining `3 - members.length` come from the profile's
 *  ranking excluding reserved ids. Each member carries `route?` — the serving
 *  group its fan-out send targets (the slot's named group, or the first of
 *  routesFor(model)). Reserved members skip selection filtering, unusable
 *  substitution and free-rotation replacement (a failure surfaces as that
 *  member's error result) but stay subject to the free-mode cost check. */
function getEnsembleModels(): Array<{
  id: string;
  maxOutput: number;
  maxInputLines: number;
  route?: ResolvedRoute;
}> {
  // D-L (design §7): a dynamic profile fans out ensemble commands when its mode
  // is `remote-ensemble` OR it carries reserved slots — `local` (mode `local`)
  // with reserved slots is no longer inert, and a `remote-ensemble` profile
  // without slots behaves exactly as before.
  const hasReserved = (activeResolved?.reservedSlots?.length ?? 0) > 0;
  if (!activeResolved || !(activeResolved.mode === "remote-ensemble" || hasReserved)) return [];
  // Read the warm 1h-TTL catalog cache synchronously -- empty when cold, in which
  // case resolveEnsembleModelLimits falls back to the calibrated table.
  const catalogById = new Map(openRouterModelCache.map((m) => [m.id, m]));
  let models: string[];
  const reserved = activeResolved.reservedSlots ?? [];
  const reservedIds = new Set(reserved.map((s) => s.modelId));
  // Reserved members: mandatory (no substitution — a failure surfaces as that
  // member's error result at fan-out), still subject to the free-mode cost
  // check (a paid reserved id under free mode is refused, same form as the
  // auto-picked arm below). D-L's backend gate replacement: the openrouter
  // backend check at the fan-out site becomes "every member has a route";
  // enforced there — here we only note whether the gate can pass.
  const members: Array<{ id: string; maxOutput: number; maxInputLines: number; route?: ResolvedRoute }> = reserved.map((s) => {
    const catalogMaxOutput = catalogById.get(s.modelId)?.top_provider?.max_completion_tokens;
    const limits = resolveEnsembleModelLimits(s.modelId, catalogMaxOutput);
    return { id: s.modelId, ...limits, route: s.routes[0] };
  });
  // D5 spend guard (design §6 D5; §7 R-4 is WHY `local` is in scope): under
  // allow_paid_models:false a REMOTE profile is force-free, so the free-mode
  // cost check below covers it. A LOCAL profile is never forced free — without
  // this guard its reserved slots could reach a billable route (a `providers:`
  // group pointing at a paid host) and bill under the master switch. Same
  // refusal form as the free-mode check; billableForRoute is the same decider
  // resolveConnection uses, so it cannot drift from what the send would bill.
  if (!isFreeModeActive() && !getAllowPaidModels()) {
    const backendBillable = activeResolved.isLocal;
    const paid = members
      .filter((m) => billableForRoute(m.route, backendBillable) && !m.id.endsWith(":free"))
      .map((m) => m.id);
    if (paid.length > 0) {
      throw new Error(
        `allow_paid_models is false but the reserved ensemble slots name billable model(s): ${paid.join(", ")} — remove the slot, point it at a non-billable provider group, or set allow_paid_models: true.`,
      );
    }
  }
  if (isFreeModeActive()) {
    // Free pool: a free_only profile uses its pinned free_models; auto-free on
    // a paid profile (TRDD-542bdbef, low balance / 402) uses the engaged pool;
    // the master switch (allow_paid_models=false) forces free with no engaged
    // pool. activeFreePool() covers all three and never returns empty (seed
    // fallback), so a paid profile with no free_models still gets a working
    // ensemble. selectFreeEnsembleModels applies the requirements + benchmark
    // filters and takes the top 3; the FULL pool stays as rotation fallbacks.
    const pool = activeFreePool();
    // combinedFreeModelEvidence (task #189): rank the pool by per-tool bench
    // verdicts overlaid with runtime no-content demotions, so a model with a
    // PASSING bench outranks a never-benchmarked one, which outranks one with
    // scored failing rows or a length+empty strike record -- the 2026-08-05
    // unfit-trio incident (a content-safety classifier selected for code
    // review) had qualified:false rows on disk that selection ignored.
    // TRDD-FDI9NYAS D3c: same "auto-picked needs a recorded pass, manual is
    // exempt" gate as buildFreeRotationPool — see its own comment.
    // D5: the ranking EXCLUDES reserved ids — a slot's model is already a
    // member; ranking it again would fan the same send out twice.
    const ranked = selectFreeEnsembleModels(
      pool,
      catalogById,
      benchmarkFailedModels(),
      combinedFreeModelEvidence(),
      new Set([...benchmarkPassedModels(), ...(activeResolved.manualModels ?? [])]),
    ).filter((id) => !reservedIds.has(id));
    const rankedCapped = ranked.slice(0, Math.max(0, 3 - members.length));
    // Cost-safety (TRDD-542bdbef): under free mode every ensemble model MUST be
    // ':free' OR served by a free (non-billable) route -- a b.ai-pinned id has
    // no ':free' suffix but still cannot bill, and treating it as a cost-safety
    // violation would refuse a perfectly safe free ensemble (P3 design addendum
    // A / T1 AC4). getActiveBillableForModel is the SAME route-aware decider
    // resolveConnection uses for the actual send, so this can never drift from
    // what the real request would have billed. D5: the RESERVED members run
    // through the same check, on their OWN route.
    const paid = [...rankedCapped, ...members.map((m) => m.id)]
      .filter(
        (id) => !id.endsWith(":free") &&
          (members.some((m) => m.id === id && m.route
            ? billableForRoute(m.route, false)
            : getActiveBillableForModel(id))),
      );
    if (paid.length > 0) {
      throw new Error(
        `free-mode cost-safety: non-':free' model(s) in the free ensemble: ${paid.join(", ")}`,
      );
    }
    models = rankedCapped;
  } else if (activeResolved.dynamic) {
    // DYNAMIC (paid) profile: build slots from model/second_model/third_model,
    // then replace any slot whose model is currently unusable (P2's shared
    // cross-process verdict, free-rotation.ts::isUnusable) with the next
    // usable candidate from the profile's OWN pool (paidModels) not already
    // occupying a slot. (The deleted ensemble_pins key never protected a slot
    // at CALL TIME either — a pinned-but-unusable slot 0 was replaced exactly
    // like any other slot; D5 removed the key outright as never-read.)
    // A static profile never reaches this branch (see below).
    // D5: the ranking EXCLUDES reserved ids (a reserved member is mandatory —
    // substituting it away would defeat the reservation), and the
    // `3 - members.length` cap applies.
    const initialSlots = [
      activeResolved.model,
      activeResolved.secondModel,
      activeResolved.thirdModel,
    ].filter((x): x is string => typeof x === "string" && x.length > 0 && !reservedIds.has(x));
    const pool = activeResolved.paidModels ?? [];
    const used = new Set([...initialSlots, ...reservedIds]);
    const ranked = initialSlots.map((id) => {
      if (!isUnusable(id)) return id;
      const replacement = pool.find((cand) => cand !== id && !used.has(cand) && !isUnusable(cand));
      if (replacement === undefined) return id; // no usable candidate left -- keep it, the send itself will surface the real error
      used.delete(id);
      used.add(replacement);
      return replacement;
    }).slice(0, Math.max(0, 3 - members.length));
    models = ranked;
  } else {
    // STATIC profile: exactly what is written, never substituted (Rule 5 --
    // P3 design sec 4 / Phase 5). A static ensemble with an unusable model
    // fails fast on the send, by design. A static profile cannot carry
    // `ensemble:` (E-S1), so reservedIds is empty here by construction.
    models = [activeResolved.model];
    if (activeResolved.secondModel) models.push(activeResolved.secondModel);
    if (activeResolved.thirdModel) models.push(activeResolved.thirdModel);
  }
  return [
    ...members,
    ...models.map((id) => {
      const catalogMaxOutput =
        catalogById.get(id)?.top_provider?.max_completion_tokens;
      const limits = resolveEnsembleModelLimits(id, catalogMaxOutput);
      return { id, ...limits };
    }),
  ];
}

/**
 * What every tool returns. The `content` envelope is OUR OWN shape — a local
 * interface, never an SDK type — so it survives the MCP removal untouched.
 * Keeping it means 40 return sites stay as they are; the CLI flattens it to
 * stdout + an exit code in exactly ONE place instead.
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

export interface DispatchOptions {
  /**
   * Emit progress lines to stderr. Off by default so scripted/piped callers
   * get clean output; the CLI turns it on for the long-running tools.
   */
  progress?: boolean;
}

/**
 * Set by boot(). dispatchCallTool REFUSES to run until boot() has completed.
 *
 * WHY this is a hard gate and not a comment: boot() calls publishFreeState(),
 * without which a remote profile silently runs PAID models even though
 * `allow_paid_models` is false. That failure is invisible — the call succeeds,
 * it just costs money. "Remember to call boot() first" is exactly the kind of
 * instruction that gets lost, so the code makes forgetting impossible.
 */
let _booted = false;

/**
 * Public entry — installs a per-invocation usage-history context (tool name +
 * compact redacted param summary + project dir + a fresh op-id) for the whole
 * call, then delegates to the real dispatcher. Every `recordRequest()` fired by
 * an LLM web request inside this call inherits this context and shares its
 * op-id, so all of one invocation's request lines correlate. This wrapper sets
 * context ONLY — it never writes a history line itself (the user wants one line
 * per web request, not per invocation).
 */
export async function dispatchCallTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  opts: DispatchOptions = {},
): Promise<ToolResult> {
  if (!_booted) {
    throw new Error(
      "llm-externalizer: dispatchCallTool() called before boot(). " +
        "boot() publishes the free-mode state; dispatching without it can send " +
        "PAID models while allow_paid_models is false.",
    );
  }
  return withUsageContext(
    { tool: name, params: summarizeParams(rawArgs) },
    () => dispatchCallToolInner(name, rawArgs, opts),
  );
}

async function dispatchCallToolInner(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  opts: DispatchOptions,
): Promise<ToolResult> {
  const args = rawArgs;
  // Long tools (mass_scout, security_scan) can run for tens of minutes; without
  // periodic output a caller cannot tell "working" from "hung".
  const onProgress = makeProgressFn(opts.progress === true);
  // D2: the dynamic profile whose detector the pre-flight scheduled; spawned
  // in the `finally` below, after the work (see the pre-flight for why).
  let detectAfterDispatch: DynamicProfileName | null = null;

  try {
    // Gate all tools except discover, reset, get_settings behind settings validation.
    // If settings.yaml is missing or misconfigured, the user must fix it by
    // editing the YAML file manually.
    if (
      !settingsValid &&
      name !== "discover" &&
      name !== "reset" &&
      name !== "get_settings" &&
      name !== "profile" &&
      name !== "list_profiles" &&
      // The whole point of this tool is helping the user get a WORKING profile
      // in the first place, so it must run even while settings are misconfigured.
      name !== "scan_local_llm_services"
    ) {
      // WHY (TRDD-5Q79QZM7): repair an invalid marked generated active profile
      // here, once, instead of refusing -- see repairInvalidActiveGeneratedProfile.
      const repairNote = repairInvalidActiveGeneratedProfile();
      if (!settingsValid) {
        return {
          content: [
            {
              type: "text",
              text: `NOT CONFIGURED\n\n${settingsError}\n\n${repairNote ? `${repairNote}\n\n` : ""}Quick fix: edit ${SETTINGS_FILE} manually in your editor, then call the "reset" tool (or restart Claude Code).\nRun the "discover" tool to see the current profile status.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Assess the model situation BEFORE the work runs (the user's "always assess
    // first" rule). Throttled ≤1×/hr and fully fail-open — a reconcile problem
    // must never break the tool — so this is safe to await on every work tool.
    // Skipped for the pure status/meta tools so they stay instant.
    // P6b dynamic-profile pre-flight BEGIN
    // (P6b-fix2 S-8: free-rotation-coverage.test.ts extracts exactly this block
    // by these two anchors and asserts the ORDER of the calls inside it with
    // indexOf. It used to measure CHARACTER DISTANCES between them, which meant
    // every comment added here moved a test closer to failing for a reason that
    // has nothing to do with the wiring — one assertion had 25 characters of
    // headroom left. Do not delete the anchors; the test names them.)
    if (!RECONCILE_SKIP_TOOLS.has(name) && !isScoutingOnlyTool(name)) {
      const effective = effectiveProfileName(activeSettings);
      if (isDynamicProfileName(effective)) {
        // P6b item 1 (design §2.1): the dynamic `free`/`paid` profiles are
        // maintained by decideDynamicProfile's own $0-patch + candidate-queue
        // machinery, not the legacy 5-name reconcile/populate pair below —
        // running BOTH for the same profile would mean two decision engines
        // racing to write the same settings.yaml section.
        //
        // C2b-wire (TRDD-OE27RD7I): this used to `await maintainDynamicProfiles`
        // in-process — a full catalog fetch + patch on EVERY dispatch to a
        // dynamic profile, which is exactly the latency card C's acceptance
        // criterion (a `settings status` call within 100ms of the same call
        // under LLM_EXT_DISABLE_AUTO_RECONCILE) forbids. It fires the detached
        // DETECTOR (profile-detector.ts's cheap fingerprint-only check) and
        // never waits on it.
        //
        // D2: the detector is SCHEDULED here and spawned in this function's
        // `finally`, AFTER the work. Spawned first, it held the profile's one
        // lock (SG2) while this same command's models were failing, so the
        // update the failure requests found the lock held and started nothing
        // -- the command's own detector suppressed its own update.
        detectAfterDispatch = effective;
        const gate = profileGateRefusal(name);
        if (gate) {
          // D2 (USER 2026-09-18, empty pool: "Refuse, retry later"): a pool
          // that is empty ONLY because it was never populated yet (and an
          // update could plausibly fill it) is the degenerate case of "not a
          // single model working": start the background update and answer
          // retry-later at once -- no foreground fill, no wait, no regate.
          // Every other refusal (malformed profile, forbidden tool, no
          // credentials, maintenance disabled, catalog recently failed,
          // unpopulated paid/local) keeps its own message, as before.
          if (gate.reason === "empty-pool-refreshable") {
            const update = requestProfileUpdate({ profile: effective, log: (m) => process.stderr.write(m) });
            if (update.state !== "unavailable") {
              return { content: [{ type: "text", text: dynamicProfileRetryLaterMessage(effective) }], isError: true };
            }
            process.stderr.write(`[llm-externalizer] '${effective}' profile update not started — ${update.reason}\n`);
          }
          return { content: [{ type: "text", text: gate.message }], isError: true };
        }
      } else {
        // A STATIC profile. runModelReconcile() only WARNS about dead ids
        // (Rule 5: a profile the user wrote is used exactly as written and is
        // never rewritten), so this arm neither populates nor gates.
        //
        // P6c-a item 5: the lazy-population call that used to follow is GONE
        // with the retired machine-owned names. It existed for profiles that
        // no longer exist; the DYNAMIC branch above is now the only
        // maintenance branch, so there is exactly one engine that may write a
        // profile section.
        await runModelReconcile();
      }
    }
    // P6b dynamic-profile pre-flight END

    // mass-scouting tools are thin shims around the CLI dispatcher in
    // mass_scouting/cli.ts. They don't go through the central LLM
    // tracking / free-routing pipeline because scout.ts owns its own
    // OpenRouter call + budget logic (TRDD §6.3, §15). Short-circuit
    // before any of that machinery.
    if (MASS_SCOUT_TOOL_NAMES.has(name)) {
      // Free-mode coverage for the subsystem path (TRDD-542bdbef Phase 2).
      // security_scan / mass_scout default to a PAID model and assert ':free'
      // (getActiveFreeOnly) — so under free mode (profile free_only OR auto-free
      // on low balance) an unset/paid `model` arg would throw. Decide auto-free
      // first, then substitute a ':free' model from the active pool. This also
      // fixes a latent gap: security_scan never self-selected a free model even
      // under an explicit free_only profile.
      const scoutArgs = { ...((args ?? {}) as Record<string, unknown>) };
      // WHY skipped for scouting-only tools (PT-05, D34): their model comes from the scouting-type profile; an injected
      // free-pool id would override it, and activeFreePool() throws on a paid active profile with no pool.
      const inject = isScoutingOnlyTool(name)
        ? undefined
        : await resolveMassScoutFreeModelOverride(
            typeof scoutArgs.model === "string" ? scoutArgs.model : "",
          );
      if (inject) {
        scoutArgs.model = inject;
        process.stderr.write(
          `[llm-externalizer] Free mode: routing ${name} through ${inject}\n`,
        );
      }
      // Forward the MCP progressToken so long-running mass-scout jobs
      // (especially `mass_scout` and `mass_scout_chain`) emit
      // notifications/progress events that keep the connection alive
      // and let the client show real progress instead of a spinner.
      return await dispatchMassScoutTool(
        name,
        scoutArgs,
        onProgress
          ? {
              onProgress: (progress, total, message) =>
                onProgress(progress, total, message),
            }
          : {},
      );
    }

    // Track active LLM requests so `reset` can wait for them to drain
    const isLLMTool = LLM_TOOLS_SET.has(name);
    if (isLLMTool) trackRequestStart();

    // Per-request overrides — passed through function chain, no global mutation
    const rawOutputDir = (args as Record<string, unknown>)?.output_dir;
    const outputDir = typeof rawOutputDir === "string" && rawOutputDir.trim()
      ? resolve(rawOutputDir.trim())
      : undefined;
    // resolveModelOverride now handles ONLY explicit free=true (TRDD-OE27RD7I
    // addendum 4 deleted the credit-exhausted-session / balance pre-flight
    // auto-fallback outright — no cross-profile switch). Sync now (fix-queue
    // 98(4a) — it was never actually asynchronous; the `await` was a leftover
    // from when it used to read a resolved auto-free pool). It THROWS when
    // `free: true` is requested and the resolved profile has no ':free' chain
    // entry (fix-queue 98(2)) -- fix-queue P1 follow-up: this throw does NOT
    // reach main().catch (the prior comment here was wrong) -- it is inside
    // THIS function's own outer try, so the outer `catch (error)` below
    // (dispatchCallToolInner's tail) converts it into the same
    // `{ content: [...], isError: true }` shape every other refusal in this
    // function returns, same as "no resolved profile is active" already does.
    const freeRequested = (args as Record<string, unknown>)?.free === true;
    const modelOverride = resolveModelOverride(freeRequested);
    if (modelOverride) {
      process.stderr.write(
        `[llm-externalizer] Routing through ${modelOverride} (free requested)\n`,
      );
    }
    // Diff-mode scoping (TRDD-MNK2YNH0): resolve the caller's diff args ONCE,
    // delegated to git, and rewrite the input contract to the changed-file set
    // — so the tools, the rules chokepoint below, --estimate and --preview all
    // see the SAME scope. review_plan additionally embeds the per-file hunks.
    let reviewDiffScope: DiffScope | null = null;
    if (
      name === "scan_folder" ||
      name === "high_quality_scan" ||
      name === "code_task" ||
      name === "review_plan"
    ) {
      const a = args as Record<string, unknown>;
      try {
        const mode = parseDiffMode(a ?? {});
        if (mode) {
          reviewDiffScope = resolveDiffScope(mode, process.cwd());
          a.input_files_paths = reviewDiffScope.files;
          delete a.folder_path; // diff mode wins; a stale folder_path would widen the scope back
          process.stderr.write(
            `[llm-externalizer] Diff scope (${mode.kind}): ${reviewDiffScope.files.length} changed file(s)` +
              (reviewDiffScope.skipped.length > 0
                ? `, ${reviewDiffScope.skipped.length} skipped (${reviewDiffScope.skipped.map((s) => s.reason).join("; ")})`
                : "") +
              "\n",
          );
        }
      } catch (err) {
        // Fail-fast: a diff of nothing, a non-repo, or mixed modes is the
        // caller's error to see, never a silent full-tree review instead.
        return {
          content: [{ type: "text", text: `diff: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    // Layered per-path review rules (TRDD-3JQVBO7M): for the review-family
    // tools, resolve the winning rules layer and AUGMENT the caller's
    // instructions with the entries matching the actual file set — resolved
    // through the SAME resolver --estimate/--preview use, so every dry-run
    // and the real run agree on which rules fire. Zero-config default: no
    // rules file anywhere → nothing changes (Auto-DUBC).
    if (
      name === "scan_folder" ||
      name === "high_quality_scan" ||
      name === "code_task" ||
      name === "review_plan"
    ) {
      const a = args as Record<string, unknown>;
      const hasInstr = typeof a?.instructions === "string";
      // instructions_files_paths is a first-class way to supply the prompt
      // (resolvePrompt appends the files' contents after a.instructions), so
      // callers using it must get the SAME rules augmentation the identical
      // inline-instructions call gets (ultracode F10, 2026-08-05). The rules
      // text lands in a.instructions; resolvePrompt then appends the caller's
      // instruction files after it — augmented, never replaced.
      const hasInstrFiles =
        typeof a?.instructions_files_paths === "string" ||
        (Array.isArray(a?.instructions_files_paths) &&
          (a.instructions_files_paths as unknown[]).length > 0);
      if (hasInstr || hasInstrFiles || name === "review_plan") {
        try {
          const resolvedRules = resolveRulesLayers({
            explicitPath:
              typeof a?.rules === "string" && a.rules.length > 0 ? a.rules : undefined,
          });
          if (resolvedRules) {
            const fileSet = buildEstimateDeps().resolveFiles(a ?? {});
            if (!fileSet.error && fileSet.files.length > 0) {
              a.instructions = composeRuleInstructions(
                hasInstr ? (a.instructions as string) : "",
                fileSet.files,
                resolvedRules,
              );
              process.stderr.write(
                `[llm-externalizer] Review rules: ${resolvedRules.layer} layer (${resolvedRules.file})\n`,
              );
            }
          }
        } catch (err) {
          // Only an EXPLICIT --rules path throws (the caller named that exact
          // file); the layered lookups degrade silently. Loud beats silent here.
          return {
            content: [{ type: "text", text: `rules: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }
    }

    // T2.7 — Snapshot backend AFTER all pre-dispatch async work (settings
    // gating + resolveModelOverride). All `currentBackend.X` reads inside
    // the switch below MUST use this `backend` snapshot so a reload that
    // fires mid-dispatch cannot interleave fields from two backends within
    // a single tool call.
    const backend = getCurrentBackend();

    try {
    switch (name) {
      case "chat": {
        const {
          instructions,
          instructions_files_paths,
          input_files_paths: chatInputPathsRaw,
          input_files_content,
          system,
          answer_mode: rawAnswerMode,
          scan_secrets: chatScan,
          redact_secrets: chatRedact,
          max_payload_kb: chatMaxPayloadKb,
          max_retries: chatMaxRetries,
          redact_regex: chatRedactRegexRaw,
          folder_path: chatFolderPath,
          extensions: chatExtensions,
          exclude_dirs: chatExcludeDirs,
          use_gitignore: chatUseGitignore,
          recursive: chatRecursive,
          follow_symlinks: chatFollowSymlinks,
          max_files: chatMaxFiles,
        } = args as {
          instructions?: string;
          instructions_files_paths?: string | string[];
          input_files_paths?: string | string[];
          input_files_content?: string;
          system?: string;
          answer_mode?: number;
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          max_retries?: number;
          max_payload_kb?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        // Ensemble always ON for remote backends, OFF for local
        const useEnsemble = backend.type === "openrouter";
        const chatBudgetBytes = (chatMaxPayloadKb ?? 400) * 1024;

        // Validate redact_regex upfront — fail fast on invalid patterns
        let chatRegexRedact: RegexRedactOpts | null = null;
        try {
          chatRegexRedact = parseRedactRegex(chatRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }
        const chatPrompt = resolvePrompt(
          instructions,
          instructions_files_paths,
        );
        if (!chatPrompt.trim() && !input_files_content) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: Either instructions or instructions_files_paths must be provided.",
              },
            ],
            isError: true,
          };
        }
        // Resolve file paths: folder_path OR input_files_paths (or both)
        let chatFilePaths = normalizePaths(chatInputPathsRaw);
        if (chatFolderPath) {
          const folderResult = resolveFolderPath(chatFolderPath, {
            extensions: chatExtensions,
            excludeDirs: chatExcludeDirs,
            useGitignore: chatUseGitignore,
            recursive: chatRecursive,
            followSymlinks: chatFollowSymlinks,
            maxFiles: chatMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && chatFilePaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          chatFilePaths = [...chatFilePaths, ...folderResult.files];
        }

        // scan_secrets: abort if any secrets are found in input files or inline content.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (chatScan && !chatRedact) {
          // Filter out group markers before scanning — they are delimiters, not file paths
          const chatRealFiles = chatFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (chatRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(chatRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
          if (input_files_content) {
            const inlineScan = scanForSecrets(input_files_content);
            if (inlineScan.found) {
              const details = inlineScan.details
                .map((d) => `  - ${d.label}: ${d.count} occurrence(s)`)
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `ABORTED: Secrets detected in input_files_content:\n${details}\n\nRemove secrets before sending to remote LLM.`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        // Always use model's maximum output capacity — no user override
        const maxTokens = resolveDefaultMaxTokens();
        const chatMode = resolveAnswerMode(rawAnswerMode, 0);

        // Build prompt base: pre-instructions + unfenced instructions + optional fenced inline content
        const chatHasFiles = chatFilePaths.length > 0 || !!input_files_content;
        let promptBase =
          buildPreInstructions(chatHasFiles, "read") + chatPrompt;
        if (input_files_content) {
          let inlineContent = input_files_content;
          if (chatRedact) inlineContent = redactSecrets(inlineContent).redacted;
          const fence = fenceBackticks(inlineContent);
          promptBase += `\n\n${fence}\n${inlineContent}\n${fence}`;
        }

        // If no input_files_paths, just send the prompt (answer_mode irrelevant)
        if (chatFilePaths.length === 0) {
          const messages: ChatMessage[] = [];
          messages.push({ role: "system", content: (system || "") + FILE_FORMAT_EXAMPLE + BREVITY_RULES });
          messages.push({ role: "user", content: promptBase });
          const resp = await ensembleStreaming(
            messages,
            { temperature: DEFAULT_TEMPERATURE, maxTokens, onProgress, modelOverride },
            useEnsemble,
          );
          const footer = formatFooter(resp, "chat");
          // Shared response gate (TRDD-P4ULUV1R): empty AND echoed responses
          // are failures — "the model printed something" is not success.
          const chatVerdict = gateLLMResponse(resp.content, promptBase);
          if (chatVerdict !== null) {
            return {
              content: [
                { type: "text", text: `FAILED: ${gateFailureMessage(chatVerdict)}.` },
              ],
              isError: true,
            };
          }
          const savedPath = saveResponse(
            "chat",
            resp.content + footer,
            { model: resp.model, task: chatPrompt },
            undefined,
            outputDir,
          );
          return { content: [{ type: "text", text: savedPath }] };
        }

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". Groups come from either:
        //   • explicit ---GROUP:id--- markers in input_files_paths, or
        //   • auto-grouping by subfolder/extension/basename when no markers
        //     were supplied (see autoGroupByHeuristic).
        // answer_mode=0 is per-file, answer_mode=2 is a single merged report.
        let chatFileGroups = parseFileGroups(chatFilePaths);
        let chatEffectivelyGrouped = hasNamedGroups(chatFileGroups);
        if (chatMode === 1 && !chatEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(chatFilePaths);
          if (autoGroups.length > 0) {
            chatFileGroups = autoGroups;
            chatEffectivelyGrouped = true;
          }
        }

        // Process each group (or single unnamed group for backward compat)
        const allGroupReports: string[] = [];
        for (const fg of chatFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id; // empty string for unnamed/backward-compat

          // ── Mode 0: one output file per input file (separate LLM calls) ──
          if (chatMode === 0 && !chatEffectivelyGrouped) {
            const chatRetries = chatMaxRetries ?? 1;
            if (chatRetries > 1) {
              // Robust path: parallel + retry + circuit breaker
              const rpResult = await robustPerFileProcess(fgPaths, {
                task: chatPrompt, maxRetries: chatRetries,
                redact: chatRedact, regexRedact: chatRegexRedact,
                onProgress, ensemble: useEnsemble,
                budgetBytes: chatBudgetBytes, toolName: "chat",
                modelOverride, outputDir,
              });
              const lines = rpResult.succeeded.map((r) => r.reportPath ?? `DONE: ${r.filePath}`);
              if (rpResult.failed.length > 0) lines.push("", "FAILED:", ...rpResult.failed.map((r) => `  ${r.filePath}: ${r.error}`));
              if (rpResult.aborted) lines.push("", `ABORTED: ${rpResult.abortReason}`);
              return { content: [{ type: "text", text: lines.join("\n") }], isError: rpResult.aborted };
            }
            // Simple sequential path (max_retries=1, no retry)
            const perFileResults: string[] = [];
            for (const fp of fgPaths) {
              const result = await processFileCheck(fp, chatPrompt, {
                maxTokens,
                redact: chatRedact,
                regexRedact: chatRegexRedact,
                onProgress,
                ensemble: useEnsemble,
                maxBytes: chatBudgetBytes,
                modelOverride, outputDir,
              });
              perFileResults.push(
                result.success && result.reportPath
                  ? result.reportPath
                  : `FAILED: ${fp} — ${result.error}`,
              );
            }
            return {
              content: [{ type: "text", text: perFileResults.join("\n") }],
            };
          }

          // Group files by configurable payload budget for auto-batching.
          // A single user/auto group may still exceed the LLM context window,
          // in which case FFD splits it across multiple LLM calls; the
          // per-group merge path below stitches them back into one report.
          const chatPromptBytes =
            Buffer.byteLength(promptBase, "utf-8") +
            (system ? Buffer.byteLength(system, "utf-8") : 0);
          const { groups, autoBatched, skipped: chatSkipped } = readAndGroupFiles(
            fgPaths,
            chatPromptBytes,
            chatRedact,
            chatBudgetBytes,
            chatRegexRedact,
          );

          // Collect results for this file group (merged-per-group output)
          const batchResults: string[] = [];
          if (chatSkipped.length > 0) {
            const skipNote = `SKIPPED (exceeds ${chatBudgetBytes / 1024} KB payload budget): ${chatSkipped.length} file(s)\n${chatSkipped.map((f) => `  - ${f}`).join("\n")}`;
            batchResults.push(skipNote);
          }
          for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            let userContent = promptBase;
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }
            const messages: ChatMessage[] = [];
            messages.push({ role: "system", content: (system || "") + FILE_FORMAT_EXAMPLE + BREVITY_RULES });
            messages.push({ role: "user", content: userContent });
            const resp = await ensembleStreaming(
              messages,
              { temperature: DEFAULT_TEMPERATURE, maxTokens, onProgress, modelOverride },
              useEnsemble,
            );
            const footer = formatFooter(resp, "chat", group[0]?.path);
            // Shared response gate (TRDD-P4ULUV1R): an echoed group answer is
            // dropped exactly like an empty one — including it would present
            // the input back as if it were analysis.
            if (gateLLMResponse(resp.content, userContent) === null) {
              if (autoBatched) {
                const fileList = group.map((fd) => fd.path).join(", ");
                batchResults.push(
                  `## Batch ${gi + 1}/${groups.length}\n\nFiles: ${fileList}\n\n${resp.content}${footer}`,
                );
              } else {
                batchResults.push(resp.content + footer);
              }
            }
          }

          // Merge batch results into one report for this group.
          if (batchResults.length === 0) continue; // skip empty groups
          const finalContent = batchResults.join("\n\n---\n\n");
          const chatMergedModel = ensembleModelLabel(useEnsemble);
          const savedPath = saveResponse(
            "chat",
            finalContent,
            { model: chatMergedModel, task: chatPrompt, inputFile: fgPaths[0], groupId: fgId || undefined },
            undefined,
            outputDir,
          );

          if (chatEffectivelyGrouped) {
            const labelId = fgId || "auto";
            allGroupReports.push(`[group:${labelId}] ${savedPath}`);
          } else {
            // Single unnamed group — return directly (mode 0/2 backward compat)
            return { content: [{ type: "text", text: savedPath }] };
          }
        }

        // Grouped mode: return all per-group report paths
        if (allGroupReports.length === 0) {
          return {
            content: [{ type: "text", text: "FAILED: LLM returned empty response for all groups." }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: allGroupReports.join("\n") }] };
      }

      case "code_task": {
        // Pipeline body extracted to code-task/core.ts (B1 Phase 3,
        // TRDD-63314265), mirroring the scan_folder / search_existing
        // extractions so the REAL pipeline (BOTH the single/inline path and the
        // multi-file FFD-batched path) can run in-process from a benchmark
        // runner; this case only wires the server-stateful deps. processFileCheck
        // and ensembleStreaming are the per-file-call and multi-model seams;
        // robustPerFileProcess carries the parallel+retry+circuit-breaker path.
        const ctDeps: CodeTaskDeps = {
          useEnsemble: backend.type === "openrouter",
          defaultTemperature: DEFAULT_TEMPERATURE,
          normalizePaths,
          resolveFolderPath,
          processFileCheck,
          ensembleStreaming: (messages, options, ensemble) =>
            ensembleStreaming(messages as ChatMessage[], options, ensemble),
          formatFooter,
          saveResponse,
          robustPerFileProcess,
          codeTaskSystemPrompt,
          ensembleModelLabel,
          resolveDefaultMaxTokens,
          onProgress,
          outputDir,
          modelOverride, // honours --free and credit-exhausted auto-fallback
        };
        return await runCodeTask(args as Record<string, unknown>, ctDeps);
      }

      case "summarize":
      case "topics":
      case "sem_deduplicate":
      case "describe": {
        // The four single-call text tools (TRDD-VFXS2ZYY / 9XOHSYFV /
        // SYEH38AV / Q3ERXAAO) share one core module with injected deps,
        // mirroring code-task/core.ts — this case only wires the
        // server-stateful seams.
        const ttDeps: TextToolsDeps = {
          useEnsemble: backend.type === "openrouter",
          defaultTemperature: DEFAULT_TEMPERATURE,
          ensembleStreaming: (messages, options, ensemble) =>
            ensembleStreaming(messages as ChatMessage[], options, ensemble),
          formatFooter,
          saveResponse,
          resolveDefaultMaxTokens,
          onProgress,
          outputDir,
          modelOverride,
        };
        const runner =
          name === "summarize"
            ? runSummarize
            : name === "topics"
              ? runTopics
              : name === "sem_deduplicate"
                ? runSemDeduplicate
                : runDescribe;
        return await runner(args as Record<string, unknown>, ttDeps);
      }

      case "rules_check": {
        // TRDD-3JQVBO7M: which rule applies to a path, and from which layer.
        // Pure lookup, no LLM — the debuggability half of the rules engine.
        const a = args as Record<string, unknown>;
        const target = typeof a?.file_path === "string" ? a.file_path : "";
        if (!target) {
          return {
            content: [{ type: "text", text: "rules_check: file_path is required" }],
            isError: true,
          };
        }
        const resolvedRules = resolveRulesLayers({
          explicitPath:
            typeof a?.rules === "string" && a.rules.length > 0 ? a.rules : undefined,
        });
        if (!resolvedRules) {
          return {
            content: [
              {
                type: "text",
                text:
                  "no rules layer found (checked: --rules, <repo>/.llm-ext/rules.yaml, " +
                  `${join(getConfigDir(), "rules.yaml")}) — tools run with their built-in rubric`,
              },
            ],
          };
        }
        const match = matchRuleForFile(target, resolvedRules.entries);
        const text = match
          ? `layer: ${resolvedRules.layer}\nfile: ${resolvedRules.file}\nmatched: \`${match.path}\`\nrule: ${match.rule}`
          : `layer: ${resolvedRules.layer}\nfile: ${resolvedRules.file}\nmatched: (none — no entry's glob matches ${target})`;
        return { content: [{ type: "text", text }] };
      }

      case "review_plan": {
        // Delegate mode (TRDD-SNAEERHU): deterministic scaffolding only, the
        // HOST agent reviews. Reuses the estimator's resolver seam so plan,
        // estimate, and run always agree on the file set — one source of truth.
        const resolved = buildEstimateDeps().resolveFiles(
          args as Record<string, unknown>,
        );
        if (resolved.error) {
          return {
            content: [{ type: "text", text: `review_plan: ${resolved.error}` }],
            isError: true,
          };
        }
        if (resolved.files.length === 0) {
          return {
            content: [
              { type: "text", text: "review_plan: the plan would cover zero files" },
            ],
            isError: true,
          };
        }
        const planFiles = resolved.files.map((p) => {
          try {
            return { path: p, bytes: statSync(p).size };
          } catch {
            return { path: p, bytes: 0 };
          }
        });
        const plan = buildReviewPlan(planFiles, {
          instructions:
            typeof (args as Record<string, unknown>).instructions === "string"
              ? ((args as Record<string, unknown>).instructions as string)
              : undefined,
          reportDir: defaultOutputDir(),
          // Diff mode (TRDD-MNK2YNH0): the plan carries the hunks themselves —
          // the host agent reviews the CHANGES with function context, and only
          // opens the full file when a hunk demands it.
          hunksByFile: reviewDiffScope?.hunksByFile,
        });
        return { content: [{ type: "text", text: plan }] };
      }

      case "discover": {
        const parts: string[] = [];

        // If settings are not configured, show the error prominently
        if (!settingsValid || !activeResolved) {
          parts.push("⚠ NOT CONFIGURED\n");
          parts.push(settingsError);
          parts.push(`\nSettings file: ${SETTINGS_FILE}`);
          parts.push(`Session log: ${LOG_FILE}`);
          // Show available profiles even when not configured
          const profileNames = Object.keys(activeSettings.profiles);
          if (profileNames.length > 0) {
            parts.push(`\nAvailable profiles: ${profileNames.join(", ")}`);
          }
          // Show available API presets
          parts.push(`\nAPI presets: ${Object.keys(API_PRESETS).join(", ")}`);
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            isError: true,
          };
        }

        // WHY (TRDD-G6XT3AY9): `active:` is a live selector again -- the
        // deprecation notice this used to print here is gone; the source
        // label below already says whether the flag, the `active:` key, or
        // the built-in default decided.
        parts.push(
          `Effective profile: ${activeResolved.name} (source: ${
            getProfileSelectionSource() === "flag"
              ? "--profile"
              : activeSettings.active !== undefined
                ? "active:"
                : "built-in default"
          })`,
        );
        // Addendum K: dynamic-profile maintainer state is labelled "as of
        // <time>" because `discover` is itself in RECONCILE_SKIP_TOOLS — this
        // read-only status command never triggers a fresh maintain pass (a
        // status query must not rewrite settings first), so the timestamp may
        // be stale and the label says so honestly rather than implying "live".
        if (isDynamicProfileName(activeResolved.name)) {
          const dynRecord = getDynamicProfileRecord(activeResolved.name);
          // P6b-fix S5: renders lastMaintainedAt — the MAINTAINER's own clock,
          // which is what "maintained as of" claims. It used to render
          // lastBenchmarkAt, a different event entirely, and because
          // recordBenchmarkFailure preserves `lastBenchmarkAt: 0` on a profile
          // that never succeeded, a record created by a first FAILED attempt
          // printed "maintained as of 1970-01-01T00:00:00.000Z" instead of
          // "not yet maintained". Falsy (absent or 0) is the honest
          // never-maintained case.
          const maintainedAt = dynRecord?.lastMaintainedAt;
          parts.push(
            maintainedAt
              ? `Dynamic profile '${activeResolved.name}' maintained as of ${new Date(maintainedAt).toISOString()}`
              : `Dynamic profile '${activeResolved.name}' not yet maintained`,
          );
        }
        parts.push(`Mode: ${activeResolved.mode}`);
        // fix-queue 89: PLACEHOLDER_MODEL_ID is an internal sentinel for
        // "profile never populated" (config.ts) -- this `settings status`
        // "Model:" line printed it verbatim for an unpopulated dynamic
        // section (the "Dynamic profile '<x>' not yet maintained" line
        // above already says so, but this SEPARATE line still leaked the
        // raw sentinel string right under it). Same population-state
        // wording writeBootBanner uses, so the two surfaces agree.
        parts.push(
          `Model: ${
            activeResolved.model === PLACEHOLDER_MODEL_ID
              ? `${activeResolved.name}: not benchmarked yet`
              : activeResolved.model
          }`,
        );
        if (activeResolved.secondModel) {
          parts.push(`Second model: ${activeResolved.secondModel}`);
        }
        if (activeResolved.thirdModel) {
          parts.push(`Third model: ${activeResolved.thirdModel}`);
        }
        // Free-mode reporting. Under forced-free (allow_paid_models=false),
        // profile free_only, the Model/second/third lines
        // above are the CONFIGURED values but are NOT what runs — the ensemble
        // draws from the free pool. Say so explicitly, and show the actual pool,
        // so the user is never misled into thinking a paid model is being billed.
        if (isFreeModeActive()) {
          const pool = activeFreePool();
          // The auto-free ("low balance / 402") arm is gone (addendum 4): with paid allowed
          // forceFreeByMasterSwitch is false, so free mode can only come from free_only.
          const reason = !getAllowPaidModels()
            ? "allow_paid_models=false — set it true to use paid models"
            : "profile free_only";
          const shown = pool.slice(0, 6).join(", ");
          // OE27RD7I row 18 + review: "benchmark-vetted" is a population-state claim, and the
          // only record/queue that state comes from is the built-in dynamic `free` profile's.
          // Any other active profile (a static free_only list, hand-listed, exempt from
          // benchmarks by design) must not borrow that unrelated record's verdict.
          let poolVetting = "as listed in the profile, not benchmarked by design";
          if (activeResolved.name === "free") {
            const freeProfile = activeSettings.profiles.free;
            const freeQueued = readCandidates(
              freeProfile ? resolveGroups(freeProfile).routesFor : (): ResolvedRoute[] => [],
            ).free.length;
            // A queued COUNT, not "pending": it stays true when maintenance is backed off or disabled.
            poolVetting =
              (getDynamicProfileRecord("free")?.lastBenchmarkAt ?? 0) <= 0
                ? "not yet benchmarked"
                : freeQueued > 0
                  ? `${freeQueued} candidate${freeQueued === 1 ? "" : "s"} awaiting benchmark`
                  : "benchmark-vetted";
          }
          parts.push(`Free mode: ON (${reason})`);
          parts.push(
            `Free pool (${pool.length}, ${poolVetting}, rotates on rate-limit): ` +
              `${shown}${pool.length > 6 ? ", …" : ""}`,
          );
          if (!getAllowPaidModels()) {
            parts.push(
              `↑ The configured Model line(s) are ignored while paid is off; the ensemble runs the free pool above.`,
            );
          }
        }
        // Show auth status so agents can verify the token is available
        const authSource = (() => {
          const authProfileName = effectiveProfileName(activeSettings);
          const preset =
            API_PRESETS[activeSettings.profiles[authProfileName]?.api];
          const profile = activeSettings.profiles[authProfileName];
          if (!preset) return "unknown";
          const rawAuth = preset.isLocal
            ? profile?.api_token || preset.defaultAuthEnv
            : profile?.api_key || preset.defaultAuthEnv;
          if (!rawAuth) return "none required";
          if (rawAuth.startsWith("$")) {
            const envVal = process.env[rawAuth.slice(1)];
            return envVal
              ? `${rawAuth} (set, ${envVal.length} chars)`
              : `${rawAuth} (NOT SET)`;
          }
          return "direct value (set)";
        })();
        parts.push(`Auth: ${authSource}`);

        // Probe the service to check availability and get context window
        const start = Date.now();
        try {
          let contextWindow = FALLBACK_CONTEXT_LENGTH;

          if (backend.type === "openrouter" && backend.model) {
            const models = await fetchOpenRouterModels();
            const match = models.find((m) => m.id === backend.model);
            if (match?.context_length) contextWindow = match.context_length;
            const ms = Date.now() - start;
            parts.push(`Status: ONLINE (${ms}ms)`);
          } else {
            const models = await listModelsRaw();
            const isLMS = await detectLMStudio(providerDeps);
            const ms = Date.now() - start;
            const backendLabel = isLMS ? "LM Studio" : "Local";
            if (models.length > 0) {
              contextWindow = getContextLength(models[0]);
              parts.push(`Status: ONLINE — ${backendLabel} (${ms}ms)`);
            } else {
              parts.push(
                `Status: ONLINE — ${backendLabel} (${ms}ms) — no model loaded, ask the user to load one`,
              );
            }
          }

          parts.push(
            `Context window: ${contextWindow.toLocaleString()} tokens (input + output combined)`,
          );
          parts.push(
            `Max output tokens per call: model maximum (${resolveDefaultMaxTokens().toLocaleString()}). Auto-managed, not user-configurable.`,
          );

          const rlCfg = await getRateLimitConfig();
          if (rlCfg.rps > 1) {
            parts.push(
              `Rate limit: ${rlCfg.rps} RPS (requests/second), up to ${rlCfg.maxInFlight} in-flight. Spawn parallel tool calls for throughput.`,
            );
          } else {
            parts.push(
              "Concurrency: SEQUENTIAL — one request at a time. Wait for each call to complete before sending the next.",
            );
          }

          parts.push(`Timeout: ${SOFT_TIMEOUT_MS / 1000}s per call.`);
        } catch (err) {
          const ms = Date.now() - start;
          const reason =
            err instanceof Error && err.name === "AbortError"
              ? `timed out after ${ms}ms`
              : err instanceof Error
                ? err.message
                : String(err);
          parts.push(`Status: OFFLINE — ${reason}`);
          parts.push(
            "The service is not available. Do not attempt to delegate tasks.",
          );
        }

        if (session.calls > 0) {
          const total = session.promptTokens + session.completionTokens;
          const costStr =
            session.totalCost > 0
              ? ` | Cost: $${session.totalCost.toFixed(6)}`
              : "";
          parts.push(
            `\nSession usage: ${total.toLocaleString()} tokens across ${session.calls} call${session.calls === 1 ? "" : "s"}${costStr}`,
          );
        }

        // Show profiles and presets for editing guidance
        const profileNames = Object.keys(activeSettings.profiles);
        parts.push(`\nProfiles: ${profileNames.join(", ")}`);
        parts.push(`API presets: ${Object.keys(API_PRESETS).join(", ")}`);
        parts.push(`Settings: ${SETTINGS_FILE}`);
        parts.push(`Session log: ${LOG_FILE}`);

        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      }

      case "scan_local_llm_services": {
        const services = await discoverLocalLlmServices();
        const cliEvidence = detectInstalledClis();
        const listText = formatDiscoveredServices(services, cliEvidence);
        const system = detectSystemInfo();
        const systemLine = `Detected system: ${(system.totalRamBytes / 1024 ** 3).toFixed(1)} GB RAM, ${system.cpuCount} CPUs`;

        const pickArg = (args as Record<string, unknown> | undefined)?.pick;
        let pick: number | undefined = typeof pickArg === "number" ? pickArg : undefined;

        // Interactive prompt ONLY when a human is actually at the terminal and
        // didn't already pass --pick — an agent/script invocation (not a TTY)
        // must never block waiting on stdin that will never arrive.
        let alreadyShowedList = false;
        if (pick === undefined && process.stdin.isTTY) {
          alreadyShowedList = true;
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await rl.question(
              `${listText}\n\n${systemLine}\n\n` +
                "Configure llm-externalizer to use one of these? Enter a number, or leave blank to cancel: ",
            );
            const trimmed = answer.trim();
            const n = Number(trimmed);
            if (trimmed !== "" && Number.isInteger(n)) pick = n;
          } finally {
            rl.close();
          }
        }

        if (pick === undefined) {
          return {
            content: [
              {
                type: "text",
                text:
                  // The interactive prompt already printed the list and the
                  // system line to this same terminal — repeating them here
                  // would show the whole scan twice for one command.
                  (alreadyShowedList ? "" : `${listText}\n\n${systemLine}\n\n`) +
                  // "no profile", not "nothing" — on a cold config dir the server's
                  // normal first-run bootstrap still writes the default settings
                  // template before any command runs. Claiming "nothing was written"
                  // is falsifiable by `find` and would undermine trust in the rest.
                  "No selection made — no profile was written and no profile was activated. " +
                  "Re-run with --pick <N> to configure " +
                  "and activate one of the REACHABLE services above " +
                  "(e.g. 'llm-ext scan-local-llm-services --pick 1').",
              },
            ],
          };
        }

        const service = services[pick - 1];
        if (!service) {
          return {
            content: [
              { type: "text", text: `Invalid selection ${pick}. Valid range: 1-${services.length}.` },
            ],
            isError: true,
          };
        }
        if (!service.reachable) {
          return {
            content: [
              {
                type: "text",
                text: `Service #${pick} (${service.baseUrl}) is not reachable — cannot configure it.`,
              },
            ],
            isError: true,
          };
        }

        let built;
        try {
          built = buildProfileForService(service, Object.keys(activeSettings.profiles));
        } catch (err) {
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }

        const result = addProfileToSettings(getSettingsPath(), built.profileName, built.profile);
        return {
          content: [
            {
              type: "text",
              text:
                // WHY (TRDD-G6XT3AY9): adding a profile section never selects
                // it (addProfileToSettings does not touch `active:`, and this
                // phase deliberately does not reinstate `setActive` here --
                // see pick.ts's addProfileToSettings doc comment) -- say both
                // ways to select it so the user isn't left to debug why their
                // new local model was ignored on the very next command.
                `Configured profile '${result.profileName}' (${String(built.profile.api)}, ` +
                `model ${String(built.profile.model)}) in ${getSettingsPath()}.\n` +
                `Select it with --profile ${result.profileName} on a command, or set ` +
                `'active: ${result.profileName}' in settings.yaml to make it the default; ` +
                `without either, '${DEFAULT_PROFILE_NAME}' is used.\n` +
                "Restart Claude Code (or call the 'reset' tool) to pick up the change.",
            },
          ],
        };
      }

      case "or_model_info":
      case "or_model_info_table":
      case "or_model_info_json": {
        const { model: infoModel, file_path: infoFilePath } = args as {
          model?: string;
          file_path?: string;
        };
        if (!infoModel || typeof infoModel !== "string") {
          return {
            content: [
              {
                type: "text",
                text: `FAILED: \`model\` parameter is required. Pass the exact OpenRouter model id, e.g. 'nvidia/nemotron-3-super-120b-a12b:free'.`,
              },
            ],
            isError: true,
          };
        }
        if (backend.type !== "openrouter") {
          return {
            content: [
              {
                type: "text",
                text: `${name} only works with OpenRouter backends. Active profile is '${activeResolved?.name}' (${activeResolved?.mode}). Switch to a remote profile to query model metadata.`,
              },
            ],
            isError: true,
          };
        }

        const result = await fetchOpenRouterModelInfo(
          infoModel,
          backend.baseUrl,
          backend.apiKey,
        );
        if (!result.ok) {
          // Friendly error messages per status code. OpenRouter uses
          // the standard HTTP error code set — see
          // docs/openrouter/errors-and-debugging.md.
          let msg: string;
          switch (result.status) {
            case 400:
              msg = `FAILED: OpenRouter rejected the request for '${infoModel}' (400 Bad Request). ${result.error}`;
              break;
            case 401:
              msg = `FAILED: OpenRouter authentication failed (401). Check that $OPENROUTER_API_KEY is set and valid — run 'discover' to verify.`;
              break;
            case 402:
              msg = `FAILED: OpenRouter credit exhausted (402). Add credits at https://openrouter.ai/credits or fall back to a :free model.`;
              break;
            case 403:
              msg = `FAILED: OpenRouter blocked the request for '${infoModel}' (403 Forbidden). The model may require moderation approval or be unavailable in your region.`;
              break;
            case 404:
              msg = `FAILED: OpenRouter returned 404 for model '${infoModel}'. Check the id — case-sensitive, requires vendor prefix and any ':free' / ':thinking' suffix.`;
              break;
            case 408:
              msg = `FAILED: OpenRouter request timed out (408). Retry in a moment.`;
              break;
            case 429:
              msg = `FAILED: OpenRouter rate limit hit (429). Wait a few seconds before retrying.`;
              break;
            case 502:
            case 503:
            case 504:
              msg = `FAILED: OpenRouter upstream error (${result.status}). The provider is down or unreachable — retry later.`;
              break;
            default:
              msg = `FAILED: ${result.error}${result.status ? ` (status ${result.status})` : ""}`;
          }
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
        }

        // JSON branch: optionally write to a file, returning only the
        // absolute path so the caller's context isn't flooded.
        if (name === "or_model_info_json") {
          const jsonText = formatModelInfoJson(result.data, infoModel);
          if (infoFilePath && typeof infoFilePath === "string" && infoFilePath.trim()) {
            const rawPath = infoFilePath.trim();
            // Enforce absolute paths — relative paths silently resolve
            // against process.cwd() which may surprise the caller and
            // opens a small path-confusion window.
            if (!isAbsolute(rawPath)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: file_path must be an absolute path (e.g. /tmp/model-info.json). Got '${rawPath}'.`,
                  },
                ],
                isError: true,
              };
            }
            let absPath: string;
            try {
              // Run the path through the same traversal guard as every other
              // file-writing surface in this server. Without this an LLM that
              // controls the tool call could overwrite arbitrary user-writable
              // files outside the project / home / tmp roots.
              absPath = sanitizeInputPath(rawPath);
            } catch (err) {
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: refusing to write JSON to ${rawPath}: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                isError: true,
              };
            }
            try {
              writeFileSync(absPath, jsonText, "utf-8");
            } catch (err) {
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: could not write JSON to '${absPath}': ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                { type: "text", text: `JSON written to ${absPath}` },
              ],
            };
          }
          return {
            content: [{ type: "text", text: jsonText }],
          };
        }

        const text =
          name === "or_model_info_table"
            ? formatModelInfoTable(result.data, infoModel, true)
            : formatModelInfoMarkdown(result.data, infoModel);

        return {
          content: [{ type: "text", text }],
        };
      }

      case "reset": {
        // Wait for any in-flight LLM requests to finish before resetting
        if (_activeRequests > 0) {
          process.stderr.write(
            `[llm-externalizer] reset: waiting for ${_activeRequests} active request(s) to complete…\n`,
          );
          await waitForRequestsDrained();
        }

        // Full soft-restart: reload settings, clear all caches, reset session counters.
        // Snapshot BEFORE reload — single read captures the "before" model atomically.
        const beforeProfile = effectiveProfileName(activeSettings);
        const beforeBackend = getCurrentBackend();
        const beforeModel = beforeBackend.model;

        // 1. Reload settings from disk (validates before applying)
        reloadSettingsFromDisk();

        // 2. Clear all caches (after reload — reload may have already replaced backend)
        openRouterModelCache = [];
        openRouterCacheTime = 0;
        cachedRateLimitConfig = null; rateLimitCacheTime = 0;
        // T2.7 — Reset LM Studio detection by clearing the EXTERNAL probe cache.
        // BackendConfig is now immutable, so cache state lives in _lmStudioProbeCache.
        clearLMStudioProbeCache();
        // D6b: same reset for the endpoint-flavor cache (same trigger, same
        // reason — a backend switch must re-probe, not read a stale flavor).
        clearEndpointFlavorCache();

        // 3. Reset session counters
        session.calls = 0;
        session.promptTokens = 0;
        session.completionTokens = 0;
        session.totalCost = 0;
        writeStatsFile();

        // (No tool-list notification: every CLI invocation is a fresh process
        // and rebuilds its command table from the tool definitions anyway.)

        // Snapshot the post-reload backend ONCE for the summary string —
        // reads of multiple fields across multiple async-safe lines.
        const afterProfile = effectiveProfileName(activeSettings);
        const afterBackend = getCurrentBackend();
        const afterModel = afterBackend.model;
        const profileChanged = beforeProfile !== afterProfile || beforeModel !== afterModel;
        const summary = [
          "RESET COMPLETE",
          `Profile: ${afterProfile} (${afterBackend.type}, ${afterBackend.model})`,
          profileChanged ? `Changed from: ${beforeProfile} / ${beforeModel}` : "Profile unchanged",
          "Caches cleared: model list, concurrency, LM Studio detection",
          "Session counters reset to zero",
        ];

        return {
          content: [{ type: "text", text: summary.join("\n") }],
        };
      }

      case "get_settings": {
        // `settings show` (TRDD settings-rename, requirement B): print the
        // EFFECTIVE profile's resolved settings to stdout, so the user sees
        // them without opening a file — then ALSO copy the raw settings.yaml
        // to the output dir (unchanged prior behaviour) for manual editing.
        const summary = formatActiveProfileSummary(
          effectiveProfileName(activeSettings),
          getProfileSelectionSource(),
        );
        try {
          const raw = readFileSync(SETTINGS_FILE, "utf-8");
          const targetDir = outputDir || defaultOutputDir();
          mkdirSync(targetDir, { recursive: true });
          const copyPath = join(targetDir, "settings_edit.yaml");
          writeFileSync(copyPath, raw, "utf-8");
          return {
            content: [{ type: "text", text: `${summary}\n\nFull settings file copied to: ${copyPath}` }],
          };
        } catch (err) {
          // Resolved-profile summary still printed even when the copy fails
          // (e.g. output dir unwritable) — the show-settings intent still succeeds.
          return {
            content: [
              {
                type: "text",
                text: `${summary}\n\nFailed to copy ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "list_profiles": {
        // `settings profiles` (TRDD settings-rename, requirement C): every
        // profile in settings.yaml, one line each, with a `*` marker on the
        // EFFECTIVE one for this invocation. Read-only — never mutates
        // settings.yaml.
        return {
          content: [{ type: "text", text: formatProfilesList(effectiveProfileName(activeSettings)) }],
        };
      }

      case "profile": {
        // Read-only. Adding/switching/removing a profile is user-only (hand-edit
        // settings.yaml + 'reset') — see the tool description. This case only
        // ever reads activeSettings.profiles / the effective profile name; it
        // never writes settings.yaml.
        const profileNames = Object.keys(activeSettings.profiles);
        if (profileNames.length === 0) {
          // Fail fast: an empty profiles map is a configuration error, not "no
          // profiles yet" — ensureSettingsExist() always seeds the three
          // machine-managed defaults (free, ensemble, mass-scout) on first run,
          // so an empty map here means the file was hand-edited into an invalid
          // state. Say so instead of silently printing an empty list.
          return {
            content: [
              {
                type: "text",
                text:
                  `No profiles defined in ${SETTINGS_FILE}.\n` +
                  `Settings file is present but its 'profiles' map is empty — this is a ` +
                  `configuration error (ensureSettingsExist always seeds defaults on first ` +
                  `run). Edit ${SETTINGS_FILE} manually to add at least one profile, then ` +
                  `call 'reset'.`,
              },
            ],
            isError: true,
          };
        }

        const showName = typeof args?.show === "string" ? args.show : undefined;

        if (showName !== undefined) {
          const profile = activeSettings.profiles[showName];
          if (!profile) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Unknown profile '${showName}'. Available profiles: ` +
                    `${profileNames.join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          let resolved: ResolvedProfile;
          try {
            resolved = resolveProfile(showName, profile);
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to resolve profile '${showName}': ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
          const lines = formatResolvedProfileLines(
            resolved,
            profile,
            resolved.name === effectiveProfileName(activeSettings),
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Default: list every profile, one line each (single source of truth
        // shared with `settings profiles` / `list_profiles` — config.ts).
        return {
          content: [{ type: "text", text: formatProfilesList(effectiveProfileName(activeSettings)) }],
        };
      }

      case "session_summary": {
        const {
          transcript: ssTranscript,
          session_id: ssSessionId,
          prune: ssPruneRaw,
          min_context: ssMinContext,
          resume: ssResume,
          checkpoint: ssCheckpointRaw,
          output: ssOutputRaw,
          stdout: ssStdoutRaw,
          max_chunk_tokens: ssMaxChunkTokens,
          concurrency: ssConcurrencyRaw,
          chunk_timeout_s: ssChunkTimeoutSecRaw,
          max_retries_per_chunk: ssMaxRetriesRaw,
          until_done: ssUntilDoneRaw,
        } = args as {
          transcript?: string;
          session_id?: string;
          prune?: string;
          min_context?: number;
          resume?: boolean;
          checkpoint?: string;
          output?: string;
          stdout?: boolean;
          max_chunk_tokens?: number;
          concurrency?: number;
          chunk_timeout_s?: number;
          max_retries_per_chunk?: number;
          until_done?: boolean;
        };

        // Per-chunk deadline. An explicit value is honored verbatim (including a
        // very large one — the caller, not this code, decides how long they are
        // willing to wait); omitted, it defaults to a value well under the
        // global soft timeout because a concurrent run's wall-clock is its
        // SLOWEST chunk.
        const ssPerChunkTimeoutMs =
          typeof ssChunkTimeoutSecRaw === "number" && ssChunkTimeoutSecRaw > 0
            ? Math.round(ssChunkTimeoutSecRaw * 1000)
            : DEFAULT_CHUNK_TIMEOUT_MS;

        const VALID_PRUNE_LEVELS = new Set(["aggressive", "moderate", "none"]);
        const prune = ssPruneRaw ?? "aggressive";
        if (!VALID_PRUNE_LEVELS.has(prune)) {
          return {
            content: [
              {
                type: "text",
                text: `FAILED: --prune must be one of aggressive, moderate, none (got '${prune}')`,
              },
            ],
            isError: true,
          };
        }

        let transcriptPath: string;
        try {
          transcriptPath = resolveTranscriptPath({
            transcriptPath: ssTranscript,
            sessionId: ssSessionId,
          });
        } catch (err) {
          return {
            content: [{ type: "text", text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }

        // Cost-safety + eligibility: catalog-only, $0. selectModels() itself
        // routes every candidate id through assertFreeOnlyModel — this call
        // can never hand back a paid model (see model-select.ts's own header).
        // Biggest-context-first, no implicit floor: "the biggest free model
        // with the biggest context memory" available today. The whole
        // ordered list (minus whatever lacks a usable completion ceiling)
        // is handed to the driver as a fallback chain — see driver.ts.
        let eligible;
        try {
          eligible = (await selectModels({ minContext: ssMinContext })).filter(
            (m) => m.maxCompletionTokens > 0,
          );
        } catch (err) {
          return {
            content: [{ type: "text", text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
        if (eligible.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `FAILED: every eligible free model reports no max_completion_tokens on the ` +
                  `OpenRouter catalog — cannot size the summarization prompt safely.`,
              },
            ],
            isError: true,
          };
        }
        const model = eligible[0];
        const fallbackModels = eligible.slice(1);

        const checkpointPath = ssCheckpointRaw
          ? resolve(ssCheckpointRaw)
          : defaultCheckpointPath(transcriptPath, getConfigDir());

        if (ssResume === true && !existsSync(checkpointPath)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `FAILED: --resume was given but no checkpoint exists at ${checkpointPath} for ` +
                  `this transcript. Re-run without --resume to start a fresh run (it will create one).`,
              },
            ],
            isError: true,
          };
        }

        // The injected model-call seam driver.ts requires (see its own header):
        // pure core + thin IO shell. This is the only place session-summary
        // touches the network — driver.ts and its tests never do.
        const callModel: CallModelFn = async (prompt, modelId, maxOutputTokens) => {
          const resp = await chatCompletionWithRetry(
            [{ role: "user", content: prompt }],
            {
              model: modelId,
              maxTokens: maxOutputTokens,
              temperature: DEFAULT_TEMPERATURE,
              onProgress,
              // A per-chunk deadline TIGHTER than the global soft timeout.
              // Under concurrency the map phase's wall-clock is the SLOWEST
              // chunk, so one straggler allowed to run the full global 300s
              // drags the entire run out even though every sibling finished
              // minutes earlier. Measured spread on same-sized chunks was 4.4x
              // (90s to 400s), so the tail — not the median — is the cost.
              // Exceeding this aborts the chunk, which then rotates/retries
              // like any other transient rather than hanging (TRDD-0H5N1V9W
              // made the deadline actually cover generation; before that fix
              // this value would have bounded only time-to-first-byte).
              // Round C item 5 (TRDD-YG72CYY7): ssPerChunkTimeoutMs is a
              // WHOLE-CHUNK wall-clock budget (driver.ts races the entire
              // chunk call against it), so the retry window must end with it —
              // without deadlineAt each chunk gets a private default 300s
              // retry window and can run 5 minutes past its own timeout.
              deadlineAt: Date.now() + ssPerChunkTimeoutMs,
              timeoutMs: ssPerChunkTimeoutMs,
            },
            providerDeps,
          );
          if (resp.finishReason === "error") {
            throw new Error(`model call to '${modelId}' failed (finishReason=error): ${resp.content || "no detail"}`);
          }
          // An empty/whitespace-only completion is deliberately NOT thrown
          // here as a generic error — it is returned as-is so driver.ts's
          // own "no-text" runtime evidence check (its permissive modality
          // selection needs this backstop) can classify it as a
          // fallback-eligible model failure and demote the model, instead
          // of it being misread as a retryable schema bug.
          return resp.content;
        };

        // Concurrency: an explicit --concurrency (including 1, to force the
        // original sequential behavior) is honored verbatim; omitted, the
        // CLI opts every real invocation into "auto" — see driver.ts's own
        // header for why the LIBRARY default stays 1.
        // Omitted => "auto": the driver sizes the pool to the chunk count
        // (min(chunks, MAX_AUTO_CONCURRENCY)) so the map phase stays SINGLE-WAVE.
        // A fixed 12 forced e.g. 27 chunks into three waves and roughly tripled
        // wall-clock for nothing — the account admits far more than 12 at once.
        const concurrency: number | "auto" =
          typeof ssConcurrencyRaw === "number" ? ssConcurrencyRaw : "auto";

        // Per-chunk progress lines labeled by chunk index, so N chunks in
        // flight at once still read clearly instead of interleaving
        // anonymous "Processing… Ns elapsed" lines (each chunk is its own
        // named line; a "done" line always carries the SAME chunk index and
        // its own elapsed time, however many other chunks completed first).
        const onChunkEvent = (event: ChunkEvent) => {
          const label = `[chunk ${event.chunkIndex + 1}/${event.totalChunks}]`;
          if (event.phase === "start") {
            process.stderr.write(`${label} started\n`);
          } else {
            const secs = ((event.elapsedMs ?? 0) / 1000).toFixed(1);
            // Say WHICH racer won when the single-chunk race decided this
            // chunk. Without it a "done in 84.2s" line is unattributable: it
            // reads identically whether the race won in 84s or whether every
            // racer failed after minutes and the sequential fallback then
            // took 84s. Those are opposite outcomes and the fix for each is
            // different, so the line must distinguish them.
            const race =
              event.raceWinnerModel !== undefined
                ? ` (race of ${event.raceSize ?? "?"} won by ${event.raceWinnerModel})`
                : "";
            process.stderr.write(`${label} done in ${secs}s${race}\n`);
          }
        };

        // --until-done: keep going until the summary exists.
        //
        // The driver is deliberately checkpoint-and-stop: a chunk gets
        // maxRetriesPerChunk attempts on a model, a dead/quota-capped model is
        // demoted to the next ranked free one, and when those run out the run
        // THROWS with a resumable checkpoint. That is the right default — a
        // command that reports a problem beats one that silently sits on it.
        //
        // It is the wrong default for an unattended compaction that must
        // eventually produce a summary. Retrying is cheap and correct here
        // BECAUSE of the checkpoint: each pass re-reads the checkpoint, keeps
        // every chunk that landed, and only redoes what did not. Re-entering
        // summarizeSession (rather than looping inside it) also re-resolves the
        // model list, so a model that was quota-capped last pass is picked up
        // again once its quota resets.
        const untilDone = ssUntilDoneRaw === true;

        let result;
        for (let attempt = 1; ; attempt++) {
          try {
            result = await summarizeSession({
              transcriptPath,
              checkpointPath,
              modelId: model.id,
              modelMaxContext: model.contextLength,
              modelMaxCompletionTokens: model.maxCompletionTokens,
              fallbackModels,
              callModel,
              pruneLevel: prune as "aggressive" | "moderate" | "none",
              maxChunkTokens: typeof ssMaxChunkTokens === "number" ? ssMaxChunkTokens : undefined,
              maxRetriesPerChunk:
                typeof ssMaxRetriesRaw === "number" && ssMaxRetriesRaw >= 0
                  ? Math.floor(ssMaxRetriesRaw)
                  : undefined,
              concurrency,
              onChunkEvent,
            });
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!untilDone) {
              return {
                content: [{ type: "text", text: `FAILED: ${msg}` }],
                isError: true,
              };
            }
            const backoffMs = untilDoneBackoffMs(attempt, looksQuotaCapped(msg));
            process.stderr.write(
              `[llm-externalizer] session-summary attempt ${attempt} failed: ${msg}\n` +
                `[llm-externalizer] --until-done: retrying in ${Math.round(backoffMs / 1000)}s ` +
                `(resumes from the checkpoint; completed chunks are not recomputed)\n`,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }

        // The outcome, not the inputs. Chunk counts, lines read and the prune
        // ratio all describe how the work was done; this is the one number the
        // command exists to produce, and until now a reader had to stat two
        // files by hand to get it. Printed to stderr as well as embedded in the
        // report, because the command's stdout is a PATH — a caller who never
        // opens the report would otherwise never see it.
        const summaryBytes = Buffer.byteLength(result.summary, "utf8");
        const sizeLine = formatSizeReport(
          result.transcriptStats.bytesIn,
          summaryBytes,
          result.transcriptStats.bytesOut,
        );
        process.stderr.write(`[llm-externalizer] ${sizeLine}\n`);

        const fallbackLines = result.fallbackEvents.map(
          (e) => `  ${e.atUnit}: '${e.fromModel}' -> '${e.toModel}' (${e.reason}: ${e.detail})`,
        );
        const header =
          `Model: ${result.modelId} (context ${eligible.find((m) => m.id === result.modelId)?.contextLength.toLocaleString() ?? "?"})\n` +
          (result.fallbackEvents.length > 0
            ? `Model fallbacks (started on '${model.id}'):\n${fallbackLines.join("\n")}\n`
            : "") +
          `Transcript: ${transcriptPath}\n` +
          `Chunks: ${result.totalChunks}\n` +
          `Lines read: ${result.transcriptStats.linesRead}, prune ratio: ` +
          `${result.transcriptStats.pruneRatio.toFixed(3)} (level: ${prune})\n` +
          `${sizeLine}\n` +
          (result.resumedFromCheckpoint
            ? `Resumed from checkpoint: ${result.checkpointPath}\n`
            : `Checkpoint: ${result.checkpointPath}\n`);

        // Final-assembly gate (TRDD-P4ULUV1R; reported by the janitor's
        // handoff composer 2026-08-18): a run whose ASSEMBLED summary is
        // empty must not exit 0 — with --stdout that shipped literally
        // nothing at a zero exit, 14 consecutive times on one host, and the
        // caller had no honest way to classify it. The per-response no-text
        // gate upstream cannot cover this: it judges one model reply, not
        // the reduce result. Wording deliberately avoids availability
        // vocabulary (quota/404/etc.) — classifyUnavailable substring-
        // matches, and this verdict must never sideline a model (same
        // reason as the (nonconforming) path, v13.5.5).
        if (result.summary.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "FAILED: session-summary assembled an empty summary " +
                  `(${result.totalChunks} chunk(s) mapped; transcript ${transcriptPath}). ` +
                  "Retry is reasonable; the checkpoint is preserved.",
              },
            ],
            isError: true,
          };
        }

        // --stdout (opt-in, caller-selected): return the summary TEXT
        // directly instead of writing a report file and returning its path.
        // Deliberately skips saveResponse entirely in this mode — "stdout
        // carries ONLY the summary text" (definitions.ts) means no header,
        // no file, no path line; a caller that wants both the direct text
        // AND a persisted report should omit --stdout and read the file.
        if (ssStdoutRaw === true) {
          return { content: [{ type: "text", text: result.summary }] };
        }

        const ssOutputDir =
          typeof ssOutputRaw === "string" && ssOutputRaw.trim() ? resolve(ssOutputRaw.trim()) : undefined;
        const savedPath = saveResponse(
          "session_summary",
          `${header}\n---\n\n${result.summary}`,
          { model: result.modelId, task: `session-summary of ${transcriptPath}` },
          undefined,
          ssOutputDir,
        );
        return { content: [{ type: "text", text: savedPath }] };
      }

      // ── Batch Operations ──────────────────────────────────────────────

      case "batch_check": {
        const {
          instructions: bcInstructions,
          instructions_files_paths: bcInstructionsFilesPaths,
          input_files_paths: bcInputPaths,
          answer_mode: bcRawMode,
          scan_secrets: bcScan,
          redact_secrets: bcRedact,
          redact_regex: bcRedactRegexRaw,
          max_payload_kb: bcMaxPayloadKb,
          folder_path: bcFolderPath,
          extensions: bcExtensions,
          exclude_dirs: bcExcludeDirs,
          use_gitignore: bcUseGitignore,
          recursive: bcRecursive,
          follow_symlinks: bcFollowSymlinks,
          max_files: bcMaxFiles,
        } = args as {
          instructions?: string;
          instructions_files_paths?: string | string[];
          input_files_paths: string[];
          answer_mode?: number;
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          redact_regex?: string;
          max_payload_kb?: number;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        const bcUseEnsemble = backend.type === "openrouter";
        const bcBudgetBytes = (bcMaxPayloadKb ?? 400) * 1024;
        const bcMode = resolveAnswerMode(bcRawMode, 0);

        // Validate redact_regex
        let bcRegexRedact: RegexRedactOpts | null = null;
        try {
          bcRegexRedact = parseRedactRegex(bcRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        let bcNormalizedPaths = normalizePaths(bcInputPaths);
        if (bcFolderPath) {
          const folderResult = resolveFolderPath(bcFolderPath, {
            extensions: bcExtensions, excludeDirs: bcExcludeDirs,
            useGitignore: bcUseGitignore, recursive: bcRecursive,
            followSymlinks: bcFollowSymlinks, maxFiles: bcMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && bcNormalizedPaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          bcNormalizedPaths = [...bcNormalizedPaths, ...folderResult.files];
        }
        if (bcNormalizedPaths.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: input_files_paths or folder_path is required.",
              },
            ],
            isError: true,
          };
        }

        // Deduplicate file paths to avoid redundant LLM calls
        const uniqueFiles = [...new Set(bcNormalizedPaths)];

        // scan_secrets: abort if any secrets are found in input files.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (bcScan && !bcRedact) {
          // Filter out group markers before scanning
          const realFiles = uniqueFiles.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (realFiles.length > 0) {
            const scanResult = scanFilesForSecrets(realFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
        }

        // ── Group-aware: if groups present (or mode 1 auto-groups),
        // process each group independently. answer_mode=1 uses the
        // heuristic auto-grouper when no ---GROUP:id--- markers are given.
        let bcFileGroups = parseFileGroups(uniqueFiles);
        let bcEffectivelyGrouped = hasNamedGroups(bcFileGroups);
        if (bcMode === 1 && !bcEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(uniqueFiles);
          if (autoGroups.length > 0) {
            bcFileGroups = autoGroups;
            bcEffectivelyGrouped = true;
          }
        }
        if (bcEffectivelyGrouped) {
          const bcGroupReports: string[] = [];
          for (const fg of bcFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "auto";
            const gBatchId = randomUUID();
            const gTask = resolvePrompt(bcInstructions, bcInstructionsFilesPaths).trim() ||
              "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures.";
            const gRl = await getRateLimitConfig();
            // Circuit-breaker + retry, mirroring the non-grouped branch below. The tool's
            // documented contract ("3 attempts for recoverable errors; aborts on 3+
            // consecutive failures") must apply equally to grouped runs — without this
            // the grouped path would retry zero times and keep hammering a dead backend.
            const gRecentOutcomes: boolean[] = [];
            let gAborted = false;
            let gAbortReason = "";
            let gTotalAttempts = 0;
            const gMaxTotalAttempts = fg.files.length * 2;
            const gTasks = fg.files.map((filePath, idx) => async () => {
              if (gAborted) {
                return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
              }
              for (let attempt = 1; attempt <= 3; attempt++) {
                if (++gTotalAttempts > gMaxTotalAttempts) {
                  gAborted = true;
                  gAbortReason = `Global retry budget exhausted (${gMaxTotalAttempts} total attempts)`;
                }
                if (gAborted) {
                  return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
                }
                try {
                  const result = await processFileCheck(filePath, gTask, {
                    maxTokens: resolveDefaultMaxTokens(),
                    batchId: gBatchId, fileIndex: idx,
                    redact: bcRedact, regexRedact: bcRegexRedact, onProgress, ensemble: bcUseEnsemble, maxBytes: bcBudgetBytes, modelOverride, outputDir,
                  });
                  gRecentOutcomes.push(result.success);
                  return result;
                } catch (err) {
                  const classified = classifyError(err);
                  if (classified.unrecoverable) {
                    if (classified.serviceLevel) {
                      gAborted = true;
                      gAbortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
                    }
                    // A closed retry window is final for this file but still a failed
                    // outcome (see the batch_check loop below).
                    if (classified.countsAsFailure && recordFailedOutcome(gRecentOutcomes)) {
                      gAborted = true;
                      gAbortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
                    }
                    return { filePath, success: false, error: classified.reason } as FileProcessResult;
                  }
                  if (attempt < 3) {
                    const delayMs = Math.pow(3, attempt - 1) * 1000;
                    await new Promise((r) => setTimeout(r, delayMs));
                    continue;
                  }
                  gRecentOutcomes.push(false);
                  if (
                    gRecentOutcomes.length >= 3 &&
                    gRecentOutcomes.slice(-3).every((v) => !v)
                  ) {
                    gAborted = true;
                    gAbortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
                  }
                  return { filePath, success: false, error: `Failed after 3 retries: ${classified.reason}` } as FileProcessResult;
                }
              }
              return { filePath, success: false, error: "Unexpected retry loop exit" } as FileProcessResult;
            });
            const gAll = await rateLimitedParallel(gTasks, gRl.rps, gRl.maxInFlight, onProgress);
            const gSucceeded = gAll.filter((r) => r.success);
            // Merge into one report per group
            const reportSections: string[] = [];
            for (const r of gSucceeded) {
              const content = r.reportPath && existsSync(r.reportPath)
                ? readFileSync(r.reportPath, "utf-8") : "";
              reportSections.push(`## File: ${r.filePath}\n\n${content}`);
            }
            const gFailed: FileProcessResult[] = gAll.filter((r) => !r.success);
            if (gFailed.length > 0) {
              reportSections.push(`## FAILED (${gFailed.length})\n\n${gFailed.map((r) => `- ${r.filePath}: ${r.error}`).join("\n")}`);
            }
            if (gAborted) {
              reportSections.push(`## BATCH ABORTED\n\n${gAbortReason}`);
            }
            if (reportSections.length > 0) {
              const mergedContent = reportSections.join("\n\n---\n\n");
              const mergedPath = saveResponse(
                "batch_check",
                mergedContent,
                { model: backend.model, task: gTask, inputFile: fg.files[0], groupId: gid },
                undefined,
                outputDir,
              );
              bcGroupReports.push(`[group:${gid}] ${mergedPath}`);
            }
          }
          if (bcGroupReports.length === 0) {
            return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
          }
          return { content: [{ type: "text", text: bcGroupReports.join("\n") }] };
        }

        const batchId = randomUUID();
        const defaultTask =
          "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures. Be specific — reference line numbers and function names.";
        // Resolve prompt from instructions + instructions_files_paths
        const bcPrompt = resolvePrompt(
          bcInstructions,
          bcInstructionsFilesPaths,
        );
        const resolvedTask = bcPrompt.trim() || defaultTask;
        const bcRl = await getRateLimitConfig();

        // Sliding window of recent completion outcomes for circuit breaker.
        // Under parallel execution, "consecutive" is meaningless — instead we track
        // the last N completions and abort if the tail is all failures.
        const recentOutcomes: boolean[] = [];
        let aborted = false;
        let abortReason = "";
        // H3: Global retry cap — max 2× file count total attempts to prevent quota exhaustion
        let totalAttempts = 0;
        const maxTotalAttempts = uniqueFiles.length * 2;

        const tasks = uniqueFiles.map((filePath, idx) => async () => {
          // If batch was aborted by a prior task, skip remaining files
          if (aborted) {
            return {
              filePath,
              success: false,
              error: "Batch aborted",
            } as FileProcessResult;
          }

          // Retry loop — up to 3 attempts for recoverable errors
          for (let attempt = 1; attempt <= 3; attempt++) {
            // H3: Check global retry budget before each attempt
            if (++totalAttempts > maxTotalAttempts) {
              aborted = true;
              abortReason = `Global retry budget exhausted (${maxTotalAttempts} total attempts)`;
            }
            // Re-check abort flag before each retry to avoid wasting calls after abort
            if (aborted) {
              return {
                filePath,
                success: false,
                error: "Batch aborted",
              } as FileProcessResult;
            }
            try {
              const result = await processFileCheck(filePath, resolvedTask, {
                maxTokens: resolveDefaultMaxTokens(),
                batchId,
                fileIndex: idx,
                redact: bcRedact,
                regexRedact: bcRegexRedact,
                onProgress,
                ensemble: bcUseEnsemble,
                maxBytes: bcBudgetBytes,
                modelOverride, outputDir,
              });
              recentOutcomes.push(result.success);
              // Report per-file batch progress
              if (onProgress) {
                const completed = recentOutcomes.length;
                onProgress(
                  completed,
                  uniqueFiles.length,
                  `batch_check: ${completed}/${uniqueFiles.length} files done`,
                );
              }
              return result;
            } catch (err) {
              const classified = classifyError(err);
              if (classified.unrecoverable) {
                if (classified.serviceLevel) {
                  // Service-level error (auth/payment) — abort the entire batch
                  aborted = true;
                  abortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
                }
                // A closed retry window is final for this file but still a failed
                // outcome: without this the "3 of the last 3 failed" abort never
                // saw it (only the retried-then-exhausted path below pushed false).
                if (classified.countsAsFailure && recordFailedOutcome(recentOutcomes)) {
                  aborted = true;
                  abortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
                }
                // File-level error (not found) — fail this file only, don't abort batch
                return {
                  filePath,
                  success: false,
                  error: classified.reason,
                } as FileProcessResult;
              }
              // Recoverable — retry with exponential backoff (1s, 3s)
              if (attempt < 3) {
                const delayMs = Math.pow(3, attempt - 1) * 1000;
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
              }
              // All retries exhausted — record failure in sliding window
              // Check if last 3 completions are all failures
              if (recordFailedOutcome(recentOutcomes)) {
                aborted = true;
                abortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
              }
              return {
                filePath,
                success: false,
                error: `Failed after 3 retries: ${classified.reason}`,
              } as FileProcessResult;
            }
          }
          return {
            filePath,
            success: false,
            error: "Unexpected retry loop exit",
          } as FileProcessResult;
        });

        const batchResults = await rateLimitedParallel(tasks, bcRl.rps, bcRl.maxInFlight, onProgress);

        // Categorize results
        const succeeded = batchResults.filter((r) => r.success);
        const failed = batchResults.filter(
          (r) => !r.success && r.error !== "Batch aborted",
        );
        const skipped = batchResults.filter((r) => r.error === "Batch aborted");

        // For modes 1/2: merge individual report files into one output
        // BUT: skip merge if any files failed — incomplete merge is misleading
        if ((bcMode === 1 || bcMode === 2) && succeeded.length > 0) {
          if (failed.length > 0 || aborted) {
            // Some files failed — skip merge, fall through to mode-0 per-file listing
            // so the agent sees exactly which files succeeded and which failed
          } else {
            // All files succeeded — safe to merge reports
            const reportSections: string[] = [];
            for (const r of succeeded) {
              const content =
                r.reportPath && existsSync(r.reportPath)
                  ? readFileSync(r.reportPath, "utf-8")
                  : "";
              reportSections.push(`## File: ${r.filePath}\n\n${content}`);
            }
            const mergedContent = reportSections.join("\n\n---\n\n");
            const mergedPath = saveResponse(
              "batch_check",
              mergedContent,
              { model: backend.model, task: resolvedTask, inputFile: uniqueFiles[0] },
              undefined,
              outputDir,
            );
            const bcSummary: string[] = [
              `BATCH CHECK COMPLETE — ${succeeded.length} succeeded (${uniqueFiles.length} total)`,
              `Batch UUID: ${batchId}`,
              `MERGED REPORT: ${mergedPath}`,
            ];
            return { content: [{ type: "text", text: bcSummary.join("\n") }] };
          }
        }

        // Mode 0 (default): list individual report paths
        const summaryLines: string[] = [
          `BATCH CHECK COMPLETE — ${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped (${uniqueFiles.length} total)`,
          `Batch UUID: ${batchId}`,
          "",
        ];
        if (uniqueFiles.length < bcNormalizedPaths.length) {
          summaryLines.push(
            `Note: ${bcNormalizedPaths.length - uniqueFiles.length} duplicate path(s) removed.`,
          );
        }

        if (succeeded.length > 0) {
          summaryLines.push("REPORTS:");
          for (const r of succeeded) {
            summaryLines.push(`  ${r.reportPath}`);
          }
        }
        if (failed.length > 0) {
          summaryLines.push("", "FAILED:");
          for (const r of failed) {
            summaryLines.push(`  ${r.filePath}: ${r.error}`);
          }
        }
        if (skipped.length > 0) {
          summaryLines.push(
            "",
            `SKIPPED (batch aborted): ${skipped.length} file(s)`,
          );
        }
        if (aborted) {
          summaryLines.push("", `BATCH ABORTED: ${abortReason}`);
        }

        return {
          content: [{ type: "text", text: summaryLines.join("\n") }],
          isError: aborted,
        };
      }

      // ── Specialized Operations ──────────────────────────────────────

      case "scan_folder": {
        // Pipeline body extracted to scan-folder/core.ts (B1 Phase 3,
        // TRDD-63314265), mirroring the search_existing_implementations
        // extraction so the REAL pipeline can run in-process from a benchmark
        // runner; this case only wires the server-stateful deps. processFileCheck
        // is injected as the per-file-call seam (the scan_folder analogue of
        // search_existing's callModel).
        const sfDeps: ScanFolderDeps = {
          useEnsemble: backend.type === "openrouter",
          backendModel: backend.model,
          processFileCheck,
          classifyError,
          saveResponse,
          getRateLimitConfig,
          resolveDefaultMaxTokens,
          onProgress,
          outputDir,
          modelOverride, // honours --free and credit-exhausted auto-fallback
        };
        return await runScanFolder(args as Record<string, unknown>, sfDeps);
      }

      case "high_quality_scan": {
        // high_quality_scan (TRDD-DBUSM55E): scan_folder driven by ONE strong
        // remote model (default z-ai/glm-5.2) at max reasoning + prompt cache,
        // NOT the cheap 3-model ensemble. The model is PAID by design, so the
        // gate REFUSES (never silently downgrades) when the backend can't run it
        // — wrong backend, free_only, or exhausted credit (gate is unit-tested).
        // Feed the RUNTIME free state (isFreeModeActive), not just the profile's
        // static free_only — so forced-free (allow_paid_models=false) and sticky
        // auto-free also refuse this paid-only tool. getAllowPaidModels shapes the
        // message: under the master switch the fix is the switch, not a profile edit.
        const hqRefusal = highQualityScanRefusal(
          backend.type,
          isFreeModeActive(),
          creditExhausted,
          getAllowPaidModels(),
        );
        if (hqRefusal) throw new Error(hqRefusal);
        const hq = activeResolved?.highQualityModel ?? HIGH_QUALITY_MODEL_DEFAULTS;
        const hqDeps: ScanFolderDeps = {
          useEnsemble: false, // single high-quality model, never the cheap ensemble
          backendModel: hq.id, // label reports with the high-quality model
          processFileCheck,
          classifyError,
          saveResponse,
          getRateLimitConfig,
          resolveDefaultMaxTokens,
          onProgress,
          outputDir,
          modelOverride: hq.id, // forces ensembleStreaming's single-model branch
          hqRequest: {
            provider: buildHighQualityProvider(hq),
            reasoning: hq.reasoningEffort,
            cache: hq.cache,
          },
        };
        return await runScanFolder(args as Record<string, unknown>, hqDeps);
      }

      case "search_existing_implementations": {
        // Pipeline body extracted to search-existing/core.ts (TRDD-828238b5
        // A6/B1 increment) so the benchmark runner can execute the REAL
        // pipeline in-process; this case only wires the server-stateful deps.
        const seiDeps: SeiDeps = {
          useEnsemble: backend.type === "openrouter",
          backendModel: backend.model,
          callModel: async (messages) =>
            ensembleStreaming(
              messages as ChatMessage[],
              {
                temperature: DEFAULT_TEMPERATURE,
                maxTokens: resolveDefaultMaxTokens(),
                onProgress,
                modelOverride, // honours --free and credit-exhausted auto-fallback
              },
              backend.type === "openrouter",
            ),
          classifyError,
          saveResponse,
          ensembleModelLabel,
          onProgress,
          outputDir,
        };
        return await runSearchExistingImplementations(
          args as Record<string, unknown>,
          seiDeps,
        );
      }

      case "compare_files": {
        const {
          input_files_paths: cfInputPaths,
          file_pairs: cfFilePairs,
          git_repo: cfGitRepo,
          from_ref: cfFromRef,
          to_ref: cfToRef,
          instructions: cfInstructions,
          instructions_files_paths: cfInstructionsFilesPaths,
          redact_secrets: cfRedact,
          scan_secrets: cfScan,
          max_payload_kb: cfMaxPayloadKb,
        } = args as {
          input_files_paths?: string[];
          file_pairs?: (string[] | string)[];
          git_repo?: string;
          from_ref?: string;
          to_ref?: string;
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          scan_secrets?: boolean;
          max_payload_kb?: number;
        };
        const cfBudgetBytes = (cfMaxPayloadKb ?? 400) * 1024;
        const cfUseEnsemble = backend.type === "openrouter";

        // ── Helper: compare a single pair and return report content ──
        const comparePair = async (fARaw: string, fBRaw: string, prompt: string): Promise<{ content: string; model: string } | { error: string }> => {
          // C1+H2: Sanitize input paths (traversal + symlink protection) before spawning diff
          let fA: string, fB: string;
          try {
            fA = sanitizeInputPath(fARaw);
            fB = sanitizeInputPath(fBRaw);
          } catch (err) {
            return { error: (err as Error).message };
          }
          if (!existsSync(fA)) return { error: `File not found: ${fARaw}` };
          if (!existsSync(fB)) return { error: `File not found: ${fBRaw}` };
          if (cfScan && !cfRedact) {
            const scanResult = scanFilesForSecrets([fA, fB]);
            if (scanResult.found) return { error: scanResult.report };
          }
          const diffResult = spawnSync("diff", ["-u", "--label", fA, "--label", fB, "--", fA, fB], { encoding: "utf-8", timeout: 30000 });
          if (diffResult.status === 2 || diffResult.error) return { error: `diff error: ${diffResult.error?.message || diffResult.stderr}` };
          let diffOutput = diffResult.stdout?.trim() ? diffResult.stdout : "(files are identical)";
          if (diffOutput.length > 200_000) { diffOutput = diffOutput.slice(0, 200_000); }
          if (cfRedact) diffOutput = redactSecrets(diffOutput).redacted;
          let sourceBlocks = "";
          try {
            const bA = readFileAsCodeBlock(fA, undefined, cfRedact, cfBudgetBytes);
            const bB = readFileAsCodeBlock(fB, undefined, cfRedact, cfBudgetBytes);
            if (bA.length + bB.length < 300_000) sourceBlocks = `\n\n## File A (full): ${fA}\n\n${bA}\n\n## File B (full): ${fB}\n\n${bB}`;
          } catch { /* too large */ }
          const fence = fenceBackticks(diffOutput);
          const msgs: ChatMessage[] = [
            // Shared seam (TRDD-2G6D42LK). This path previously carried a WEAKER
            // variant than the git-diff path below; converged UP onto the stronger
            // one, which only adds constraints. Two live prompts meant one
            // benchmark could never speak for the whole command.
            { role: "system", content: compareFilesSystemPrompt(FILE_FORMAT_EXAMPLE + BREVITY_RULES) },
            { role: "user", content: `${prompt ? prompt + "\n\n" : ""}Compare:\n- Before: ${fA}\n- After: ${fB}\n\nDiff:\n${fence}\n${diffOutput}\n${fence}${sourceBlocks}` },
          ];
          let resp;
          try {
            resp = await ensembleStreaming(msgs, { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride }, cfUseEnsemble);
          } catch (err) {
            return { error: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
          }
          // Shared response gate (TRDD-P4ULUV1R): echo added beside the
          // empty check — a model returning the diff back is not a comparison.
          {
            const v = gateLLMResponse(resp.content, String(msgs[1].content));
            if (v !== null) return { error: gateFailureMessage(v) };
          }
          return { content: resp.content + formatFooter(resp, "compare_files", fA), model: resp.model };
        };

        // ── Helper: git diff between two refs (no LLM) ──
        const gitDiffPair = (repo: string, fromRef: string, toRef: string, filePath: string): string => {
          const result = spawnSync("git", ["diff", fromRef, toRef, "--", filePath], { cwd: repo, encoding: "utf-8", timeout: 30000 });
          if (result.status !== 0 && result.status !== 1) return `(git diff failed: ${result.stderr?.trim() || "unknown error"})`;
          return result.stdout?.trim() || "(no differences)";
        };

        const cfPrompt = resolvePrompt(cfInstructions, cfInstructionsFilesPaths);

        // ── GIT DIFF MODE ──
        if (cfGitRepo) {
          if (!cfFromRef) return { content: [{ type: "text", text: "FAILED: from_ref is required with git_repo." }], isError: true };
          // C1+H2: Sanitize git_repo path (traversal + symlink protection) before spawning git
          let cfGitRepoSafe: string;
          try {
            cfGitRepoSafe = sanitizeInputPath(cfGitRepo);
          } catch (err) {
            return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
          }
          if (!existsSync(cfGitRepoSafe)) return { content: [{ type: "text", text: `FAILED: git_repo not found: ${cfGitRepo}` }], isError: true };
          const toRef = cfToRef || "HEAD";
          // Get list of changed files between the two refs
          // Validate refs don't start with - (prevents flag injection)
          if (cfFromRef.startsWith("-") || toRef.startsWith("-")) {
            return { content: [{ type: "text", text: "FAILED: git refs must not start with '-'" }], isError: true };
          }
          const nameResult = spawnSync("git", ["diff", "--name-only", cfFromRef, toRef], { cwd: cfGitRepoSafe, encoding: "utf-8", timeout: 15000 });
          if (nameResult.status !== 0 && nameResult.status !== 1) {
            return { content: [{ type: "text", text: `FAILED: git diff --name-only failed: ${nameResult.stderr?.trim()}` }], isError: true };
          }
          const changedFiles = (nameResult.stdout || "").split("\n").filter((f) => f.trim());

          // If file_pairs contains group markers, use them to filter/group the changed files
          // Otherwise create one group with all changed files
          interface DiffGroup { id: string; files: string[] }
          let diffGroups: DiffGroup[];

          if (cfFilePairs && cfFilePairs.length > 0) {
            // Parse group markers from file_pairs (single-element entries are markers)
            diffGroups = [];
            let currentGroup: DiffGroup | null = null;
            let ungrouped: string[] = [];
            for (const entry of cfFilePairs) {
              const marker = Array.isArray(entry) ? (entry.length === 1 ? entry[0] : null) : entry;
              if (marker && typeof marker === "string" && GROUP_HEADER_RE.test(marker)) {
                if (currentGroup && currentGroup.files.length > 0) diffGroups.push(currentGroup);
                if (ungrouped.length > 0) { diffGroups.push({ id: "", files: ungrouped }); ungrouped = []; }
                currentGroup = { id: marker.match(GROUP_HEADER_RE)![1], files: [] };
                continue;
              }
              if (marker && typeof marker === "string" && GROUP_FOOTER_RE.test(marker)) {
                if (currentGroup && currentGroup.files.length > 0) diffGroups.push(currentGroup);
                currentGroup = null;
                continue;
              }
              // Regular file path — filter from changed files
              const filePath = Array.isArray(entry) ? entry[0] : entry;
              if (typeof filePath === "string" && changedFiles.includes(filePath)) {
                if (currentGroup) currentGroup.files.push(filePath);
                else ungrouped.push(filePath);
              }
            }
            if (currentGroup && currentGroup.files.length > 0) diffGroups.push(currentGroup);
            if (ungrouped.length > 0) diffGroups.push({ id: "", files: ungrouped });
          } else {
            diffGroups = [{ id: "", files: changedFiles }];
          }

          const isGrouped = diffGroups.some((g) => g.id !== "");
          const reportPaths: string[] = [];

          for (const dg of diffGroups) {
            if (dg.files.length === 0) continue;
            const sections: string[] = [];
            for (const filePath of dg.files) {
              const diff = gitDiffPair(cfGitRepoSafe, cfFromRef, toRef, filePath);
              const fence = fenceBackticks(diff);
              sections.push(`## ${filePath}\n\n${fence}diff\n${diff}\n${fence}`);
            }
            const reportContent = `# Git Diff: ${cfFromRef} → ${toRef}\n\nRepository: ${cfGitRepoSafe}\nFiles changed: ${dg.files.length}\n\n---\n\n${sections.join("\n\n---\n\n")}`;
            const gid = dg.id || undefined;
            const rp = saveResponse(
              "compare_files",
              reportContent,
              {
                model: "git-diff (no LLM)",
                task: `${cfFromRef} → ${toRef}`,
                inputFile: join(cfGitRepoSafe, dg.files[0]),
                groupId: gid,
              },
              undefined,
              outputDir,
            );
            if (isGrouped) reportPaths.push(`[group:${dg.id}] ${rp}`);
            else reportPaths.push(rp);
          }
          return { content: [{ type: "text", text: reportPaths.join("\n") }] };
        }

        // ── BATCH MODE (file_pairs) ──
        if (cfFilePairs && cfFilePairs.length > 0) {
          // Parse pairs and group markers
          interface PairGroup { id: string; pairs: [string, string][] }
          const pairGroups: PairGroup[] = [];
          let currentPG: PairGroup | null = null;
          let ungroupedPairs: [string, string][] = [];

          for (const entry of cfFilePairs) {
            // Single-element entries are group markers
            const marker = Array.isArray(entry) ? (entry.length === 1 ? entry[0] : null) : entry;
            if (marker && typeof marker === "string" && GROUP_HEADER_RE.test(marker)) {
              if (currentPG && currentPG.pairs.length > 0) pairGroups.push(currentPG);
              if (ungroupedPairs.length > 0) { pairGroups.push({ id: "", pairs: ungroupedPairs }); ungroupedPairs = []; }
              currentPG = { id: marker.match(GROUP_HEADER_RE)![1], pairs: [] };
              continue;
            }
            if (marker && typeof marker === "string" && GROUP_FOOTER_RE.test(marker)) {
              if (currentPG && currentPG.pairs.length > 0) pairGroups.push(currentPG);
              currentPG = null;
              continue;
            }
            // Must be a [fileA, fileB] pair
            if (Array.isArray(entry) && entry.length === 2) {
              const pair: [string, string] = [entry[0], entry[1]];
              if (currentPG) currentPG.pairs.push(pair);
              else ungroupedPairs.push(pair);
            }
          }
          if (currentPG && currentPG.pairs.length > 0) pairGroups.push(currentPG);
          if (ungroupedPairs.length > 0) pairGroups.push({ id: "", pairs: ungroupedPairs });

          const isGrouped = pairGroups.some((g) => g.id !== "");
          const reportPaths: string[] = [];

          for (const pg of pairGroups) {
            if (pg.pairs.length === 0) continue;
            const sections: string[] = [];
            for (const [fA, fB] of pg.pairs) {
              const result = await comparePair(fA, fB, cfPrompt);
              if ("error" in result) {
                sections.push(`## ${fA} vs ${fB}\n\nFAILED: ${result.error}`);
              } else {
                sections.push(`## ${fA} vs ${fB}\n\n${result.content}`);
              }
            }
            const reportContent = sections.join("\n\n---\n\n");
            const gid = pg.id || undefined;
            const model = backend.model;
            const rp = saveResponse(
              "compare_files",
              reportContent,
              { model, task: `Batch compare: ${pg.pairs.length} pair(s)`, inputFile: pg.pairs[0][0], groupId: gid },
              undefined,
              outputDir,
            );
            if (isGrouped) reportPaths.push(`[group:${pg.id}] ${rp}`);
            else reportPaths.push(rp);
          }
          return { content: [{ type: "text", text: reportPaths.join("\n") }] };
        }

        // ── PAIR MODE (original: exactly 2 files) ──
        const cfNormalizedPaths = normalizePaths(cfInputPaths);
        if (cfNormalizedPaths.length !== 2) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: Provide input_files_paths (2 files), file_pairs (batch), or git_repo+from_ref (git diff).",
              },
            ],
            isError: true,
          };
        }
        // C1+H2: Sanitize input paths (traversal + symlink protection) before spawning diff
        let fileA: string, fileB: string;
        try {
          fileA = sanitizeInputPath(cfNormalizedPaths[0]);
          fileB = sanitizeInputPath(cfNormalizedPaths[1]);
        } catch (err) {
          return {
            content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }],
            isError: true,
          };
        }
        if (!existsSync(fileA)) {
          return {
            content: [
              { type: "text", text: `FAILED: File not found: ${fileA}` },
            ],
            isError: true,
          };
        }
        if (!existsSync(fileB)) {
          return {
            content: [
              { type: "text", text: `FAILED: File not found: ${fileB}` },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (cfScan && !cfRedact) {
          const scanResult = scanFilesForSecrets([fileA, fileB]);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        // Compute unified diff using system diff command
        // diff exit codes: 0=identical, 1=different, 2=error
        const diffResult = spawnSync(
          "diff",
          ["-u", "--label", fileA, "--label", fileB, "--", fileA, fileB],
          {
            encoding: "utf-8",
            timeout: 30000,
          },
        );

        if (diffResult.status === 2 || diffResult.error) {
          const errMsg =
            diffResult.error?.message ||
            diffResult.stderr ||
            "Unknown diff error";
          return {
            content: [
              { type: "text", text: `FAILED: diff command error: ${errMsg}` },
            ],
            isError: true,
          };
        }

        let diffOutput = diffResult.stdout?.trim()
          ? diffResult.stdout
          : "(files are identical — no differences found)";

        // Truncate huge diffs to avoid overwhelming the LLM context window
        const MAX_DIFF_CHARS = 200_000; // ~50K tokens
        let diffTruncated = false;
        if (diffOutput.length > MAX_DIFF_CHARS) {
          diffOutput = diffOutput.slice(0, MAX_DIFF_CHARS);
          diffTruncated = true;
        }
        // Apply secret redaction to diff content
        if (cfRedact) {
          diffOutput = redactSecrets(diffOutput).redacted;
        }

        // Include both source files alongside the diff for context on renamed/moved code
        let sourceFileBlocks = "";
        try {
          const blockA = readFileAsCodeBlock(fileA, undefined, cfRedact, cfBudgetBytes);
          const blockB = readFileAsCodeBlock(fileB, undefined, cfRedact, cfBudgetBytes);
          // Only include source files if total size is manageable
          const totalSourceChars = blockA.length + blockB.length;
          if (totalSourceChars < 300_000) {
            sourceFileBlocks = `\n\n## File A (full): ${fileA}\n\n${blockA}\n\n## File B (full): ${fileB}\n\n${blockB}`;
          }
        } catch {
          // Files too large or binary — diff-only comparison is fine
        }

        const diffFence = fenceBackticks(diffOutput);
        const cfMessages: ChatMessage[] = [
          {
            role: "system",
            content: compareFilesSystemPrompt(FILE_FORMAT_EXAMPLE + BREVITY_RULES),
          },
          {
            role: "user",
            content:
              `${cfPrompt ? cfPrompt + "\n\n" : ""}` +
              `Compare these two files and summarize all differences:\n` +
              `- File A (before): ${fileA}\n` +
              `- File B (after): ${fileB}\n\n` +
              `Unified diff${diffTruncated ? " (TRUNCATED — original diff was too large)" : ""}:\n${diffFence}\n${diffOutput}\n${diffFence}` +
              sourceFileBlocks,
          },
        ];

        const cfResp = await ensembleStreaming(
          cfMessages,
          {
            temperature: DEFAULT_TEMPERATURE,
            maxTokens: resolveDefaultMaxTokens(),
            onProgress,
            modelOverride,
          },
          cfUseEnsemble,
        );
        const cfFooter = formatFooter(cfResp, "compare_files", fileA);
        // Shared response gate (TRDD-P4ULUV1R): echo added beside the empty check.
        const cfVerdict = gateLLMResponse(cfResp.content, String(cfMessages[1].content));
        if (cfVerdict !== null) {
          return {
            content: [
              { type: "text", text: `FAILED: ${gateFailureMessage(cfVerdict)}.` },
            ],
            isError: true,
          };
        }

        const cfReportPath = saveResponse(
          "compare_files",
          cfResp.content + cfFooter,
          { model: cfResp.model, task: `Compare ${basename(fileA)} vs ${basename(fileB)}`, inputFile: fileA },
          undefined,
          outputDir,
        );
        return { content: [{ type: "text", text: cfReportPath }] };
      }

      case "check_references": {
        const {
          input_files_paths: crInputPathsRaw,
          instructions: crInstructions,
          instructions_files_paths: crInstructionsFilesPaths,
          redact_secrets: crRedact,
          answer_mode: crRawMode,
          scan_secrets: crScan,
          max_payload_kb: crMaxPayloadKb,
          redact_regex: crRedactRegexRaw,
          folder_path: crFolderPath,
          extensions: crExtensions,
          exclude_dirs: crExcludeDirs,
          use_gitignore: crUseGitignore,
          recursive: crRecursive,
          follow_symlinks: crFollowSymlinks,
          max_files: crMaxFiles,
        } = args as {
          input_files_paths: string | string[];
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          answer_mode?: number;
          scan_secrets?: boolean;
          max_payload_kb?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        const crUseEnsemble = backend.type === "openrouter";
        const crBudgetBytes = (crMaxPayloadKb ?? 400) * 1024;

        let crRegexRedact: RegexRedactOpts | null = null;
        try { crRegexRedact = parseRedactRegex(crRedactRegexRaw); }
        catch (err) { return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true }; }

        let crFilePathsAll = [...new Set(normalizePaths(crInputPathsRaw))];
        if (crFolderPath) {
          const folderResult = resolveFolderPath(crFolderPath, {
            extensions: crExtensions, excludeDirs: crExcludeDirs,
            useGitignore: crUseGitignore, recursive: crRecursive,
            followSymlinks: crFollowSymlinks, maxFiles: crMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && crFilePathsAll.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          crFilePathsAll = [...new Set([...crFilePathsAll, ...folderResult.files])];
        }
        if (crFilePathsAll.length === 0) {
          return {
            content: [
              { type: "text", text: "FAILED: input_files_paths or folder_path is required." },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (crScan && !crRedact) {
          const crRealFiles = crFilePathsAll.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (crRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(crRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
        }

        const crPrompt = resolvePrompt(
          crInstructions,
          crInstructionsFilesPaths,
        );
        const crMode = resolveAnswerMode(crRawMode, 0);

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". If the caller did not
        // supply ---GROUP:id--- markers, auto-group files by heuristic so
        // the grouped-output path below can run unchanged.
        let crFileGroups = parseFileGroups(crFilePathsAll);
        let crEffectivelyGrouped = hasNamedGroups(crFileGroups);
        if (crMode === 1 && !crEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(crFilePathsAll);
          if (autoGroups.length > 0) {
            crFileGroups = autoGroups;
            crEffectivelyGrouped = true;
          }
        }

        if (crEffectivelyGrouped) {
          const crGroupReports: string[] = [];
          for (const fg of crFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "auto";
            const gReports: string[] = [];
            for (const filePath of fg.files) {
              if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
              const src = readFileSync(filePath, "utf-8");
              const lang = detectLang(filePath);
              const deps = extractLocalImports(filePath, src);
              const depBlocks: string[] = [];
              for (const dp of deps) { try { depBlocks.push(readFileAsCodeBlock(dp, undefined, crRedact, crBudgetBytes, crRegexRedact)); } catch { /* skip */ } }
              const srcBlock = readFileAsCodeBlock(filePath, undefined, crRedact, crBudgetBytes, crRegexRedact);
              const msgs: ChatMessage[] = [
                { role: "system", content: `Expert ${lang} developer. Check the source file for broken or outdated references to functions, variables, constants, types, and classes. Cross-reference all symbols against the dependency files provided. Report each broken reference with: the symbol name, the function/class/method where it is used (never by line number), and what is wrong. Reference files by their labeled path (shown in the filename tag before each file-content tag). If all references are valid, say so.` + FILE_FORMAT_EXAMPLE + BREVITY_RULES },
                { role: "user", content: `${crPrompt ? crPrompt + "\n\n" : ""}Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n${depBlocks.length > 0 ? `## Local Dependencies (${deps.length} files)\n\n${depBlocks.join("\n\n")}` : "## No local dependencies resolved."}` },
              ];
              const resp = await ensembleStreaming(msgs, { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride }, crUseEnsemble, src.split("\n").length);
              const footer = formatFooter(resp, "check_references", filePath);
              // Shared response gate (TRDD-P4ULUV1R): an echoed reply (the
              // source file returned verbatim) is dropped like an empty one.
              if (gateLLMResponse(resp.content, String(msgs[1].content)) === null) {
                const depInfo = deps.length > 0 ? `\n\nDependencies checked: ${deps.map((p) => `\`${p}\``).join(", ")}` : "";
                gReports.push(`## File: ${filePath}${depInfo}\n\n${resp.content}${footer}`);
              }
            }
            if (gReports.length > 0) {
              const mergedPath = saveResponse(
                "check_references",
                gReports.join("\n\n---\n\n"),
                { model: backend.model, task: "Check references", inputFile: fg.files[0], groupId: gid },
                undefined,
                outputDir,
              );
              crGroupReports.push(`[group:${gid}] ${mergedPath}`);
            }
          }
          if (crGroupReports.length === 0) {
            return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
          }
          return { content: [{ type: "text", text: crGroupReports.join("\n") }] };
        }

        // Non-grouped: existing behavior
        const crFilePaths = crFilePathsAll;
        const crReports: string[] = [];
        const crReportPaths: string[] = [];

        for (const filePath of crFilePaths) {
          if (!existsSync(filePath)) {
            crReports.push(`## ${filePath}\n\nFAILED: File not found.`);
            crReportPaths.push("(skipped — file not found)");
            continue;
          }
          const crSourceCode = readFileSync(filePath, "utf-8");
          const crLang = detectLang(filePath);

          // Auto-resolve local imports and read dependency files
          const depPaths = extractLocalImports(filePath, crSourceCode);
          const depBlocks: string[] = [];
          for (const dp of depPaths) {
            try {
              depBlocks.push(readFileAsCodeBlock(dp, undefined, crRedact, crBudgetBytes, crRegexRedact));
            } catch {
              /* skip unreadable */
            }
          }

          const srcBlock = readFileAsCodeBlock(filePath, undefined, crRedact, crBudgetBytes, crRegexRedact);
          const crMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                `Expert ${crLang} developer. Check the source file for broken or outdated references to ` +
                "functions, variables, constants, types, and classes. Cross-reference all symbols against the " +
                "dependency files provided. Report each broken reference with: the symbol name, the function/class/method " +
                "where it is used (never by line number), and what is wrong (missing, renamed, wrong signature, deprecated). " +
                "Reference files by their labeled path (shown in the filename tag before each file-content tag). If all references are valid, say so." +
                FILE_FORMAT_EXAMPLE + BREVITY_RULES,
            },
            {
              role: "user",
              content:
                `${crPrompt ? crPrompt + "\n\n" : ""}` +
                `Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n` +
                (depBlocks.length > 0
                  ? `## Local Dependencies (${depPaths.length} files)\n\n${depBlocks.join("\n\n")}`
                  : "## No local dependencies resolved — check for external import issues."),
            },
          ];

          const crLineCount = crSourceCode.split("\n").length;
          const crResp = await ensembleStreaming(
            crMessages,
            {
              temperature: DEFAULT_TEMPERATURE,
              maxTokens: resolveDefaultMaxTokens(),
              onProgress,
              modelOverride,
            },
            crUseEnsemble,
            crLineCount,
          );
          const crFooter = formatFooter(crResp, "check_references", filePath);

          // Shared response gate (TRDD-P4ULUV1R): echo dropped like empty.
          if (gateLLMResponse(crResp.content, String(crMessages[1].content)) === null) {
            const depInfo =
              depPaths.length > 0
                ? `\n\nDependencies checked: ${depPaths.map((p) => `\`${p}\``).join(", ")}`
                : "";
            if (crMode === 0) {
              const rp = saveResponse(
                "check_references",
                crResp.content + crFooter + depInfo,
                { model: crResp.model, task: "Check references", inputFile: filePath },
                undefined,
                outputDir,
              );
              crReportPaths.push(rp);
            } else {
              crReports.push(
                `## File: ${filePath}${depInfo}\n\n${crResp.content}${crFooter}`,
              );
            }
          }
        }

        if (crMode === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  crReportPaths.length > 0
                    ? crReportPaths.join("\n")
                    : "FAILED: LLM returned empty response.",
              },
            ],
            isError: crReportPaths.length === 0,
          };
        }
        if (crReports.length === 0) {
          return {
            content: [
              { type: "text", text: "FAILED: LLM returned empty response." },
            ],
            isError: true,
          };
        }
        const crMergedPath = saveResponse(
          "check_references",
          crReports.join("\n\n---\n\n"),
          { model: backend.model, task: "Check references", inputFile: crFilePaths[0] },
          undefined,
          outputDir,
        );
        return { content: [{ type: "text", text: crMergedPath }] };
      }

      case "check_imports": {
        const {
          input_files_paths: ciInputPathsRaw,
          project_root,
          instructions: ciInstructions,
          instructions_files_paths: ciInstructionsFilesPaths,
          redact_secrets: ciRedact,
          answer_mode: ciRawMode,
          scan_secrets: ciScan,
          max_payload_kb: ciMaxPayloadKb,
          redact_regex: ciRedactRegexRaw,
          folder_path: ciFolderPath,
          extensions: ciExtensions,
          exclude_dirs: ciExcludeDirs,
          use_gitignore: ciUseGitignore,
          recursive: ciRecursive,
          follow_symlinks: ciFollowSymlinks,
          max_files: ciMaxFiles,
        } = args as {
          input_files_paths: string | string[];
          project_root?: string;
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          answer_mode?: number;
          scan_secrets?: boolean;
          max_payload_kb?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        // check_imports uses chatCompletionJSON directly (not ensembleStreaming),
        // so the backend type is not referenced in this case body (other than
        // via the shared snapshot for the saveResponse() metadata).
        const ciBudgetBytes = (ciMaxPayloadKb ?? 400) * 1024;

        let ciRegexRedact: RegexRedactOpts | null = null;
        try { ciRegexRedact = parseRedactRegex(ciRedactRegexRaw); }
        catch (err) { return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true }; }

        let ciFilePathsAll = [...new Set(normalizePaths(ciInputPathsRaw))];
        if (ciFolderPath) {
          const folderResult = resolveFolderPath(ciFolderPath, {
            extensions: ciExtensions, excludeDirs: ciExcludeDirs,
            useGitignore: ciUseGitignore, recursive: ciRecursive,
            followSymlinks: ciFollowSymlinks, maxFiles: ciMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && ciFilePathsAll.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          ciFilePathsAll = [...new Set([...ciFilePathsAll, ...folderResult.files])];
        }
        if (ciFilePathsAll.length === 0) {
          return {
            content: [
              { type: "text", text: "FAILED: input_files_paths or folder_path is required." },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (ciScan && !ciRedact) {
          const ciRealFiles = ciFilePathsAll.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (ciRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(ciRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
        }

        const ciPrompt = resolvePrompt(
          ciInstructions,
          ciInstructionsFilesPaths,
        );
        const ciMode = resolveAnswerMode(ciRawMode, 0);

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". Auto-group the files
        // when the caller did not supply ---GROUP:id--- markers.
        let ciFileGroups = parseFileGroups(ciFilePathsAll);
        let ciEffectivelyGrouped = hasNamedGroups(ciFileGroups);
        if (ciMode === 1 && !ciEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(ciFilePathsAll);
          if (autoGroups.length > 0) {
            ciFileGroups = autoGroups;
            ciEffectivelyGrouped = true;
          }
        }
        if (ciEffectivelyGrouped) {
          const ciGroupReports: string[] = [];
          for (const fg of ciFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "auto";
            const gReports: string[] = [];
            for (const filePath of fg.files) {
              if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
              const ciLang = detectLang(filePath);
              const fileDir = dirname(filePath);
              const ciResolveBase = project_root || fileDir;
              // Prompt built by the SHARED seam (TRDD-f45eeaa0). It used to be
              // inline here AND on the ungrouped path below — two copies of one
              // prompt, which drift the day one is edited. The benchmark drives
              // this same function, so it scores the real tool.
              const extractMessages: ChatMessage[] = buildCheckImportsExtractMessages({
                lang: ciLang,
                userPrompt: ciPrompt,
                fileBlock: readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact),
                fileFormatExample: FILE_FORMAT_EXAMPLE,
              });
              const extractResp = await chatCompletionJSONWithFreeRotation(extractMessages, { temperature: 0, maxTokens: resolveDefaultMaxTokens(), jsonSchema: EXTRACT_PATHS_SCHEMA, onProgress });
              recordUsage(extractResp.usage);
              logRequest({ tool: "check_imports", model: extractResp.model, status: "success", usage: extractResp.usage, filePath });
              const rawPaths = extractResp.parsed.paths;
              const extractedPaths: string[] = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === "string") : [];
              const validPaths: string[] = []; const brokenPaths: string[] = []; const packageImports: string[] = [];
              for (const importPath of extractedPaths) {
                if (!importPath.startsWith(".") && !importPath.startsWith("/")) { packageImports.push(importPath); continue; }
                const resolveDir = importPath.startsWith(".") ? fileDir : ciResolveBase;
                const resolvedBase = importPath.startsWith("/") ? resolve(importPath) : join(resolveDir, importPath);
                if (!resolvedBase.startsWith(ciResolveBase) && !resolvedBase.startsWith(fileDir)) { packageImports.push(importPath); continue; }
                let found = existsSync(resolvedBase) && statSync(resolvedBase).isFile();
                if (!found && !extname(resolvedBase)) {
                  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".json"]) { if (existsSync(resolvedBase + ext)) { found = true; break; } }
                  if (!found) { for (const ext of [".ts", ".tsx", ".js", ".jsx"]) { if (existsSync(join(resolvedBase, `index${ext}`))) { found = true; break; } } }
                }
                (found ? validPaths : brokenPaths).push(importPath);
              }
              const lines = [`# Import Check: ${filePath}`, "", `**Total**: ${extractedPaths.length}, **Valid**: ${validPaths.length}, **BROKEN**: ${brokenPaths.length}, **Packages**: ${packageImports.length}`, ""];
              if (brokenPaths.length > 0) lines.push("## BROKEN IMPORTS", "", ...brokenPaths.map((p) => `- \`${p}\``), "");
              if (validPaths.length > 0) lines.push("## Valid", "", ...validPaths.map((p) => `- \`${p}\``), "");
              gReports.push(lines.join("\n"));
            }
            if (gReports.length > 0) {
              const mergedPath = saveResponse(
                "check_imports",
                gReports.join("\n\n---\n\n"),
                { model: backend.model, task: "Check imports", inputFile: fg.files[0], groupId: gid },
                undefined,
                outputDir,
              );
              ciGroupReports.push(`[group:${gid}] ${mergedPath}`);
            }
          }
          if (ciGroupReports.length === 0) {
            return { content: [{ type: "text", text: "No reports generated." }], isError: true };
          }
          return { content: [{ type: "text", text: ciGroupReports.join("\n") }] };
        }

        // Non-grouped: existing behavior
        const ciFilePaths = ciFilePathsAll;
        const ciReports: string[] = [];
        const ciReportPaths: string[] = [];

        for (const filePath of ciFilePaths) {
          if (!existsSync(filePath)) {
            ciReports.push(`## ${filePath}\n\nFAILED: File not found.`);
            ciReportPaths.push("(skipped — file not found)");
            continue;
          }
          const ciLang = detectLang(filePath);
          const fileDir = dirname(filePath);
          // Use project_root for resolving imports if provided, fall back to file's directory
          const ciResolveBase = project_root || fileDir;

          // Phase 1: Ask LLM to extract all file/import references
          const extractMessages: ChatMessage[] = buildCheckImportsExtractMessages({
            lang: ciLang,
            userPrompt: ciPrompt,
            fileBlock: readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact),
            fileFormatExample: FILE_FORMAT_EXAMPLE,
          });

          const extractResp = await chatCompletionJSONWithFreeRotation(
            extractMessages,
            {
              temperature: 0,
              maxTokens: resolveDefaultMaxTokens(),
              jsonSchema: EXTRACT_PATHS_SCHEMA,
              onProgress,
            },
          );
          recordUsage(extractResp.usage);
          logRequest({
            tool: "check_imports",
            model: extractResp.model,
            status: "success",
            usage: extractResp.usage,
            filePath,
          });

          const rawPaths = extractResp.parsed.paths;
          const extractedPaths: string[] = Array.isArray(rawPaths)
            ? rawPaths.filter((p): p is string => typeof p === "string")
            : [];

          // Phase 2: Validate each path on disk
          const validPaths: string[] = [];
          const brokenPaths: string[] = [];
          const packageImports: string[] = [];

          for (const importPath of extractedPaths) {
            // Skip package/module imports (not relative paths)
            if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
              packageImports.push(importPath);
              continue;
            }
            // Dot-relative imports (./foo, ../bar) resolve against the file's own directory,
            // NOT project_root. Only absolute paths use ciResolveBase.
            const resolveDir = importPath.startsWith(".")
              ? fileDir
              : ciResolveBase;
            const resolvedBase = importPath.startsWith("/")
              ? resolve(importPath)
              : join(resolveDir, importPath);
            // Reject paths resolving outside allowed project directories to prevent filesystem oracle attacks.
            if (!resolvedBase.startsWith(ciResolveBase) && !resolvedBase.startsWith(fileDir)) {
              packageImports.push(importPath);
              continue;
            }
            let found = false;

            if (existsSync(resolvedBase) && statSync(resolvedBase).isFile()) {
              found = true;
            }
            if (!found && !extname(resolvedBase)) {
              for (const ext of [
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                ".mjs",
                ".cjs",
                ".py",
                ".go",
                ".rs",
                ".json",
              ]) {
                if (existsSync(resolvedBase + ext)) {
                  found = true;
                  break;
                }
              }
              if (!found) {
                for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
                  if (existsSync(join(resolvedBase, `index${ext}`))) {
                    found = true;
                    break;
                  }
                }
              }
            }

            if (found) {
              validPaths.push(importPath);
            } else {
              brokenPaths.push(importPath);
            }
          }

          // Build report
          const ciReportLines: string[] = [
            `# Import Check: ${filePath}`,
            "",
            `**Total references extracted**: ${extractedPaths.length}`,
            `**Local valid**: ${validPaths.length}`,
            `**Local BROKEN**: ${brokenPaths.length}`,
            `**Package imports** (not checked): ${packageImports.length}`,
            "",
          ];
          if (brokenPaths.length > 0) {
            ciReportLines.push(
              "## BROKEN IMPORTS",
              "",
              ...brokenPaths.map((p) => `- \`${p}\``),
              "",
            );
          }
          if (validPaths.length > 0) {
            ciReportLines.push(
              "## Valid Imports",
              "",
              ...validPaths.map((p) => `- \`${p}\``),
              "",
            );
          }
          if (packageImports.length > 0) {
            ciReportLines.push(
              "## Package Imports (not checked)",
              "",
              ...packageImports.map((p) => `- \`${p}\``),
              "",
            );
          }

          const ciReportText = ciReportLines.join("\n");
          if (ciMode === 0) {
            const rp = saveResponse(
              "check_imports",
              ciReportText,
              { model: extractResp.model, task: "Check imports", inputFile: filePath },
              undefined,
              outputDir,
            );
            ciReportPaths.push(rp);
          } else {
            ciReports.push(ciReportText);
          }
        }

        if (ciMode === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  ciReportPaths.length > 0
                    ? ciReportPaths.join("\n")
                    : "No reports generated.",
              },
            ],
          };
        }
        if (ciReports.length === 0) {
          return {
            content: [{ type: "text", text: "No reports generated." }],
            isError: true,
          };
        }
        const ciMergedPath = saveResponse(
          "check_imports",
          ciReports.join("\n\n---\n\n"),
          { model: backend.model, task: "Check imports", inputFile: ciFilePaths[0] },
          undefined,
          outputDir,
        );
        return { content: [{ type: "text", text: ciMergedPath }] };
      }

      case "check_against_specs": {
        // Pipeline body extracted to check-specs/core.ts (P2a, zero-token model
        // pipeline), mirroring the search_existing / scan_folder / code_task
        // extractions so the REAL pipeline can run in-process from a benchmark
        // runner; this case only wires the server-stateful deps. Unlike
        // scan_folder there is no per-file processFileCheck seam: every LLM call
        // (answer_mode 0's one-call-per-file path and the FFD-batched path alike)
        // goes through ensembleStreaming, so that is the single LLM seam.
        const csDeps: CheckSpecsDeps = {
          useEnsemble: backend.type === "openrouter",
          normalizePaths,
          resolveFolderPath,
          ensembleStreaming,
          formatFooter,
          saveResponse,
          ensembleModelLabel,
          resolveDefaultMaxTokens,
          onProgress,
          outputDir,
          modelOverride, // honours --free and credit-exhausted auto-fallback
        };
        return await runCheckAgainstSpecs(args as Record<string, unknown>, csDeps);
      }

      case "cluster_synonyms": {
        // Phase B implementation — runClusterSynonyms orchestrates JSONL
        // load → optional pre-flight → embeddings → Phase 1 grouping via
        // retry-ladder → checkpoint write → emit four outputs. Phase 2
        // verification + Phase 3 LLM canonical labels are still no-ops in
        // this cut; clusters.jsonl reflects Phase 1 partitions alone.
        const {
          input_file: csInputFile,
          output_dir: csOutputDir,
          embeddings_file: csEmbeddingsFile,
          policy_file: csPolicyFile,
          resume_from: csResumeFrom,
        } = args as {
          input_file?: string;
          output_dir?: string;
          embeddings_file?: string;
          policy_file?: string;
          resume_from?: string;
        };
        if (!csInputFile || !csOutputDir) {
          return {
            content: [{ type: "text", text: "FAILED: cluster_synonyms requires input_file and output_dir." }],
            isError: true,
          };
        }
        const csInvocation: ClusterSynonymsInvocation = {
          input_file: csInputFile,
          output_dir: csOutputDir,
          ...(csEmbeddingsFile !== undefined ? { embeddings_file: csEmbeddingsFile } : {}),
          ...(csPolicyFile !== undefined ? { policy_file: csPolicyFile } : {}),
          ...(csResumeFrom !== undefined ? { resume_from: csResumeFrom } : {}),
        };
        // Wire the existing completion layer as the rawLlmCall so the cluster
        // orchestrator inherits rate-limiting / retry / model-fallback logic
        // from the rest of the server (chatCompletionWithProfileFallback for
        // the funded/non-free path below -- TRDD-OE27RD7I 14.1-C2 §0).
        const csRawLlmCall: Phase1RawLlmCall = async (prompt) => {
          const messages: ChatMessage[] = [{ role: "user", content: prompt }];
          // Cost guard (TRDD-ec45c66f): synonym clustering/canonicalisation is a
          // small classification — the model emits a short JSON object, not prose.
          // It must NEVER reason (reasoning tokens are billed and would dwarf the
          // answer on a reasoning primary like deepseek-v4-pro) and never needs a
          // 65K output budget. reasoning:"off" + a 4K cap keep each call cheap.
          const csCallOpts = {
            temperature: 0.1,
            maxTokens: 4096,
            reasoning: "off" as const,
          };
          // Free mode: rotate across the approved free pool. A clustering run is
          // thousands of small calls, so a daily-capped model here is guaranteed
          // to be hit — and without rotation it would abort the whole run.
          // The 4K cap survives rotation (the helper clamps DOWN, never up), so
          // the cost guard above still holds on every fallback model.
          const csPool = isFreeModeActive() ? buildFreeRotationPool() : [];
          const resp =
            csPool.length > 0
              ? await callSingleWithFreeRotation(
                  csPool[0],
                  csPool.slice(1),
                  messages,
                  csCallOpts,
                )
              // TRDD-OE27RD7I 14.1-C2 §0 (review follow-up): funded/non-free
              // path had zero fallback on a model failure since C1 deleted
              // the credit-borrow this call's own comment used to rely on
              // ("inherits ... model-fallback logic") -- walk the profile's
              // own chain instead of a bare single attempt.
              : await chatCompletionWithProfileFallback(messages, csCallOpts, providerDeps);
          if (resp.finishReason === "error") {
            throw new Error(`cluster_synonyms: LLM call failed: ${resp.content}`);
          }
          return resp.content;
        };
        // compute_embeddings.py lives alongside the built dist/ — resolve
        // from this module's URL so the path follows the install layout.
        const csModuleDir = dirname(fileUrlToPath_cs(import.meta.url));
        const csEmbeddingsScript = join(csModuleDir, "..", "scripts", "compute_embeddings.py");
        // Wire the pre-flight benchmark gate (TRDD-828238b5 B4): before an
        // expensive clustering run, prove the configured model can do
        // meaning-equivalence clustering on 3 sentences. makePreflightHook wraps
        // runPreflightBenchmark, which caches the verdict per-model-per-day, so
        // this is at most one tiny call/day; an LLM-call failure becomes
        // {ok:false} → the core early-aborts (fail-closed gate). Users opt out
        // via the policy's skip_preflight_benchmark flag (the core honors it).
        const csPreflightModel = getCurrentBackend().model ?? "unknown";
        const csHooks: ClusterSynonymsHooks = {
          rawLlmCall: csRawLlmCall,
          embeddingsScriptPath: csEmbeddingsScript,
          profileName: csPreflightModel,
          preflight: makePreflightHook(csPreflightModel, (prompt) =>
            csRawLlmCall(prompt),
          ),
        };
        try {
          const csResult = await runClusterSynonyms(csInvocation, csHooks);
          if (!csResult.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `FAILED: ${csResult.errors.join("; ")}`,
                },
              ],
              isError: true,
            };
          }
          const csSummary =
            `cluster_synonyms OK\n` +
            `  items_in:        ${csResult.stats.items_in}\n` +
            `  clusters_out:    ${csResult.stats.clusters_out}\n` +
            `  reduction_pct:   ${csResult.stats.reduction_pct.toFixed(2)}%\n` +
            `  llm_calls_total: ${csResult.stats.llm_calls_total}\n` +
            `  walltime_s:      ${csResult.stats.walltime_seconds.toFixed(2)}\n` +
            `  budget_exhausted: ${csResult.stats.budget_exhausted}\n` +
            `  warnings:        ${csResult.stats.warnings.length}\n` +
            `  outputs:\n` +
            `    ${csResult.clusters_jsonl}\n` +
            `    ${csResult.clusters_summary_json}\n` +
            `    ${csResult.stats_json}\n` +
            `    ${csResult.checkpoint_sqlite}\n`;
          return { content: [{ type: "text", text: csSummary }] };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `FAILED: cluster_synonyms threw: ${errMsg}` }],
            isError: true,
          };
        }
      }

      default:
        // Return the same shape every other branch uses instead of throwing.
        // Throwing falls into the outer try/catch which logs the unknown name
        // as a service error and bumps the SERVICE_HEALTH error counter — that
        // attribution is wrong for a typo'd tool name (no LLM call was made).
        // The early return here keeps the session-error counter honest.
        return {
          content: [{ type: "text", text: `FAILED: Unknown tool '${name}'.` }],
          isError: true,
        };
    }
    } finally {
      // Release active request tracker so `reset` can proceed when all LLM calls finish
      if (isLLMTool) trackRequestEnd();
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // T2.7 — snapshot for atomic .model read in error log
    const errBackend = getCurrentBackend();
    // Log errors to the session log file
    logRequest({
      tool: name,
      model: errBackend.model ?? "",
      status: "error",
      error: errMsg,
    });
    // TRDD-OE27RD7I 14.1-C2 §1: a whole-chain exhaustion prints the Rule's
    // OWN sentence verbatim -- no "Error: " prefix, no stack trace, no
    // retry (D2: for a dynamic profile, the retry-later sentence; its update
    // already runs in the background). cli/main.ts's own catch writes `text`
    // straight to stderr on isError, so this IS the exact stderr line the
    // Rule specifies.
    if (error instanceof ProfileExhaustedError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: `Error: ${errMsg}` }],
      isError: true,
    };
  } finally {
    // D2: the pre-flight's detector, fired AFTER the work so it can never hold
    // the profile's lock while this command asks for an update (see the
    // pre-flight). Fire-and-forget: spawnDetachedDetector never throws for a
    // spawn problem and never waits for the child.
    if (detectAfterDispatch !== null) {
      spawnDetachedDetector({ profile: detectAfterDispatch, log: (m) => process.stderr.write(m) });
    }
  }
}

/**
 * Prepare the engine for dispatch. MUST be awaited before dispatchCallTool()
 * (which throws otherwise — see `_booted`).
 *
 * This is the surviving half of what used to be `main()`: the MCP transport and
 * the registerTool loop are gone, but the three side effects below were never
 * about MCP and are still required. `publishFreeState()` in particular is
 * load-bearing and easy to lose: the module-init chokepoint is set at import
 * from the profile's own `free_only` and does NOT yet know the
 * `allow_paid_models` master switch, because the force-free `let` + helpers live
 * below the boot IIFE and would be in the TDZ there. boot() runs after every
 * binding is ready, so it recomputes the master-switch force and re-publishes
 * the chokepoint — without it a remote profile runs PAID under
 * `allow_paid_models: false`, silently.
 *
 * Idempotent: safe to call more than once (the CLI calls it exactly once).
 */
export async function boot(): Promise<void> {
  if (_booted) return;
  publishFreeState();
  // Write the stats file up front so the statusline has numbers immediately.
  writeStatsFile();
  // Install/update the plugin's usage rule into ~/.claude/rules/. Best-effort +
  // content-gated: never blocks boot, no churn after the first sync. Opt out
  // with LLM_EXT_INSTALL_RULE=0.
  try {
    const ruleResult = installUsageRule();
    if (ruleResult.status === "installed" || ruleResult.status === "updated") {
      process.stderr.write(
        `[llm-externalizer] Usage rule ${ruleResult.status}: ${ruleResult.dest}\n`,
      );
    } else if (ruleResult.status === "error") {
      process.stderr.write(
        `[llm-externalizer] Usage-rule install skipped: ${ruleResult.detail ?? "unknown"}\n`,
      );
    }
  } catch (e) {
    process.stderr.write(
      `[llm-externalizer] Usage-rule install error (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  _booted = true;
}

/**
 * The banner the old server printed at startup. Split out of boot() because a
 * CLI must be able to stay quiet: piping a report path into another command
 * should not dump five lines of preamble first. The CLI prints this only for
 * interactive/verbose invocations. Writes to STDERR so STDOUT stays clean.
 */
export function writeBootBanner(): void {
  const bootBackend = getCurrentBackend();
  // fq83/fix-queue 89: PLACEHOLDER_MODEL_ID is an internal sentinel for
  // "profile never populated" (see config.ts), not a real model id -- the
  // spec says it must never reach the user. Compute the population-state
  // label FIRST, then build every line's model text off THIS label, never
  // off bootBackend.model directly -- fq83 only patched the OpenRouter
  // branch below; the Local/Remote branch's `suffix` still interpolated
  // the raw sentinel, so an unpopulated `local` section (whose stub `api:
  // lmstudio-local` resolves to a real localhost:1234 URL before
  // dynamicProfileGate ever runs -- row 95a) printed
  // "Local (http://localhost:1234, placeholder/unpopulated-default-profile)".
  const modelLabel =
    bootBackend.model === PLACEHOLDER_MODEL_ID
      ? `${effectiveProfileName(activeSettings)}: not benchmarked yet`
      : bootBackend.model;
  // "local" here is BackendConfig.type, which means "not the OpenRouter request
  // path" — it does NOT mean the server is on this machine. A remote
  // OpenAI-compatible preset (chat-b-ai-remote) is type "local" by that rule, so
  // labelling off the type alone printed "Local (https://api.b.ai)" — a claim the
  // URL on the same line contradicts. Decide the word from the URL instead.
  const suffix = `${bootBackend.baseUrl}${modelLabel ? `, ${modelLabel}` : ""}`;
  const backendLabel =
    bootBackend.type === "openrouter"
      ? `OpenRouter (${modelLabel})`
      : isLocalUrl(bootBackend.baseUrl)
        ? `Local (${suffix})`
        : `Remote (${suffix})`;
  process.stderr.write(`LLM Externalizer — backend: ${backendLabel}\n`);
  process.stderr.write(`Settings: ${SETTINGS_FILE}\n`);
  process.stderr.write(`Session log: ${LOG_FILE}\n`);
}
