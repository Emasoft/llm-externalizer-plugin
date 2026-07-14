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
  realpathSync,
  watchFile,
  unwatchFile,
} from "node:fs";
import { parse as yamlParse } from "yaml";
import { spawnSync } from "node:child_process";
import { extname, join, basename, dirname, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  GROUP_HEADER_RE,
  GROUP_FOOTER_RE,
  parseFileGroups,
  hasNamedGroups,
  autoGroupByHeuristic,
} from "./grouping.js";

// T2.MCP-SDK — Migrated from the deprecated `Server` constructor to
// `McpServer`. The high-level surface (registerTool) auto-handles
// ListTools and CallTool routing, validates inputs against per-tool
// Zod schemas, and exposes the underlying Server via `mcpServer.server`
// for advanced operations (notifications, request handlers we still
// need). The behavior of the wire protocol is preserved exactly.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MASS_SCOUT_TOOL_NAMES,
  dispatchMassScoutTool,
} from "./mass_scouting/mcp-tools.js";
import { buildTools } from "./tools/definitions.js";
import { safeReadJson } from "./safe-body.js";
import {
  runClusterSynonyms,
  type ClusterSynonymsHooks,
  type ClusterSynonymsInvocation,
} from "./cluster/cluster_synonyms_main.js";
import type { Phase1RawLlmCall } from "./cluster/phase1_batch.js";
import { makePreflightHook } from "./cluster/preflight_benchmark.js";
// Provider layer (B1 Phase 5a/5b, TRDD-63314265). These modules import NOTHING
// from index.ts — the mutable backend/profile state they need is handed to them
// through the `providerDeps` seam object built below.
import { fetchWithTimeout } from "./provider/http.js";
import {
  detectLMStudio,
  clearLMStudioProbeCache,
} from "./provider/lmstudio.js";
import {
  chatCompletionJSON,
  chatCompletionWithRetry,
  EXTRACT_PATHS_SCHEMA,
  type JSONCompletionResult,
} from "./provider/completion.js";
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
  type Profile,
  type ResolvedProfile,
  API_PRESETS,
  validateSettings,
  resolveProfile,
  ensureSettingsExist,
  getSettingsPath,
  getConfigDir,
  generateDefaultSettings,
  setActiveFreeOnly,
  FREE_POOL_SEED,
  HIGH_QUALITY_MODEL_DEFAULTS,
  buildHighQualityProvider,
  highQualityScanRefusal,
  type HighQualityRequest,
} from "./config.js";
// recordRequest moved with the completion layer (B1 Phase 5b) — the per-request
// usage line is written where the request is actually made (provider/completion.ts
// + provider/lmstudio.ts), so index.ts only sets up the usage CONTEXT here.
import {
  withUsageContext,
  summarizeParams,
} from "./usage-history.js";
import { installUsageRule } from "./rule-install.js";
import { resolveProjectMainRoot } from "./project-root.js";
import { resolveEnsembleModelLimits } from "./ensemble-limits.js";
import { benchmarkFailedModels } from "./benchmark/security-triage/index.js";
import { isFreeSuffixModelId } from "./benchmark/free-mode.js";
import {
  AllFreeModelsExhaustedError,
  callWithFreeRotation,
  classifyUnavailable,
  filterFreeModels,
  getCooldownStore,
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
import { maybeTriggerFreePoolBench } from "./free-pool-auto-bench.js";

// Settings path (cross-platform, see config.ts)
const SETTINGS_FILE = getSettingsPath();

// Whether settings are valid (configured by user). If false, all tools except
// discover return an error asking the user to configure settings.yaml.
let settingsValid = false;
let settingsError = "";

// ── Profile-based startup ────────────────────────────────────────────
// Load settings.yaml, validate active profile, resolve to concrete values.
// ensureSettingsExist() generates default settings.yaml on first run.

let activeSettings: Settings = (() => {
  try {
    return ensureSettingsExist();
  } catch (err) {
    settingsError = `Failed to load settings: ${err instanceof Error ? err.message : String(err)}\n\nSettings file: ${SETTINGS_FILE}`;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return generateDefaultSettings();
  }
})();

let activeResolved: ResolvedProfile | null = (() => {
  const validation = validateSettings(activeSettings);
  if (!validation.valid) {
    settingsError = `${validation.errors.join("; ")}\n\nSettings file: ${SETTINGS_FILE}`;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return null;
  }
  settingsValid = true;
  const profile = activeSettings.profiles[activeSettings.active];
  const resolved = resolveProfile(activeSettings.active, profile);
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
  // Auto-bench the free pool when free_only is ON and the cache lacks
  // :free entries (TRDD-f1510055). Fire-and-forget — never blocks server
  // boot; the detached child writes to ~/.llm-externalizer/free-pool-bench.log.
  // Cost-safety: --bench-free-pool + the runner's free_only guard reject
  // any non-:free model, so this is zero-spend by construction.
  // At startup we don't know the *prior* free_only state, so pass null —
  // the helper treats null as "fire if active and cache is empty".
  maybeTriggerFreePoolBench({
    activeProfile: activeSettings.active,
    freeOnlyActive: resolved.freeOnly,
    freeOnlyWasOn: null,
    log: (msg) => process.stderr.write(msg),
  });
  return resolved;
})();

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
    baseUrl: resolved.url,
    apiKey: resolved.authToken,
    model: modelOverride || resolved.model,
    __version: ++RELOAD_VERSION,
  };
}

let currentBackend: BackendConfig = activeResolved
  ? makeBackendFromProfile(activeResolved)
  : { type: "local", baseUrl: "http://localhost:1234", apiKey: "", model: "", __version: ++RELOAD_VERSION };

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

// ── Settings file watcher — auto-reload on manual edits ─────────────
// Polls settings.yaml every 5s. On change: validate → reload in memory.
// Invalid changes are logged but ignored (old settings remain active).

// Late-bound hook — assigned after the MCP server is created (see notifyToolsChanged)
let _onSettingsReloaded: (() => void) | null = null;

/**
 * Reload settings from disk. Returns true if settings changed and were applied.
 *
 * T2.7 — All new backend state is built into LOCAL variables first, then
 * applied via a single atomic assignment. Intermediate state is never
 * exposed to other handlers. Any caller mid-flight that snapshotted
 * `getCurrentBackend()` will keep its consistent view; new callers will
 * see the new backend via the next `getCurrentBackend()` call.
 */
