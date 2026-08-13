/**
 * Profile-based configuration for the LLM Externalizer MCP server.
 *
 * Single source of truth for settings.yaml loading, validation,
 * and resolution. Used by the server (index.ts), CLI (cli.ts), and tests.
 *
 * Settings file: ~/.llm-externalizer/settings.yaml
 *
 * Cross-platform: uses os.homedir() + path.join() for all paths.
 * Works on macOS, Linux, and Windows WSL.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse, Document as YamlDocument, isScalar } from "yaml";
import { registeredTools } from "./model-qualification/registry.js";

// ── Types ────────────────────────────────────────────────────────────

export type ApiProtocol = "lmstudio_api" | "openai_api" | "openrouter_api";
export type Mode = "local" | "remote" | "remote-ensemble";

export interface ApiPreset {
  /** Underlying API protocol */
  protocol: ApiProtocol;
  /** Default server URL (empty = user must set explicitly) */
  defaultUrl: string;
  /** Default env var for auth (e.g. '$LM_API_TOKEN'), empty = no auth */
  defaultAuthEnv: string;
  /** Default request timeout in seconds */
  defaultTimeout: number;
  /** Default app name (OpenRouter dashboard) */
  defaultAppName: string;
  /** Default HTTP referer (OpenRouter analytics) */
  defaultHttpReferer: string;
  /** Default context window override (0 = auto-detect) */
  defaultContextWindow: number;
  /** true for local backends, false for remote */
  isLocal: boolean;
}

export interface Profile {
  mode: Mode;
  /** API preset name from API_PRESETS */
  api: string;
  /** Model identifier */
  model: string;
  /** Override preset default URL */
  url?: string;
  /** API key — env var ref ($VAR_NAME) or direct value */
  api_key?: string;
  /** Auth token for local servers — env var ref ($VAR_NAME) or direct value */
  api_token?: string;
  /** Second model for remote-ensemble mode */
  second_model?: string;
  /** Third model for remote-ensemble mode (optional) */
  third_model?: string;
  /**
   * Free-only switch (TRDD-8b6b3646). When true, this profile uses ONLY the
   * `free_models` pool — `model` / `second_model` / `third_model` are ignored.
   * The top free models (benchmark-filtered) form the ensemble; the rest are the
   * rate-limit fallback pool. EVERY `free_models` entry MUST end with `:free`
   * (validateProfile enforces this) so the profile can never bill.
   */
  free_only?: boolean;
  /** Free-model pool for `free_only`, in preference order (all must be `:free`). */
  free_models?: string[];
  /**
   * Optional per-tool model overrides (TRDD-f45eeaa0). Keyed by LLM-using tool
   * name (must be one of model-qualification/registry's registeredTools()). When
   * a tool has an entry here, that model is used for the tool instead of this
   * profile's `model`; when absent, the tool falls back to its own default
   * (back-compat). A model assigned here SHOULD pass that tool's benchmark —
   * see resolveModelForTool() and the security-triage benchmark.
   */
  tool_models?: Record<string, string>;
  /**
   * Optional high-quality-scan model config (TRDD-DBUSM55E). Absent → built-in
   * defaults (GLM 5.2 @ xhigh reasoning, cache on, fp8+ quant, GMICloud). The
   * `high_quality_scan` tool reads this to run ONE strong model instead of the
   * cheap 3-model ensemble. See HighQualityModel.
   */
  high_quality_model?: HighQualityModel;
  /** Request timeout in seconds */
  timeout?: number;
  /** Context window override (0 = auto-detect) */
  context_window?: number;
  /** App name for OpenRouter dashboard */
  app_name?: string;
  /** HTTP Referer for OpenRouter analytics */
  http_referer?: string;
}

export interface Settings {
  /** Active profile name */
  active: string;
  /** Named profiles */
  profiles: Record<string, Profile>;
  /**
   * Override for the `ensemble` default profile's price ceiling (USD per
   * million tokens, applied to BOTH input and output). Absent/invalid ⟹
   * DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M. See getEnsemblePriceCeiling().
   */
  ensemble_price_ceiling_usd_per_million?: number;
  /**
   * Master paid-spend switch (USER directive, this session). DEFAULT false —
   * "only free models are viable, everything runs free by default". While false,
   * every remote (OpenRouter) profile is FORCED to free mode at boot regardless of
   * its configured `model` fields, and paid *benchmarks* are refused too — one
   * switch governs every kind of paid spend. Set true to restore paid sends +
   * paid benchmarks (per-profile `free_only` then remains an opt-in). Absent ⟺
   * false, so a settings file that never heard of this key is safely free.
   */
  allow_paid_models?: boolean;
}

/** Fully resolved profile with concrete values (no env var refs) */
export interface ResolvedProfile {
  name: string;
  mode: Mode;
  protocol: ApiProtocol;
  url: string;
  model: string;
  authToken: string;
  secondModel: string;
  thirdModel: string;
  /** Free-only mode active (TRDD-8b6b3646). When true, freeModels is the source of truth. */
  freeOnly: boolean;
  /** Free-model pool in preference order (empty unless freeOnly). All entries end `:free`. */
  freeModels: string[];
  /** Per-tool model overrides (empty object when none). See resolveModelForTool. */
  toolModels: Record<string, string>;
  timeout: number;
  contextWindow: number;
  appName: string;
  httpReferer: string;
  /** Resolved high-quality-scan model config (TRDD-DBUSM55E; defaults filled). */
  highQualityModel: ResolvedHighQualityModel;
}

/**
 * Optional per-profile "high-quality model" config (TRDD-DBUSM55E). Drives the
 * `high_quality_scan` tool: ONE strong model run at max reasoning instead of the
 * cheap 3-model ensemble, with deterministic OpenRouter provider/quantization
 * routing and prompt caching. Every sub-field is optional — an absent block (or
 * absent field) falls back to HIGH_QUALITY_MODEL_DEFAULTS, so `high_quality_scan`
 * works out-of-the-box on any OpenRouter profile.
 */
export interface HighQualityModel {
  /** OpenRouter model id. Default "z-ai/glm-5.2". */
  id?: string;
  /**
   * Reasoning effort: off|low|medium|high|xhigh|max. "max" is an alias for the
   * real OpenRouter ceiling "xhigh" (there is no literal "max" wire value).
   * Default "max".
   */
  reasoning_effort?: string;
  /** Enable prompt caching (cache_control breakpoint on the system prompt). Default true. */
  cache?: boolean;
  /**
   * Minimum acceptable quantization, expanded to "this precision or higher" for
   * OpenRouter's provider.quantizations filter. Default "fp8".
   */
  min_quantization?: string;
  /**
   * Preferred OpenRouter provider slug (may carry a quant variant suffix, e.g.
   * "gmicloud/fp8"), used as provider.order[0]. Default "gmicloud/fp8".
   */
  provider?: string;
  /**
   * Allow OpenRouter to fall back to other providers if the preferred one is
   * unavailable. Default false (pin the preferred provider).
   */
  allow_fallbacks?: boolean;
}

/**
 * Fully resolved high-quality-model config: defaults filled, "max"→"xhigh",
 * min_quantization expanded to the fp8-or-higher whitelist. Always present on a
 * ResolvedProfile (resolveHighQualityModel never returns null).
 */
export interface ResolvedHighQualityModel {
  id: string;
  /** One of off|xhigh|high|medium|low (the "max" alias already mapped to xhigh). */
  reasoningEffort: string;
  cache: boolean;
  /** OpenRouter provider.order list (the preferred provider slug). */
  providerOrder: string[];
  /** OpenRouter provider.quantizations whitelist (min_quantization expanded). */
  quantizations: string[];
  /** OpenRouter provider.allow_fallbacks. */
  allowFallbacks: boolean;
}

