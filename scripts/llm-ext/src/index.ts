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
import { join, basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeStatsJsonGuarded } from "./stats-file.js";
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
} from "./grouping.js";

import {
  MASS_SCOUT_TOOL_NAMES,
  dispatchMassScoutTool,
} from "./mass_scouting/mcp-tools.js";
import { safeReadJson } from "./safe-body.js";
import { buildTools } from "./tools/definitions.js";
import { writeSettingsCopy } from "./tools/settings-copy.js";
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
import { classifyContextOverflow } from "./session_summary/chunker.js";
// Provider layer (B1 Phase 5a/5b, TRDD-63314265). These modules import NOTHING
// from index.ts — the mutable backend/profile state they need is handed to them
// through the `providerDeps` seam object built below.
import { fetchWithTimeout, RetryDeadlineError, failureText, failureOf, hostOf, isOpenRouterHost, OUTAGE_NETWORK_CODES, stoppedError, stopIfStopOnErrors } from "./provider/http.js";
import {
  clearLMStudioProbeCache,
} from "./provider/lmstudio.js";
import {
  chatCompletionJSON,
  chatCompletionWithRetry,
  type JSONCompletionResult,
  type SimpleCompletionOptions,
} from "./provider/completion.js";
import { sendRefusal } from "./provider/connection.js";
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
  scanFilesForSecrets,
  redactSecrets,
  isCalibratedBudget,
  registerCalibratedBudget,
  buildPreInstructions,
  resolvePrompt,
  walkDir,
  BREVITY_RULES,
  FILE_FORMAT_EXAMPLE,
  codeTaskSystemPrompt,
  numberedLineCount,
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
import { type FileUsage } from "./usage-totals.js";
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

import type { NetworkGiveUp, RetryClock } from "./provider/http.js";
import { brokerClientVersion, brokerQueueTimeoutMs, defaultBrokerEntry, endpointFailureKind, ensureBroker } from "./broker/client.js";
import { checkModelChanges, markProfileUsed } from "./calibration/triggers.js";
import { enqueueUnlocked, withStateLock } from "./calibration/state.js";
import { ensureCalibrator } from "./calibration/runner.js";
import { CommandStoppedError, commandStopReason, stoppableSleep } from "./command-stop.js";
import { timingsFromEnv } from "./broker/scheduler.js";
import { serverStatusText, serverStopText } from "./broker/server-commands.js";

import { handleBatchCheck } from "./tools/batch-check.js";
import { handleChat } from "./tools/chat.js";
import { handleCheckReferences } from "./tools/check-references.js";
import { handleDiscover } from "./tools/discover.js";
import { handleOrModelInfoJson } from "./tools/or-model-info-json.js";
import { handleCheckImports } from "./check-imports/handler.js";
import { handleSessionSummary } from "./session_summary/handler.js";
import type {
  ErrorClassification,
  FileProcessResult,
  FolderResolveResult,
  OpenRouterModelInfo,
  ProcessOptions,
  RateLimitConfig,
  RobustPerFileOpts,
  RobustPerFileResult,
  ToolResult,
} from "./tools/dispatch-deps.js";

/**
 * Resolve max output tokens for the current model.
 * Uses the model's actual max_completion_tokens from OpenRouter metadata.
 * For reasoning models, this includes the thinking token budget, so it must
 * be the full value — we don't include thinking tokens in the saved output,
 * but they still count against this limit.
 * Falls back to context_length if max_completion_tokens is unavailable.
 */
function maxTokensFor(profile: ResolvedProfile | null, backend: BackendConfig, tool: string | undefined): number {
  // P7 decision 4: on a local llama.cpp or Locals model with an ok calibration record, max_tokens is the output cap the
  // input budget subtracted, so the calibrated input and the output fit the window together. `tool` is the command name
  // (completion.ts reads it the same way); outside a command, or for a remote profile, nothing changes.
  // Review m3: the route of the send is not known here, so on a local profile that also routes some models to a
  // remote provider group the cap applies to those sends too (spec 6 "P7 as built").
  const localSizing = localSizingFor(profile, tool);
  if (localSizing?.state === "calibrated") return localSizing.maxTokens;
  // T2.7 — `backend` is the caller's snapshot, read consistently
  if (backend.type === "openrouter" && backend.model) {
    const match = openRouterModelCache.find(
      (m) => m.id === backend.model,
    );
    if (match?.top_provider?.max_completion_tokens)
      return match.top_provider.max_completion_tokens;
    if (match?.context_length) return match.context_length;
  }
  // The same expression as FALLBACK_CONTEXT_LENGTH, which is assigned from activeResolved next to every write of it.
  return profile?.contextWindow || 100000;
}

/** maxTokensFor over the ACTIVE profile and backend, for the command in progress. */
function resolveDefaultMaxTokens(): number {
  return maxTokensFor(activeResolved, getCurrentBackend(), ctxStore.getStore()?.tool);
}

/**
 * The context the broker gives one request of a managed profile: its context_window, or PROVISIONAL_LOCAL_CTX per
 * slot when it sets none. ONE expression for localBroker (which starts the server with it) and the P7 sizing (round 3,
 * M1), so the input budget can never assume a larger context than the server really has.
 */
export function brokerSlotCtx(contextWindow: number): number {
  return contextWindow > 0 ? contextWindow : PROVISIONAL_LOCAL_CTX;
}

/**
 * Per-command memo of the P7 sizing: usage context (one object per dispatchCallTool), then profile name and tool (review m4).
 * The name is part of the key so a per-walk object made over another profile (makeProviderDeps, TRDD-78LZFUVJ) never reads the sizing memoized for the
 * active one in the same command.
 */
const localSizingMemo = new WeakMap<object, Map<string, LocalSizing | null>>();

/**
 * P7: the calibrated input budget and max_tokens of the running command on a local llama.cpp or Locals profile
 * (local-input-budget.ts planLocalSizing), or null when nothing changes (a remote route, another local api, a command
 * not in the task-kind table, or no command at all). Every model the command may send to is sized together: the
 * head, its fallbacks and its ensemble members, the same ids localEnsembleMemberCount counts; a managed member gets
 * the broker's slot context (brokerSlotCtx), an unmanaged one the profile context_window (0: the record's window).
 * Read once per command, profile and tool (spec 6) and memoized, so each stderr note is printed once. A too-small context or
 * an unfit kind throws (spec 6: the command fails at once). `fresh` reads the records again (after waiting for a
 * calibration) and replaces the memo. Outside a command (--estimate) nothing is memoized and nothing waits.
 * `profile` is the profile whose members are sized: the active one for localSizingForCommand, the target for a per-walk object.
 */
function localSizingFor(profile: ResolvedProfile | null, tool: string | undefined, fresh = false): LocalSizing | null {
  if (tool === undefined) return null;
  const r = profile;
  if (r === null) return null;
  const ctx = ctxStore.getStore();
  const memo = ctx !== undefined ? (localSizingMemo.get(ctx) ?? new Map<string, LocalSizing | null>()) : null;
  if (memo !== null && ctx !== undefined) localSizingMemo.set(ctx, memo);
  const memoKey = `${r.name}\u0000${tool}`;
  if (!fresh && memo?.has(memoKey)) return memo.get(memoKey) ?? null;
  const ids = [...new Set([r.model, r.secondModel, r.thirdModel, ...(r.reservedSlots ?? []).map((s) => s.modelId)].filter((x) => typeof x === "string" && x.length > 0))];
  const members: LocalMember[] = ids.map((model) => {
    const route = r.routeForModel(model);
    // Managed exactly as localBroker decides: the profile starts a server and the model is on its own primary group.
    const managed = r.server !== null && route?.primary === true;
    return { model, engine: route !== null ? localEngineOf(route.api) : null, managed, ctx: managed ? brokerSlotCtx(r.contextWindow) : r.contextWindow };
  });
  const sizing = planLocalSizing({ dir: getConfigDir(), tool, members, userMaxOutput: resolveRequestOptions(r.requestOptions, tool)?.maxOutputTokens });
  if (sizing?.state === "default" && sizing.note !== null) process.stderr.write(sizing.note);
  if (sizing?.state === "calibrated") for (const n of sizing.notes) process.stderr.write(n);
  memo?.set(memoKey, sizing);
  return sizing;
}

/** localSizingFor over the ACTIVE profile (the one the running command was started with). */
function localSizingForCommand(tool: string | undefined, fresh = false): LocalSizing | null {
  // tool first: outside a command nothing reads activeResolved (a module-init call would hit its TDZ).
  if (tool === undefined) return null;
  return localSizingFor(activeResolved, tool, fresh);
}

/**
 * The bytes a request carries besides its file blocks: the caller's instructions, its inline input_files_content, its instruction files, and the
 * shared system-prompt fragments every file-reading tool appends (FILE_FORMAT_EXAMPLE, BREVITY_RULES). Reserved from
 * the calibrated budget before it is injected as a per-file limit (round 3, M4), because the per-file sites check only
 * the file against max_payload_kb.
 */
function promptReserveBytes(a: Record<string, unknown>): number {
  let n = Buffer.byteLength(FILE_FORMAT_EXAMPLE + BREVITY_RULES, "utf-8");
  if (typeof a.instructions === "string") n += Buffer.byteLength(a.instructions, "utf-8");
  // Inline content goes into the same request as the files (chat, code_task).
  if (typeof a.input_files_content === "string") n += Buffer.byteLength(a.input_files_content, "utf-8");
  const files = typeof a.instructions_files_paths === "string" ? [a.instructions_files_paths] : Array.isArray(a.instructions_files_paths) ? a.instructions_files_paths : [];
  for (const f of files) {
    try {
      if (typeof f === "string") n += statSync(f).size;
    } catch {
      // An unreadable instruction file fails later at its own read, with its own message.
    }
  }
  return n;
}


/**
 * P7 round 3 (M4): check_references sends a source file and all of its local dependencies in ONE request, while its
 * max_payload_kb is checked per file, so the dependency count alone could carry a request past the calibrated window.
 * Under a calibrated budget (the injected one, scan-pipeline isCalibratedBudget) the dependency blocks are kept in order
 * while source + dependencies fit it, and the rest are left out with one stderr line; any other budget keeps them all.
 */
function capDependencyBlocks(filePath: string, srcBlock: string, depBlocks: readonly string[], budgetBytes: number): string[] {
  if (!isCalibratedBudget(budgetBytes)) return [...depBlocks];
  const kept: string[] = [];
  let used = Buffer.byteLength(srcBlock, "utf-8");
  for (const b of depBlocks) {
    const n = Buffer.byteLength(b, "utf-8");
    if (used + n > budgetBytes) break;
    kept.push(b);
    used += n;
  }
  if (kept.length < depBlocks.length) {
    process.stderr.write(`[llm-externalizer] check_references ${filePath}: ${depBlocks.length - kept.length} of ${depBlocks.length} dependency files left out, over the calibrated input budget of ${budgetBytes} bytes\n`);
  }
  return kept;
}

/**
 * Round 2 gap 1, round 3: start the calibration of managed models the way the broker does for a held job
 * (broker/server.ts requestCalibration, design trigger 1): mark the profile used, queue each model in
 * calibration/queue.json under the state lock (enqueueUnlocked keeps one entry per model, so a repeat is harmless), and
 * make sure a runner works on them (ensureCalibrator starts one only when no live runner of this version exists).
 * THROWS when the queue cannot be written or the runner cannot be started: the waiting command then fails with the
 * reason instead of waiting for a calibration nobody runs.
 */