function reloadSettingsFromDisk(): boolean {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS_FILE, "utf-8");
  } catch {
    // File temporarily missing (mid-save) — skip this cycle
    return false;
  }

  let parsed: { active?: string; profiles?: Record<string, Profile> };
  try {
    parsed = yamlParse(raw);
  } catch {
    process.stderr.write(
      `[llm-externalizer] ⚠ settings.yaml has invalid YAML — ignoring change\n`,
    );
    return false;
  }

  if (!parsed || typeof parsed !== "object" || !parsed.profiles) {
    return false;
  }

  const newSettings: Settings = {
    active: parsed.active || "",
    profiles: parsed.profiles || {},
  };

  // Validate before applying
  if (newSettings.active) {
    const validation = validateSettings(newSettings);
    if (!validation.valid) {
      process.stderr.write(
        `[llm-externalizer] ⚠ settings.yaml change rejected: ${validation.errors.join("; ")}\n`,
      );
      return false;
    }
  }

  // T2.7 — Build all replacement state in LOCAL variables first.
  // Nothing is published to module-level state until every value is ready.
  let nextResolved: ResolvedProfile | null = null;
  let nextBackend: BackendConfig | null = null;
  let nextValid = false;
  let nextErr = "";

  if (newSettings.active && newSettings.profiles[newSettings.active]) {
    const profile = newSettings.profiles[newSettings.active];
    nextResolved = resolveProfile(newSettings.active, profile);
    nextBackend = makeBackendFromProfile(nextResolved);
    nextValid = true;
  } else {
    nextErr = "No active profile configured";
  }

  // T2.7 — Atomic swap section. Each assignment is a single JS statement
  // (atomic between event-loop ticks). The order matters: assign
  // currentBackend LAST so a handler that just snapshotted via
  // getCurrentBackend() and is about to read activeSettings sees a
  // coherent pair.
  // Snapshot the *previous* free_only state BEFORE overwriting it so the
  // auto-bench helper can detect a real OFF→ON transition (TRDD-f1510055).
  const priorFreeOnly = activeResolved?.freeOnly ?? false;
  activeSettings = newSettings;
  activeResolved = nextResolved;
  // Re-publish free_only on every reload so the subsystem guard tracks the live
  // profile (TRDD-97ef8b63). null resolved (invalid settings) → not free_only.
  // Preserve a live auto-free engagement across the reload (TRDD-542bdbef): a
  // low-balance session stays free even if the user edits an unrelated part of
  // settings.yaml — the wallet is still empty, so don't un-protect the spend
  // sites. (Cleared only on process restart.)
  setActiveFreeOnly((nextResolved?.freeOnly ?? false) || autoFreeEngaged);
  // Auto-bench the free pool on an OFF→ON transition with an empty cache
  // (TRDD-f1510055). Helper is fire-and-forget and short-circuits on every
  // skip condition (already-on, cache populated, lock held, opt-out env).
  maybeTriggerFreePoolBench({
    activeProfile: newSettings.active,
    freeOnlyActive: nextResolved?.freeOnly ?? false,
    freeOnlyWasOn: priorFreeOnly,
    log: (msg) => process.stderr.write(msg),
  });
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
  // Notify MCP client that tool descriptions may have changed (backend switch)
  _onSettingsReloaded?.();
  return true;
}

// Track mtime so we only reload when the file actually changed on disk
let _settingsLastMtimeMs = (() => {
  try {
    return statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    return 0;
  }
})();

// Poll every 5s — fs.watchFile uses stat polling (reliable across all platforms/NFS)
watchFile(SETTINGS_FILE, { interval: 5000 }, (curr, _prev) => {
  if (curr.mtimeMs === _settingsLastMtimeMs) return; // no change
  _settingsLastMtimeMs = curr.mtimeMs;

  process.stderr.write(
    `[llm-externalizer] settings.yaml changed on disk — reloading…\n`,
  );
  if (reloadSettingsFromDisk()) {
    // Snapshot AFTER reload completes — getCurrentBackend() returns the
    // post-reload generation. Two reads of the same snapshot are safe.
    const postBackend = getCurrentBackend();
    const label = activeResolved
      ? `${activeSettings.active} (${postBackend.type}, ${postBackend.model}, v${postBackend.__version})`
      : "(no active profile)";
    process.stderr.write(`[llm-externalizer] Settings reloaded: ${label}\n`);
  }
});

// Clean up watcher on process exit to avoid dangling handles
process.on("exit", () => {
  unwatchFile(SETTINGS_FILE);
});

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

// ── OpenRouter balance + credit-exhaustion state ────────────────────
// Session-level flag that flips to true the first time we hit a 402
// "Payment required" error. All subsequent calls automatically route
// through FREE_MODEL_ID instead of the paid ensemble. The flag is only
// cleared on process restart — no point probing a dead wallet repeatedly.
let creditExhausted = false;

// ── Auto-free pure helpers (TRDD-542bdbef) — exported for unit tests ──

/** Parse the low-balance auto-free threshold (USD) from LLM_EXT_FREE_BELOW_USD.
 *  Default $1.00; a non-finite or ≤0 value falls back to $1.00. */
export function parseFreeBelowUsd(raw: string | undefined): number {
  if (raw === undefined) return 1.0;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}

/** Resolve the single working free model (LLM_EXT_FREE_MODEL_ID) for the
 *  `free: true` flag + 402 single-retry. Default poolside/laguna-m.1:free —
 *  across 4 free-pool benchmark runs (TRDD-f1510055) it was the ONLY model to
 *  return valid output every time (the others 429'd or emitted empty content)
 *  AND it scored the top security-triage PASS (0.966). Availability matters
 *  most for a single-model path with no rotation. A non-':free' override is
 *  rejected (cost-safety). The ensemble paths use the rotating free POOL, so
 *  this single id is only the narrow fallback. */
export function resolveFreeModelId(raw: string | undefined): string {
  if (typeof raw === "string" && raw.trim().endsWith(":free")) {
    return raw.trim();
  }
  return "poolside/laguna-m.1:free";
}

/** The free pool to route through when auto-free engages on a paid profile:
 *  the profile's pinned free_models if any, else the bundled FREE_POOL_SEED.
 *  Always a fresh mutable copy. */
export function resolveAutoFreePool(
  profileFreeModels: readonly string[],
): string[] {
  return profileFreeModels.length > 0
    ? [...profileFreeModels]
    : [...FREE_POOL_SEED];
}

/** Which model to force for a single-model subsystem (security_scan /
 *  mass_scout) under free mode (TRDD-542bdbef Phase 2). Those tools default to
 *  a PAID model and assert ':free' on it (getActiveFreeOnly), so under free
 *  mode an unset or paid `model` arg must be replaced with a ':free' one.
 *  Returns undefined to leave the caller's choice untouched (free mode off, or
 *  the caller already passed a ':free' model). Pure + offline-testable. */