// ── High-quality model constants (TRDD-DBUSM55E) ────────────────────────────
// Quantization precision tiers, low → high. "fp8 or higher" = fp8 and every tier
// to its right. "unknown" is intentionally excluded (we want a KNOWN high-precision
// endpoint). Mirrors OpenRouter's provider.quantizations values.
const QUANT_TIERS: readonly string[] = Object.freeze([
  "int4",
  "fp4",
  "int8",
  "fp6",
  "fp8",
  "fp16",
  "bf16",
  "fp32",
]);

/** Built-in defaults for the high-quality scan model (the spec asked for). */
export const HIGH_QUALITY_MODEL_DEFAULTS: ResolvedHighQualityModel = {
  id: "z-ai/glm-5.2",
  reasoningEffort: "xhigh", // "max" maps here — the real OpenRouter ceiling
  cache: true,
  providerOrder: ["gmicloud/fp8"],
  quantizations: ["fp8", "fp16", "bf16", "fp32"], // fp8-or-higher
  allowFallbacks: false,
};

/** Accepted reasoning_effort tokens in YAML ("max" is an alias for "xhigh"). */
const VALID_HQ_REASONING: ReadonlySet<string> = new Set([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Ready-to-apply high-quality-scan request knobs, derived from a
 * ResolvedHighQualityModel at the high_quality_scan dispatch site and threaded
 * down the single-model scan path (ScanFolderDeps → processFileCheck →
 * ensembleStreaming → chatCompletionSimple). Defined in this leaf module so both
 * index.ts and scan-folder/core.ts can share ONE type (core.ts must not import
 * from index.ts). All fields optional → a no-op for every non-high_quality_scan
 * caller. `provider` is the OpenRouter provider-routing block (a control field
 * that survives the supported-params filter); `reasoning` is the wire effort
 * string ("xhigh" etc., cast to the effort union inside index.ts); `cache`
 * toggles the system-prompt cache_control breakpoint.
 */
export interface HighQualityRequest {
  provider?: Record<string, unknown>;
  reasoning?: string;
  cache?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── API Presets ──────────────────────────────────────────────────────
// Each preset bundles protocol + default connection settings.
// Names use -local / -remote suffix to prevent mode/preset mismatches.

export const API_PRESETS: Record<string, ApiPreset> = {
  // ── Local presets ─────────────────────────────────────────────────
  "lmstudio-local": {
    protocol: "lmstudio_api",
    defaultUrl: "http://localhost:1234",
    defaultAuthEnv: "$LM_API_TOKEN",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "ollama-local": {
    protocol: "openai_api",
    defaultUrl: "http://localhost:11434",
    defaultAuthEnv: "",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "vllm-local": {
    protocol: "openai_api",
    defaultUrl: "http://localhost:8000",
    defaultAuthEnv: "$VLLM_API_KEY",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "llamacpp-local": {
    protocol: "openai_api",
    defaultUrl: "http://localhost:8080",
    defaultAuthEnv: "",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  "generic-local": {
    protocol: "openai_api",
    defaultUrl: "",
    defaultAuthEnv: "$LM_API_TOKEN",
    defaultTimeout: 300,

    defaultAppName: "",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: true,
  },
  // ── Remote presets ────────────────────────────────────────────────
  "openrouter-remote": {
    protocol: "openrouter_api",
    defaultUrl: "https://openrouter.ai/api",
    defaultAuthEnv: "$OPENROUTER_API_KEY",
    defaultTimeout: 600, // 10 min — reasoning models (Qwen, etc.) need extended thinking time

    defaultAppName: "llm-externalizer",
    defaultHttpReferer: "",
    defaultContextWindow: 0,
    isLocal: false,
  },
};

// ── Paths ────────────────────────────────────────────────────────────
// Cross-platform: homedir() + join() works on macOS, Linux, Windows WSL.

/** Config directory: ~/.llm-externalizer (or LLM_EXT_CONFIG_DIR for CI) */
export function getConfigDir(): string {
  const raw = resolve(process.env.LLM_EXT_CONFIG_DIR || join(homedir(), ".llm-externalizer"));
  // Resolve symlinks in the deepest existing ancestor so that a symlink like
  // $HOME/.evil -> /etc is followed even when the full path doesn't exist yet.
  // Without this, mkdirSync(dir, { recursive: true }) follows symlinks in the
  // existing prefix while the guard sees only the unresolved string, allowing
  // directory creation outside allowed paths.
  function resolveDeepestExisting(p: string): string {
    try { return realpathSync(p); } catch { /* p doesn't exist */ }
    const parent = join(p, "..");
    if (parent === p) return p; // filesystem root
    const resolvedParent = resolveDeepestExisting(parent);
    return join(resolvedParent, p.slice(parent.length + (parent.endsWith("/") || parent.endsWith("\\") ? 0 : 1)));
  }
  const dir = resolveDeepestExisting(raw);
  // M8: Path traversal guard — config dir must be under homedir() or /tmp.
  // Resolve home and /tmp through symlinks so the comparison uses canonical paths
  // (e.g. /tmp → /private/tmp on macOS; homedir() may also be a symlink).
  const home = (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })();
  const tmpCanonical = (() => { try { return realpathSync("/tmp"); } catch { return "/tmp"; } })();
  const sep = process.platform === "win32" ? "\\" : "/";
  const underHome = dir.startsWith(home + sep) || dir === home;
  const underTmp = dir.startsWith(tmpCanonical + sep) || dir === tmpCanonical;
  if (!underHome && !underTmp) {
    throw new Error(`Config directory '${dir}' is outside allowed paths (${home} or ${tmpCanonical})`);
  }
  return dir;
}

/** Settings file: ~/.llm-externalizer/settings.yaml */
export function getSettingsPath(): string {
  return join(getConfigDir(), "settings.yaml");
}

// ── Env var resolution ──────────────────────────────────────────────

// Map of env-var names that have a corresponding plugin.json userConfig key.
// When the user sets a value via the Claude Code plugin config UI, Claude
// exports it as CLAUDE_PLUGIN_OPTION_<KEY> to this subprocess. We transparently
// map that into the canonical env-var name the rest of the code reads from,
// so both new (userConfig) and old (shell env var) setups work unchanged.
// Preference: userConfig wins over shell env if both are set.
const USER_CONFIG_ENV_MAP: Record<string, string> = {
  OPENROUTER_API_KEY: "CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY",
};

/**
 * Resolve a value that may be an env var reference.
 * - Values starting with '$' are env var names → resolved from process.env
 * - All other values are direct values → returned as-is
 * - Empty/undefined → returns ''
 *
 * For env vars in USER_CONFIG_ENV_MAP, the corresponding CLAUDE_PLUGIN_OPTION_*
 * var takes precedence if non-empty. This means plugin.json userConfig values
 * override shell env vars — users can migrate to userConfig without changing
 * anything else in their setup.
 */
export function resolveEnvValue(value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("$")) {
    // M9: Trim env var name to prevent whitespace injection (e.g. "$VAR_NAME ")
    const name = value.slice(1).trim();
    const userConfigVar = USER_CONFIG_ENV_MAP[name];
    if (userConfigVar) {
      const userConfigVal = process.env[userConfigVar];
      if (userConfigVal && userConfigVal.length > 0) return userConfigVal;
    }
    return process.env[name] || "";
  }
  return value;
}

// ── URL validation ──────────────────────────────────────────────────

const LOCAL_URL_PATTERN =
  /\/\/localhost([:/]|$)|\/\/127\.\d+\.\d+\.\d+|\/\/192\.168\.\d+\.\d+|\/\/10\.\d+\.\d+\.\d+|\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\/\/\[::1\]|\/\/0\.0\.0\.0/i;

/** Check if a URL points to a local/private network address */
export function isLocalUrl(url: string): boolean {
  return LOCAL_URL_PATTERN.test(url);
}

// ── Settings load / save ────────────────────────────────────────────

/**
 * Load settings.yaml from the config directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadSettings(): Settings | null {
  const settingsPath = getSettingsPath();
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = readFileSync(settingsPath, "utf-8");
    // H10: Sanitize YAML output to strip __proto__ and prevent prototype pollution
    const parsed = JSON.parse(JSON.stringify(yamlParse(raw)));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      active: parsed.active || "",
      profiles: parsed.profiles || {},
      // Absent / any non-true value ⟺ false: the safe (free) side. A YAML that
      // predates this key, or sets it to a typo, never accidentally enables paid.
      allow_paid_models: parsed.allow_paid_models === true,
      // Absent / non-finite / non-positive ⟹ undefined, so getEnsemblePriceCeiling()
      // falls back to the built-in default instead of silently accepting a bad value.
      ensemble_price_ceiling_usd_per_million:
        typeof parsed.ensemble_price_ceiling_usd_per_million === "number" &&
        isFinite(parsed.ensemble_price_ceiling_usd_per_million) &&
        parsed.ensemble_price_ceiling_usd_per_million > 0
          ? parsed.ensemble_price_ceiling_usd_per_million
          : undefined,
    };
  } catch (err) {
    process.stderr.write(
      `[llm-externalizer] Warning: Failed to read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

// ── Dynamic default profiles (owner directive) ──────────────────────────────
//
// Three profiles are MACHINE-OWNED: `free`, `ensemble`, `mass-scout`. Unlike
// every other profile (hand-written by the user or the setup-wizard agent),
// these carry NO predefined model ids — they are populated and kept current by
// the scan/benchmark/compare procedure (src/benchmark/update-all.ts +
// src/benchmark/pick.ts's applyFreePoolToSettings / applyPicksToSettings /
// applyEnsembleSlotToSettings writers, each of which touches ONLY the named
// profile it is given — see pick.ts's "ownership invariant" note).
//
//   free        — the passing free ('*:free') pool, $0.
//   ensemble    — top 3 models with BOTH input and output price strictly under
//                 DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M (override via the
//                 top-level `ensemble_price_ceiling_usd_per_million` key).
//   mass-scout  — the single best ultra-low-cost, small-input-accurate model
//                 for mass-scouting; NEVER a ':free' id (thousands of requests
//                 would rate-limit a free model — enforced in pick.ts's
//                 pickMassScoutModel and again in updateMassScoutDefaultProfile).
export const DEFAULT_PROFILE_NAMES = ["free", "ensemble", "mass-scout"] as const;
export type DefaultProfileName = (typeof DEFAULT_PROFILE_NAMES)[number];

/** True iff `name` is one of the three machine-owned default profiles. */
export function isDefaultProfileName(name: string): name is DefaultProfileName {
  return (DEFAULT_PROFILE_NAMES as readonly string[]).includes(name);
}

/** Ensemble profile price ceiling (USD / million tokens, input AND output),
 *  overridable via `ensemble_price_ceiling_usd_per_million`. Single source of
 *  truth — never hardcode 1.3 elsewhere. */
export const DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M = 1.3;

/** Resolve the effective ensemble price ceiling: the settings override when
 *  present and valid (loadSettings() already rejects non-finite/non-positive
 *  values to undefined), else the built-in default. */
export function getEnsemblePriceCeiling(settings: Settings | null | undefined): number {
  const raw = settings?.ensemble_price_ceiling_usd_per_million;
  return typeof raw === "number" && isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M;
}

/**
 * Sentinel model id marking an unpopulated default-profile PLACEHOLDER. Never
 * a real OpenRouter model id (deliberately unroutable), so a placeholder that
 * somehow reached the wire would 404 rather than silently bill or mis-route.
 */
export const PLACEHOLDER_MODEL_ID = "placeholder/unpopulated-default-profile";

/**
 * True iff `profile` is a not-yet-populated default-profile placeholder.
 *
 * The signal differs by profile SHAPE, and that is load-bearing:
 *  - free_only  → an EMPTY free_models pool. Its models live in the pool, and
 *    applyFreePoolToSettings (the writer that populates it) never touches
 *    `model`. Keying on the sentinel id here would leave `free` looking
 *    unpopulated forever and re-run its benchmark on every single command.
 *  - everything else → `model` is the unroutable sentinel, which the slot
 *    writers (applyPicksToSettings / applyEnsembleSlotToSettings) DO overwrite.
 */
export function isPlaceholderProfile(profile: Profile): boolean {
  if (profile.free_only === true) {
    // A MALFORMED free_models (a YAML scalar where a list belongs) is a broken
    // profile, not an empty one — coerceFreeModels flattens it to [], so
    // treating "coerces to empty" as "placeholder" would silently reclassify a
    // user's typo as "not benchmarked yet", swallow the "must be a YAML list"
    // error, and quietly overwrite their line with benchmark output.
    if (profile.free_models !== undefined && !Array.isArray(profile.free_models)) {
      return false;
    }
    return coerceFreeModels(profile.free_models).length === 0;
  }
  return profile.model === PLACEHOLDER_MODEL_ID;
}

/**
 * True iff this is a MACHINE-OWNED default profile that simply has not been
 * benchmarked yet — the one case where an "invalid" profile is expected and
 * self-healing rather than a user error.
 *
 * The name check is load-bearing: an arbitrary user profile with an empty
 * free_models list is a genuine misconfiguration and must keep failing
 * validation. Only free/ensemble/mass-scout populate themselves.
 */
export function isUnpopulatedDefaultProfile(name: string, profile: Profile): boolean {
  return isDefaultProfileName(name) && isPlaceholderProfile(profile);
}

function placeholderFreeProfile(): Profile {
  return {
    mode: "remote-ensemble",
    api: "openrouter-remote",
    free_only: true,
    free_models: [],
    // Ignored at runtime — resolveProfile's free_only branch overrides `model`
    // from free_models[0]. Present because the field is required, and the
    // unroutable sentinel is the only honest value for an unpopulated slot.
    model: PLACEHOLDER_MODEL_ID,
    api_key: "$OPENROUTER_API_KEY",
  };
}

function placeholderEnsembleProfile(): Profile {
  return {
    mode: "remote-ensemble",
    api: "openrouter-remote",
    model: PLACEHOLDER_MODEL_ID,
    second_model: PLACEHOLDER_MODEL_ID,
    third_model: PLACEHOLDER_MODEL_ID,
    api_key: "$OPENROUTER_API_KEY",
  };
}

function placeholderMassScoutProfile(): Profile {
  return {
    mode: "remote",
    api: "openrouter-remote",
    model: PLACEHOLDER_MODEL_ID,
    api_key: "$OPENROUTER_API_KEY",
  };
}

/** Default settings: the 3 dynamic, machine-owned default profiles, each an
 *  unpopulated PLACEHOLDER (see isPlaceholderProfile). The scan/benchmark/
 *  compare procedure (update-all.ts) populates them; nothing here hardcodes a
 *  model id. These placeholders do NOT pass validateProfile — an empty pool
 *  genuinely cannot serve a request — so the boot path must recognise them via
 *  isUnpopulatedDefaultProfile() and route them to population rather than to a
 *  misconfiguration error. */
export function generateDefaultSettings(): Settings {
  return {
    active: "free",
    // Explicit free-safe default (USER: free-by-default).
    allow_paid_models: false,
    profiles: {
      free: placeholderFreeProfile(),
      ensemble: placeholderEnsembleProfile(),
      "mass-scout": placeholderMassScoutProfile(),
    },
  };
}

/**
 * Render the on-disk default settings.yaml — a commented file GENERATED from
 * generateDefaultSettings(), so the shipped defaults have exactly ONE source.
 *
 * This used to be a hand-maintained SETTINGS_TEMPLATE string literal sitting
 * beside generateDefaultSettings(), and the two drifted the moment the default
 * profiles changed: the template still declared the five old hand-written
 * profiles while the code claimed to write three machine-managed ones, and the
 * template was the copy that actually reached disk. A generated file cannot
 * drift from the object it is generated from — the test asserts a round-trip.
 */
export function renderDefaultSettingsYaml(): string {
  const doc = new YamlDocument(generateDefaultSettings());

  doc.commentBefore = [
    " ──────────────────────────────────────────────────────────────────────",
    " LLM Externalizer — Settings",
    " ──────────────────────────────────────────────────────────────────────",
    " Profile-based configuration. Each profile defines a complete LLM backend",
    " setup. Edit this file by hand, then run `llm-ext settings reset` to reload.",
    "",
    " Location: ~/.llm-externalizer/settings.yaml",
    "",
    " The three profiles below (free, ensemble, mass-scout) are MACHINE-MANAGED:",
    " their model ids are chosen and kept current by the benchmark procedure, and",
    " are (re)populated automatically when a model is retired, repriced, or a",
    " better one appears. They start EMPTY — a placeholder model id means 'not",
    " benchmarked yet', not 'broken'. Any profile you add yourself is left alone,",
    " forever: nothing here rewrites a profile it does not own.",
    " ──────────────────────────────────────────────────────────────────────",
  ].join("\n");

  const activeNode = doc.get("active", true);
  if (isScalar(activeNode)) {
    activeNode.comment = " the profile every command uses unless --profile says otherwise";
  }

  const paidNode = doc.get("allow_paid_models", true);
  if (isScalar(paidNode)) {
    paidNode.commentBefore = [
      " ── Master paid-spend switch ─────────────────────────────────────────",
      " DEFAULT false — only FREE models are used, everywhere, by default. While",
      " this is false (or absent), every remote profile is forced to its free pool",
      " no matter which 'model' it configures, and the two paid machine-managed",
      " profiles (ensemble, mass-scout) refuse to auto-benchmark themselves,",
      " because benchmarking a paid model sends billable requests. Set it to true",
      " to allow paid models — then `ensemble` and `mass-scout` populate on first",
      " use, printing their estimated cost ceiling before spending anything.",
    ].join("\n");
  }

  return doc.toString({ indent: 2 });
}

/** Local-time timestamp `YYYYMMDD_HHMMSS±HHMM` for a corrupt-settings backup
 *  filename (never UTC — ties the backup to the user's own wall clock). */
function formatLocalTimestamp(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offMin = -d.getTimezoneOffset(); // minutes EAST of UTC
  const sign = offMin >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMin) / 60));
  const offM = pad(Math.abs(offMin) % 60);
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${offH}${offM}`
  );
}

/**
 * Ensure settings.yaml exists AND parses. Regenerates the 3 dynamic default
 * profiles (free/ensemble/mass-scout, as unpopulated placeholders) when the
 * file is MISSING or CORRUPT/UNPARSEABLE.
 *
 * CRITICAL data-safety invariant: a corrupt file is NEVER silently overwritten.
 * It is first copied verbatim to a timestamped `settings.yaml.corrupt-<ts>`
 * backup (local-time±offset, so a user can find "the file from this afternoon")
 * — only then does a fresh default template get written. The user's own
 * profiles inside a corrupt file cannot be recovered automatically (the parser
 * couldn't read them either), so this says so plainly instead of pretending.
 * Also warns if old settings.yml exists (migration hint).
 */
export function ensureSettingsExist(): Settings {
  const settingsPath = getSettingsPath();
  const configDir = getConfigDir();

  // Warn about old settings.yml if it exists alongside new path
  const oldSettingsPath = join(configDir, "settings.yml");
  if (existsSync(oldSettingsPath) && !existsSync(settingsPath)) {
    process.stderr.write(
      `[llm-externalizer] Found old settings.yml — the new format is settings.yaml with profiles.\n` +
        `[llm-externalizer] Generating new settings.yaml. Your old settings.yml is preserved but no longer read.\n`,
    );
  }

  if (!existsSync(settingsPath)) {
    mkdirSync(configDir, { recursive: true });
    // First run: write the commented defaults, GENERATED from
    // generateDefaultSettings() so the on-disk file can never disagree with the
    // in-memory fallback (they were two hand-maintained copies, and drifted).
    writeFileSync(settingsPath, renderDefaultSettingsYaml(), "utf-8");
    // Restrict permissions immediately — users may add API keys to the template,
    // so default umask (0644) is not safe.
    try { chmodSync(settingsPath, 0o600); } catch { /* Windows may not support chmod */ }
    process.stderr.write(
      `[llm-externalizer] Generated default settings at ${settingsPath}\n`,
    );
  } else if (!loadSettings()) {
    // File exists but is corrupt/unparseable. Back it up BEFORE writing a
    // fresh one — never destroy data we could not read; the user's hand-
    // written profiles may still be recoverable by hand from the backup.
    const backupPath = `${settingsPath}.corrupt-${formatLocalTimestamp()}`;
    const raw = readFileSync(settingsPath, "utf-8");
    writeFileSync(backupPath, raw, "utf-8");
    try { chmodSync(backupPath, 0o600); } catch { /* Windows may not support chmod */ }
    process.stderr.write(
      `[llm-externalizer] WARNING: ${settingsPath} could not be parsed as YAML. ` +
        `Your original file has been preserved at ${backupPath} — inspect it by ` +
        `hand to recover any custom profiles; they could NOT be recovered ` +
        `automatically. Regenerating ${settingsPath} with the 3 machine-managed ` +
        `default profiles (free, ensemble, mass-scout).\n`,
    );
    writeFileSync(settingsPath, renderDefaultSettingsYaml(), "utf-8");
    try { chmodSync(settingsPath, 0o600); } catch { /* Windows may not support chmod */ }
  }

  const settings = loadSettings();
  if (!settings) {
    // Should be unreachable (we just wrote renderDefaultSettingsYaml(), which
    // is valid YAML by construction — a round-trip test proves it) — but never
    // silently proceed with a null settings object.
    throw new Error(`Failed to parse ${settingsPath}. Check YAML syntax.`);
  }

  return settings;
}

// ── Profile validation ──────────────────────────────────────────────

/**
 * Validate a single profile for correctness and consistency.
 * Returns { valid: true, errors: [] } or { valid: false, errors: [...] }.
 */
export function validateProfile(
  name: string,
  profile: Profile,
): ValidationResult {
  const errors: string[] = [];

  // ── Required fields ───────────────────────────────────────────────
  if (!profile.mode) {
    errors.push(`Profile '${name}': missing required field: mode`);
  } else if (!["local", "remote", "remote-ensemble"].includes(profile.mode)) {
    errors.push(
      `Invalid mode '${profile.mode}'. Must be: local, remote, or remote-ensemble`,
    );
  }

  if (!profile.api) {
    errors.push(`Profile '${name}': missing required field: api`);
  }

  // Under free_only the `model` field is supplied by free_models[0], so it is
  // optional here (the free_only block below validates free_models instead).
  if (!profile.model && !profile.free_only) {
    errors.push(`Profile '${name}': missing required field: model`);
  }

  // ── Preset existence ──────────────────────────────────────────────
  const preset = profile.api ? API_PRESETS[profile.api] : undefined;
  if (profile.api && !preset) {
    errors.push(
      `Unknown api preset '${profile.api}'. Valid presets: ${Object.keys(API_PRESETS).join(", ")}`,
    );
    // Can't validate further without a valid preset
    return { valid: false, errors };
  }

  if (!preset || !profile.mode) {
    return { valid: false, errors };
  }

  // ── Mode ↔ preset suffix compatibility ────────────────────────────
  if (profile.mode === "local" && !preset.isLocal) {
    errors.push(
      `Mode 'local' requires a -local api preset, got '${profile.api}'`,
    );
  }
  if (
    (profile.mode === "remote" || profile.mode === "remote-ensemble") &&
    preset.isLocal
  ) {
    errors.push(
      `Mode '${profile.mode}' requires a -remote api preset, got '${profile.api}'`,
    );
  }

  // NOTE — deliberately NO placeholder exemption here. An unpopulated default
  // profile genuinely CANNOT serve a request (no models), so reporting it valid
  // would be a lie, and the "free_only needs a non-empty pool" rule below is a
  // zero-spend invariant, not a formality. The distinction that actually
  // matters is "the USER misconfigured this" vs "the MACHINE has not populated
  // it yet" — and that belongs to the CALLER, which knows whether the profile
  // is machine-owned and can route it to population instead of to an error.
  // See isUnpopulatedDefaultProfile() and the boot gate in index.ts.

  // ── free_only rules (TRDD-8b6b3646) ───────────────────────────────
  // The switch can NEVER cause spend, so the constraints here are strict.
  if (profile.free_only) {
    if (preset.isLocal) {
      errors.push(
        `Profile '${name}': free_only requires a remote (OpenRouter) api preset — ':free' models are an OpenRouter concept. Got local preset '${profile.api}'.`,
      );
    }
    // free_models comes from YAML (untyped at runtime) — a scalar would crash the
    // checks below, so flag a non-list explicitly and coerce for the rest.
    if (profile.free_models !== undefined && !Array.isArray(profile.free_models)) {
      errors.push(
        `Profile '${name}': free_models must be a YAML list of ':free' model ids.`,
      );
    }
    const pool = coerceFreeModels(profile.free_models);
    if (pool.length === 0) {
      errors.push(
        `Profile '${name}': free_only requires a non-empty 'free_models' list.`,
      );
    }
    const nonFree = pool.filter((m) => !m.endsWith(":free"));
    if (nonFree.length > 0) {
      errors.push(
        `Profile '${name}': free_only forbids non-':free' models — every free_models entry MUST end with ':free'. Offending: ${nonFree.join(", ")}`,
      );
    }
    if (profile.mode === "remote-ensemble" && pool.length < 2) {
      errors.push(
        `Profile '${name}': free_only + mode 'remote-ensemble' needs at least 2 free_models (the ensemble fans out to the top models). Use mode 'remote' for a single free model.`,
      );
    }
  }

  // ── second_model / third_model rules ──────────────────────────────
  // Under free_only the ensemble models come from free_models, so second_model
  // is not required (and is ignored if set).
  if (
    profile.mode === "remote-ensemble" &&
    !profile.second_model &&
    !profile.free_only
  ) {
    errors.push("Mode 'remote-ensemble' requires 'second_model'");
  }
  if (profile.mode === "local" && profile.second_model) {
    errors.push("Mode 'local' does not support 'second_model'");
  }
  if (profile.mode === "remote" && profile.second_model) {
    errors.push(
      "Mode 'remote' does not support 'second_model'. Use 'remote-ensemble'",
    );
  }
  if (profile.third_model && profile.mode !== "remote-ensemble") {
    errors.push("'third_model' is only supported in 'remote-ensemble' mode");
  }

  // ── LM Studio native API constraints ──────────────────────────────
  if (profile.api === "lmstudio-local") {
    if (profile.second_model) {
      errors.push("LM Studio native API does not support second_model");
    }
  }

  // ── URL validation ────────────────────────────────────────────────
  const effectiveUrl = profile.url || preset.defaultUrl;
  if (effectiveUrl) {
    const urlIsLocal = isLocalUrl(effectiveUrl);
    if (
      (profile.mode === "remote" || profile.mode === "remote-ensemble") &&
      urlIsLocal
    ) {
      errors.push(`Remote mode cannot use local URL '${effectiveUrl}'`);
    }
  }

  // generic-local requires explicit url (no default)
  if (profile.api === "generic-local" && !profile.url) {
    errors.push("Api preset 'generic-local' requires explicit 'url'");
  }

  // ── Numeric field validation ─────────────────────────────────────
  if (
    profile.timeout !== undefined &&
    (typeof profile.timeout !== "number" ||
      !isFinite(profile.timeout) ||
      profile.timeout < 0)
  ) {
    errors.push(
      `Profile '${name}': timeout must be a non-negative finite number`,
    );
  }
  if (
    profile.context_window !== undefined &&
    (typeof profile.context_window !== "number" ||
      !isFinite(profile.context_window) ||
      profile.context_window < 0)
  ) {
    errors.push(
      `Profile '${name}': context_window must be a non-negative finite number`,
    );
  }

  // M10: Upper bounds on numeric overrides to prevent resource abuse
  if (typeof profile.timeout === "number" && profile.timeout > 3600) {
    errors.push(`Profile '${name}': timeout must be <= 3600 (1 hour)`);
  }
  if (typeof profile.context_window === "number" && profile.context_window > 10_000_000) {
    errors.push(`Profile '${name}': context_window must be <= 10,000,000`);
  }

  // ── Remote auth ───────────────────────────────────────────────────
  if (!preset.isLocal) {
    const rawAuth = profile.api_key || preset.defaultAuthEnv;
    const resolved = resolveEnvValue(rawAuth);
    if (!resolved) {
      const hint = rawAuth?.startsWith("$")
        ? ` (env var ${rawAuth} is not set)`
        : "";
      errors.push(`Remote api '${profile.api}' requires 'api_key'${hint}`);
    }
  }

  // ── Per-tool model overrides (tool_models) ────────────────────────
  // Optional map {toolName: modelId} (TRDD-f45eeaa0). Validated as untrusted
  // YAML: keys must be known LLM-using tools (the registry is the single source
  // of truth), values must be non-empty model-id strings. Catches typos like
  // `securty_scan:` that would otherwise silently never apply.
  // `tool_models:` left blank in YAML parses to null — treat null (and
  // undefined) as "no overrides", consistent with resolveProfile/coerceToolModels.
  // A non-null non-map value (string / array / number) is still a real mistake.
  const rawToolModels: unknown = profile.tool_models;
  if (rawToolModels !== undefined && rawToolModels !== null) {
    if (typeof rawToolModels !== "object" || Array.isArray(rawToolModels)) {
      errors.push(
        `Profile '${name}': tool_models must be a map of {tool: model}`,
      );
    } else {
      const known = new Set(registeredTools());
      for (const [toolName, modelId] of Object.entries(
        rawToolModels as Record<string, unknown>,
      )) {
        if (!known.has(toolName)) {
          errors.push(
            `Profile '${name}': tool_models has unknown tool '${toolName}'. ` +
              `Known LLM tools: ${registeredTools().join(", ")}`,
          );
        }
        if (typeof modelId !== "string" || modelId.length === 0) {
          errors.push(
            `Profile '${name}': tool_models['${toolName}'] must be a non-empty model-id string`,
          );
        }
      }
    }
  }

  // ── High-quality-scan model (high_quality_model) (TRDD-DBUSM55E) ──
  // Optional block; blank YAML key → null → "no override, use defaults". A
  // non-null non-object is a real mistake. Sub-fields are validated when present;
  // resolveHighQualityModel still fills defaults for any field omitted or wrong.
  const rawHq: unknown = profile.high_quality_model;
  if (rawHq !== undefined && rawHq !== null) {
    if (typeof rawHq !== "object" || Array.isArray(rawHq)) {
      errors.push(
        `Profile '${name}': high_quality_model must be a map of {id, reasoning_effort, cache, min_quantization, provider, allow_fallbacks}`,
      );
    } else {
      const hq = rawHq as Record<string, unknown>;
      if (
        hq.id !== undefined &&
        (typeof hq.id !== "string" || hq.id.length === 0)
      ) {
        errors.push(
          `Profile '${name}': high_quality_model.id must be a non-empty model-id string`,
        );
      }
      if (
        hq.reasoning_effort !== undefined &&
        (typeof hq.reasoning_effort !== "string" ||
          !VALID_HQ_REASONING.has(hq.reasoning_effort.toLowerCase()))
      ) {
        errors.push(
          `Profile '${name}': high_quality_model.reasoning_effort must be one of off|low|medium|high|xhigh|max`,
        );
      }
      if (hq.cache !== undefined && typeof hq.cache !== "boolean") {
        errors.push(
          `Profile '${name}': high_quality_model.cache must be a boolean`,
        );
      }
      if (
        hq.min_quantization !== undefined &&
        (typeof hq.min_quantization !== "string" ||
          !QUANT_TIERS.includes(hq.min_quantization.toLowerCase()))
      ) {
        errors.push(
          `Profile '${name}': high_quality_model.min_quantization must be one of ${QUANT_TIERS.join("|")}`,
        );
      }
      if (
        hq.provider !== undefined &&
        (typeof hq.provider !== "string" || hq.provider.length === 0)
      ) {
        errors.push(
          `Profile '${name}': high_quality_model.provider must be a non-empty provider slug string`,
        );
      }
      if (
        hq.allow_fallbacks !== undefined &&
        typeof hq.allow_fallbacks !== "boolean"
      ) {
        errors.push(
          `Profile '${name}': high_quality_model.allow_fallbacks must be a boolean`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate entire settings: active profile must exist and be valid.
 */
export function validateSettings(settings: Settings): ValidationResult {
  if (!settings.active) {
    return {
      valid: false,
      errors: [
        `No active profile set. Edit ${getSettingsPath()} manually and set the 'active:' field to one of the profile names listed under 'profiles:', then restart Claude Code or call the MCP 'reset' tool.`,
      ],
    };
  }

  const profile = settings.profiles[settings.active];
  if (!profile) {
    const available = Object.keys(settings.profiles);
    return {
      valid: false,
      errors: [
        `Active profile '${settings.active}' not found. Available: ${available.join(", ") || "(none)"}`,
      ],
    };
  }

  return validateProfile(settings.active, profile);
}

// ── Profile resolution ──────────────────────────────────────────────

/**
 * Coerce an untrusted `tool_models` value into a plain string-map. null /
 * undefined / arrays / non-objects (e.g. a stray scalar) all collapse to `{}`
 * so resolution stays safe even on the best-effort settings-read paths that do
 * NOT pre-validate (e.g. the security_scan model injection). validateProfile is
 * what reports a malformed value to the user; this just never throws or mangles.
 */
function coerceToolModels(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, string>) };
}

/**
 * Coerce an untrusted `free_models` value (from YAML) into a clean string[].
 * A scalar / object / null collapses to [] and non-string entries are dropped,
 * so neither resolveProfile (which spreads the value) nor validateProfile (which
 * filters it) can throw on a malformed settings.yaml. validateProfile reports a
 * bad value to the user; this just never throws or mangles (e.g. it must NOT let
 * a stray string spread into an array of single characters).
 */
function coerceFreeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === "string");
}

/**
 * A profile's configured `free_models`, WITHOUT the `free_only` gate that
 * resolveProfile applies.
 *
 * resolveProfile returns `freeModels: []` unless the profile sets `free_only`
 * (see its freeModels line), because there it feeds model/second_model/
 * third_model — a runtime invariant that must not change. But free mode is now
 * normally enabled by the TOP-LEVEL `allow_paid_models: false` master switch,
 * whose users have no per-profile `free_only` at all. Anything that wants the
 * pool ITSELF (rather than the resolved ensemble) must therefore read it
 * unconditionally, or it silently sees an empty list and falls back to a
 * hardcoded seed — which is exactly how --bench-free-pool ended up benchmarking
 * stale seed ids instead of the user's real pool.
 */
export function profileFreeModels(profile: Profile | undefined): string[] {
  return coerceFreeModels(profile?.free_models);
}

// ── High-quality model resolution (TRDD-DBUSM55E) ───────────────────────────

/**
 * Map a config reasoning_effort token to the wire value ("max" → "xhigh"). An
 * unrecognized value falls back to the default (validateProfile reports it).
 */
function mapReasoningEffort(raw: string | undefined): string {
  if (typeof raw !== "string") return HIGH_QUALITY_MODEL_DEFAULTS.reasoningEffort;
  const v = raw.toLowerCase();
  if (v === "max") return "xhigh";
  return VALID_HQ_REASONING.has(v)
    ? v
    : HIGH_QUALITY_MODEL_DEFAULTS.reasoningEffort;
}

/**
 * Expand a min_quantization into the "this-precision-or-higher" whitelist for
 * OpenRouter's provider.quantizations filter. An unknown value falls back to the
 * default fp8+ set (validateProfile reports the bad value; this never throws).
 */
function expandMinQuantization(raw: string | undefined): string[] {
  if (typeof raw !== "string")
    return [...HIGH_QUALITY_MODEL_DEFAULTS.quantizations];
  const idx = QUANT_TIERS.indexOf(raw.toLowerCase());
  if (idx < 0) return [...HIGH_QUALITY_MODEL_DEFAULTS.quantizations];
  return QUANT_TIERS.slice(idx);
}

/**
 * Resolve a (possibly absent / partial / null) high_quality_model block into a
 * fully-defaulted ResolvedHighQualityModel. Untrusted YAML: a non-object collapses
 * to all-defaults; each field falls back to HIGH_QUALITY_MODEL_DEFAULTS when
 * omitted or the wrong type (validateProfile is what reports a malformed value to
 * the user; this just never throws or mangles).
 */
export function resolveHighQualityModel(raw: unknown): ResolvedHighQualityModel {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...HIGH_QUALITY_MODEL_DEFAULTS };
  }
  const hq = raw as HighQualityModel;
  const id =
    typeof hq.id === "string" && hq.id.length > 0
      ? hq.id
      : HIGH_QUALITY_MODEL_DEFAULTS.id;
  const provider =
    typeof hq.provider === "string" && hq.provider.length > 0
      ? hq.provider
      : HIGH_QUALITY_MODEL_DEFAULTS.providerOrder[0];
  return {
    id,
    reasoningEffort: mapReasoningEffort(hq.reasoning_effort),
    cache:
      typeof hq.cache === "boolean"
        ? hq.cache
        : HIGH_QUALITY_MODEL_DEFAULTS.cache,
    providerOrder: [provider],
    quantizations: expandMinQuantization(hq.min_quantization),
    allowFallbacks:
      typeof hq.allow_fallbacks === "boolean"
        ? hq.allow_fallbacks
        : HIGH_QUALITY_MODEL_DEFAULTS.allowFallbacks,
  };
}

/**
 * Build the OpenRouter `provider` routing block for a high_quality_scan request
 * from a resolved high-quality model (TRDD-DBUSM55E). `allow_fallbacks` is always
 * present; `order` (the preferred provider, e.g. gmicloud/fp8) and `quantizations`
 * (the fp8+ whitelist) are included only when non-empty, so we never send an empty
 * array. The result is attached as the request's `provider` control field, which
 * survives the supported-params filter to the wire.
 */
export function buildHighQualityProvider(
  hq: ResolvedHighQualityModel,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    allow_fallbacks: hq.allowFallbacks,
  };
  if (hq.providerOrder.length > 0) provider.order = hq.providerOrder;
  if (hq.quantizations.length > 0) provider.quantizations = hq.quantizations;
  return provider;
}

/**
 * Fail-fast gate for high_quality_scan (TRDD-DBUSM55E). The tool runs a PAID
 * high-quality model, so it must refuse (never silently downgrade) when the
 * backend cannot deliver it: a non-OpenRouter backend can't reach the remote
 * model, free_only mode forbids any non-':free' model, and exhausted credit
 * would 402 every file and fall back to the free pool — defeating the quality
 * promise. Returns the user-facing refusal message, or null when allowed.
 */
export function highQualityScanRefusal(
  backendType: string,
  freeOnly: boolean,
  creditExhausted: boolean,
  // The master paid switch (getAllowPaidModels()). Only shapes the free-mode
  // MESSAGE — under the global free-default the fix is the switch, not a
  // per-profile edit. Defaults true so the pre-switch 3-arg callers (and their
  // tests) keep the original "disable free_only" wording unchanged.
  allowPaidModels: boolean = true,
): string | null {
  if (backendType !== "openrouter") {
    return (
      `high_quality_scan requires the OpenRouter backend (it runs a remote ` +
      `high-quality model); the active backend is ${backendType}. Switch to a ` +
      `remote profile, or use scan_folder for the local backend.`
    );
  }
  if (freeOnly) {
    // Deliberately a REFUSAL, not a silent downgrade: high_quality_scan's whole
    // contract is "ONE strong (paid) model". Degrading it to a free model would
    // return free-tier results under a name that promises better — worse than an
    // honest refusal. Under the master switch the actionable fix is the switch.
    if (!allowPaidModels) {
      return (
        `high_quality_scan runs ONE paid high-quality model, and paid models are ` +
        `off (allow_paid_models: false). Set allow_paid_models: true in ` +
        `~/.llm-externalizer/settings.yaml to enable it, or use scan_folder (the ` +
        `free 3-model ensemble).`
      );
    }
    return (
      `high_quality_scan uses a paid high-quality model and cannot run under ` +
      `free_only mode. Disable free_only in your profile, or use scan_folder ` +
      `(which honours the free pool).`
    );
  }
  if (creditExhausted) {
    return (
      `high_quality_scan needs OpenRouter credit for its paid high-quality model, ` +
      `but credit is exhausted (a 402 was seen this session). Add credit, or use ` +
      `scan_folder.`
    );
  }
  return null;
}

/**
 * Resolve a profile to concrete connection values.
 * Merges profile overrides with preset defaults and resolves env var refs.
 */
export function resolveProfile(
  name: string,
  profile: Profile,
): ResolvedProfile {
  const preset = API_PRESETS[profile.api];
  if (!preset) {
    throw new Error(`Unknown api preset '${profile.api}'`);
  }

  // Auth: api_token preferred for local presets, api_key accepted as fallback;
  // api_key is the canonical field for remote presets.
  const rawAuth = preset.isLocal
    ? profile.api_token || profile.api_key || preset.defaultAuthEnv
    : profile.api_key || preset.defaultAuthEnv;

  // Free-only (TRDD-8b6b3646): the free_models pool is the source of truth — the
  // top three become model / secondModel / thirdModel, so the existing ensemble
  // machinery (getEnsembleModels, which reads these) runs the free top-3 with no
  // hot-path change. The configured model/second_model/third_model are ignored.
  // (Benchmark/requirements filtering of the pool happens downstream in
  // getEnsembleModels, where the catalog is available.)
  const freeOnly = profile.free_only === true;
  const freeModels = freeOnly ? coerceFreeModels(profile.free_models) : [];
  const model = freeOnly ? (freeModels[0] ?? "") : profile.model;
  const secondModel = freeOnly
    ? (freeModels[1] ?? "")
    : profile.second_model || "";
  const thirdModel = freeOnly
    ? (freeModels[2] ?? "")
    : profile.third_model || "";

  return {
    name,
    mode: profile.mode,
    protocol: preset.protocol,
    url: profile.url || preset.defaultUrl,
    model,
    authToken: resolveEnvValue(rawAuth),
    secondModel,
    thirdModel,
    freeOnly,
    freeModels,
    // Under free_only the free pool overrides EVERY per-tool choice (TRDD-97ef8b63):
    // the resolved profile carries NO active per-tool overrides so resolveModelForTool,
    // get_settings, and drift all agree that free models win. The user's settings.yaml
    // tool_models are left intact on disk — they reactivate when free_only is off.
    toolModels: freeOnly ? {} : coerceToolModels(profile.tool_models),
    timeout: profile.timeout ?? preset.defaultTimeout,
    contextWindow: profile.context_window ?? preset.defaultContextWindow,
    appName: profile.app_name ?? preset.defaultAppName,
    httpReferer: profile.http_referer ?? preset.defaultHttpReferer,
    // High-quality-scan model (TRDD-DBUSM55E): always resolved (defaults filled),
    // independent of mode — the high_quality_scan tool reads it; other tools ignore it.
    highQualityModel: resolveHighQualityModel(profile.high_quality_model),
  };
}

// ── Profile display (settings-rename: `settings show` / `settings profiles`) ──
// Single source of truth for both the `profile --show <name>` formatting and
// `settings show`'s "print the active profile's resolved settings" requirement
// — never duplicate this shape in two places.

/** One resolved profile's full detail, as display lines (no trailing newline). */
export function formatResolvedProfileLines(
  resolved: ResolvedProfile,
  profile: Profile,
  isActive: boolean,
): string[] {
  const lines: string[] = [
    `Profile: ${resolved.name}${isActive ? " (ACTIVE)" : ""}`,
    `Mode: ${resolved.mode}`,
    `Backend: ${profile.api} (${resolved.protocol})`,
    `URL: ${resolved.url}`,
  ];
  if (resolved.freeOnly) {
    lines.push(`Free only: true`);
    lines.push(`Free pool: ${resolved.freeModels.join(", ") || "(empty)"}`);
  } else {
    lines.push(`Model: ${resolved.model}`);
    if (resolved.secondModel) lines.push(`Second model: ${resolved.secondModel}`);
    if (resolved.thirdModel) lines.push(`Third model: ${resolved.thirdModel}`);
  }
  if (Object.keys(resolved.toolModels).length > 0) {
    lines.push(
      `Per-tool overrides: ${Object.entries(resolved.toolModels)
        .map(([tool, m]) => `${tool}=${m}`)
        .join(", ")}`,
    );
  }
  lines.push(`Timeout: ${resolved.timeout}s`);
  lines.push(`Context window: ${resolved.contextWindow.toLocaleString()} tokens`);
  lines.push(
    `Auth: ${resolved.authToken ? `set (${resolved.authToken.length} chars)` : "NOT SET"}`,
  );
  return lines;
}

/**
 * `settings show` (TRDD settings-rename, requirement B): the ACTIVE profile's
 * resolved configuration, ready to print to stdout. Reads settings.yaml fresh
 * (via getSettingsPath()/loadSettings(), both env-var-aware) instead of relying
 * on any module-scoped cache, so it is independently unit-testable and reflects
 * the file as it is on disk right now. Read-only — never writes settings.yaml.
 * Never throws: every failure mode (file missing, unparseable, active profile
 * absent, resolution error) returns a plain-text message instead.
 */
export function formatActiveProfileSummary(): string {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return (
      `No settings file found at ${settingsPath}.\n` +
      `It is created automatically the first time any llm-ext command runs.`
    );
  }
  const settings = loadSettings();
  if (!settings) {
    return `Failed to read/parse ${settingsPath}. Check YAML syntax.`;
  }
  const profile = settings.profiles[settings.active];
  if (!profile) {
    return (
      `Active profile '${settings.active}' not found in ${settingsPath}.\n` +
      `Available profiles: ${Object.keys(settings.profiles).join(", ") || "(none)"}`
    );
  }
  try {
    const resolved = resolveProfile(settings.active, profile);
    return formatResolvedProfileLines(resolved, profile, true).join("\n");
  } catch (err) {
    return `Failed to resolve active profile '${settings.active}': ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * `settings profiles` / `list_profiles` (TRDD settings-rename, requirement C):
 * every profile defined in settings.yaml, one line each, with a `*` marker on
 * the active one. Reads settings.yaml only — never mutates it. Never throws:
 * a missing file is reported plainly instead (it is created automatically the
 * first time any llm-ext command runs).
 */
export function formatProfilesList(): string {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return (
      `No settings file found at ${settingsPath}.\n` +
      `It is created automatically the first time any llm-ext command runs.`
    );
  }
  const settings = loadSettings();
  if (!settings) {
    return `Failed to read/parse ${settingsPath}. Check YAML syntax.`;
  }
  const profileNames = Object.keys(settings.profiles);
  if (profileNames.length === 0) {
    return (
      `No profiles defined in ${settingsPath}.\n` +
      `Settings file is present but its 'profiles' map is empty.`
    );
  }
  const lines = [`Settings file: ${settingsPath}`, ""];
  let anyUnpopulated = false;
  for (const profileName of profileNames) {
    const profile = settings.profiles[profileName];
    const marker = profileName === settings.active ? "* " : "  ";
    const owner = isDefaultProfileName(profileName) ? " [machine-managed]" : "";

    // An unpopulated default profile must NOT print its sentinel model id.
    // `placeholder/unpopulated-default-profile` looks like a broken config the
    // user is expected to fix by hand, when in fact it is a normal pre-benchmark
    // state that resolves itself — so say what it actually means.
    let modelSummary: string;
    if (isUnpopulatedDefaultProfile(profileName, profile)) {
      anyUnpopulated = true;
      modelSummary = "not benchmarked yet — populates on first use";
    } else if (profile.free_only) {
      modelSummary = `free_only (${(profile.free_models ?? []).length} models)`;
    } else {
      modelSummary = [profile.model, profile.second_model, profile.third_model]
        .filter(Boolean)
        .join(", ");
    }

    lines.push(
      `${marker}${profileName}${owner} — ${profile.mode} / ${profile.api} — ${modelSummary}`,
    );
  }
  lines.push("", "* = active profile. Use --show <name> for full resolved detail.");
  if (profileNames.some((n) => isDefaultProfileName(n))) {
    lines.push(
      "[machine-managed] = free / ensemble / mass-scout. These pick and refresh their own",
      "models from benchmark results; every other profile is yours and is never modified.",
    );
  }
  if (anyUnpopulated) {
    lines.push(
      "",
      "Unpopulated profiles are expected on a fresh install: 'free' works immediately from a",
      "bundled seed pool while it benchmarks, and the paid profiles populate on first use once",
      "allow_paid_models is true.",
    );
  }
  return lines.join("\n");
}

/**
 * Resolve the model a given LLM tool should use (TRDD-f45eeaa0 §2.3).
 *
 * Resolution order:
 *   1. The profile's per-tool override `tool_models[tool]`, when set non-empty.
 *   2. The caller-supplied `fallback` (a tool's OWN default, e.g. security_scan's
 *      DEFAULT_MODEL) — pass `undefined` to fall through to step 3.
 *   3. The profile's main `model`.
 *
 * Back-compat: a profile with no `tool_models` (the common case) and a caller
 * that passes no `fallback` always returns `resolved.model` — identical to the
 * pre-#97 behavior. A model assigned via `tool_models` is NEVER auto-selected;
 * the operator sets it deliberately (and SHOULD confirm it passes that tool's
 * benchmark — see the security-triage benchmark).
 *
 * free_only override (TRDD-97ef8b63): when the profile is free_only, the free
 * pool overrides EVERY per-tool choice — `tool_models` AND any caller `fallback`
 * are ignored, and the top free model (`resolved.model` = free_models[0]) wins
 * for single-model resolution. This is the "free models override every
 * customized choice of the tools" guarantee; combined with the resolveConnection
 * chokepoint guard it makes a paid model unreachable under free_only.
 */
export function resolveModelForTool(
  resolved: ResolvedProfile,
  tool: string,
  fallback?: string,
): string {
  if (resolved.freeOnly) return resolved.model; // free overrides tool_models + fallback
  const override = resolved.toolModels[tool];
  if (typeof override === "string" && override.length > 0) return override;
  if (fallback !== undefined) return fallback;
  return resolved.model;
}

// ── Free-pool seed list (TRDD-f1510055) ────────────────────────────────────
// Runtime "never dark" fallback pool: used when a remote profile has no
// configured `free_models` of its own, so free_only / cost-safety code paths
// always have a usable free pool to fall back to. This list is NOT copied
// into generated settings.yaml (see renderDefaultSettingsYaml() above) —
// the two are independent now; keep this comment free of any template
// cross-reference.
//
// Selection criteria (curated 2026-05-27): OpenRouter `:free` tier models that
//   - meet the per-tool requirements floor (context >= 128K, max_output >= 8K,
//     structured_outputs OR response_format, reasoning OR include_reasoning)
//   - cover a spread of providers (no single-provider dependency)
//   - have non-zero uptime at curation time
//
// This is the SEED that the auto-benchmark trigger scores when the user first
// activates `free_only: true` with no cached `:free` benchmark results. The
// trigger feeds each id into the keyword + security-triage benchmarks; passers
// become the active ensemble (top-N by meanF1 + cost asc).
export const FREE_POOL_SEED: readonly string[] = Object.freeze([
  "poolside/laguna-m.1:free",
  "deepseek/deepseek-v4-flash:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "arcee-ai/trinity-large-thinking:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "minimax/minimax-m2.5:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-coder:free",
  "z-ai/glm-4.5-air:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
]);

// ── Process-wide free_only flag (TRDD-97ef8b63) ────────────────────────────
// The pure subsystem modules (security_scan/judge.ts, mass_scouting/scout.ts,
// benchmark/runner.ts) each fetch OpenRouter directly and cannot import
// index.ts's `activeResolved` (cycle + they are intentionally pure). They read
// the active free_only state through this one accessor instead. The owner of the
// active profile (index.ts on load/reload; the standalone CLIs in their main())
// calls setActiveFreeOnly() right where it resolves the profile, so there is a
// SINGLE write point per process and the flag never drifts from the live profile.
// Defaults false, so unit tests that never set it (and any non-free profile) are
// completely unaffected.
let _activeFreeOnly = false;

/** Record whether the active profile is free_only. Call wherever the active
 *  profile is resolved (index.ts load/reload; CLI main()). */
export function setActiveFreeOnly(freeOnly: boolean): void {
  _activeFreeOnly = freeOnly;
}

/** True iff the active profile is free_only. Read by the subsystem spend sites. */
export function getActiveFreeOnly(): boolean {
  return _activeFreeOnly;
}

// Master paid-spend switch (Settings.allow_paid_models). The STATE lives in the
// leaf module ./paid-switch.js — NOT here — because benchmark/discover.ts also
// reads it, and config.ts → model-qualification/registry.ts → benchmark/discover.ts
// is already a chain; discover.ts importing config.ts would close that into a
// cycle that leaves TOOL_MODEL_REGISTRY undefined at init. config.ts re-exports so
// its own consumers (index.ts / cli.ts / benchmark/index.ts) import from here as
// before, while discover.ts imports the leaf directly.
export { setAllowPaidModels, getAllowPaidModels } from "./paid-switch.js";

/**
 * The pure force-free decision (USER: free-by-default). Free mode is FORCED for a
 * remote profile whenever paid is globally off. LOCAL profiles are $0/offline and
 * never forced; a null mode (invalid/absent active profile) is not forced because
 * there is nothing to run. Extracted so the rule is unit-testable in isolation;
 * index.ts's recomputeForceFree is the single caller that supplies the live inputs.
 */
export function shouldForceFreeMode(
  allowPaidModels: boolean,
  mode: Mode | null,
): boolean {
  return !allowPaidModels && mode !== null && mode !== "local";
}

/**
 * Airtight free_only cost-safety gate (TRDD-97ef8b63). Under a free_only profile
 * EVERY OpenRouter request — across EVERY subsystem (the main chat/scan path via
 * resolveConnection, the security_scan judge, the mass_scout fan-out, the
 * security-triage / keyword benchmark) — MUST target a ':free' model. Each
 * subsystem fetches OpenRouter independently, so each calls this guard right
 * before its request: a non-':free' id throws BEFORE the fetch, so a config or
 * logic leak fails fast instead of billing. No-op when free_only is off, and for
 * local backends (':free' is an OpenRouter concept; local is always $0). PURE —
 * `freeOnly` is passed in (callers pass getActiveFreeOnly(), or an explicit value
 * in tests) so every call site is offline-testable.
 *
 * Lives in config.ts (a leaf module) so index.ts AND the pure subsystem modules
 * (judge.ts, scout.ts, benchmark/runner.ts) can all import it with no cycle.
 */
export function assertFreeOnlyModel(
  freeOnly: boolean,
  backendType: "local" | "openrouter",
  model: string,
): void {
  if (freeOnly && backendType === "openrouter" && !model.endsWith(":free")) {
    throw new Error(
      `free_only cost-safety: refusing to send non-free model '${model}' to OpenRouter. ` +
        `Under a free_only profile every tool MUST use a ':free' model — this is a bug, please report it.`,
    );
  }
}