async function startCalibration(models: ReadonlyArray<{ engine: "llama" | "locals"; model: string }>): Promise<void> {
  const dir = getConfigDir();
  if (activeResolved !== null) markProfileUsed(dir, activeResolved.name, activeSettings.profiles);
  const done = withStateLock(dir, 5_000, () => {
    for (const m of models) enqueueUnlocked(dir, { engine: m.engine, model: m.model, reason: "first-use" });
    return true;
  });
  if (done === undefined) throw new Error(`could not queue ${models.map((m) => `'${m.model}'`).join(", ")} for calibration: the calibration state lock stayed busy for 5 s`);
  await ensureCalibrator({ dir, version: brokerClientVersion(), entry: defaultBrokerEntry() });
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
  hasNoTextProfile,
  builtinLocalProfiles,
  PROVISIONAL_LOCAL_CTX,
} from "./config.js";
import { readCachedModelPrice } from "./catalog-cache.js";
import { writeDynamicProfileSection } from "./benchmark/pick.js";
import { loadSettingsAfterMigrations } from "./boot-settings.js";
// P6b item 1 (design §2.1/§3.3): the dynamic free/paid gate. D2: this file
// no longer runs the maintainer at all -- every profile update happens in a
// detached child (default-profiles-runner.ts's requestProfileUpdate /
// spawnDetachedDetector, profile-detector.ts).
import { dynamicProfileGate, regenerateInvalidMarkedSection } from "./dynamic-maintainer.js";
// C2b-wire + D2: the detached DETECTOR (fired at the end of every dispatch on
// a dynamic profile, never awaited) and the background update a command
// requests when its profile has no working model (never awaited either).
import { spawnDetachedDetector, requestProfileUpdate } from "./default-profiles-runner.js";
import {
  dynamicExhaustionStore,
  takeUpdateBaseline,
  waitForProfileUpdate,
  type DynamicExhaustion,
  type UpdateBaseline,
} from "./foreground-repair.js";
// recordRequest moved with the completion layer (B1 Phase 5b) — the per-request
// usage line is written where the request is actually made (provider/completion.ts
// + provider/lmstudio.ts), so index.ts only sets up the usage CONTEXT here.
import {
  calibratedOutputTokens,
  ctxStore,
  withUsageContext,
  summarizeParams,
} from "./usage-history.js";
import { installUsageRule } from "./rule-install.js";
import { resolveEnsembleModelLimits, type ModelLimits } from "./ensemble-limits.js";
import { benchmarkFailedModels, benchmarkPassedModels } from "./benchmark/security-triage/index.js";
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
import { makeNetworkGiveUp, PROBE_TIMEOUT_MS, readyLocalTarget, remoteFallbackApplies } from "./network-give-up.js";
import { fallbackVerdict, fallbackWarning, type FallbackFacts } from "./remote-fallback.js";
import { freeFailureCauseToError, FreeRotationNetworkError } from "./free-failure-cause.js";
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

import { clearEndpointFlavorCache } from "./provider/endpoint-flavor.js";
import { OUTPUT_LIMIT_PREFIX, resolveRequestOptions } from "./provider/request-options.js";
import { localEngineOf, localThinkingFor, planLocalSizing, taskEntryOf, waitForCalibration, type LocalMember, type LocalSizing } from "./local-input-budget.js";

// Settings path (cross-platform, see config.ts)
const SETTINGS_FILE = getSettingsPath();

// Whether settings are valid (configured by user). If false, all tools except
// discover return an error asking the user to configure settings.yaml.
let settingsValid = false;
let settingsError = "";
// TRDD-FBWXV4JF: true while the settings load threw at boot and activeSettings is the GENERATED default, not the user's document. The generated
// placeholder `free` is exempt from validation, so without this flag boot, the CLI's default overrideActiveProfile and the dispatch repair would all
// treat that default as a real configuration and serve requests on it. Cleared only by a reload that accepts a document read from disk.
let settingsLoadFailed = false;

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
    // The migrations and the re-read that follow live in boot-settings.ts (loadSettingsAfterMigrations); the call here only makes sure settings.yaml exists and parses.
    ensureSettingsExist();
    return loadSettingsAfterMigrations();
  } catch (err) {
    settingsError = `Failed to load settings: ${err instanceof Error ? err.message : String(err)}\n\nSettings file: ${SETTINGS_FILE}`;
    settingsLoadFailed = true;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return generateDefaultSettings();
  }
})();
// Publish the master paid-spend switch to config.ts the instant settings load, so
// getAllowPaidModels() is correct for any early reader (tool-schema gen, the boot
// force-free publish in main(), the paid-benchmark guard). Absent ⟺ false = the
// safe/free posture (USER: "only free models are viable, everything free by default").
setAllowPaidModels(activeSettings.allow_paid_models === true);
// P6 trigger 2 (calibration design section 3): a model the user added or changed
// in a managed local profile that has been used is queued for calibration, and
// a runner is started. Never fails or blocks a command: a busy state lock
// skips the check for this run, and the runner is spawned detached.
try {
  // Review m3: with settings.yaml unreadable, activeSettings are the defaults; comparing those would record
  // them as "seen" and later queue every model of each used profile as changed. Skip the check for this run.
  const changed = settingsError ? [] : checkModelChanges(getConfigDir(), activeSettings.profiles);
  if (changed.length > 0) {
    process.stderr.write(`[llm-externalizer] queued for calibration (model changed in a used local profile): ${changed.map((c) => c.model).join(", ")}\n`);
    void ensureCalibrator({ dir: getConfigDir(), version: brokerClientVersion(), entry: defaultBrokerEntry() }).catch((e: Error) =>
      process.stderr.write(`[llm-externalizer] could not start the calibration runner: ${e.message}\n`),
    );
  }
} catch (err) {
  process.stderr.write(`[llm-externalizer] the calibration model-change check failed: ${err instanceof Error ? err.message : String(err)}\n`);
}