export function resolveSubsystemFreeModel(
  freeActive: boolean,
  freePool: readonly string[],
  requestedModel: string,
): string | undefined {
  if (!freeActive) return undefined; // paid mode — caller's model stands
  if (requestedModel.trim().endsWith(":free")) return undefined; // already free
  return freePool[0] ?? resolveFreeModelId(undefined);
}

// Minimum balance (USD) to attempt a PAID ensemble call. Below this the
// server auto-engages free mode (TRDD-542bdbef): the main-dispatch ensemble
// routes through the validated free pool (with rate-limit rotation) instead
// of 402'ing on the paid ensemble — which was making agents refuse the tool.
// Default $1.00 (a balance this low can't reliably clear even one ensemble
// pass). Override via LLM_EXT_FREE_BELOW_USD; non-finite/≤0 → $1.00.
const MIN_BALANCE_FOR_PAID_USD: number = parseFreeBelowUsd(
  process.env.LLM_EXT_FREE_BELOW_USD,
);

// Auto-free engagement (TRDD-542bdbef). Flips true the first time the balance
// is seen below MIN_BALANCE_FOR_PAID_USD, or a 402 fires. While engaged, the
// main-dispatch ensemble (getEnsembleModels) routes through autoFreePool — the
// active profile's free_models if it pins any, else the bundled FREE_POOL_SEED
// — using the existing rate-limit rotation (TRDD-8b6b3646 Phase 3). Cleared
// only on process restart (no point re-probing a dead wallet every call).
let autoFreeEngaged = false;
let autoFreePool: string[] = [];

/** Engage auto-free: route EVERY spend site through the free pool.
 *  Idempotent — safe to call on every low-balance / 402 check. Sets the global
 *  free_only flag (TRDD-97ef8b63 chokepoint) so security_scan / mass_scout also
 *  go free (Phase 2); the dispatch site injects a ':free' model into those
 *  subsystems so the chokepoint assertion is satisfied rather than thrown. The
 *  main-dispatch ensemble picks up autoFreePool via getEnsembleModels. */
function engageAutoFree(reason: string): void {
  if (autoFreeEngaged) return;
  autoFreeEngaged = true;
  autoFreePool = resolveAutoFreePool(activeResolved?.freeModels ?? []);
  // Engage the airtight chokepoint so the subsystem spend sites (judge.ts,
  // scout.ts) that read getActiveFreeOnly() also enforce ':free'. Safe because
  // the dispatch site now substitutes a ':free' model for those tools.
  setActiveFreeOnly(true);
  process.stderr.write(
    `[llm-externalizer] Auto-free engaged (${reason}) — ALL tools now route through the free pool (${autoFreePool.length} models, rotation on rate-limit). Funded-profile choices reactivate on restart.\n`,
  );
}

// Balance query cache: fresh for 60s so we don't hammer /v1/credits
// every time a tool is invoked. Still queried on demand when the cache
// is stale. `null` means "not yet queried this session".
let cachedBalanceUsd: number | null = null;
let balanceCacheTime = 0;
const BALANCE_CACHE_TTL_MS = 60_000;

/**
 * Returns the remaining OpenRouter balance in USD, or `Infinity` if the
 * key is unlimited (no cap), or `NaN` if the query fails / we can't tell.
 * Callers should treat NaN as "unknown — proceed as if paid".
 */
async function getOpenRouterBalance(): Promise<number> {
  if (!activeResolved || activeResolved.protocol !== "openrouter_api") {
    return NaN;
  }
  const now = Date.now();
  if (cachedBalanceUsd !== null && now - balanceCacheTime < BALANCE_CACHE_TTL_MS) {
    return cachedBalanceUsd;
  }
  try {
    // /v1/key is the cheapest probe — returns limit_remaining for capped keys.
    const keyRes = await fetchWithTimeout(`${activeResolved.url}/v1/key`, {
      headers: { Authorization: `Bearer ${activeResolved.authToken}` },
    });
    if (keyRes.ok) {
      const body = (await keyRes.json()) as {
        data: {
          limit?: number | null;
          usage?: number;
          limit_remaining?: number | null;
        };
      };
      if (
        body.data?.limit_remaining !== null &&
        body.data?.limit_remaining !== undefined
      ) {
        cachedBalanceUsd = body.data.limit_remaining;
        balanceCacheTime = now;
        return cachedBalanceUsd;
      }
      if (body.data?.limit === null) {
        // Unlimited key — no cap. Treat as infinite for the purpose of
        // pre-flight checks; we'll still react to 402 mid-flight.
        cachedBalanceUsd = Infinity;
        balanceCacheTime = now;
        return Infinity;
      }
    }
    // Fall back to /v1/credits (requires management-level key).
    const credRes = await fetchWithTimeout(`${activeResolved.url}/v1/credits`, {
      headers: { Authorization: `Bearer ${activeResolved.authToken}` },
    });
    if (credRes.ok) {
      const body = (await credRes.json()) as {
        data: { total_credits?: number; total_usage?: number };
      };
      const credits = body.data?.total_credits ?? 0;
      const usage = body.data?.total_usage ?? 0;
      cachedBalanceUsd = credits - usage;
      balanceCacheTime = now;
      return cachedBalanceUsd;
    }
  } catch {
    // Non-fatal — unknown balance, proceed normally.
  }
  return NaN;
}

/**
 * Decide which model (if any) to force for a given tool invocation.
 *
 * - If the caller explicitly set `free: true`, always return FREE_MODEL_ID.
 * - If the backend is not OpenRouter, return undefined (no override).
 * - If the credit-exhausted session flag is set, return FREE_MODEL_ID.
 * - If the balance query succeeds and the remaining balance is below
 *   MIN_BALANCE_FOR_PAID_USD, return FREE_MODEL_ID and log the fallback.
 * - Otherwise return undefined (proceed with the normal ensemble / profile).
 */
async function resolveModelOverride(
  freeRequested: boolean,
): Promise<string | undefined> {
  if (freeRequested) return FREE_MODEL_ID;
  // T2.7 — single read but snapshot anyway for consistency
  const backend = getCurrentBackend();
  if (backend.type !== "openrouter") return undefined;
  await ensureAutoFreeDecided();
  if (!autoFreeEngaged) return undefined; // funded → normal paid ensemble
  // Auto-free (TRDD-542bdbef): an ensemble profile routes through the free
  // pool (getEnsembleModels) — return undefined so the free ensemble runs with
  // rotation; a single-model (remote) profile has no ensemble, so use the one
  // validated free model.
  return activeResolved?.mode === "remote-ensemble" ? undefined : FREE_MODEL_ID;
}

/** Decide whether to engage auto-free (TRDD-542bdbef): engage on a prior 402
 *  (creditExhausted) or when the OpenRouter balance is below the threshold.
 *  Idempotent + cached (60s balance cache). Shared by the main dispatch and the
 *  security_scan / mass_scout short-circuit so every entry point agrees. */
