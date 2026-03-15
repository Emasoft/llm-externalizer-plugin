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
export declare const API_PRESETS: Record<string, ApiPreset>;
/** Config directory: ~/.llm-externalizer (or LLM_EXT_CONFIG_DIR for CI) */
export declare function getConfigDir(): string;
/** Settings file: ~/.llm-externalizer/settings.yaml */
export declare function getSettingsPath(): string;
/** Backup directory: ~/.llm-externalizer/backups/ */
export declare function getBackupDir(): string;
/**
 * Resolve a value that may be an env var reference.
 * - Values starting with '$' are env var names → resolved from process.env
 * - All other values are direct values → returned as-is
 * - Empty/undefined → returns ''
 */
export declare function resolveEnvValue(value: string | undefined): string;
/** Check if a URL points to a local/private network address */
export declare function isLocalUrl(url: string): boolean;
/**
 * Load settings.yaml from the config directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export declare function loadSettings(): Settings | null;
/**
 * Save settings to disk. Creates a timestamped backup of the previous
 * file before overwriting. Creates config and backup directories if needed.
 */
export declare function saveSettings(settings: Settings): void;
/** Default settings with 4 predefined profiles */
export declare function generateDefaultSettings(): Settings;
/**
 * Ensure settings.yaml exists. If not, generate default with comments.
 * Also warns if old settings.yml exists (migration hint).
 */
export declare function ensureSettingsExist(): Settings;
/**
 * Validate a single profile for correctness and consistency.
 * Returns { valid: true, errors: [] } or { valid: false, errors: [...] }.
 */
export declare function validateProfile(name: string, profile: Profile): ValidationResult;
/**
 * Validate entire settings: active profile must exist and be valid.
 */
export declare function validateSettings(settings: Settings): ValidationResult;
/**
 * Resolve a profile to concrete connection values.
 * Merges profile overrides with preset defaults and resolves env var refs.
 */
export declare function resolveProfile(name: string, profile: Profile): ResolvedProfile;
export declare const SETTINGS_TEMPLATE = "# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# LLM Externalizer \u2014 Settings\n# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# Profile-based configuration. Each profile defines a complete LLM\n# backend setup. Switch profiles with:\n#   npx llm-externalizer profile select <name>\n# Or via MCP: get_settings / set_settings\n#\n# Location: ~/.llm-externalizer/settings.yaml\n# Backups:  ~/.llm-externalizer/backups/\n# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n# Active profile name\nactive: local-lmstudio-qwen35\n\n# \u2500\u2500 Profiles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nprofiles:\n\n  # \u2500\u2500 Local: LM Studio with Qwen 3.5 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  local-lmstudio-qwen35:\n    mode: local\n    api: lmstudio-local\n    model: \"thecluster/qwen3.5-27b-mlx\"\n    # url: \"http://localhost:1234\"       # (default from lmstudio-local preset)\n    # api_token: $LM_API_TOKEN           # (default from lmstudio-local preset)\n    # timeout: 300                        # (default from lmstudio-local preset)\n\n  # \u2500\u2500 Local: Ollama with Qwen 3 14B \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  local-ollama-qwen314:\n    mode: local\n    api: ollama-local\n    model: \"qwen3:14b\"\n    # url: \"http://localhost:11434\"       # (default from ollama-local preset)\n\n  # \u2500\u2500 Remote: Single model via OpenRouter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  remote-single-geminiflash:\n    mode: remote\n    api: openrouter-remote\n    model: \"google/gemini-2.5-flash\"\n    api_key: $OPENROUTER_API_KEY          # set this env var, or replace with direct key\n\n  # \u2500\u2500 Remote: Ensemble (two models in parallel) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  remote-ensemble-geminigrok:\n    mode: remote-ensemble\n    api: openrouter-remote\n    model: \"google/gemini-2.5-flash\"\n    second_model: \"x-ai/grok-4.1-fast\"\n    api_key: $OPENROUTER_API_KEY\n\n# \u2500\u2500 API Presets Reference \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# Use with --api when creating profiles:\n#\n# LOCAL PRESETS (mode: local):\n#   lmstudio-local    LM Studio native API     http://localhost:1234   auth: $LM_API_TOKEN\n#   ollama-local      Ollama OpenAI-compat     http://localhost:11434  auth: (none)\n#   vllm-local        vLLM OpenAI-compat       http://localhost:8000   auth: $VLLM_API_KEY\n#   llamacpp-local    llama.cpp OpenAI-compat   http://localhost:8080   auth: (none)\n#   generic-local     Any OpenAI-compat        (url required)          auth: $LM_API_TOKEN\n#\n# REMOTE PRESETS (mode: remote / remote-ensemble):\n#   openrouter-remote  OpenRouter              https://openrouter.ai   auth: $OPENROUTER_API_KEY\n#\n# All local backends must support structured output (response_format: json_schema).\n#\n# \u2500\u2500 Modes Reference \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n#   local             Sequential requests to a local server\n#   remote            Parallel requests, single model via OpenRouter\n#   remote-ensemble   Parallel requests, two models, combined report\n#\n# \u2500\u2500 Auth Values \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# Auth fields (api_key, api_token) accept either:\n#   $ENV_VAR_NAME     Resolved from process environment at runtime\n#   \"direct-value\"    Used as-is (no env lookup)\n";
