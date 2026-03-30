/**
 * Profile-based configuration for the LLM Externalizer MCP server.
 *
 * Single source of truth for settings.yaml loading, saving, validation,
 * and resolution. Used by the server (index.ts), CLI (cli.ts), and tests.
 *
 * Settings file: ~/.llm-externalizer/settings.yaml
 * Backups:       ~/.llm-externalizer/backups/settings_<timestamp>.yaml
 *
 * Cross-platform: uses os.homedir() + path.join() for all paths.
 * Works on macOS, Linux, and Windows WSL.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

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
  /** Default max parallel requests (0 = auto-detect or sequential) */
  defaultMaxConcurrent: number;
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
  /** Request timeout in seconds */
  timeout?: number;
  /** Context window override (0 = auto-detect) */
  context_window?: number;
  /** Max parallel requests (0 = auto) */
  max_concurrent?: number;
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
  timeout: number;
  contextWindow: number;
  maxConcurrent: number;
  appName: string;
  httpReferer: string;
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
    defaultMaxConcurrent: 0,
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
    defaultMaxConcurrent: 0,
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
    defaultMaxConcurrent: 0,
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
    defaultMaxConcurrent: 0,
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
    defaultMaxConcurrent: 0,
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
    defaultTimeout: 120,
    defaultMaxConcurrent: 0,
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
  const dir = resolve(process.env.LLM_EXT_CONFIG_DIR || join(homedir(), ".llm-externalizer"));
  // M8: Path traversal guard — config dir must be under homedir() or /tmp
  const home = homedir();
  if (!dir.startsWith(home + "/") && !dir.startsWith("/tmp/") && dir !== home && dir !== "/tmp") {
    throw new Error(`Config directory '${dir}' is outside allowed paths (${home} or /tmp)`);
  }
  return dir;
}

/** Settings file: ~/.llm-externalizer/settings.yaml */
export function getSettingsPath(): string {
  return join(getConfigDir(), "settings.yaml");
}

/** Backup directory: ~/.llm-externalizer/backups/ */
export function getBackupDir(): string {
  return join(getConfigDir(), "backups");
}

// ── Env var resolution ──────────────────────────────────────────────

/**
 * Resolve a value that may be an env var reference.
 * - Values starting with '$' are env var names → resolved from process.env
 * - All other values are direct values → returned as-is
 * - Empty/undefined → returns ''
 */
export function resolveEnvValue(value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("$")) {
    // M9: Trim env var name to prevent whitespace injection (e.g. "$VAR_NAME ")
    return process.env[value.slice(1).trim()] || "";
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

/**
 * Save settings to disk. Creates a timestamped backup of the previous
 * file before overwriting. Creates config and backup directories if needed.
 */
export function saveSettings(settings: Settings): void {
  const settingsPath = getSettingsPath();
  const configDir = getConfigDir();
  const backupDir = getBackupDir();

  mkdirSync(configDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  // L: Restrict backup directory permissions to owner-only (0o700)
  chmodSync(backupDir, 0o700);

  // Timestamped backup of existing file (done BEFORE temp write)
  if (existsSync(settingsPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `settings_${ts}.yaml`);
    copyFileSync(settingsPath, backupPath);
  }

  // M7: Atomic write — write to temp file first, then rename (atomic on same filesystem)
  const yaml = yamlStringify(settings, { lineWidth: 120 });
  const tmpPath = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, yaml, "utf-8");
  renameSync(tmpPath, settingsPath);
  // Restrict permissions — settings may contain API keys in plaintext
  try { chmodSync(settingsPath, 0o600); } catch { /* Windows may not support chmod */ }
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

  if (!profile.model) {
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

  // ── second_model rules ────────────────────────────────────────────
  if (profile.mode === "remote-ensemble" && !profile.second_model) {
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

  // ── LM Studio native API constraints ──────────────────────────────
  if (profile.api === "lmstudio-local") {
    if (profile.second_model) {
      errors.push("LM Studio native API does not support second_model");
    }
    if (profile.max_concurrent !== undefined && profile.max_concurrent !== 0) {
      errors.push(
        "LM Studio native API is sequential only (max_concurrent must be 0 or omitted)",
      );
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
  if (
    profile.max_concurrent !== undefined &&
    (typeof profile.max_concurrent !== "number" ||
      !isFinite(profile.max_concurrent) ||
      profile.max_concurrent < 0)
  ) {
    errors.push(
      `Profile '${name}': max_concurrent must be a non-negative finite number`,
    );
  }

  // M10: Upper bounds on numeric overrides to prevent resource abuse
  if (typeof profile.timeout === "number" && profile.timeout > 3600) {
    errors.push(`Profile '${name}': timeout must be <= 3600 (1 hour)`);
  }
  if (typeof profile.max_concurrent === "number" && profile.max_concurrent > 32) {
    errors.push(`Profile '${name}': max_concurrent must be <= 32`);
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
        "No active profile set. Use: npx llm-externalizer profile select <name>",
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

  // Auth: api_key for remote presets, api_token for local presets
  const rawAuth = preset.isLocal
    ? profile.api_token || preset.defaultAuthEnv
    : profile.api_key || preset.defaultAuthEnv;

  return {
    name,
    mode: profile.mode,
    protocol: preset.protocol,
    url: profile.url || preset.defaultUrl,
    model: profile.model,
    authToken: resolveEnvValue(rawAuth),
    secondModel: profile.second_model || "",
    timeout: profile.timeout ?? preset.defaultTimeout,
    contextWindow: profile.context_window ?? preset.defaultContextWindow,
    maxConcurrent: profile.max_concurrent ?? preset.defaultMaxConcurrent,
    appName: profile.app_name ?? preset.defaultAppName,
    httpReferer: profile.http_referer ?? preset.defaultHttpReferer,
  };
}

// ── Settings template ───────────────────────────────────────────────
// Written on first run for human readability (comments are preserved).
// Subsequent saves via saveSettings() use yamlStringify (no comments).

export const SETTINGS_TEMPLATE = `# ──────────────────────────────────────────────────────────────────────
# LLM Externalizer — Settings
# ──────────────────────────────────────────────────────────────────────
# Profile-based configuration. Each profile defines a complete LLM
# backend setup. Switch profiles with:
#   npx llm-externalizer profile select <name>
# Or via MCP: get_settings / set_settings
#
# Location: ~/.llm-externalizer/settings.yaml
# Backups:  ~/.llm-externalizer/backups/
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

  # ── Remote: Ensemble (two models in parallel) ─────────────────────
  remote-ensemble-geminigrok:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    api_key: $OPENROUTER_API_KEY

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
#   remote-ensemble   Parallel requests, two models, combined report
#
# ── Auth Values ──────────────────────────────────────────────────────
# Auth fields (api_key, api_token) accept either:
#   $ENV_VAR_NAME     Resolved from process environment at runtime
#   "direct-value"    Used as-is (no env lookup)
`;