let activeResolved: ResolvedProfile | null = (() => {
  // effectiveProfileName(), not the raw `activeSettings.active` read: this
  // IIFE runs at module-import time, BEFORE cli/main.ts's guaranteed
  // overrideActiveProfile(profileOverride ?? DEFAULT_PROFILE_NAME) call
  // (item 2) -- its result is a transient best-effort guess, always
  // superseded a moment later. Using the same helper here keeps this guess
  // consistent with everything downstream instead of re-deriving
  // "omitted -> free" locally.
  const targetName = effectiveProfileName(activeSettings);
  // WHY (TRDD-FBWXV4JF): the load threw and activeSettings is the generated default, whose placeholder `free` the validity verdict below would
  // exempt: settingsValid would become true and the NOT CONFIGURED gate would not fire. Stay invalid; settingsError already holds the cause.
  if (settingsLoadFailed) return null;
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
  // WHY nothing is printed for `verdict.exempt` here: a machine-owned dynamic profile ('free' | 'paid') that has
  // never been benchmarked is EXPECTED to fail validateProfile (an empty pool / a placeholder model id cannot serve a
  // request) -- that is not a user misconfiguration, it is the self-healing "not populated yet" state. Booting anyway is
  // intended: the dispatch pre-flight's dynamic maintainer populates it on first real use, and gating boot on
  // validateProfile's verdict would send every fresh install into NOT CONFIGURED with no path forward. A genuinely
  // misconfigured user profile (any other invalid shape) still falls through to the NOT CONFIGURED branch above.
  // The "not benchmarked yet" notice is printed at that first use (unbenchmarkedProfileNotice, dispatch pre-flight), not
  // here: this IIFE runs at import time, and the CLI imports the engine for every command, including a classify command
  // that never reads the text profile.
  settingsValid = true;
  const profile = activeSettings.profiles[targetName];
  const resolved = resolveProfile(targetName, profile);
  // Log auth status on startup so users can verify env vars are picked up.
  // The token length is not printed: it is information about a secret and the user needs only to know one was found (TRDD-TN8OUZ50).
  if (resolved.authToken) {
    process.stderr.write(
      `[llm-externalizer] Auth: token resolved\n`,
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
  // WHY (TRDD-FBWXV4JF): after a failed boot load the in-memory active profile is the generated default's, not the user's; the first successful read
  // of the file is the user's own document, so its `active:` is the selection (effectiveProfileName(freshSettings) applies the same default).
  const newSettings: Settings = { ...freshSettings, active: effectiveProfileName(settingsLoadFailed ? freshSettings : activeSettings) };

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

  // The document was read from disk and validated above: it replaces the generated default, so the boot load failure (TRDD-FBWXV4JF) is over.
  settingsLoadFailed = false;
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
  // WHY (TRDD-FBWXV4JF): after a failed settings load activeSettings is the generated default, not the file; repairing from it would rewrite the
  // user's settings.yaml from a document that was never read. The load error stands until a reload reads the file.
  if (settingsLoadFailed) return "";
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
  // WHY (TRDD-FBWXV4JF): after a failed settings load activeSettings is the generated default. Applying it would mark settings valid and clear
  // settingsError (cli/main.ts calls this for every command, default source included), so the gate would serve requests on that default.
  if (settingsLoadFailed) return { ok: false, error: settingsError };
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
  // P5 review m4: the migration also adds the built-in local profiles (local_llama, locals-mlx); they are not "the user has profiles" either, unless `active:` names one of them.
  const builtinLocalNames = new Set(builtinLocalProfiles().map((b) => b.name));
  const userProfiles = Object.fromEntries(Object.entries(activeSettings.profiles).filter(([n]) => n === name || !builtinLocalNames.has(n)));
  if (source === "default" && hasNoTextProfile(userProfiles)) {
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
  // TRDD-1OOAH3LD broker (spec 3): a managed profile hands batches to the
  // broker, which serializes per model across every command; the pool here is
  // only the submission window W = 2 x B, so the broker has a full batch of
  // this command's files to group. rps = W too: rps 1 would spread W submits
  // over W seconds. Checked before the generic local rule below.
  if (activeResolved !== null && activeResolved.server !== null) {
    const w = 2 * timingsFromEnv(process.env).batch;
    return { rps: w, maxInFlight: w };
  }
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
  // TRDD-N0S2UL0K: decide free mode FIRST and build the pool only when it is
  // active. Passing activeFreePool() as an argument evaluated it eagerly, and it
  // throws when the profile has no free pool -- so a profile that is NOT in free
  // mode (a managed local profile is $0 and never forced free, see
  // shouldForceFreeMode; a funded paid profile with allow_paid_models: true)
  // failed every model tool with "free mode is active ..." even though it was
  // not. Free mode off => the caller's model stands (this function's contract),
  // so a local model is never swapped for a remote free id.
  if (!isFreeModeActive()) return undefined;
  return resolveSubsystemFreeModel(true, activeFreePool(), requestedModel);
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
    // TRDD-B07E5M93: the directory guards (symlink, owner uid, no-follow) live in writeStatsJsonGuarded, matching the statusline.
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
    // Atomic, guarded write (temp file + rename, no-follow, owner check); a refusal throws into the catch below.
    writeStatsJsonGuarded(dirname(STATS_FILE), basename(STATS_FILE), JSON.stringify(stats));
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

function apiHeaders(profile: ResolvedProfile | null, backend: BackendConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (backend.apiKey)
    h["Authorization"] = `Bearer ${assertSafeHeaderValue("Authorization", backend.apiKey)}`;
  // OpenRouter requires HTTP-Referer and X-Title headers for ranking/attribution
  if (backend.type === "openrouter") {
    if (profile?.httpReferer)
      h["HTTP-Referer"] = assertSafeHeaderValue("HTTP-Referer", profile.httpReferer);
    if (profile?.appName)
      h["X-Title"] = assertSafeHeaderValue("X-Title", profile.appName);
  }
  return h;
}

/** Test-only export of routeHeaders (routeHeaders itself stays private/unexported,
 *  matching this file's "private by design" convention — see __getBootStateForTests
 *  above for the same pattern). Exists because the empty-authToken branch (no
 *  Authorization key at all) and the protocol-gated attribution headers were only
 *  ever exercised through a MOCK in connection.test.ts, never the real function. */
export function __routeHeadersForTests(route: ResolvedRoute): Record<string, string> {
  return routeHeaders(activeResolved, route);
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

/** Test-only export of ensembleStreaming (KP4DWUF9): reaches the fan-out and its all-failed wiring with a seeded retry clock. */
export function __ensembleStreamingForTests(
  messages: ChatMessage[],
  options: Parameters<typeof ensembleStreaming>[1],
  retryClock: RetryClock,
): Promise<StreamingResult> {
  return ensembleStreaming(messages, options, true, undefined, retryClock);
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
function routeHeaders(profile: ResolvedProfile | null, route: ResolvedRoute): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (route.authToken)
    h["Authorization"] = `Bearer ${assertSafeHeaderValue("Authorization", route.authToken)}`;
  if (route.protocol === "openrouter_api") {
    if (profile?.httpReferer)
      h["HTTP-Referer"] = assertSafeHeaderValue("HTTP-Referer", profile.httpReferer);
    if (profile?.appName)
      h["X-Title"] = assertSafeHeaderValue("X-Title", profile.appName);
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
// ONE field list for every profile (TRDD-78LZFUVJ). `getProfile` and `getBackend` run on EVERY field read and their
// result is never kept, which is what the two reasons above require of the boot object (reload-safe, TDZ-safe); the
// same list over a fixed profile is makeProviderDeps below. The fields that read the settings file or a constant
// (getModelPricePerMillion, getEnsemblePriceCeilingUsd, defaultTemperature) do not depend on the profile.
// `noHold` (TRDD-WSPV40Y5, Q6): every broker job of these deps fails instead of being held for a calibration; only the local
// fallback of a general command sets it, so the boot object and every other per-walk object are unchanged.
function providerDepsFrom(getProfile: () => ResolvedProfile | null, getBackend: () => BackendConfig, noHold = false): CompletionDeps {
  return {
    getBackend,
    apiHeaders: () => apiHeaders(getProfile(), getBackend()),
    // Read through the profile on EVERY call, never captured — a settings
    // reload replaces the profile, and a stale route table would keep sending to
    // the provider the user just removed.
    routeForModel: (model: string) => getProfile()?.routeForModel(model) ?? null,
    routeHeaders: (route) => routeHeaders(getProfile(), route),
    // The profile's own timeout: the SOFT_TIMEOUT_MS global is (activeResolved?.timeout ?? 300) * 1000, assigned only at
    // its declaration and in the settings swap right after activeResolved, so for the boot object the two are equal.
    getSoftTimeoutMs: () => (getProfile()?.timeout ?? 300) * 1000,
    isFreeOnly: () => getProfile()?.freeOnly ?? false,
    isLMStudioProvider: () => getProfile()?.protocol === "lmstudio_api",
    // TRDD-FDI9NYAS D3b: read through the profile on EVERY call, same reload
    // reason as routeForModel above — a stale manualModels set would keep
    // exempting an id from a profile the user just switched away from.
    isManualModel: (model: string) => getProfile()?.manualModels?.has(model) ?? false,
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
    getDefaultMaxTokens: () => maxTokensFor(getProfile(), getBackend(), ctxStore.getStore()?.tool),
    // TRDD-1OOAH3LD: read through the profile on EVERY call (reload-safe, like routeForModel above); null when the profile sets no request_options.
    getRequestOptions: (tool) => resolveRequestOptions(getProfile()?.requestOptions ?? null, tool),
    // TRDD-1OOAH3LD gap C1-7 / TRDD-ZGSGGHQG gap Z-3: the per-model thinking switch of a calibrated local route. Lives in this ONE field list, so the
    // boot object and every per-walk object (makeProviderDeps, the local fallback included) send it; completion.ts calls it where the body is built.
    getLocalThinking: (tool, model, route) => localThinkingFor(getConfigDir(), tool, model, route?.api),
    getActiveProtocol: () => getProfile()?.protocol ?? "openai_api",
    // TRDD-1OOAH3LD broker: read through the profile on EVERY call
    // (reload-safe, like routeForModel above). Only the profile's own primary
    // group is managed (the validator requires its api to be llamacpp-local or
    // locals-local; r.server names the engine); a providers[] route is sent
    // directly, as before.
    localBroker: async ({ route }) => {
      const r = getProfile();
      if (!r || r.server === null || (route && !route.primary)) return null;
      const ep = await ensureBroker({ dir: getConfigDir(), version: brokerClientVersion() });
      // P6: a profile that sent a request is "used": trigger 2 then watches its model ids. The name is the one of the
      // profile these deps were made for (TRDD-78LZFUVJ), so a per-walk object marks its own profile.
      markProfileUsed(getConfigDir(), r.name, activeSettings.profiles);
      // F11: no context_window means the provisional per-slot context, never the model's whole default (a huge KV cache).
      return {
        ...ep,
        engine: r.server,
        ctx: brokerSlotCtx(r.contextWindow),
        queueTimeoutMs: brokerQueueTimeoutMs(),
        // P6 (review F1): after a broker exit gave a held job back, the call submits it to the current broker.
        reconnect: () => ensureBroker({ dir: getConfigDir(), version: brokerClientVersion(), fresh: true }),
        ...(noHold ? { noHold: true } : {}),
      };
    },
  };
}

/**
 * The provider deps of ONE fixed profile and backend (TRDD-78LZFUVJ): every field of providerDeps, read from `profile`
 * and `backend` instead of the module's active ones. The local fallback of TRDD-WSPV40Y5 calls it over the ready local target (with
 * noHold); the module globals and the published spend and free state keep describing the active profile.
 */
export function makeProviderDeps(profile: ResolvedProfile | null, backend: BackendConfig, o: { noHold?: boolean } = {}): CompletionDeps {
  return providerDepsFrom(() => profile, () => backend, o.noHold === true);
}

// The boot object: the same field list over the module's active profile and backend, read at call time.
const providerDeps: CompletionDeps = providerDepsFrom(() => activeResolved, getCurrentBackend);

/** Test-only export of the boot providerDeps, for comparing it with makeProviderDeps over the active profile. */
export function __providerDepsForTests(): CompletionDeps {
  return providerDeps;
}

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
    headers: apiHeaders(activeResolved, backend),
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

import { defaultOutputDir, defaultScratchDir } from "./project-root.js";

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

/** One short observation per cause ("503", "ECONNREFUSED") when EVERY cause is a provider-side failure, else undefined. */
/** One short observation ("503", "ECONNREFUSED") plus the chain entry of a cause that is a provider-side failure; undefined for anything else. */
function providerSideFailure(cause: unknown): { observed: string; modelId?: string; baseUrl?: string } | undefined {
  let source = cause;
  while (source instanceof RetryDeadlineError) source = source.cause; // the real failure rides on the wrapped cause
  // Typed fields only (attached by the HTTP layer): an untyped cause is not evidence of an outage.
  const f = failureOf(source);
  if (f === undefined) return undefined;
  if (f.status !== undefined) {
    return f.status >= 500 || f.status === 408 ? { observed: String(f.status), modelId: f.modelId, baseUrl: f.baseUrl } : undefined;
  }
  if (f.networkCode !== undefined && OUTAGE_NETWORK_CODES.has(f.networkCode)) {
    return { observed: f.networkCode, modelId: f.modelId, baseUrl: f.baseUrl };
  }
  return undefined;
}

/**
 * TRDD-5Q79QZM7 scope 3 -- do the causes SUGGEST a PROVIDER-WIDE outage rather than dead models? Evidence needs at
 * least 2 DISTINCT models, all on the SAME provider (base URL), and EVERY cause a 5xx, a timeout (408
 * or a local/connect timeout) or a network error (refused, reset, DNS); a single 404/400/402/401 means a model or key
 * problem that a profile update can fix, so the normal repair path applies. Causes without a recorded model and base URL
 * (profileChain records them) give no evidence. Returns the provider base URL and the observed statuses/codes, or undefined.
 */
export function detectProviderOutage(causes: readonly unknown[]): { baseUrl: string; observed: string[] } | undefined {
  const sides = causes.map(providerSideFailure);
  if (sides.some((s) => s === undefined || s.modelId === undefined || s.baseUrl === undefined)) return undefined;
  const entries = sides as Array<{ observed: string; modelId: string; baseUrl: string }>;
  // Causes of different providers are never merged (the free profile can hold a reserved slot on another vendor), and the
  // same model failing twice is one model's evidence, not two.
  if (new Set(entries.map((e) => e.baseUrl)).size !== 1) return undefined;
  if (new Set(entries.map((e) => e.modelId)).size < 2) return undefined;
  return { baseUrl: entries[0].baseUrl, observed: [...new Set(entries.map((e) => e.observed))] };
}

/**
 * TRDD-PN0N4290: the network give-up window of one dispatch, or undefined where it cannot apply: a LOCAL active profile has no
 * remote to give up on and no other local profile to switch to. WHY built per dispatch and not once: the settings, the flag and
 * the readiness of the local profiles are read when the dispatch starts, so a settings change between commands is honoured.
 */
function newNetworkGiveUp(): NetworkGiveUp | undefined {
  // TRDD-WSPV40Y5 F1: the SAME predicate tryLocalFallback asks (remoteFallbackApplies), so the window is armed only where a fallback can
  // follow it. Armed for a static user profile it only cut that profile's retry budget to the window and then threw, with no fallback.
  if (activeResolved === null || !remoteFallbackApplies(activeResolved, activeResolved.name)) return undefined;
  const profileName = activeResolved.name;
  return makeNetworkGiveUp(activeSettings, getConfigDir(), {
    // TRDD-WSPV40Y5 F2: readyLocalTarget vouches for the engine, the weights and an ok record; sendToLocalTarget also needs a
    // "calibrated" sizing for the running tool, which is absent for a tool with no task kind or a model unfit for its kind. Without
    // this check the window armed and the fallback then refused (LocalFallbackNotReady): a cut retry budget with no local answer.
    // Outside a command (no ctx) tryLocalFallback sends nothing, so the window must not arm either.
    sendReady: () => {
      const ctx = ctxStore.getStore();
      if (ctx === undefined) return false;
      const t = localFallbackTarget(profileName);
      return t !== undefined && localSizingFor(t.target, ctx.tool)?.state === "calibrated";
    },
  });
}

/** Timeout of the reachability probe that confirms a suspected provider outage. */
export const OUTAGE_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS; // TRDD-PN0N4290: one bound shared with the strict probe (network-give-up.ts)

/**
 * CONTROL CHECK (TRDD-5Q79QZM7 scope 3): is the provider itself reachable? GET `<base>/v1/models` (the endpoint
 * the rest of the code already uses for it; public on OpenRouter, no key). Any HTTP answer below 500 means the provider is
 * up; a 5xx answer, a timeout or a network error means it is down.
 */
export async function providerReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: "GET" }, OUTAGE_PROBE_TIMEOUT_MS);
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * The outage verdict: the cause pattern (detectProviderOutage) AND a failing control probe. WHY the probe: a model
 * whose upstream is broken returns 5xx for days while the provider works; the pattern alone would call that an outage
 * forever and never repair the profile. Reachable provider = the models are broken = normal repair path.
 */
export async function providerOutageError(profileName: DynamicProfileName, causes: readonly unknown[]): Promise<Error | undefined> {
  const suspected = detectProviderOutage(causes);
  if (suspected === undefined || (await providerReachable(suspected.baseUrl))) return undefined;
  return new ProviderOutageError(profileName, causes, suspected.baseUrl, suspected.observed);
}

/** Thrown for a detected provider outage: static (no update, no wait), final for the whole batch. */
class ProviderOutageError extends ProfileExhaustedError {
  constructor(profileName: DynamicProfileName, causes: readonly unknown[], baseUrl: string, observed: readonly string[]) {
    const host = hostOf(baseUrl);
    const provider = isOpenRouterHost(host) ? "OpenRouter" : host || baseUrl;
    // The message is fully custom: the static exhaustion text says "change the profile", which would be wrong advice here.
    super(
      profileName,
      "static",
      causes,
      undefined,
      `${provider} appears to be down or unreachable (observed: ${observed.join(", ")}); the models are probably fine, so no profile update was started — retry in a few minutes`,
    );
  }
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
  // TRDD-3CG178O7 (a message-only increment): the causes the routing DECISION below reads, when they must differ from the causes
  // carried on the resulting error. Only freeRotationExhausted passes it (the last model detail alone, exactly what it decided on
  // before typed causes existed); every other caller decides on all of `causes`, unchanged. TRDD-WSPV40Y5 decided: the in-profile
  // routing keeps this last-cause input; only the switch to a local profile reads every cause (freeRotationLocalFallback).
  decisionCauses?: readonly unknown[],
): Error {
  const decision = decisionCauses ?? causes;
  const texts = decision.map(causeText);
  const is401 = (m: string) => /API error 401\b/.test(m);
  const certain402 = (m: string) => paymentErrorCertainty(m) === "certain";
  if (texts.length > 0) {
    if (texts.some(is401) && texts.every((m) => is401(m) || certain402(m))) {
      return actionable(decision.filter((_, i) => is401(texts[i])));
    }
    if (profileName === "paid" && texts.every(certain402)) return actionable(decision);
    if (texts.every((m) => NON_TRANSIENT_4XX_RE.test(m)) && texts.some((m) => !SERVICE_LEVEL_STATUS_RE.test(m))) {
      return actionable(decision);
    }
  }
  // TRDD-VAORGKVF (COORDINATOR DEFAULT, not a USER ruling): an IRON RULE refusal is a $0 ledger verdict reached before anything is sent. The paid/free populate writes only the rank-0 keyword ledger (benchmark/index.ts recordGeneralKeywordPasses; measure r2 item 2), so for a tool ranked above 0 no update can cure it and "an update is underway" would be false. This EXTENDS the principle in the doc comment above ("an update cannot fix every failure, and then the actionable error wins"). Rank-0 tools, and any refusal whose tool name cannot be read from its text, fall through to the update branch.
  if (texts.length > 0 && texts.every((m) => m.startsWith(IRON_RULE_REFUSAL_PREFIX))) {
    const refusedTools = texts.map((m) => /is not validated for (\S+?)\. /.exec(m)?.[1]);
    if (refusedTools.every((t) => t !== undefined && !profileUpdateCanValidate(t))) return actionable(decision);
  }
  // WHY: a command stopped by --command_timeout starts no profile update: a detached updater would be spawned for a
  // command that no longer runs, and a retry-later answer would promise a repair nobody waits for. The file is reported
  // as stopped (it is unfinished); the models may well have failed first, but with the stop set this command does not
  // act on that. Placed after the actionable branches above so a real 401 or credit verdict still reports its true
  // cause, and before the retry test so a first pass reached with the stop already set is covered too.
  const stopped = commandStopReason();
  if (stopped !== null) return stoppedError(stopped);
  // WHY (TRDD-5Q79QZM7): the single same-run retry after the foreground repair must not start another update --
  // one repair per run; its failure is reported by dispatchCallTool.
  if (dynamicExhaustionStore.getStore()?.retry === true) return new ProfileExhaustedError(profileName, "dynamic", causes);
  // Taken BEFORE requestProfileUpdate spawns the updater: a fast child can record its outcome within milliseconds.
  const baseline = takeUpdateBaseline();
  const update = requestProfileUpdate({ profile: profileName, log: (m) => process.stderr.write(m) });
  if (update.state === "unavailable") {
    process.stderr.write(`[llm-externalizer] '${profileName}' profile update not started — ${update.reason}\n`);
    return actionable(causes);
  }
  // WHY (TRDD-5Q79QZM7 scope 2): tell dispatchCallTool that every model of this generated profile failed and an
  // update is underway, so it can wait for it (bounded) and retry the request once instead of only answering
  // retry-later. Key/credit/request-specific verdicts returned above never reach this line.
  const exhaustion = dynamicExhaustionStore.getStore();
  if (exhaustion) {
    exhaustion.profile = profileName;
    exhaustion.update = update;
    exhaustion.baseline = baseline;
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
    // TRDD-5Q79QZM7 scope 3: a detected provider outage is final for the whole batch (every file would hit the same dead provider).
    if (error instanceof ProviderOutageError) return { unrecoverable: true, serviceLevel: true, reason: msg };
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
    // TRDD-1OOAH3LD: every cause is an OUTPUT LIMIT -- the model ran out of its
    // request_options budget on each attempt. Final for THIS file (rerunning an
    // expensive generation with the same cap fails the same way), but not
    // service-level (another file may fit) and still a failed outcome for the
    // "3 of the last 3 failed" abort.
    if (every((m) => m.startsWith(OUTPUT_LIMIT_PREFIX))) {
      return { unrecoverable: true, serviceLevel: false, reason: `${msg} — ${causes[0]}`, countsAsFailure: true };
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
  // TRDD-1OOAH3LD: a raw OUTPUT LIMIT error (reply cut off on a request_options profile). Never "recoverable": the per-file loops would re-run the same costly generation into the same cap. Per-file failure, not service-level.
  if (msg.startsWith(OUTPUT_LIMIT_PREFIX)) return { unrecoverable: true, serviceLevel: false, reason: msg, countsAsFailure: true };
  // TRDD-WSPV40Y5 (Q9): a request the local fallback refused fails THIS file only; the other files of the command go on locally.
  if (error instanceof LocalFallbackRefusedError) return { unrecoverable: true, serviceLevel: false, reason: msg, countsAsFailure: true };
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
          lineNumbers: opts.lineNumbers,
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
    fileLineCount(path) {
      try {
        return numberedLineCount(readFileSync(path, "utf-8"));
      } catch {
        return 0; // unreadable file costs nothing in the estimate; the run itself will fail loudly on it (same rule as fileSizeBytes)
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
      // P7 round 3 (M5): an estimate sends nothing, so it never waits for or queues a calibration: it sizes from the
      // records that exist, and says so when a managed model has none yet (its cap is then the profile default).
      const local = localSizingForCommand(toolName);
      if (local?.state === "await") {
        process.stderr.write(`[llm-externalizer] this estimate is provisional: ${local.models.map((m) => m.model).join(", ")} not calibrated yet, so its output cap is the profile default until calibration\n`);
      }
      const localCap = local?.state === "calibrated" ? local.maxTokens : null;
      const ensemble = getEnsembleModels();
      if (ensemble.length > 0)
        return ensemble.map((m) => ({ id: m.id, maxOutput: localCap ?? m.maxOutput }));
      // Single-model mode: the backend's configured model with its default cap.
      const backend = getCurrentBackend();
      if (!backend.model) return [];
      return [{ id: backend.model, maxOutput: localCap ?? resolveDefaultMaxTokens() }];
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
    slotRefusal(toolName, modelId) {
      // Same gates as resolveConnection (TRDD-4TTFUIL0), one function; the tool name
      // is the dispatchCallTool name a real send puts in ctxStore.
      return sendRefusal(modelId, toolName, providerDeps);
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
  // P6: they queue or report local-model calibration and send no model request;
  // reconcile rewriting settings first would only delay them.
  "calibrate_model",
  "calibration_status",
  // They only read or stop the server registry and send no model request.
  "server_status",
  "server_stop",
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
// WHY a function and not an inline write (and why here, not at boot): the notice says the profile "will populate on first use", so it is
// printed where the dispatch pre-flight starts that population for the ACTIVE text profile. Only the machine-owned remote
// profiles ('free' | 'paid') are populated by the maintainer this way; 'local' has its own rescan message.
export function unbenchmarkedProfileNotice(profile: string): string | null {
  return profile === "free" || profile === "paid"
    ? `[llm-externalizer] '${profile}' has not been benchmarked yet — it will populate on first use.\n`
    : null;
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
  return exhaustedFreeRotation(activeResolved?.name, err);
}

/** freeRotationExhausted with the active profile name given, so a test can reach it without a resolved profile. */
function exhaustedFreeRotation(name: string | undefined, err: unknown): unknown {
  if (!(err instanceof AllFreeModelsExhaustedError) || name === undefined || !isDynamicProfileName(name)) return err;
  // TRDD-3CG178O7: one typed cause per model the rotation tried is CARRIED on the resulting error, so the fallback decision (1d) can
  // read each model status and networkCode. The causes are Errors whose message is that model detail, because failDynamicProfile
  // and classifyError read causes as text.
  // WHY the routing decision reads the LAST cause only: before typed causes this site passed one bare Error built from lastDetail,
  // and the key/credit/request-specific/update branches were decided on it. This increment changes messages only, so the decision
  // input is unchanged ([429, then 402] on paid is still the credit verdict). TRDD-WSPV40Y5 kept it so: only the switch to a
  // local profile reads every cause (freeRotationLocalFallback, called before this).
  const causes = err.causes.map(freeFailureCauseToError);
  return failDynamicProfile(name, causes, () => err, causes.slice(-1));
}


/**
 * TRDD-WSPV40Y5: the local fallback of the two free-rotation sites. The rotation ends in AllFreeModelsExhaustedError (every model
 * failed) or in a FreeRotationNetworkError (a raw network failure, 1a). WHY every cause decides here while
 * freeRotationExhausted routes on the LAST cause only (the 1a comment left this to 1d): falling back to another profile is the
 * bigger step, so it needs the evidence of EVERY model tried (all network-isolation codes, all refused keys), and the in-profile
 * routing keeps the input it always had. No outage verdict on this path: the free causes carry no base URL to probe (1a), so
 * a dead network is caught by the network trigger (the 1b window and its strict probe) instead.
 */
async function freeRotationLocalFallback<T>(err: unknown, messages: readonly ChatMessage[], maxTokens: number | undefined, clock: RetryClock | undefined, send: LocalSend<T>): Promise<T | undefined> {
  if (!(err instanceof AllFreeModelsExhaustedError) && !(err instanceof FreeRotationNetworkError)) return undefined;
  const name = activeResolved?.name;
  if (name === undefined) return undefined;
  const causes = err.causes.map(freeFailureCauseToError);
  return tryLocalFallback(name, causes, { outageConfirmed: false, networkArmed: await giveUpArmed(clock) }, messages, maxTokens, send);
}

/** Test-only export of the free-rotation exhaustion conversion (TRDD-3CG178O7), same convention as __classifyErrorForTests. */
export function __freeRotationExhaustedForTests(name: string | undefined, err: unknown): unknown {
  return exhaustedFreeRotation(name, err);
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
  // TRDD-WSPV40Y5 (Q8): a command already switched to local never tries the remote again.
  const latched = latchedLocalFallback();
  if (latched !== undefined) return sendToLocalTarget(latched, messages, options.maxTokens as number | undefined, streamingLocalSend(messages, options));
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
    // TRDD-WSPV40Y5: the free path never reaches chatCompletionWithProfileFallback, so it falls back here, before
    // freeRotationExhausted (which may spawn an updater through failDynamicProfile).
    const local = await freeRotationLocalFallback(err, messages, options.maxTokens as number | undefined, options.retryClock as RetryClock | undefined, streamingLocalSend(messages, options));
    if (local !== undefined) return local;
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
  // TRDD-PN0N4290: the JSON path (check_imports) gets the same give-up window as ensembleStreaming.
  const scoped = { ...options, retryClock: { networkGiveUp: newNetworkGiveUp() } as RetryClock };
  const pool = isFreeModeActive() ? buildFreeRotationPool() : [];
  // TRDD-WSPV40Y5: the check_imports JSON send on the local target (prompt-based JSON there: json_schema is OpenRouter-only).
  const localSend: LocalSend<JSONCompletionResult> = (model, deps, o) =>
    chatCompletionJSON(messages, { ...localSendOptions(options), model, maxTokens: o.maxTokens, retryClock: o.retryClock }, deps);
  // Q8: a command already switched to local never tries the remote again.
  const latched = latchedLocalFallback();
  if (latched !== undefined) return sendToLocalTarget(latched, messages, options.maxTokens, localSend);
  if (pool.length === 0) {
    // TRDD-WSPV40Y5: the single remote JSON call (no pool) is the whole chain of this path, so its one failure is the cause list.
    // A .catch chain, not try/await: free-rotation-coverage.test.ts pins "no awaited raw chatCompletionJSON call" in index.ts.
    return chatCompletionJSON(messages, scoped, providerDeps).catch(async (err: unknown) => {
      const name = activeResolved?.name;
      const local = name === undefined ? undefined : await tryLocalFallback(name, [err], { outageConfirmed: false, networkArmed: await giveUpArmed(scoped.retryClock) }, messages, options.maxTokens, localSend);
      if (local !== undefined) return local;
      throw err;
    });
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
    // TRDD-WSPV40Y5: same local fallback as callSingleWithFreeRotation, before freeRotationExhausted.
    const local = await freeRotationLocalFallback(err, messages, options.maxTokens, scoped.retryClock, localSend);
    if (local !== undefined) return local;
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
      // --command_timeout (spec 15): the command is stopping; trying the next model would only fail the same way, later.
      if (err instanceof CommandStoppedError) throw err;
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
      // TRDD-1OOAH3LD broker (spec 5): the classification lives in
      // endpointFailureKind (broker/client.ts), where it is unit-tested.
      const unwrapped = err instanceof RetryDeadlineError ? err.cause : err;
      const endpointKind = endpointFailureKind(unwrapped, msg);
      const isEndpointModelDead = endpointKind === "endpoint-model";
      const isEndpointDead = endpointKind === "endpoint";
      // --stop_on_errors (TRDD-SWNIIFTF): the first failure that would start a fallback ends the command instead.
      // After endpointKind on purpose: a dead broker job or endpoint is a typed verdict the stop reads, not a text it matches.
      stopIfStopOnErrors(modelId, err, endpointKind !== null);
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
        kind: isEndpointDead ? "endpoint" : isEndpointModelDead ? "endpoint-model" : isCreditDead ? "credit" : "model",
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
    // TRDD-WSPV40Y5 (Q8): a command already switched to local never tries the remote again (it would burn the retry window per file).
    const latched = latchedLocalFallback();
    if (latched !== undefined) return await sendToLocalTarget(latched, messages, options.maxTokens, streamingLocalSend(messages, options));
    return await walkProfileChainOnce(activeResolved, messages, options, deps, tool);
  } catch (err) {
    if (!(err instanceof ProfileExhaustedError) || err.kind !== "dynamic" || !isDynamicProfileName(profileName)) {
      throw err;
    }
    // WHY (TRDD-5Q79QZM7 scope 3): when two or more models of ONE provider failed with a 5xx, a timeout or a network error AND
    // a reachability probe of that provider fails too, the PROVIDER is down, not the models. Falling through would start a
    // paid benchmark sweep and make the caller wait up to 10 minutes (scope 2) for an update that cannot succeed against a
    // dead provider; answer honestly and at once instead. Done here, not in failDynamicProfile, because the probe is async.
    // Safe to run before it: every verdict failDynamicProfile gives ahead of the update branch (401/402/4xx/refusal) needs a
    // cause that is not a 5xx/timeout/network error, so none can apply when this detects an outage.
    // WHY serviceLevel + unrecoverable for the batch (classifyError): with the probe confirming the provider is down, every
    // remaining file would hit the same dead provider, so aborting the batch is correct. Without the probe it would not be.
    const outage = await providerOutageError(profileName, err.causes);
    // TRDD-WSPV40Y5: a service verdict (outage, no network path, paid credit at zero, refused key) finishes on a ready local
    // profile; evaluated BEFORE failDynamicProfile, which may spawn an updater. Not ready or failed locally: the verdict below, as before.
    const facts = { outageConfirmed: outage !== undefined, networkArmed: await giveUpArmed(options.retryClock) };
    const local = await tryLocalFallback(profileName, err.causes, facts, messages, options.maxTokens, streamingLocalSend(messages, options));
    if (local !== undefined) return local;
    if (outage !== undefined) throw outage;
    // D2: ONE walk, then the verdict. The actionable form is the static
    // exhaustion carrying the causes classifyError keys on (credit verdict,
    // key error, or this file only) -- the text the pre-D2 "exhausted again
    // after the update" path produced, unchanged.
    throw failDynamicProfile(profileName, err.causes, (causes) => new ProfileExhaustedError(profileName, "static", causes));
  }
}


// ── TRDD-WSPV40Y5 (increment 1d): automatic fallback of general commands to a ready local profile ──────────────────────

/** A request the local fallback refused (over the local input budget, or the target is not calibrated for this tool): THIS file fails, the batch goes on (Q9). */
export class LocalFallbackRefusedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalFallbackRefusedError";
  }
}


/** The local target has no calibrated input budget for this tool ("await" or "default" sizing, or a tool outside the task-kind table): not ready, so the fallback does not happen. */
class LocalFallbackNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalFallbackNotReady";
  }
}

/** The ready local target of a command: a HEAD-ONLY copy of the profile and its per-walk deps (noHold). */
interface LocalFallbackTarget {
  /** The remote profile the command gave up on. */
  from: string;
  target: ResolvedProfile;
  deps: CompletionDeps;
}

/**
 * Q8 (never retry the remote within one command once switched): the latch, keyed by the command usage context exactly like
 * localSizingMemo, so it dies with the command and a later command tries the remote again. Never a process global.
 */
const localFallbackLatch = new WeakMap<object, LocalFallbackTarget>();

function latchedLocalFallback(): LocalFallbackTarget | undefined {
  const ctx = ctxStore.getStore();
  return ctx === undefined ? undefined : localFallbackLatch.get(ctx);
}

/**
 * The first ready local profile (readyLocalTarget, the 1b no-process readiness check: engine on PATH, HEAD model on disk, ok
 * record), as a HEAD-ONLY profile. WHY head-only: readiness vouches for the head model alone; walking the profile's other models
 * could reach one with no weights or no record, i.e. a download or a calibration on a failure path (constraint 1).
 */
function localFallbackTarget(from: string): LocalFallbackTarget | undefined {
  const ready = readyLocalTarget(activeSettings, getConfigDir());
  if (ready === undefined) return undefined;
  const full = resolveProfile(ready.profile, activeSettings.profiles[ready.profile]);
  const target: ResolvedProfile = { ...full, model: ready.model, secondModel: "", thirdModel: "", freeModels: [], paidModels: [], toolModels: {}, reservedSlots: [] };
  return { from, target, deps: makeProviderDeps(target, makeBackendFromProfile(target), { noHold: true }) };
}

/** The bytes a request carries (every message content), compared with the local input budget. */
function requestBytes(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += Buffer.byteLength(typeof m.content === "string" ? m.content : JSON.stringify(m.content), "utf-8");
  return n;
}

/** What a local send gets: the target's head model, a max_tokens clamped to the local sizing, and a fresh retry clock (no give-up window: the target is local). */
type LocalSend<T> = (model: string, deps: CompletionDeps, o: { maxTokens: number; retryClock: RetryClock }) => Promise<T>;

/**
 * Sends one request to the local target, after the input-budget check (constraint 3, refuse never truncate). The sizing must
 * be "calibrated" for the running command's tool (read from ctxStore: the call sites receive tool "default"); "await" or
 * "default" is not ready and is refused, never waited for.
 */
async function sendToLocalTarget<T>(t: LocalFallbackTarget, messages: readonly ChatMessage[], maxTokens: number | undefined, send: LocalSend<T>): Promise<T> {
  const tool = ctxStore.getStore()?.tool;
  const sizing = localSizingFor(t.target, tool);
  if (sizing?.state !== "calibrated") {
    // Not ready (constraint 1), never a switch: tryLocalFallback reads this as "no local target" and changes nothing.
    throw new LocalFallbackNotReady(`local profile '${t.target.name}' (model ${t.target.model}) has no calibrated input budget for ${tool ?? "this call"}; the local fallback does not wait for a calibration`);
  }
  const bytes = requestBytes(messages);
  if (bytes > sizing.windowBudgetBytes) {
    throw new LocalFallbackRefusedError(`request of ${bytes} bytes is over the local input budget of ${sizing.windowBudgetBytes} bytes of model ${t.target.model} (profile '${t.target.name}'); refused, never truncated`);
  }
  return send(t.target.model, t.deps, { maxTokens: Math.min(maxTokens ?? sizing.maxTokens, sizing.maxTokens), retryClock: {} });
}

/**
 * THE shared fallback step of every call site (the chain walk, the free rotation, the check_imports JSON rotation). Given the
 * causes of a remote failure just caught, returns the local answer, or undefined when the failure stays in-profile: the active
 * profile is local or not a built-in dynamic one (static user-defined profiles do NOT fall back: the 2026-09-17 ruling, agent
 * decision Q5 of 2026-11-14), the causes give no service verdict (fallbackVerdict), or NO local profile is ready, in which case
 * nothing at all changes (no line, no process). WHY before failDynamicProfile: it can spawn a profile updater, which no
 * fallback trigger wants (item 5: none can succeed against a dead service, an empty wallet or a refused key).
 * When a target was ready but the local send fails, one stderr line says why and the caller throws its ORIGINAL verdict
 * (fail fast, nothing masked). WHY the line goes to stderr and not into the error: classifyError reads the error message, and
 * a local error text appended to it (an "API error 4xx" of the local server) could change the verdict of the remote failure.
 * An over-budget request is the exception (Q9): the command stays latched on local and THIS file fails with the refusal, so
 * the other files go on locally instead of the batch aborting on a serviceLevel remote verdict.
 */
async function tryLocalFallback<T>(
  profileName: string,
  causes: readonly unknown[],
  facts: FallbackFacts,
  messages: readonly ChatMessage[],
  maxTokens: number | undefined,
  send: LocalSend<T>,
): Promise<T | undefined> {
  // TRDD-WSPV40Y5 F1: the predicate is shared with newNetworkGiveUp (remoteFallbackApplies), so the window and this step cannot disagree.
  if (!remoteFallbackApplies(activeResolved, profileName)) return undefined;
  const trigger = fallbackVerdict(causes, profileName, facts);
  if (trigger === undefined) return undefined;
  const ctx = ctxStore.getStore();
  // Outside a command there is no tool to size the local request for, so nothing can be sent locally: unchanged behaviour.
  if (ctx === undefined) return undefined;
  // TRDD-WSPV40Y5 F3: localFallbackTarget reads the filesystem (cache dir, calibration record, settings) and can throw. Outside the
  // try below that throw would replace the caller's ORIGINAL verdict with an fs error. Same handling as a failed local send: one
  // stderr line naming the cause, then undefined so the caller throws its own verdict.
  let found: LocalFallbackTarget | undefined;
  try {
    found = latchedLocalFallback() ?? localFallbackTarget(profileName);
  } catch (targetErr) {
    process.stderr.write(`[llm-externalizer] the local fallback target could not be determined, the original error is thrown: ${failureText(targetErr).split("\n")[0].slice(0, 300)}\n`);
    return undefined;
  }
  if (found === undefined) return undefined;
  // TRDD-WSPV40Y5 N2 (review 20261116_162203): --stop_on_errors wins over the fallback (its help: the command ends instead of falling back).
  // WHY here and not at the callers: this is exactly where a fallback would START (a trigger holds AND a target is ready), and two paths
  // reach it with no stop of their own: the free rotation throws a raw network failure at free-rotation.ts before its own stop, and the
  // no-pool check_imports JSON .catch has none. When nothing is ready no stop is needed: the caller throws its verdict as before.
  // The stop names the failed model of the last cause, else the profile.
  stopIfStopOnErrors(failureOf(causes[causes.length - 1])?.modelId ?? profileName, causes[causes.length - 1]);
  const t = found;
  // WHY latched only once the local side answered or refused by budget (Q8, Q9): the warning says "answered locally", and a
  // target that failed must not pull the next files away from the remote verdict. First latch prints, a concurrent one does not.
  const latch = () => {
    if (localFallbackLatch.has(ctx)) return;
    localFallbackLatch.set(ctx, t);
    process.stderr.write(fallbackWarning(trigger, profileName, t.target.name, t.target.model));
  };
  try {
    const answer = await sendToLocalTarget(t, messages, maxTokens, send);
    latch();
    return answer;
  } catch (localErr) {
    // Not ready for this tool: exactly the no-ready-local case, no line, no latch, the caller throws its verdict.
    if (localErr instanceof LocalFallbackNotReady) return undefined;
    if (localErr instanceof LocalFallbackRefusedError) {
      latch();
      throw localErr;
    }
    // The local target failed: unlatch so the next file does not repeat a dead local send, and let the caller throw its verdict.
    if (localFallbackLatch.get(ctx) === t) localFallbackLatch.delete(ctx);
    process.stderr.write(`[llm-externalizer] the local fallback to profile '${t.target.name}' (model ${t.target.model}) failed too: ${failureText(localErr).split("\n")[0].slice(0, 300)}\n`);
    return undefined;
  }
}

/** Whether the 1b give-up window of this dispatch armed (its strict probe got no genuine provider answer and a local target was ready). */
async function giveUpArmed(clock: RetryClock | undefined): Promise<boolean> {
  const armed = clock?.networkGiveUp?.armed;
  return armed === undefined ? false : armed;
}

/** Remote request options a local send must not carry: the remote model, route, OpenRouter provider routing and prompt cache, and the remote clock. */
function localSendOptions<O extends object>(options: O): O {
  return { ...options, model: undefined, route: undefined, provider: undefined, cache: undefined, deadlineAt: undefined, retryClock: undefined, modelOverride: undefined };
}

/** The streaming local send (chain walk and free rotation): the head model on its own primary route, a breaker verdict thrown, never returned as content. */
function streamingLocalSend(messages: ChatMessage[], options: object): LocalSend<StreamingResult> {
  return async (model, deps, o) =>
    ensureNotServiceAbort(
      await chatCompletionWithRetry(messages, { ...localSendOptions(options), model, route: deps.routeForModel(model) ?? undefined, maxTokens: o.maxTokens, retryClock: o.retryClock, localFallback: true }, deps),
    );
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
  // Test seam: production callers omit it (a fresh clock per dispatch). A test seeds a short deadlineAt so a
  // retry window closes in ~1s instead of the real five minutes.
  retryClock: RetryClock = {},
): Promise<StreamingResult> {
  // T2.7 — snapshot once for the type gating below. The old
  // `backend.type !== "openrouter"` ensemble gate is GONE (D-L): the gate is
  // "every member has a route" now, so the snapshot itself is no longer read.
  const freeMode = isFreeModeActive();
  // One retry clock for this whole dispatch (TRDD-YG72CYY7): every rotated
  // model, chain entry and ensemble slot below spreads `options`, so all of
  // them share one five-minute window instead of getting a fresh one each.
  // TRDD-PN0N4290: the give-up window rides on this shared clock so it covers every model of the dispatch; a clock a test seeded with its own wins.
  // TRDD-PN0N4290 N1 (review 20261116_162203): armed LAZILY, only on the branches below that can reach a local fallback site
  // (callSingleWithFreeRotation, chatCompletionWithProfileFallback). WHY not here at the top: the paid modelOverride branch
  // (high_quality_scan), the single-model send and the fan-out Promise.all never fall back, so a window armed for them only cut
  // the 300 s retry budget to the give-up window on a network blip and then threw, with no local answer.
  const armGiveUp = (): void => {
    retryClock.networkGiveUp ??= newNetworkGiveUp();
  };
  const options = { ...callerOptions, retryClock };

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
      armGiveUp(); // N1: callSingleWithFreeRotation below is a fallback site; the paid override branch further down is not
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

  // Single-model path: ensemble off, not a fan-out profile (see canFanOut), or no models configured. D-L (design §7): the
  // old `backend.type !== "openrouter"` gate is replaced by "every member has a route" — a local/other-backend profile with
  // reserved slots fans out to them (each member's send rides its own serving group). A profile whose members are not all
  // routed fans out only when the USER declared it a remote-ensemble profile; any other such profile sends to one model.
  const ensembleModels = getEnsembleModels();
  const canFanOut =
    ensembleModels.length > 0 &&
    // TRDD-7H5MGN34: a USER-declared remote-ensemble profile reaches one endpoint for all members, so its non-reserved
    // members (model/second_model/third_model, which carry no route) still fan out; requiring a route here collapsed every
    // plain remote ensemble onto the single-model path. NOT the built-in dynamic profiles (free, paid, local): the benchmark
    // and the maintainer may write mode remote-ensemble into them, but they have always sent one model at a time (free
    // rotates, paid walks its chain), and fanning them out would triple the requests and the bill of every file.
    ((activeResolved?.mode === "remote-ensemble" && activeResolved.dynamic !== true) || ensembleModels.every((m) => m.route !== undefined));
  if (
    !ensemble ||
    ensembleModels.length === 0 ||
    !canFanOut
  ) {
    armGiveUp(); // N1: both returns below are fallback sites (callSingleWithFreeRotation / chatCompletionWithProfileFallback)
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
    armGiveUp(); // N1: this branch ends in a fallback site (callSingleWithFreeRotation / chatCompletionWithProfileFallback)
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
      // P8 decision 5 (TRDD-1OOAH3LD): a local ensemble answers as late as its slowest member (a 3B GGUF at ~35 tok/s
      // next to a 1.7B at ~115), and neither the report nor stderr showed where the time went: one line per local
      // member. Remote members print nothing, so remote stderr is unchanged. It is a progress line, so it follows
      // --quiet the way the progress lines do: options.onProgress is undefined when progress is off (makeProgressFn).
      const startedAt = m.route?.isLocal === true && options.onProgress !== undefined ? Date.now() : null;
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
        // --stop_on_errors (TRDD-SWNIIFTF): a dead member of the fan-out ends the command. WHY here: this catch turns the
        // failure into a slot result, so the other members answering would otherwise hide it (exit 0 with one of three dead).
        // Thrown, the stop rejects Promise.all and the command ends at once, siblings still in flight included.
        stopIfStopOnErrors(m.id, err, endpointFailureKind(err instanceof RetryDeadlineError ? err.cause : err, failureText(err)) !== null);
        return {
          model: m.id,
          content: slotErrorContent(err),
          usage: undefined,
          truncated: false,
          error: true,
          cause: err,
        };
      } finally {
        if (startedAt !== null) process.stderr.write(`[llm-externalizer] Ensemble member ${m.id}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed, including any wait in the local-model broker queue\n`);
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
    // WHY undefined, not 0: a slot that sent no cost must not turn "unknown" into a free run in the scan totals (TRDD-RPLLP8CF).
    cost: succeeded.some((r) => typeof r.usage?.cost === "number") ? succeeded.reduce((s, r) => s + (r.usage?.cost ?? 0), 0) : undefined,
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
    undefined,
    options.lineNumbers,
  );
  const lang = options.language || detectLang(filePath);
  // Derive line count from the already-read code block (avoid double file read)
  const fileLineCount = codeBlock.split("\n").length;
  const useEnsemble = options.ensemble !== false; // default true

  const perFileUserContent = `${buildPreInstructions(true, "read", options.lineNumbers)}Task: ${task}\n\n${codeBlock}`;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: codeTaskSystemPrompt(lang, options.lineNumbers),
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

  // WHY computed before the rejection returns below: a reply the response checks reject (finish_reason=error, empty,
  // echoed) still spent paid tokens; each failed result carries them so the scan totals count every file that reported usage.
  const usage: FileUsage | undefined = resp.usage
    ? { promptTokens: resp.usage.prompt_tokens, completionTokens: resp.usage.completion_tokens, costUsd: resp.usage.cost }
    : undefined;

  // TRDD-PN84WC1L part C: a reply the provider ended with finish_reason=error (a mid-stream
  // failure after partial text, labelled UPSTREAM ERROR by the retry layer) is a failed file,
  // not a report. WHY here: this scan is one model per file, so no other model covers the gap
  // the way a failed ensemble slot is covered (the ensemble returns finishReason "stop" for its
  // combined text, so it never reaches this branch).
  if (resp.finishReason === "error") {
    return { filePath, success: false, error: "The provider ended the answer with finish_reason=error after partial output; the partial text is not saved as a report", usage };
  }

  // Shared response gate (TRDD-P4ULUV1R): empty AND echoed responses are
  // failures — "the model printed something" is not success.
  {
    const verdict = gateLLMResponse(resp.content, perFileUserContent);
    if (verdict !== null) {
      return { filePath, success: false, error: gateFailureMessage(verdict), usage };
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

  // Counted per item so dispatchCallTool can tell a multi-item run that partly succeeded (never re-run whole after
  // a foreground repair) from one that got nowhere (retried once). Every multi-file tool funnels through here.
  const exhaustionStore = dynamicExhaustionStore.getStore();
  if (exhaustionStore) exhaustionStore.itemsSucceeded = (exhaustionStore.itemsSucceeded ?? 0) + 1;
  // TRDD-RPLLP8CF: carry the reply's usage so the scan summary sums one source. cost stays undefined when the provider sent none.
  return {
    filePath,
    success: true,
    reportPath,
    usage,
  };
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
      : localEnsembleMemberCount(activeResolved) >= 2
        // P8 review: a local profile with two or more models fans out (ensembleAllowed); the old text called every
        // non-openrouter backend SEQUENTIAL, which the local ensemble no longer is.
        ? "• LOCAL ENSEMBLE: each file goes to every model of the profile, all members at once. On a managed profile (server: managed) one local-model broker serves one model at a time, so members queue behind model loads."
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
 *  timeout. Any other error reads exactly as before (failureText == message).
 *  The provider-state line (OKK9JVK6) is appended the same way classifyError does
 *  for a single-model call: this function flattens the error to text and the
 *  all-failed message / "Unavailable models" section are built from that text, so
 *  the line carried on the error's failure fields would otherwise be lost here. */
export function slotErrorContent(err: unknown): string {
  const text =
    err instanceof RetryDeadlineError && err.cause !== undefined
      ? `ERROR: ${err.message} ${err.causeLabel} ${failureText(err)}`
      : `ERROR: ${failureText(err)}`;
  return withStates(text, [stateOf(err)]);
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

/** Distinct model ids a mode-local profile declares as ensemble members (model, second_model, third_model and
 *  reserved slots); 0 for any other mode. */
function localEnsembleMemberCount(r: ResolvedProfile | null): number {
  if (r?.mode !== "local") return 0;
  const ids = [r.model, r.secondModel, r.thirdModel, ...(r.reservedSlots ?? []).map((s) => s.modelId)];
  return new Set(ids.filter((x) => typeof x === "string" && x.length > 0)).size;
}

/**
 * P8 (TRDD-1OOAH3LD): the ONE ensemble gate every ensemble command reads; it replaced ten copies of
 * `backend.type === "openrouter"`. True for the openrouter backend exactly as before, and for a mode-local profile
 * that declares two or more members (the built-ins local_llama and locals-mlx declare three). WHY keyed on `mode`
 * and not on `backend.type`: a remote openai_api preset (b.ai) resolves to backend type "local" while being a remote
 * endpoint, so reading the type would turn its ensemble on. A local profile with one member keeps the single-model
 * path. getEnsembleModels and canFanOut still decide what actually fans out.
 */
export function ensembleAllowed(backend: Pick<BackendConfig, "type">, resolved: ResolvedProfile | null): boolean {
  return backend.type === "openrouter" || localEnsembleMemberCount(resolved) >= 2;
}

/**
 * P8 review decision 1: a local ensemble member is sized EXACTLY like a single local request of the same model: the
 * output budget the single-model path asks for (resolveDefaultMaxTokens: with an ok calibration record, the P7 output
 * cap shared by every member, else the profile's context window or the fallback), and no input-line filter (the
 * single-model path has none). The P7 input budget covers every member at once (localSizingForCommand).
 */
function localMemberLimits(): ModelLimits {
  return { maxOutput: resolveDefaultMaxTokens(), maxInputLines: Number.POSITIVE_INFINITY };
}

/**
 * P8 review decision 2: every member of a local ensemble must carry a route. canFanOut's "every member has a route" arm
 * would otherwise be false, and the call would silently send ONE model (the TRDD-7H5MGN34 symptom). Fail fast instead,
 * naming the members.
 */
export function assertLocalMembersRouted(members: ReadonlyArray<{ id: string; route?: ResolvedRoute }>): void {
  const unrouted = members.filter((m) => m.route === undefined).map((m) => m.id);
  if (unrouted.length > 0) {
    throw new Error(`local ensemble member(s) with no serving route: ${unrouted.join(", ")} — no provider group of the active profile serves them; fix the profile's providers or remove the model`);
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
  // P8 (TRDD-1OOAH3LD): a mode-local profile declaring two or more distinct members (model, second_model, third_model
  // and reserved slots, localEnsembleMemberCount) fans out too; without reserved slots it returned [] here before P8.
  if (!activeResolved || !(activeResolved.mode === "remote-ensemble" || hasReserved || localEnsembleMemberCount(activeResolved) >= 2)) return [];
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
    // P8 review: a reserved LOCAL member is sized like a single local request too (localMemberLimits).
    return { id: s.modelId, ...(activeResolved?.mode === "local" ? localMemberLimits() : limits), route: s.routes[0] };
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
  // P8 (TRDD-1OOAH3LD): a mode-local member carries its route, from the same routeForModel a single local request
  // reads in resolveConnection, so canFanOut's "every member has a route" arm passes and each send reaches the server
  // that serves it (a managed primary goes through the broker, keyed by model id). It is sized like a single local
  // request (localMemberLimits). A remote member is built exactly as before (no route, catalog limits), so remote
  // behaviour is byte-for-byte unchanged (remote-ensemble-fanout.test.ts).
  const resolved = activeResolved;
  const all = [
    ...members,
    ...models.map((id) => {
      if (resolved.mode === "local") {
        const route = resolved.routeForModel(id);
        return { id, ...localMemberLimits(), ...(route ? { route } : {}) };
      }
      const catalogMaxOutput =
        catalogById.get(id)?.top_provider?.max_completion_tokens;
      const limits = resolveEnsembleModelLimits(id, catalogMaxOutput);
      return { id, ...limits };
    }),
  ];
  // P8 review: a local ensemble whose member has no route must fail, never collapse to one model (TRDD-7H5MGN34 symptom).
  if (localEnsembleMemberCount(resolved) >= 2) assertLocalMembersRouted(all);
  return all;
}

export type { ToolResult };

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
  return withUsageContext({ tool: name, params: summarizeParams(rawArgs) }, async () => {
    // WHY (TRDD-5Q79QZM7 scope 2; USER requirement: "a command must never stay blocked; when a profile's models
    // fail, llm-ext repairs the profile and the command works"): failDynamicProfile records here that every model
    // of a generated profile failed and an update is running. Instead of answering retry-later at once, wait
    // (bounded) for that update, reload settings and retry the SAME request ONCE. The retry runs outside the
    // store, so it can never loop. A second session finds the update already running and waits on its lock.
    // (TRDD-5Q79QZM7 review) The retry happens only when the profile content actually changed, and the whole call
    // is re-run only when no item of it succeeded (a single-request tool, or a multi-item run that got nowhere):
    // re-running a run that partly succeeded would redo its successful files and double their cost, so it gets
    // one honest line telling the caller to re-run the failed files. Retrying only the failed items stays a
    // recorded follow-up. Items are counted by processFileCheck into `itemsSucceeded`.
    const exhaustion: DynamicExhaustion = {};
    const first = await dynamicExhaustionStore.run(exhaustion, () => dispatchCallToolInner(name, rawArgs, opts));
    if (!first.isError || exhaustion.profile === undefined || exhaustion.update === undefined || exhaustion.baseline === undefined) return first;
    const retryLater = dynamicProfileRetryLaterMessage(exhaustion.profile);
    // includes, not ===: a per-file tool (scan_folder) wraps the sentence inside its report.
    if (!first.content.some((c) => c.text.includes(retryLater))) return first;
    process.stderr.write(`[llm-externalizer] every model of '${exhaustion.profile}' failed -- repairing the profile in the foreground\n`);
    const repair = await repairProfileInForeground(exhaustion.profile, exhaustion.update, exhaustion.baseline);
    // WHY: the stop ended the repair wait. The request is not dispatched again (that would re-enter the gate and could
    // start another update); the first pass's result, with the files that already completed, is kept and only its
    // retry-later sentence is replaced by the stop reason and the real cause. The CLI exits 124 because the stop flag is
    // set (cli/main.ts).
    const stopped = commandStopReason();
    if (stopped !== null) return withStopReason(first, retryLater, exhaustion.profile, stopped);
    if (!repair.ok) return withRepairLine(first, repair.line);
    if (!repair.changed) {
      return withRepairLine(
        first,
        repair.rebenchmarked
          ? "Foreground repair finished but the profile content did not change, so the request was not retried."
          : "Foreground update only pruned models (a $0 maintenance pass, not re-benchmarked) and the profile content did not change, so the request was not retried.",
      );
    }
    if ((exhaustion.itemsSucceeded ?? 0) > 0) {
      return withRepairLine(
        first,
        `The '${exhaustion.profile}' profile was repaired in the foreground. ${exhaustion.itemsSucceeded} item(s) of '${name}' already succeeded and are not re-run: re-run the failed files now.`,
      );
    }
    const retried = await dynamicExhaustionStore.run({ retry: true }, () => dispatchCallToolInner(name, rawArgs, opts));
    return retried.isError
      ? withRepairLine(retried, "Foreground repair finished and the request was retried once; it failed again.")
      : retried;
  });
}

/**
 * Wait (bounded) for the profile's update to record its outcome, then load the repaired settings. `changed` says
 * whether the profile's section differs from the one this process was running (compared before vs after the reload).
 * Shared by dispatchCallTool (every model failed) and the empty-pool gate.
 */
async function repairProfileInForeground(
  profile: DynamicProfileName,
  update: Parameters<typeof waitForProfileUpdate>[1],
  baseline: UpdateBaseline,
): Promise<{ ok: true; changed: boolean; rebenchmarked: boolean } | { ok: false; line: string }> {
  const waited = await waitForProfileUpdate(profile, update, baseline);
  if (!waited.ok) {
    return { ok: false, line: waited.failed ? `Foreground repair was tried and failed: ${waited.why}.` : `Foreground repair was tried and stopped: ${waited.why}.` };
  }
  const snapshot = () => JSON.stringify(activeSettings.profiles?.[profile] ?? null);
  const before = snapshot();
  const reloaded = reloadSettingsFromDisk();
  if (!reloaded.ok) return { ok: false, line: `Foreground repair finished but the repaired settings were not loaded: ${reloaded.error}.` };
  return { ok: true, changed: snapshot() !== before, rebenchmarked: waited.rebenchmarked };
}

/** The tool result with the retry-later sentence replaced by the stop reason plus the real cause; all else is kept.
 *  WHY: this runs only after every model of the profile failed, so those files did fail for lack of working models and
 *  the output must still say so; the stop only ended the wait for the repair, whose update continues in the background.
 *  The lines of files that completed before the failure stay in the output. */
function withStopReason(result: ToolResult, retryLater: string, profile: string, stopReason: string): ToolResult {
  const text = `${stopReason}; every model of '${profile}' had failed and its update continues in the background`;
  return { ...result, content: result.content.map((c) => ({ ...c, text: c.text.split(retryLater).join(text) })) };
}

/** The tool result with one extra line appended to its last text block. */
function withRepairLine(result: ToolResult, line: string): ToolResult {
  const content = result.content.map((c) => ({ ...c }));
  const last = content[content.length - 1];
  if (last) last.text = `${last.text}\n${line}`;
  else content.push({ type: "text", text: line });
  return { ...result, content };
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
        let gate = profileGateRefusal(name);
        if (gate) {
          // D2 (USER 2026-09-18) said "refuse, retry later" for a pool that is empty only because it was never
          // populated. SUPERSEDED by the USER's 2026-10-27 directive (TRDD-5Q79QZM7: "a command must never remain
          // blocked"): start the update, wait for its recorded outcome (bounded, same limit as the all-models-failed
          // path), reload and re-judge the gate; the command runs when the pool is now populated. Only when the
          // repair fails or times out does it answer retry-later, plus one line saying why. Every other refusal
          // (malformed profile, forbidden tool, no credentials, maintenance disabled, catalog recently failed,
          // unpopulated paid/local) keeps its own message, as before.
          if (gate.reason === "empty-pool-refreshable") {
            // WHY: a command already stopped by --command_timeout starts no profile update (it would spawn a detached
            // updater for a command that no longer runs); the tool does not run, so the answer is the stop reason.
            const stoppedBefore = commandStopReason();
            if (stoppedBefore !== null) return { content: [{ type: "text", text: stoppedBefore }], isError: true };
            // First use of an unbenchmarked free/paid profile: this is where it starts to populate (see unbenchmarkedProfileNotice).
            const firstUseNotice = unbenchmarkedProfileNotice(effective);
            if (firstUseNotice) process.stderr.write(firstUseNotice);
            // Before the spawn, for the same reason as in failDynamicProfile.
            const baseline = takeUpdateBaseline();
            const update = requestProfileUpdate({ profile: effective, log: (m) => process.stderr.write(m) });
            if (update.state !== "unavailable") {
              const repair = await repairProfileInForeground(effective, update, baseline);
              // WHY: the stop ended the repair wait (waitForProfileUpdate), so the pool is still empty and the tool must not
              // run on it. The answer is the stop reason, not the retry-later sentence: the command was stopped, it did not
              // fail for lack of models. The CLI exits 124 because the stop flag is set (cli/main.ts).
              const stoppedAfter = commandStopReason();
              if (stoppedAfter !== null) return { content: [{ type: "text", text: stoppedAfter }], isError: true };
              if (repair.ok && profileGateRefusal(name) === null) {
                gate = null;
              } else {
                const line = repair.ok
                  ? repair.rebenchmarked
                    ? "Foreground repair finished but the pool is still empty."
                    : "Foreground update only pruned models (not re-benchmarked) and the pool is still empty."
                  : repair.line;
                return { content: [{ type: "text", text: `${dynamicProfileRetryLaterMessage(effective)}\n${line}` }], isError: true };
              }
            } else {
              process.stderr.write(`[llm-externalizer] '${effective}' profile update not started — ${update.reason}\n`);
            }
          }
          if (gate) return { content: [{ type: "text", text: gate.message }], isError: true };
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
      // free-pool id would override it.
      // P6: calibrate_model's `model` names the LOCAL model to calibrate, and calibration_status sends no request;
      // on a remote profile in free mode a free-pool id injected here would queue a remote id for calibration.
      // Free mode off (every local profile; a funded paid one) => the override returns undefined and the caller's
      // model stands; it never builds the free pool, which throws when the profile has none (TRDD-N0S2UL0K).
      const inject = isScoutingOnlyTool(name) || name === "calibrate_model" || name === "calibration_status"
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

    // P7 (TRDD-1OOAH3LD, TRDD-ZGSGGHQG): size this command's input from the calibration record when its model is a
    // local llama.cpp or Locals model with an ok record (local-input-budget.ts). Computed ONCE here, before any tool
    // runs, so a too-small context or an unfit kind fails the command before anything is read or sent. WHY injected
    // into args.max_payload_kb: nine commands read `max_payload_kb ?? 400`, four of them inside their own core modules
    // (scan-folder, code-task, search-existing, check-specs), so filling the argument the caller left out is the one
    // place that reaches all of them; a remote route returns null and never gets here. max_payload_kb is a PER-FILE
    // limit at most sites (one file per request, or two plus their diff in compare_files), so what is injected is the
    // budget minus this command's instructions and system prompt, divided by the files one request carries
    // (taskEntryOf().filesPerRequest); check_references caps its dependency total itself (capDependencyBlocks). An
    // explicit max_payload_kb wins up to the window bound (window - cap - overhead), above which it is capped; one
    // stderr line says either.
    let localSizing = localSizingForCommand(name);
    if (localSizing?.state === "await") {
      // Round 2 gap 1, round 3 M2: every managed member with no record is calibrated first and the command sizes from
      // the records; grouping now with the 400 KB default would overflow the calibrated window once the jobs run.
      const waitFor = localSizing.models;
      await waitForCalibration({
        dir: getConfigDir(),
        models: waitFor,
        head: localSizing.head,
        start: () => startCalibration(waitFor),
        sleep: stoppableSleep,
        stopReason: commandStopReason,
        write: (line) => process.stderr.write(line),
      });
      localSizing = localSizingForCommand(name, true);
    }
    const sizedEntry = taskEntryOf(name);
    if (localSizing?.state === "calibrated" && sizedEntry?.sizesInput === true && args !== undefined) {
      const sizedArgs = args as Record<string, unknown>;
      // Round 3 (M4): what one file may take so that the request (the prompt plus filesPerRequest file blocks) stays
      // within `bytes`. readAndGroupFiles sites subtract the prompt again: on the safe side by under 1 KB.
      const reserve = promptReserveBytes(sizedArgs);
      const perFileOf = (bytes: number): number => Math.floor((bytes - reserve) / (sizedEntry.filesPerRequest ?? 1));
      const perFile = perFileOf(localSizing.budgetBytes);
      const windowPerFile = perFileOf(localSizing.windowBudgetBytes);
      if (perFile <= 0) throw new Error(`the instructions of this command (${reserve} bytes with the system prompt) leave no room in the calibrated input budget of ${localSizing.models.join(", ")} (${localSizing.budgetBytes} bytes)`);
      const explicitKb = sizedArgs.max_payload_kb;
      if (typeof explicitKb === "number") {
        if (explicitKb * 1024 > windowPerFile) {
          // Round 3 (M7): above the window bound the request would pass the window; cap it there.
          process.stderr.write(
            `[llm-externalizer] max_payload_kb ${explicitKb} is above the window of ${localSizing.models.join(", ")} (${windowPerFile} bytes per file after the ${localSizing.maxTokens}-token output cap and the prompt); capped there\n`,
          );
          sizedArgs.max_payload_kb = windowPerFile / 1024;
          registerCalibratedBudget(windowPerFile);
        } else if (explicitKb * 1024 > perFile) {
          process.stderr.write(
            `[llm-externalizer] max_payload_kb ${explicitKb} is above the calibrated input budget of ${localSizing.models.join(", ")} (${perFile} bytes per file, ${localSizing.inputTokens} tokens for ${localSizing.kind} tasks); using it as asked\n`,
          );
        }
      } else {
        sizedArgs.max_payload_kb = perFile / 1024;
        // Gap 3: only an injected budget is exempt from readAndGroupFiles' 10 KB clamp; an explicit value keeps it.
        // perFile / 1024 * 1024 === perFile exactly (an integer over a power of two), and the four core modules pass
        // (max_payload_kb ?? 400) * 1024 unchanged, so isCalibratedBudget's equality holds there (review m1).
        registerCalibratedBudget(perFile);
      }
    }

    try {
    // WHY (TRDD-TYSKX72I): the cases that call a handler from tools/, session_summary/ or check-imports/ hand it, inline
    // in the case, exactly the index.ts functions and state its old body read. Inline and per case, not one shared
    // object: free-forbidden-tools.test.ts derives which tools reach chat/completions from the identifiers of each
    // case text, and a shared object would make every handler case look like a sender. The getters keep reading the
    // live module bindings, which settings reloads reassign.
    switch (name) {
      case "chat":
        return await handleChat(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            DEFAULT_TEMPERATURE,
            ensembleAllowed,
            ensembleModelLabel,
            ensembleStreaming,
            formatFooter,
            normalizePaths,
            processFileCheck,
            resolveDefaultMaxTokens,
            resolveFolderPath,
            robustPerFileProcess,
            saveResponse,
            get activeResolved() {
              return activeResolved;
            },
          },
        );

      case "code_task": {
        // Pipeline body extracted to code-task/core.ts (B1 Phase 3,
        // TRDD-63314265), mirroring the scan_folder / search_existing
        // extractions so the REAL pipeline (BOTH the single/inline path and the
        // multi-file FFD-batched path) can run in-process from a benchmark
        // runner; this case only wires the server-stateful deps. processFileCheck
        // and ensembleStreaming are the per-file-call and multi-model seams;
        // robustPerFileProcess carries the parallel+retry+circuit-breaker path.
        const ctDeps: CodeTaskDeps = {
          useEnsemble: ensembleAllowed(backend, activeResolved), // P8: one predicate (see ensembleAllowed)
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
          useEnsemble: ensembleAllowed(backend, activeResolved), // P8: one predicate (see ensembleAllowed)
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

      case "discover":
        return await handleDiscover(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            LOG_FILE,
            SETTINGS_FILE,
            activeFreePool,
            fetchOpenRouterModels,
            getContextLength,
            getProfileSelectionSource,
            getRateLimitConfig,
            isFreeModeActive,
            listModelsRaw,
            providerDeps,
            resolveDefaultMaxTokens,
            session,
            get FALLBACK_CONTEXT_LENGTH() {
              return FALLBACK_CONTEXT_LENGTH;
            },
            get SOFT_TIMEOUT_MS() {
              return SOFT_TIMEOUT_MS;
            },
            get activeResolved() {
              return activeResolved;
            },
            get activeSettings() {
              return activeSettings;
            },
            get settingsError() {
              return settingsError;
            },
            get settingsValid() {
              return settingsValid;
            },
            get settingsLoadFailed() {
              return settingsLoadFailed;
            },
          },
        );

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
      case "or_model_info_json":
        return await handleOrModelInfoJson(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            get activeResolved() {
              return activeResolved;
            },
          },
        );

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
        // WHY (TRDD-LFWV2DKG): same as list_profiles — a failed boot load stays an error even when the file is readable again; the formatter re-reads the disk.
        if (settingsLoadFailed) return { content: [{ type: "text", text: settingsError }], isError: true };
        const summaryResult = formatActiveProfileSummary(
          effectiveProfileName(activeSettings),
          getProfileSelectionSource(),
        );
        const summary = summaryResult.text;
        try {
          const raw = readFileSync(SETTINGS_FILE, "utf-8");
          // TRDD-PNU8XECB: a copy of settings.yaml is tool configuration (it can name keys and private
          // endpoints), never a final report, so it goes to the gitignored scratch root, not reports/.
          const targetDir = outputDir || defaultScratchDir();
          mkdirSync(targetDir, { recursive: true });
          // TRDD-BYHR8EGG: a differing earlier copy is kept under a stamped name, never overwritten (see tools/settings-copy.ts).
          const { copyPath, keptPath } = writeSettingsCopy(targetDir, raw);
          const keptNote = keptPath === undefined ? "" : `\nPrevious differing copy kept as: ${keptPath}`;
          return {
            content: [{ type: "text", text: `${summary}\n\nFull settings file copied to: ${copyPath}${keptNote}` }],
            // WHY (TRDD-8DMLEAW8): a dangling active: or an unresolvable profile still gets the copy the user needs to fix the file, and stays an error (non-zero exit).
            isError: summaryResult.isError,
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

      case "server_status": {
        return { content: [{ type: "text", text: await serverStatusText(getConfigDir()) }] };
      }

      case "server_stop": {
        const a = (args ?? {}) as Record<string, unknown>;
        const engine = a.engine;
        const role = a.role;
        if (engine !== undefined && engine !== "llama" && engine !== "locals") {
          return { content: [{ type: "text", text: "--engine must be llama or locals" }], isError: true };
        }
        if (role !== undefined && role !== "main" && role !== "cal" && role !== "all") {
          return { content: [{ type: "text", text: "--role must be main, cal or all" }], isError: true };
        }
        const r = await serverStopText(getConfigDir(), { engine, role });
        return { content: [{ type: "text", text: r.text }], isError: r.isError };
      }
      case "list_profiles": {
        // `settings profiles` (TRDD settings-rename, requirement C): every
        // profile in settings.yaml, one line each, with a `*` marker on the
        // EFFECTIVE one for this invocation. Read-only — never mutates
        // settings.yaml.
        // WHY (TRDD-LFWV2DKG): the boot load can fail while settings.yaml is readable again by now (transient lock/read error); the formatter re-reads the disk and would
        // then list the user's file as if the boot had loaded it. A failed boot load is an error whatever the file holds now.
        if (settingsLoadFailed) return { content: [{ type: "text", text: settingsError }], isError: true };
        const listed = formatProfilesList(effectiveProfileName(activeSettings));
        return {
          content: [{ type: "text", text: listed.text }],
          isError: listed.isError,
        };
      }

      case "profile": {
        // Read-only. Adding/switching/removing a profile is user-only (hand-edit
        // settings.yaml + 'reset') — see the tool description. This case only
        // ever reads activeSettings.profiles / the effective profile name; it
        // never writes settings.yaml.
        // WHY (TRDD-LFWV2DKG): after a failed settings load activeSettings is the generated default; `--show <name>` or the list would resolve and print
        // that in-memory default as if it were the user's configuration. Fail fast with the same error the gate and boot use.
        if (settingsLoadFailed) return { content: [{ type: "text", text: settingsError }], isError: true };
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
        const listed = formatProfilesList(effectiveProfileName(activeSettings));
        return {
          content: [{ type: "text", text: listed.text }],
          isError: listed.isError,
        };
      }

      case "session_summary":
        return await handleSessionSummary(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            DEFAULT_TEMPERATURE,
            brokerSlotCtx,
            makeBackendFromProfile,
            makeProviderDeps,
            providerDeps,
            saveResponse,
            startCalibration,
            get activeResolved() {
              return activeResolved;
            },
            get activeSettings() {
              return activeSettings;
            },
          },
        );

      // ── Batch Operations ──────────────────────────────────────────────

      case "batch_check":
        return await handleBatchCheck(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            classifyError,
            ensembleAllowed,
            getRateLimitConfig,
            normalizePaths,
            processFileCheck,
            recordFailedOutcome,
            resolveDefaultMaxTokens,
            resolveFolderPath,
            saveResponse,
            get activeResolved() {
              return activeResolved;
            },
          },
        );

      // ── Specialized Operations ──────────────────────────────────────

      case "scan_folder": {
        // Pipeline body extracted to scan-folder/core.ts (B1 Phase 3,
        // TRDD-63314265), mirroring the search_existing_implementations
        // extraction so the REAL pipeline can run in-process from a benchmark
        // runner; this case only wires the server-stateful deps. processFileCheck
        // is injected as the per-file-call seam (the scan_folder analogue of
        // search_existing's callModel).
        const sfDeps: ScanFolderDeps = {
          useEnsemble: ensembleAllowed(backend, activeResolved), // P8: one predicate (see ensembleAllowed)
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
          useEnsemble: ensembleAllowed(backend, activeResolved), // P8: one predicate (see ensembleAllowed)
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
              ensembleAllowed(backend, activeResolved), // P8: one predicate (see ensembleAllowed)
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
        const cfUseEnsemble = ensembleAllowed(backend, activeResolved); // P8: one predicate (see ensembleAllowed)

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
          // P7 round 3 (M4): the same calibrated diff share as the single-pair path below.
          const cfDiffMax = isCalibratedBudget(cfBudgetBytes) ? Math.min(200_000, 2 * cfBudgetBytes) : 200_000;
          if (diffOutput.length > cfDiffMax) { diffOutput = diffOutput.slice(0, cfDiffMax); }
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
        // P7 round 3 (M4): under a calibrated local budget the diff gets two of the four per-file shares compare_files
        // is sized with (TASK_KIND_BY_TOOL filesPerRequest 4): diff + A + B then stay within the request budget.
        const MAX_DIFF_CHARS = isCalibratedBudget(cfBudgetBytes) ? Math.min(200_000, 2 * cfBudgetBytes) : 200_000; // ~50K tokens
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

      case "check_references":
        return await handleCheckReferences(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            DEFAULT_TEMPERATURE,
            capDependencyBlocks,
            ensembleAllowed,
            ensembleStreaming,
            formatFooter,
            normalizePaths,
            resolveDefaultMaxTokens,
            resolveFolderPath,
            saveResponse,
            get activeResolved() {
              return activeResolved;
            },
          },
        );

      case "check_imports":
        return await handleCheckImports(
          { args, backend, onProgress, modelOverride, outputDir, name },
          {
            chatCompletionJSONWithFreeRotation,
            logRequest,
            normalizePaths,
            recordUsage,
            resolveDefaultMaxTokens,
            resolveFolderPath,
            saveResponse,
          },
        );

      case "check_against_specs": {
        // Pipeline body extracted to check-specs/core.ts (P2a, zero-token model
        // pipeline), mirroring the search_existing / scan_folder / code_task
        // extractions so the REAL pipeline can run in-process from a benchmark
        // runner; this case only wires the server-stateful deps. Unlike
        // scan_folder there is no per-file processFileCheck seam: every LLM call
        // (answer_mode 0's one-call-per-file path and the FFD-batched path alike)
        // goes through ensembleStreaming, so that is the single LLM seam.
        const csDeps: CheckSpecsDeps = {
          useEnsemble: ensembleAllowed(backend, activeResolved), // TRDD-1OOAH3LD P8: one predicate, local ensembles too
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
