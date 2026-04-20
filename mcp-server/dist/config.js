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
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as yamlParse } from "yaml";
// ── API Presets ──────────────────────────────────────────────────────
// Each preset bundles protocol + default connection settings.
// Names use -local / -remote suffix to prevent mode/preset mismatches.
export const API_PRESETS = {
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
export function getConfigDir() {
    let dir = resolve(process.env.LLM_EXT_CONFIG_DIR || join(homedir(), ".llm-externalizer"));
    // Follow symlinks to detect if the resolved target is outside allowed boundaries
    try {
        dir = realpathSync(dir);
    }
    catch { /* dir may not exist yet — resolve() is sufficient */ }
    // M8: Path traversal guard — config dir must be under homedir() or /tmp.
    // Resolve home and /tmp through symlinks so the comparison uses canonical paths
    // (e.g. /tmp → /private/tmp on macOS; homedir() may also be a symlink).
    const home = (() => { try {
        return realpathSync(homedir());
    }
    catch {
        return homedir();
    } })();
    const tmpCanonical = (() => { try {
        return realpathSync("/tmp");
    }
    catch {
        return "/tmp";
    } })();
    const sep = process.platform === "win32" ? "\\" : "/";
    const underHome = dir.startsWith(home + sep) || dir === home;
    const underTmp = dir.startsWith(tmpCanonical + sep) || dir === tmpCanonical;
    if (!underHome && !underTmp) {
        throw new Error(`Config directory '${dir}' is outside allowed paths (${home} or ${tmpCanonical})`);
    }
    return dir;
}
/** Settings file: ~/.llm-externalizer/settings.yaml */
export function getSettingsPath() {
    return join(getConfigDir(), "settings.yaml");
}
// ── Env var resolution ──────────────────────────────────────────────
// Map of env-var names that have a corresponding plugin.json userConfig key.
// When the user sets a value via the Claude Code plugin config UI, Claude
// exports it as CLAUDE_PLUGIN_OPTION_<KEY> to this subprocess. We transparently
// map that into the canonical env-var name the rest of the code reads from,
// so both new (userConfig) and old (shell env var) setups work unchanged.
// Preference: userConfig wins over shell env if both are set.
const USER_CONFIG_ENV_MAP = {
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
export function resolveEnvValue(value) {
    if (!value)
        return "";
    if (value.startsWith("$")) {
        // M9: Trim env var name to prevent whitespace injection (e.g. "$VAR_NAME ")
        const name = value.slice(1).trim();
        const userConfigVar = USER_CONFIG_ENV_MAP[name];
        if (userConfigVar) {
            const userConfigVal = process.env[userConfigVar];
            if (userConfigVal && userConfigVal.length > 0)
                return userConfigVal;
        }
        return process.env[name] || "";
    }
    return value;
}
// ── URL validation ──────────────────────────────────────────────────
const LOCAL_URL_PATTERN = /\/\/localhost([:/]|$)|\/\/127\.\d+\.\d+\.\d+|\/\/192\.168\.\d+\.\d+|\/\/10\.\d+\.\d+\.\d+|\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\/\/\[::1\]|\/\/0\.0\.0\.0/i;
/** Check if a URL points to a local/private network address */
export function isLocalUrl(url) {
    return LOCAL_URL_PATTERN.test(url);
}
// ── Settings load / save ────────────────────────────────────────────
/**
 * Load settings.yaml from the config directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadSettings() {
    const settingsPath = getSettingsPath();
    try {
        if (!existsSync(settingsPath))
            return null;
        const raw = readFileSync(settingsPath, "utf-8");
        // H10: Sanitize YAML output to strip __proto__ and prevent prototype pollution
        const parsed = JSON.parse(JSON.stringify(yamlParse(raw)));
        if (!parsed || typeof parsed !== "object")
            return null;
        return {
            active: parsed.active || "",
            profiles: parsed.profiles || {},
        };
    }
    catch (err) {
        process.stderr.write(`[llm-externalizer] Warning: Failed to read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}\n`);
        return null;
    }
}
/** Default settings with 4 predefined profiles */
export function generateDefaultSettings() {
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
export function ensureSettingsExist() {
    const settingsPath = getSettingsPath();
    const configDir = getConfigDir();
    // Warn about old settings.yml if it exists alongside new path
    const oldSettingsPath = join(configDir, "settings.yml");
    if (existsSync(oldSettingsPath) && !existsSync(settingsPath)) {
        process.stderr.write(`[llm-externalizer] Found old settings.yml — the new format is settings.yaml with profiles.\n` +
            `[llm-externalizer] Generating new settings.yaml. Your old settings.yml is preserved but no longer read.\n`);
    }
    if (!existsSync(settingsPath)) {
        mkdirSync(configDir, { recursive: true });
        // First run: write commented template for human readability
        writeFileSync(settingsPath, SETTINGS_TEMPLATE, "utf-8");
        // Restrict permissions immediately — users may add API keys to the template,
        // so default umask (0644) is not safe.
        try {
            chmodSync(settingsPath, 0o600);
        }
        catch { /* Windows may not support chmod */ }
        process.stderr.write(`[llm-externalizer] Generated default settings at ${settingsPath}\n`);
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
export function validateProfile(name, profile) {
    const errors = [];
    // ── Required fields ───────────────────────────────────────────────
    if (!profile.mode) {
        errors.push(`Profile '${name}': missing required field: mode`);
    }
    else if (!["local", "remote", "remote-ensemble"].includes(profile.mode)) {
        errors.push(`Invalid mode '${profile.mode}'. Must be: local, remote, or remote-ensemble`);
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
        errors.push(`Unknown api preset '${profile.api}'. Valid presets: ${Object.keys(API_PRESETS).join(", ")}`);
        // Can't validate further without a valid preset
        return { valid: false, errors };
    }
    if (!preset || !profile.mode) {
        return { valid: false, errors };
    }
    // ── Mode ↔ preset suffix compatibility ────────────────────────────
    if (profile.mode === "local" && !preset.isLocal) {
        errors.push(`Mode 'local' requires a -local api preset, got '${profile.api}'`);
    }
    if ((profile.mode === "remote" || profile.mode === "remote-ensemble") &&
        preset.isLocal) {
        errors.push(`Mode '${profile.mode}' requires a -remote api preset, got '${profile.api}'`);
    }
    // ── second_model / third_model rules ──────────────────────────────
    if (profile.mode === "remote-ensemble" && !profile.second_model) {
        errors.push("Mode 'remote-ensemble' requires 'second_model'");
    }
    if (profile.mode === "local" && profile.second_model) {
        errors.push("Mode 'local' does not support 'second_model'");
    }
    if (profile.mode === "remote" && profile.second_model) {
        errors.push("Mode 'remote' does not support 'second_model'. Use 'remote-ensemble'");
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
        if ((profile.mode === "remote" || profile.mode === "remote-ensemble") &&
            urlIsLocal) {
            errors.push(`Remote mode cannot use local URL '${effectiveUrl}'`);
        }
    }
    // generic-local requires explicit url (no default)
    if (profile.api === "generic-local" && !profile.url) {
        errors.push("Api preset 'generic-local' requires explicit 'url'");
    }
    // ── Numeric field validation ─────────────────────────────────────
    if (profile.timeout !== undefined &&
        (typeof profile.timeout !== "number" ||
            !isFinite(profile.timeout) ||
            profile.timeout < 0)) {
        errors.push(`Profile '${name}': timeout must be a non-negative finite number`);
    }
    if (profile.context_window !== undefined &&
        (typeof profile.context_window !== "number" ||
            !isFinite(profile.context_window) ||
            profile.context_window < 0)) {
        errors.push(`Profile '${name}': context_window must be a non-negative finite number`);
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
    return { valid: errors.length === 0, errors };
}
/**
 * Validate entire settings: active profile must exist and be valid.
 */
export function validateSettings(settings) {
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
 * Resolve a profile to concrete connection values.
 * Merges profile overrides with preset defaults and resolves env var refs.
 */
export function resolveProfile(name, profile) {
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
        thirdModel: profile.third_model || "",
        timeout: profile.timeout ?? preset.defaultTimeout,
        contextWindow: profile.context_window ?? preset.defaultContextWindow,
        appName: profile.app_name ?? preset.defaultAppName,
        httpReferer: profile.http_referer ?? preset.defaultHttpReferer,
    };
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

  # ── Remote: Ensemble (three models in parallel) ────────────────────
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
#   remote-ensemble   Parallel requests, three models, combined report
#
# ── Auth Values ──────────────────────────────────────────────────────
# Auth fields (api_key, api_token) accept either:
#   $ENV_VAR_NAME     Resolved from process environment at runtime
#   "direct-value"    Used as-is (no env lookup)
`;
//# sourceMappingURL=config.js.map