async function ensureAutoFreeDecided(): Promise<void> {
  if (autoFreeEngaged) return;
  if (getCurrentBackend().type !== "openrouter") return;
  if (creditExhausted) {
    engageAutoFree("credit-exhausted session");
    return;
  }
  const balance = await getOpenRouterBalance();
  if (!isFinite(balance)) return; // unknown → proceed normally (treat as paid)
  if (balance < MIN_BALANCE_FOR_PAID_USD) {
    creditExhausted = true; // lock the session so we don't re-probe
    engageAutoFree(
      `balance $${balance.toFixed(4)} < $${MIN_BALANCE_FOR_PAID_USD.toFixed(2)}`,
    );
  }
}

/** Invalidate the cached balance so the next check hits the API fresh. */
function invalidateBalanceCache(): void {
  cachedBalanceUsd = null;
  balanceCacheTime = 0;
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
//   2. TDZ. `FREE_MODEL_ID` is a `const` declared LATER in this file than this
//      object literal. Reading it eagerly here (`getFreeModelId: FREE_MODEL_ID`)
//      throws at module init; the arrow defers the read to call time.
//
// SINGLE BINDING — the two mutators below are the load-bearing part of Phase 5b.
// `creditExhausted` (read by shouldUseFree + the dispatch layer) and the auto-free
// flags (read by getEnsembleModels) stay HERE, in index.ts, as the one and only
// binding. completion.ts writes them THROUGH this seam instead of owning copies,
// which would diverge from what index.ts actually reads on the very next call.
const providerDeps: CompletionDeps = {
  getBackend: () => getCurrentBackend(),
  apiHeaders: () => apiHeaders(),
  getSoftTimeoutMs: () => SOFT_TIMEOUT_MS,
  isFreeOnly: () => activeResolved?.freeOnly ?? false,
  isLMStudioProvider: () => activeResolved?.protocol === "lmstudio_api",
  defaultTemperature: DEFAULT_TEMPERATURE,
  getDefaultMaxTokens: () => resolveDefaultMaxTokens(),
  getFreeModelId: () => FREE_MODEL_ID,
  setCreditExhausted: () => {
    creditExhausted = true;
  },
  engageAutoFree: (reason: string) => engageAutoFree(reason),
  invalidateBalanceCache: () => invalidateBalanceCache(),
};

// The completion layer — chatCompletionSimple / chatCompletionJSON /
// chatCompletionWithRetry, the reasoning ladder, the supported-params filter and
// the SERVICE_HEALTH circuit breaker — moved to ./provider/completion.ts
// (B1 Phase 5b). resolveConnection() → ./provider/connection.ts; fetchWithTimeout /
// fetchWithRetry429 / computeBackoffMs / sanitizeProviderError → ./provider/http.ts;
// the LM Studio native block → ./provider/lmstudio.ts; the OpenAI-compat wire types
// → ./provider/types.ts. All four are called with `providerDeps`.

// ── MCP progress notifications ───────────────────────────────────────
// Sending progress notifications keeps the client connection alive during
// long-running LLM calls, preventing the default 60s MCP request timeout.
// The progressToken comes from request.params._meta?.progressToken.

// ProgressFn type moved to ./rate-limiter.ts (B1 Phase 2b, TRDD-63314265) —
// imported above; it lives with the rateLimitedParallel executor that consumes it.

function makeProgressFn(
  progressToken: string | number | undefined,
): ProgressFn | undefined {
  if (progressToken === undefined) return undefined;
  return (progress: number, total: number, message?: string) => {
    // Fire-and-forget — progress notifications must never block or throw.
    // T2.MCP-SDK: use mcpServer.server.notification (low-level Server is
    // exposed via the .server property of McpServer for exactly this kind
    // of advanced operation).
    mcpServer.server
      .notification({
        method: "notifications/progress" as const,
        params: {
          progressToken,
          progress,
          total,
          ...(message ? { message } : {}),
        },
      })
      .catch(() => {});
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

// ── Response file output ────────────────────────────────────────────
// LLM responses are saved to timestamped .md files. The default lives
// under `<main-repo-root>/reports/llm-externalizer/` per the
// agent-reports-location rule (hyphen, not underscore — that matches
// the rule's `<component>` slug convention).
//
// Default resolution (highest precedence first):
//   1. LLM_OUTPUT_DIR  — explicit env override; absolute path wins all.
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

let _cachedDefaultOutputDir: string | undefined;

function defaultOutputDir(): string {
  if (_cachedDefaultOutputDir) return _cachedDefaultOutputDir;
  const envOverride = process.env.LLM_OUTPUT_DIR;
  if (envOverride && envOverride.trim()) {
    _cachedDefaultOutputDir = resolve(envOverride.trim());
    return _cachedDefaultOutputDir;
  }
  _cachedDefaultOutputDir = join(resolveProjectMainRoot(), "reports", "llm-externalizer");
  return _cachedDefaultOutputDir;
}

/** Test-only: reset the cached default so a test that sets
 *  CLAUDE_PROJECT_DIR / LLM_OUTPUT_DIR mid-run gets the recomputed value. */
export function _resetDefaultOutputDirCache(): void {
  _cachedDefaultOutputDir = undefined;
}

/** Test-only re-export of the internal helper so default-output-dir.test.ts
 *  can verify the env-override / git-root / fallback chain without
 *  launching the full MCP server. */
export function _testDefaultOutputDir(): string {
  return defaultOutputDir();
}

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
  // <git-root>/reports/llm-externalizer/ default. Issue #5 traced
  // many call sites that silently dropped outputDir — fix is to
  // thread it through every saveResponse() in this file. This
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

function classifyError(error: unknown): {
  unrecoverable: boolean;
  serviceLevel: boolean;
  reason: string;
} {
  const msg = error instanceof Error ? error.message : String(error);
  // Service-level errors — abort the entire batch (retrying won't help)
  // Use specific "API error NNN" pattern to avoid false positives from file paths containing digits
  if (/API error 401\b/.test(msg))
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason: "Authentication failed (invalid API key)",
    };
  if (/API error 402\b/.test(msg)) {
    // Credit exhausted. Flag the session so all subsequent calls go
    // through the free model automatically. This specific call is also
    // retried at the chatCompletionWithRetry layer with FREE_MODEL_ID,
    // so we report it as recoverable here — the caller does not need
    // to abort the batch. The 402 is still surfaced to stderr by the
    // caller, and the free-mode fallback is logged separately.
    creditExhausted = true;
    invalidateBalanceCache();
    engageAutoFree("402 (batch classifier)"); // route later ensemble calls through the free pool
    return {
      unrecoverable: false,
      serviceLevel: false,
      reason: "Payment required (credit exhausted on OpenRouter) — switching to free model",
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
  return { unrecoverable: false, serviceLevel: false, reason: msg };
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
          return { filePath, success: false, error: classified.reason } as FileProcessResult;
        }
        if (attempt < maxRetries) {
          const delayMs = Math.pow(3, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        recentOutcomes.push(false);
        if (recentOutcomes.length >= 3 && recentOutcomes.slice(-3).every((v) => !v)) {
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
  });
  if (files.length === 0) {
    const extInfo = opts?.extensions ? ` with extensions ${opts.extensions.join(", ")}` : "";
    return { files: [], error: `No matching files found in ${folderPath}${extInfo}` };
  }
  return { files };
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
 * profile, OR a paid profile with auto-free engaged (balance under the threshold
 * / a prior 402 — TRDD-542bdbef).
 *
 * Rotation keys off THIS, not off `freeOnly` alone. That was the bug: under
 * auto-free, getEnsembleModels() already served the free pool while the rotation
 * predicate still said "not a free profile", so the fallback list came out empty
 * and the boot log's promise of "rotation on rate-limit" was simply false.
 */
function isFreeModeActive(): boolean {
  return (activeResolved?.freeOnly ?? false) || autoFreeEngaged;
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
  // free_only pins its own pool; every other profile draws on autoFreePool,
  // which is resolved at profile-load time (the profile's free_models, else the
  // bundled FREE_POOL_SEED) and is therefore always populated.
  const pool = activeResolved.freeOnly ? activeResolved.freeModels : autoFreePool;
  const catalogById = new Map(openRouterModelCache.map((cm) => [cm.id, cm]));
  const out: Array<RotationCandidate & { maxInputLines: number }> = [];
  for (const id of filterFreeModels(pool, catalogById, benchmarkFailedModels())) {
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

/** One free-pool call with rotation, for the paths that have no ensemble slots
 *  (a ':free' modelOverride, ensemble:false, or a file too large for every
 *  ensemble primary). Throws AllFreeModelsExhaustedError only after every
 *  approved free model has actually been tried and failed. */
async function callSingleWithFreeRotation(
  primary: RotationCandidate,
  fallbacks: readonly RotationCandidate[],
  messages: ChatMessage[],
  options: Record<string, unknown>,
): Promise<StreamingResult> {
  return callWithFreeRotation<StreamingResult>(
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
      onRotate: (from, _to, detail) =>
        process.stderr.write(
          `[llm-externalizer] Free model ${from} unavailable (${detail.split("\n")[0].slice(0, 120)}) — rotating to the next approved free model.\n`,
        ),
    },
  );
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
  const pool = isFreeModeActive() ? buildFreeRotationPool() : [];
  if (pool.length === 0) {
    return chatCompletionJSON(messages, options, providerDeps);
  }
  return callWithFreeRotation<JSONCompletionResult>(
    pool[0],
    pool.slice(1),
    (model, maxOutput) =>
      chatCompletionJSON(
        messages,
        {
          ...options,
          model,
          maxTokens: Math.min(options.maxTokens ?? maxOutput, maxOutput),
        },
        providerDeps,
      ),
    {
      onRotate: (from, _to, detail) =>
        process.stderr.write(
          `[llm-externalizer] Free model ${from} unavailable (${detail.split("\n")[0].slice(0, 120)}) — rotating to the next approved free model.\n`,
        ),
    },
  );
}

async function ensembleStreaming(
  messages: ChatMessage[],
  options: {
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
  // T2.7 — snapshot once for the type gating below
  const backend = getCurrentBackend();
  const freeMode = isFreeModeActive();

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
    return chatCompletionWithRetry(messages, { ...options, model: options.modelOverride }, providerDeps);
  }

  // Single-model path: ensemble off, not remote-ensemble, or no models configured
  const ensembleModels = getEnsembleModels();
  if (
    !ensemble ||
    backend.type !== "openrouter" ||
    ensembleModels.length === 0
  ) {
    // Free mode ONLY: one model at a time is still ONE model at a time —
    // rotation is failover, not ensembling — so a rate-limited free model hands
    // off to the next approved free one instead of failing the call. A funded
    // profile keeps its own model and its existing backoff.
    const pool = freeMode ? buildFreeRotationPool(fileLineCount) : [];
    if (pool.length > 0) {
      return callSingleWithFreeRotation(pool[0], pool.slice(1), messages, options);
    }
    return chatCompletionWithRetry(messages, options, providerDeps);
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
    return chatCompletionWithRetry(messages, options, providerDeps);
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
    return chatCompletionWithRetry(
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
    );
  }

  // Run all qualifying models in parallel — wait for ALL to finish.
  // The MCP timeout is configured by the user on the Claude Code side.
  const results = await Promise.all(
    models.map(async (m) => {
      const callOne = (model: string, maxOutput: number) =>
        chatCompletionWithRetry(
          messages,
          {
            ...options,
            model,
            maxTokens: Math.min(options.maxTokens ?? maxOutput, maxOutput),
          },
          providerDeps,
        );
      // Free mode: rotate to another approved free model on a rate/daily-limit
      // error — and remember, across calls, which ones are spent.
      if (freeMode) {
        return callEnsembleSlotWithRotation(m, fallbacks, claimFallback, callOne);
      }
      try {
        const resp = await callOne(m.id, m.maxOutput);
        return {
          model: m.id,
          content: resp.content,
          usage: resp.usage,
          truncated: resp.truncated,
          error: false,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          model: m.id,
          content: `ERROR: ${errMsg}`,
          usage: undefined,
          truncated: false,
          error: true,
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
    throw new Error(`All ensemble models failed: ${errorSummary}`);
  }

  // Some models failed — log warning, continue with successful ones
  if (failed.length > 0) {
    for (const f of failed) {
      process.stderr.write(
        `[llm-externalizer] Ensemble model unavailable: ${f.model} — ${f.content}. Continuing with ${succeeded.length} model(s).\n`,
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

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: codeTaskSystemPrompt(lang),
    },
    {
      role: "user",
      content: `${buildPreInstructions(true, "read")}Task: ${task}\n\n${codeBlock}`,
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

  if (resp.content.trim().length === 0) {
    return { filePath, success: false, error: "LLM returned empty response" };
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

// ── MCP Tool definitions ─────────────────────────────────────────────

// Dynamic limits block appended to each task tool description.
// Changes based on which backend is active (local = sequential, OpenRouter = parallel).
function limitsBlock(): string {
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

// Single working free model for the `free: true` per-call flag and the 402
// single-retry (the ensemble paths use the rotating free pool instead).
// Benchmark-validated default (TRDD-f1510055: z-ai/glm-4.5-air scored 100%
// keyword F1 + a security-triage PASS at 0.906; the prior nvidia default
// returned empty content and broke the fallback). Override via
// LLM_EXT_FREE_MODEL_ID; a non-':free' override is rejected (cost-safety).
const FREE_MODEL_ID: string = resolveFreeModelId(
  process.env.LLM_EXT_FREE_MODEL_ID,
);

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
): Promise<{
  model: string;
  content: string;
  usage: StreamingResult["usage"];
  truncated: boolean;
  error: boolean;
}> {
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
        onRotate:
          hooks.onRotate ??
          ((from, _to, detail) =>
            process.stderr.write(
              `[llm-externalizer] Free model ${from} unavailable (${detail.split("\n")[0].slice(0, 120)}) — rotating to the next approved free model.\n`,
            )),
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
      return { model: last, content: `ERROR: ${err.message}`, usage: undefined, truncated: false, error: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { model: primary.id, content: `ERROR: ${msg}`, usage: undefined, truncated: false, error: true };
  }
}

/** Build ensemble model list from the active profile's model + second_model + third_model */
function getEnsembleModels(): Array<{
  id: string;
  maxOutput: number;
  maxInputLines: number;
}> {
  if (!activeResolved || activeResolved.mode !== "remote-ensemble") return [];
  // Read the warm 1h-TTL catalog cache synchronously — empty when cold, in which
  // case resolveEnsembleModelLimits falls back to the calibrated table.
  const catalogById = new Map(openRouterModelCache.map((m) => [m.id, m]));
  let models: string[];
  if (activeResolved.freeOnly || autoFreeEngaged) {
    // Free pool: a free_only profile uses its pinned free_models; auto-free on
    // a paid profile (TRDD-542bdbef, low balance / 402) uses the engaged pool
    // (the profile's free_models if any, else FREE_POOL_SEED). Either way
    // selectFreeEnsembleModels applies the requirements + benchmark filters and
    // takes the top 3; the FULL pool stays as rotation fallbacks downstream.
    const pool = activeResolved.freeOnly
      ? activeResolved.freeModels
      : autoFreePool;
    models = selectFreeEnsembleModels(
      pool,
      catalogById,
      benchmarkFailedModels(),
    );
    // Cost-safety (TRDD-542bdbef): under free mode every ensemble model MUST be
    // ':free'. FREE_POOL_SEED and validated free_models are all ':free', so this
    // only fires on a future regression — fail fast rather than bill.
    const paid = models.filter((id) => !id.endsWith(":free"));
    if (paid.length > 0) {
      throw new Error(
        `free-mode cost-safety: non-':free' model(s) in the free ensemble: ${paid.join(", ")}`,
      );
    }
  } else {
    models = [activeResolved.model];
    if (activeResolved.secondModel) models.push(activeResolved.secondModel);
    if (activeResolved.thirdModel) models.push(activeResolved.thirdModel);
  }
  return models.map((id) => {
    const catalogMaxOutput =
      catalogById.get(id)?.top_provider?.max_completion_tokens;
    const limits = resolveEnsembleModelLimits(id, catalogMaxOutput);
    return { id, ...limits };
  });
}

// ── MCP Server ───────────────────────────────────────────────────────

// T2.MCP-SDK — migrated from `Server` to `McpServer`. McpServer enumerates
// registered tools for ListTools requests; we register each tool (one
// `registerTool` call per tool name) below the dispatch function.
//
// Version is hard-coded here AND in package.json. publish.py's release flow
// keeps them in sync; if you bump one, bump the other in the same commit.
// (A previous release skipped the index.ts side, leaving the MCP server
// advertising 9.5.1 to clients while the plugin manifest reported 9.7.0 —
// see commit history for the consolidation.)
const mcpServer = new McpServer(
  { name: "llm-externalizer", version: "10.3.0" },
  { capabilities: { tools: { listChanged: true } } },
);

// Notify the MCP client that our tool list may have changed (e.g. after
// profile switch). The client will re-call ListTools to get fresh
// descriptions. T2.MCP-SDK: notification() is on the underlying Server.
function notifyToolsChanged(): void {
  // First, update the description of every registered tool so the next
  // ListTools call serves up the current backend's labels (limitsBlock
  // text changes when local→remote or vice versa). Use the .update API
  // exposed by the RegisteredTool returned from registerTool().
  refreshAllToolDescriptions();
  mcpServer.server
    .notification({
      method: "notifications/tools/list_changed" as const,
      params: {},
    })
    .catch(() => {
      /* fire-and-forget — client may not be connected yet */
    });
}

// Wire up the late-bound hook so reloadSettingsFromDisk() triggers tool list refresh
_onSettingsReloaded = notifyToolsChanged;

// ── JSON Schema → Zod converter ──────────────────────────────────────
// T2.MCP-SDK — McpServer.registerTool only accepts Zod schemas. Our
// buildTools() returns plain JSON Schema for backward compatibility with
// the existing wire format. This converter handles ONLY the subset of
// JSON Schema we actually use: primitives (string/number/boolean), array
// of strings, object with properties + required, and `oneOf` unions of
// (string | string[]). Anything outside this subset returns z.unknown()
// so the SDK still accepts the value (validation is then deferred to
// the tool handler itself, which always validated inputs anyway).

interface JsonSchemaSubset {
  type?: string;
  description?: string;
  items?: JsonSchemaSubset;
  properties?: Record<string, JsonSchemaSubset>;
  required?: string[];
  oneOf?: JsonSchemaSubset[];
}

function jsonSchemaPropToZod(s: JsonSchemaSubset): z.ZodType {
  // Handle oneOf: [{type:"string"}, {type:"array", items:{type:"string"}}]
  // → z.union([z.string(), z.array(z.string())])
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const variants = s.oneOf.map((v) => jsonSchemaPropToZod(v));
    if (variants.length === 1) {
      return s.description ? variants[0].describe(s.description) : variants[0];
    }
    // z.union requires at least 2 variants
    const u = z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    return s.description ? u.describe(s.description) : u;
  }
  let base: z.ZodType;
  switch (s.type) {
    case "string":
      base = z.string();
      break;
    case "number":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "array":
      base = z.array(s.items ? jsonSchemaPropToZod(s.items) : z.unknown());
      break;
    case "object":
      if (s.properties) {
        base = jsonSchemaToZod(s);
      } else {
        base = z.record(z.string(), z.unknown());
      }
      break;
    default:
      base = z.unknown();
  }
  return s.description ? base.describe(s.description) : base;
}

/**
 * Convert a JSON-Schema object (the kind buildTools() returns) into a
 * Zod object schema. The returned schema is the COMPLETE input shape:
 * every required field is required, every non-required field is optional.
 */
function jsonSchemaToZod(
  s: JsonSchemaSubset,
): z.ZodObject<Record<string, z.ZodType>> {
  if (!s.properties) return z.object({});
  const required = new Set(s.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(s.properties)) {
    const zodProp = jsonSchemaPropToZod(prop);
    shape[key] = required.has(key) ? zodProp : zodProp.optional();
  }
  return z.object(shape);
}

// ── Registered tools registry ────────────────────────────────────────
// T2.MCP-SDK — keep a handle to every RegisteredTool we install so we
// can refresh their descriptions on settings reload (the backend label
// and parallel/sequential note in limitsBlock() change when local→remote
// switches happen). The SDK's `.update({description})` triggers the
// tools/list_changed notification automatically.
interface RegisteredToolHandle {
  update(updates: { description?: string; enabled?: boolean }): void;
}
const registeredToolHandles = new Map<string, RegisteredToolHandle>();

function refreshAllToolDescriptions(): void {
  // Rebuild every tool's description from buildTools(). Only descriptions
  // are dynamic — names and inputSchema are static at registration time.
  const fresh = buildTools(limitsBlock());
  for (const t of fresh) {
    const handle = registeredToolHandles.get(t.name);
    if (handle) {
      try { handle.update({ description: t.description }); } catch { /* best effort */ }
    }
  }
}

/**
 * Dispatch a call to one of our tools. This is the body that used to live
 * inside `setRequestHandler(CallToolRequestSchema, …)` — split out so
 * each `registerTool` callback can route into the same logic.
 *
 * `extra` is the SDK's RequestHandlerExtra; we only need its `_meta`.
 */
interface DispatchExtra { _meta?: { progressToken?: string | number } }

/**
 * Public entry — installs a per-invocation usage-history context (tool name +
 * compact redacted param summary + project dir + a fresh op-id) for the whole
 * call, then delegates to the real dispatcher. Every `recordRequest()` fired by
 * an LLM web request inside this call inherits this context and shares its
 * op-id, so all of one invocation's request lines correlate. This wrapper sets
 * context ONLY — it never writes a history line itself (the user wants one line
 * per web request, not per invocation).
 */
async function dispatchCallTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  extra: DispatchExtra,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean; [k: string]: unknown }> {
  return withUsageContext(
    { tool: name, params: summarizeParams(rawArgs) },
    () => dispatchCallToolInner(name, rawArgs, extra),
  );
}

async function dispatchCallToolInner(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  extra: DispatchExtra,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean; [k: string]: unknown }> {
  const args = rawArgs;
  // Extract progress token — if the client supports it, we send periodic
  // progress notifications to keep the connection alive during long LLM calls.
  const progressToken = extra._meta?.progressToken;
  const onProgress = makeProgressFn(progressToken);

  try {
    // Gate all tools except discover, reset, get_settings behind settings validation.
    // If settings.yaml is missing or misconfigured, the user must fix it by
    // editing the YAML file manually.
    if (
      !settingsValid &&
      name !== "discover" &&
      name !== "reset" &&
      name !== "get_settings"
    ) {
      return {
        content: [
          {
            type: "text",
            text: `NOT CONFIGURED\n\n${settingsError}\n\nQuick fix: edit ${SETTINGS_FILE} manually in your editor, then call the "reset" tool (or restart Claude Code).\nRun the "discover" tool to see the current profile status.`,
          },
        ],
        isError: true,
      };
    }

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
      await ensureAutoFreeDecided();
      const freeActive = (activeResolved?.freeOnly ?? false) || autoFreeEngaged;
      const freePool = activeResolved?.freeOnly
        ? activeResolved.freeModels
        : autoFreePool;
      const inject = resolveSubsystemFreeModel(
        freeActive,
        freePool,
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
    // resolveModelOverride handles: explicit free=true, credit-exhausted
    // session flag, and pre-flight balance check. If the OpenRouter balance
    // drops below MIN_BALANCE_FOR_PAID_USD, this tool call (and all later
    // ones in the session) will automatically route through FREE_MODEL_ID
    // instead of the paid ensemble. Never throws — always returns something.
    const freeRequested = (args as Record<string, unknown>)?.free === true;
    const modelOverride = await resolveModelOverride(freeRequested);
    if (modelOverride) {
      process.stderr.write(
        `[llm-externalizer] Routing through ${modelOverride}${freeRequested ? " (free requested)" : " (auto-fallback)"}\n`,
      );
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
          if (resp.content.trim().length === 0) {
            return {
              content: [
                { type: "text", text: "FAILED: LLM returned empty response." },
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
            if (resp.content.trim().length > 0) {
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

        parts.push(`Active profile: ${activeResolved.name}`);
        parts.push(`Mode: ${activeResolved.mode}`);
        parts.push(`Model: ${activeResolved.model}`);
        if (activeResolved.secondModel) {
          parts.push(`Second model: ${activeResolved.secondModel}`);
        }
        if (activeResolved.thirdModel) {
          parts.push(`Third model: ${activeResolved.thirdModel}`);
        }
        // Show auth status so agents can verify the token is available
        const authSource = (() => {
          const preset =
            API_PRESETS[activeSettings.profiles[activeSettings.active]?.api];
          const profile = activeSettings.profiles[activeSettings.active];
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
        const beforeProfile = activeSettings.active;
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

        // 3. Reset session counters
        session.calls = 0;
        session.promptTokens = 0;
        session.completionTokens = 0;
        session.totalCost = 0;
        writeStatsFile();

        // 4. Notify client to refresh tool list
        notifyToolsChanged();

        // Snapshot the post-reload backend ONCE for the summary string —
        // reads of multiple fields across multiple async-safe lines.
        const afterProfile = activeSettings.active;
        const afterBackend = getCurrentBackend();
        const afterModel = afterBackend.model;
        const profileChanged = beforeProfile !== afterProfile || beforeModel !== afterModel;
        const summary = [
          "RESET COMPLETE",
          `Profile: ${afterProfile} (${afterBackend.type}, ${afterBackend.model})`,
          profileChanged ? `Changed from: ${beforeProfile} / ${beforeModel}` : "Profile unchanged",
          "Caches cleared: model list, concurrency, LM Studio detection",
          "Session counters reset to zero",
          "Tool list refresh sent to client",
        ];

        return {
          content: [{ type: "text", text: summary.join("\n") }],
        };
      }

      case "get_settings": {
        // Copy settings.yaml to output dir and return only the path (saves context tokens).
        // Per-call output_dir honored; otherwise default to <git-root>/reports/llm-externalizer/.
        try {
          const raw = readFileSync(SETTINGS_FILE, "utf-8");
          const targetDir = outputDir || defaultOutputDir();
          mkdirSync(targetDir, { recursive: true });
          const copyPath = join(targetDir, "settings_edit.yaml");
          writeFileSync(copyPath, raw, "utf-8");
          return { content: [{ type: "text", text: copyPath }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to read ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
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
              recentOutcomes.push(false);
              // Check if last 3 completions are all failures
              if (
                recentOutcomes.length >= 3 &&
                recentOutcomes.slice(-3).every((v) => !v)
              ) {
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
        const hqRefusal = highQualityScanRefusal(
          backend.type,
          activeResolved?.freeOnly ?? false,
          creditExhausted,
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
            { role: "system", content: "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary. Group related changes. Note potential issues. Identify code by FUNCTION/CLASS/METHOD NAME, never by line number." + FILE_FORMAT_EXAMPLE + BREVITY_RULES },
            { role: "user", content: `${prompt ? prompt + "\n\n" : ""}Compare:\n- Before: ${fA}\n- After: ${fB}\n\nDiff:\n${fence}\n${diffOutput}\n${fence}${sourceBlocks}` },
          ];
          let resp;
          try {
            resp = await ensembleStreaming(msgs, { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride }, cfUseEnsemble);
          } catch (err) {
            return { error: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
          }
          if (!resp.content.trim()) return { error: "LLM returned empty response" };
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
            content:
              "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary of all changes. " +
              "Group related changes. Note any potential issues, regressions, or improvements.\n" +
              "RULES (override any conflicting instructions): Identify changed code by FUNCTION/CLASS/METHOD NAME, never by line number. " +
              "Reference files by their full path as labeled in the user message." +
              FILE_FORMAT_EXAMPLE + BREVITY_RULES,
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
        if (!cfResp.content.trim()) {
          return {
            content: [
              { type: "text", text: "FAILED: LLM returned empty response." },
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
              if (resp.content.trim()) {
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

          if (crResp.content.trim()) {
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
              const extractMessages: ChatMessage[] = [
                { role: "system", content: `Expert ${ciLang} developer. Extract ALL file path references and import statements from the source code. The source file is labeled with its full path inside a filename tag before the file-content tag — reference it by that path. Include: import/require paths, file path strings, configuration references. Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. Include both local (relative) and package imports. Be exhaustive.` + FILE_FORMAT_EXAMPLE },
                { role: "user", content: `${ciPrompt ? ciPrompt + "\n\n" : ""}Extract all import and file references from:\n\n${readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact)}` },
              ];
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
          const extractMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                `Expert ${ciLang} developer. Extract ALL file path references and import statements from the source code. ` +
                "The source file is labeled with its full path inside a filename tag before the file-content tag — reference it by that path. " +
                "Include: import/require paths, file path strings, configuration references. " +
                'Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. ' +
                "Include both local (relative) and package imports. Be exhaustive." +
                FILE_FORMAT_EXAMPLE,
            },
            {
              role: "user",
              content:
                `${ciPrompt ? ciPrompt + "\n\n" : ""}Extract all import and file references from:\n\n` +
                readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact),
            },
          ];

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
        // Wire the existing chatCompletionWithRetry as the rawLlmCall so
        // the cluster orchestrator inherits rate-limiting / retry /
        // model-fallback logic from the rest of the server.
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
              : await chatCompletionWithRetry(messages, csCallOpts, providerDeps);
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
    return {
      content: [{ type: "text", text: `Error: ${errMsg}` }],
      isError: true,
    };
  }
}

// ── Tool registration loop (T2.MCP-SDK) ──────────────────────────────
// Iterate over every tool definition from buildTools() AND every
// mass-scouting tool, and register each one with the McpServer. The
// SDK handles ListTools serving + per-call CallTool routing for us.
// Every callback delegates into the shared dispatchCallTool() above so
// the existing switch logic is preserved verbatim.
//
// We snapshot the descriptions at startup; refreshAllToolDescriptions()
// updates them on every settings reload (the limitsBlock() text depends
// on the current backend type).
{
  const initialTools = buildTools(limitsBlock());
  for (const def of initialTools) {
    const toolName = def.name;
    let inputZod: z.ZodTypeAny;
    try {
      inputZod = jsonSchemaToZod(
        (def as { inputSchema?: JsonSchemaSubset }).inputSchema ?? { type: "object" },
      );
    } catch {
      // Fallback: accept any object. The handler does its own validation.
      // Zod 4: `z.object({}).passthrough()` is deprecated; use `z.looseObject({})`.
      inputZod = z.looseObject({});
    }
    const handle = mcpServer.registerTool(
      toolName,
      {
        description: def.description,
        inputSchema: (inputZod as unknown as { shape: Record<string, z.ZodType> }).shape ?? {},
      },
      async (args: unknown, extra: { _meta?: { progressToken?: string | number } }) => {
        return dispatchCallTool(
          toolName,
          (args ?? {}) as Record<string, unknown>,
          extra,
        );
      },
    );
    // Stash the handle so refreshAllToolDescriptions can update it later.
    registeredToolHandles.set(toolName, handle as unknown as RegisteredToolHandle);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  // Write initial stats file at startup so statusline can show MCP icons immediately
  writeStatsFile();
  // Install/update the plugin's usage rule into ~/.claude/rules/ (the MCP server
  // subprocess can write there even when the agent's hooks forbid writes outside
  // the project). Best-effort + content-gated: never blocks boot, no churn after
  // the first sync. Opt out with LLM_EXT_INSTALL_RULE=0.
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
  // T2.7 — snapshot for the banner. Strictly defense in depth (main runs once
  // at startup, before any reload can race).
  const bootBackend = getCurrentBackend();
  const backendLabel =
    bootBackend.type === "openrouter"
      ? `OpenRouter (${bootBackend.model})`
      : `Local (${bootBackend.baseUrl}${bootBackend.model ? `, ${bootBackend.model}` : ""})`;
  process.stderr.write(
    `LLM Externalizer server running — backend: ${backendLabel}\n`,
  );
  process.stderr.write(`Settings: ${SETTINGS_FILE}\n`);
  process.stderr.write(`Session log: ${LOG_FILE}\n`);
}

// Boot ONLY when this module is the process entry point. Importing it (tests
// that pull _testDefaultOutputDir / _resetDefaultOutputDirCache, or any future
// consumer) must NEVER boot the server or contact a backend — cost-safety
// (TRDD-e82f2c49). The spawned `node dist/index.js` MCP server still boots
// because there argv[1] === this module's path.
const __isEntrypoint = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileUrlToPath_cs(import.meta.url));
  } catch {
    return false;
  }
})();

if (__isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`Fatal error: ${error}\n`);
    process.exit(1);
  });
}
