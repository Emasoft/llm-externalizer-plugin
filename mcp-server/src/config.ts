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
import { parse as yamlParse } from "yaml";
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
    };
  } catch (err) {
    process.stderr.write(
      `[llm-externalizer] Warning: Failed to read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/** Default settings with 4 predefined profiles */
export function generateDefaultSettings(): Settings {
  return {
    active: "local-lmstudio-qwen35",
    profiles: {
      "local-lmstudio-qwen35": {
        mode: "local",
        api: "lmstudio-local",
        model: "thecluster/qwen3.5-27b-mlx",
      },
      "local-ollama-qwen314": {
        mode: "local",
        api: "ollama-local",
        model: "qwen3:14b",
      },
      "remote-single-geminiflash": {
        mode: "remote",
        api: "openrouter-remote",
        model: "google/gemini-2.5-flash",
        api_key: "$OPENROUTER_API_KEY",
      },
      "remote-ensemble-geminigrok": {
        mode: "remote-ensemble",
        api: "openrouter-remote",
        model: "google/gemini-2.5-flash",
        second_model: "x-ai/grok-4.1-fast",
        third_model: "qwen/qwen3.6-plus",
        api_key: "$OPENROUTER_API_KEY",
      },
    },
  };
}

/**
 * Ensure settings.yaml exists. If not, generate default with comments.
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
    // First run: write commented template for human readability
    writeFileSync(settingsPath, SETTINGS_TEMPLATE, "utf-8");
    // Restrict permissions immediately — users may add API keys to the template,
    // so default umask (0644) is not safe.
    try { chmodSync(settingsPath, 0o600); } catch { /* Windows may not support chmod */ }
    process.stderr.write(
      `[llm-externalizer] Generated default settings at ${settingsPath}\n`,
    );
  }

  const settings = loadSettings();
  if (!settings) {
    // File exists but can't be parsed — fatal
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
// Canonical default `free_models` pool for the `remote-free-ensemble` profile.
// Updating this list MUST stay in sync with the SETTINGS_TEMPLATE block above
// (the generator copies these entries verbatim into a fresh settings.yaml).
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

// ── Settings template ───────────────────────────────────────────────
// Written on first run for human readability (comments are preserved).
// Users edit settings.yaml manually in their editor.

export const SETTINGS_TEMPLATE = `# ──────────────────────────────────────────────────────────────────────
# LLM Externalizer — Settings
# ──────────────────────────────────────────────────────────────────────
# Profile-based configuration. Each profile defines a complete LLM
# backend setup. Edit this file manually and either restart Claude Code
# or call the MCP 'reset' tool to reload.
#
# Location: ~/.llm-externalizer/settings.yaml
# ──────────────────────────────────────────────────────────────────────

# Active profile name
active: local-lmstudio-qwen35

# ── Profiles ─────────────────────────────────────────────────────────
profiles:

  # ── Local: LM Studio with Qwen 3.5 ────────────────────────────────
  local-lmstudio-qwen35:
    mode: local
    api: lmstudio-local
    model: "thecluster/qwen3.5-27b-mlx"
    # url: "http://localhost:1234"       # (default from lmstudio-local preset)
    # api_token: $LM_API_TOKEN           # (default from lmstudio-local preset)
    # timeout: 300                        # (default from lmstudio-local preset)

  # ── Local: Ollama with Qwen 3 14B ─────────────────────────────────
  local-ollama-qwen314:
    mode: local
    api: ollama-local
    model: "qwen3:14b"
    # url: "http://localhost:11434"       # (default from ollama-local preset)

  # ── Remote: Single model via OpenRouter ────────────────────────────
  remote-single-geminiflash:
    mode: remote
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    api_key: $OPENROUTER_API_KEY          # set this env var, or replace with direct key
    # Optional: high-quality scan model (TRDD-DBUSM55E). Drives high_quality_scan —
    # ONE strong model at max reasoning instead of the cheap 3-model ensemble.
    # Absent → these exact defaults are used automatically. Needs an OpenRouter
    # (remote) profile; NOT available under free_only (it is a paid model).
    # high_quality_model:
    #   id: "z-ai/glm-5.2"            # default high-quality model
    #   reasoning_effort: max          # max -> OpenRouter "xhigh" (the real ceiling)
    #   cache: true                    # prompt-cache the system prompt across files
    #   min_quantization: fp8          # accept fp8-or-higher precision endpoints only
    #   provider: "gmicloud/fp8"       # preferred provider (provider.order[0])
    #   allow_fallbacks: false         # pin the preferred provider

  # ── Remote: Ensemble (three models in parallel) ────────────────────
  remote-ensemble-geminigrok:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    api_key: $OPENROUTER_API_KEY
    # Optional: per-tool model overrides (TRDD-f45eeaa0). Absent → this
    # profile's \`model\` (back-compat). Keys must be LLM-using tool names;
    # a model set here should pass that tool's benchmark — see the
    # security-triage benchmark (/llm-externalizer-security-triage-benchmark).
    # tool_models:
    #   security_scan: "qwen/qwen-2.5-7b-instruct"
    #   code_task: "google/gemini-2.5-flash"

  # ── Remote: FREE-ONLY ensemble (zero spend) ───────────────────────
  # free_only ignores model/second_model/third_model and uses ONLY the
  # free_models pool. The top free models that clear the requirements
  # floor form the ensemble; the rest are the rate-limit fallback pool.
  # EVERY free_models entry MUST end with ':free' — the validator rejects
  # the profile otherwise, so this profile can NEVER bill.
  #
  # The 15-model seed list below matches FREE_POOL_SEED in config.ts and
  # is the canonical default. The auto-benchmark trigger (TRDD-f1510055)
  # scores this pool when the profile is first activated (free_only=true
  # + empty :free cache) and writes results to:
  #   ~/.llm-externalizer/benchmark-results.json (keyword task)
  #   ~/.llm-externalizer/security-triage-results.json (security_scan)
  # Run it manually with: /llm-externalizer:llm-externalizer-bench-free-pool
  remote-free-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    api_key: $OPENROUTER_API_KEY            # free models still need the key (rate-limited, but $0)
    free_models:
      - "poolside/laguna-m.1:free"
      - "deepseek/deepseek-v4-flash:free"
      - "google/gemma-4-26b-a4b-it:free"
      - "google/gemma-4-31b-it:free"
      - "arcee-ai/trinity-large-thinking:free"
      - "nvidia/nemotron-3-super-120b-a12b:free"
      - "nvidia/nemotron-3-nano-30b-a3b:free"
      - "minimax/minimax-m2.5:free"
      - "qwen/qwen3-next-80b-a3b-instruct:free"
      - "openai/gpt-oss-120b:free"
      - "openai/gpt-oss-20b:free"
      - "qwen/qwen3-coder:free"
      - "z-ai/glm-4.5-air:free"
      - "meta-llama/llama-3.3-70b-instruct:free"
      - "nousresearch/hermes-3-llama-3.1-405b:free"

# ── API Presets Reference ────────────────────────────────────────────
# Use with --api when creating profiles:
#
# LOCAL PRESETS (mode: local):
#   lmstudio-local    LM Studio native API     http://localhost:1234   auth: $LM_API_TOKEN
#   ollama-local      Ollama OpenAI-compat     http://localhost:11434  auth: (none)
#   vllm-local        vLLM OpenAI-compat       http://localhost:8000   auth: $VLLM_API_KEY
#   llamacpp-local    llama.cpp OpenAI-compat   http://localhost:8080   auth: (none)
#   generic-local     Any OpenAI-compat        (url required)          auth: $LM_API_TOKEN
#
# REMOTE PRESETS (mode: remote / remote-ensemble):
#   openrouter-remote  OpenRouter              https://openrouter.ai   auth: $OPENROUTER_API_KEY
#
# All local backends must support structured output (response_format: json_schema).
#
# ── Modes Reference ─────────────────────────────────────────────────
#   local             Sequential requests to a local server
#   remote            Parallel requests, single model via OpenRouter
#   remote-ensemble   Parallel requests, three models, combined report
#
# ── Auth Values ──────────────────────────────────────────────────────
# Auth fields (api_key, api_token) accept either:
#   $ENV_VAR_NAME     Resolved from process environment at runtime
#   "direct-value"    Used as-is (no env lookup)
`;
