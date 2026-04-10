#!/usr/bin/env node
/**
 * CLI for LLM Externalizer profile management.
 *
 * Usage:
 *   npx llm-externalizer profile list
 *   npx llm-externalizer profile add <name> --mode <mode> --api <api> --model <model> [options]
 *   npx llm-externalizer profile select <name>
 *   npx llm-externalizer profile edit <name> [--field value ...]
 *   npx llm-externalizer profile remove <name>
 *   npx llm-externalizer profile rename <old> <new>
 */

import {
  type Mode,
  type Profile,
  API_PRESETS,
  ensureSettingsExist,
  saveSettings,
  validateProfile,
  resolveProfile,
  getSettingsPath,
} from "./config.js";
import {
  fetchOpenRouterModelInfo,
  formatModelInfoTable,
  formatModelInfoMarkdown,
  formatModelInfoJson,
} from "./or-model-info.js";
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────

function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/** Parse --key value pairs from argv into a Record */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        // --key=value syntax
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    }
  }
  return flags;
}

/** Build a Profile from CLI flags */
function profileFromFlags(flags: Record<string, string>): Partial<Profile> {
  const p: Partial<Profile> = {};

  if (flags.mode) p.mode = flags.mode as Mode;
  if (flags.api) p.api = flags.api;
  if (flags.model) p.model = flags.model;
  if (flags.url) p.url = flags.url;
  if (flags.api_key) p.api_key = flags.api_key;
  if (flags.api_token) p.api_token = flags.api_token;
  if (flags.second_model) p.second_model = flags.second_model;
  if (flags.timeout && flags.timeout !== "null" && flags.timeout !== "") {
    const n = Number(flags.timeout);
    if (!isFinite(n) || n < 0)
      die(`--timeout must be a non-negative number, got '${flags.timeout}'`);
    p.timeout = n;
  }
  if (flags.context_window && flags.context_window !== "null" && flags.context_window !== "") {
    const n = Number(flags.context_window);
    if (!isFinite(n) || n < 0)
      die(
        `--context_window must be a non-negative number, got '${flags.context_window}'`,
      );
    p.context_window = n;
  }
  if (flags.app_name) p.app_name = flags.app_name;
  if (flags.http_referer) p.http_referer = flags.http_referer;

  return p;
}

// ── Commands ─────────────────────────────────────────────────────────

function cmdList(): void {
  const settings = ensureSettingsExist();
  const names = Object.keys(settings.profiles);
  if (names.length === 0) {
    info("No profiles configured.");
    return;
  }

  info(`Settings: ${getSettingsPath()}`);
  info(`Active:   ${settings.active || "(none)"}\n`);

  for (const name of names) {
    const p = settings.profiles[name];
    const marker = name === settings.active ? " *" : "  ";
    const ensemble = p.second_model ? ` + ${p.second_model}` : "";
    info(`${marker} ${name}  [${p.mode}]  ${p.api}  ${p.model}${ensemble}`);
  }
}

function cmdAdd(name: string, args: string[]): void {
  const settings = ensureSettingsExist();

  if (settings.profiles[name]) {
    die(`Profile '${name}' already exists. Use 'profile edit' to modify it.`);
  }

  const flags = parseFlags(args);

  if (!flags.mode)
    die("Missing required flag: --mode (local | remote | remote-ensemble)");
  if (!flags.api)
    die(
      `Missing required flag: --api (${Object.keys(API_PRESETS).join(", ")})`,
    );
  if (!flags.model) die("Missing required flag: --model <model-identifier>");

  const profile = profileFromFlags(flags) as Profile;

  // Validate before saving
  const validation = validateProfile(name, profile);
  if (!validation.valid) {
    die(
      `Profile validation failed:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  settings.profiles[name] = profile;
  saveSettings(settings);
  info(`Profile '${name}' added.`);
}

function cmdSelect(name: string): void {
  const settings = ensureSettingsExist();

  if (!settings.profiles[name]) {
    const available = Object.keys(settings.profiles).join(", ") || "(none)";
    die(`Profile '${name}' not found. Available: ${available}`);
  }

  // Validate the profile before activating
  const profile = settings.profiles[name];
  const validation = validateProfile(name, profile);
  if (!validation.valid) {
    die(
      `Cannot select profile '${name}' — validation failed:\n` +
        validation.errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  settings.active = name;
  saveSettings(settings);

  // Show resolved info
  const resolved = resolveProfile(name, profile);
  info(`Active profile: ${name}`);
  info(`  Mode:     ${resolved.mode}`);
  info(`  Protocol: ${resolved.protocol}`);
  info(`  URL:      ${resolved.url}`);
  info(`  Model:    ${resolved.model}`);
  if (resolved.secondModel) {
    info(`  Second:   ${resolved.secondModel}`);
  }
}

function cmdEdit(name: string, args: string[]): void {
  const settings = ensureSettingsExist();

  if (!settings.profiles[name]) {
    die(`Profile '${name}' not found.`);
  }

  const flags = parseFlags(args);
  if (Object.keys(flags).length === 0) {
    die(
      'No fields to edit. Use --field value pairs (e.g. --model "new-model").',
    );
  }

  // Check for fields to clear BEFORE numeric conversion
  const clearFields = Object.entries(flags)
    .filter(([, v]) => v === "" || v === "null")
    .map(([k]) => k);

  const updates = profileFromFlags(flags);
  const updated = { ...settings.profiles[name], ...updates } as Profile;

  // Remove fields explicitly set to empty string or 'null'
  for (const key of clearFields) {
    delete (updated as unknown as Record<string, unknown>)[key];
  }

  // Validate merged profile
  const validation = validateProfile(name, updated);
  if (!validation.valid) {
    die(
      `Validation failed after edit:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  settings.profiles[name] = updated;
  saveSettings(settings);
  info(`Profile '${name}' updated.`);
}

function cmdRemove(name: string): void {
  const settings = ensureSettingsExist();

  if (!settings.profiles[name]) {
    die(`Profile '${name}' not found.`);
  }

  if (name === settings.active) {
    die(
      `Cannot remove the active profile '${name}'. Select a different profile first.`,
    );
  }

  delete settings.profiles[name];
  saveSettings(settings);
  info(`Profile '${name}' removed.`);
}

function cmdRename(oldName: string, newName: string): void {
  const settings = ensureSettingsExist();

  if (!settings.profiles[oldName]) {
    die(`Profile '${oldName}' not found.`);
  }

  if (settings.profiles[newName]) {
    die(`Profile '${newName}' already exists.`);
  }

  settings.profiles[newName] = settings.profiles[oldName];
  delete settings.profiles[oldName];

  if (settings.active === oldName) {
    settings.active = newName;
  }

  saveSettings(settings);
  info(`Profile '${oldName}' renamed to '${newName}'.`);
}

// ── Usage ────────────────────────────────────────────────────────────

// ── model-info command ──────────────────────────────────────────────

async function cmdModelInfo(modelId: string, flags: Record<string, string>): Promise<void> {
  // Resolve the OpenRouter base URL and auth token.
  // Prefer the active profile's resolved values; fall back to environment
  // variables + the openrouter-remote preset default URL so this works
  // even when the active profile is local (the user might want to look
  // up an OpenRouter model regardless of which backend is active).
  const settings = ensureSettingsExist();
  const activeName = settings.active;
  const active = activeName ? settings.profiles[activeName] : undefined;

  let baseUrl = "https://openrouter.ai/api";
  let authToken: string;

  if (active && active.api === "openrouter-remote") {
    const resolved = resolveProfile(activeName, active);
    baseUrl = resolved.url;
    authToken = resolved.authToken;
  } else {
    // Fall back to env var so the user can query OpenRouter even when the
    // active profile is local.
    authToken = process.env.OPENROUTER_API_KEY ?? "";
  }

  if (!authToken) {
    die(
      "No OpenRouter auth token available. Set $OPENROUTER_API_KEY or switch to an openrouter-remote profile.",
    );
  }

  const result = await fetchOpenRouterModelInfo(modelId, baseUrl, authToken);
  if (!result.ok) {
    if (result.status === 404) {
      die(
        `OpenRouter returned 404 for model '${modelId}'. Check the id — case-sensitive, with vendor prefix and any ':free' / ':thinking' suffix.`,
      );
    }
    die(`${result.error}${result.status ? ` (status ${result.status})` : ""}`);
  }

  // Render mode: table (default) | markdown | json.
  //
  // --json accepts an optional filepath argument:
  //   --json                  → print JSON to stdout
  //   --json output.json      → write JSON to output.json, stdout shows the path
  //
  // parseFlags already handles this: `--json foo.json` → flags.json = "foo.json",
  // `--json` alone → flags.json = "true".
  const jsonFlag = flags.json;
  const useJson = jsonFlag !== undefined;
  const useMarkdown = flags.markdown === "true" || flags.plain === "true";
  const useColor =
    flags["no-color"] !== "true" && !process.env.NO_COLOR && process.stdout.isTTY !== false;

  let text: string;
  if (useJson) {
    text = formatModelInfoJson(result.data, modelId);
    // If a filepath was passed alongside --json, write to that file.
    // "true" is the sentinel parseFlags uses when the flag has no argument.
    if (jsonFlag && jsonFlag !== "true") {
      const filepath = resolvePath(jsonFlag);
      try {
        writeFileSync(filepath, text, "utf-8");
      } catch (err) {
        die(
          `Failed to write JSON to '${filepath}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      info(`JSON written to ${filepath}`);
      return;
    }
  } else if (useMarkdown) {
    text = formatModelInfoMarkdown(result.data, modelId);
  } else {
    text = formatModelInfoTable(result.data, modelId, useColor);
  }
  info(text);
}

function printUsage(): void {
  info(`LLM Externalizer — Profile Management CLI

Usage:
  llm-externalizer profile list
  llm-externalizer profile add <name> --mode <mode> --api <api> --model <model> [options]
  llm-externalizer profile select <name>
  llm-externalizer profile edit <name> --field <value> [...]
  llm-externalizer profile remove <name>
  llm-externalizer profile rename <old-name> <new-name>
  llm-externalizer model-info <model-id> [--markdown | --json [file]] [--no-color]

Modes:
  local             Sequential requests to a local server
  remote            Parallel requests, single model via OpenRouter
  remote-ensemble   Parallel requests, two models, combined report

API Presets:
  lmstudio-local    LM Studio native API     http://localhost:1234
  ollama-local      Ollama OpenAI-compat     http://localhost:11434
  vllm-local        vLLM OpenAI-compat       http://localhost:8000
  llamacpp-local    llama.cpp OpenAI-compat   http://localhost:8080
  generic-local     Any OpenAI-compat        (url required)
  openrouter-remote OpenRouter               https://openrouter.ai/api

Optional flags (for add/edit):
  --url <url>              Override preset default URL
  --api_key <key|$ENV>     API key (remote) — env var ref or direct value
  --api_token <token|$ENV> Auth token (local) — env var ref or direct value
  --second_model <model>   Second model for remote-ensemble mode
  --timeout <seconds>      Request timeout
  --context_window <size>  Context window override (0 = auto)
  --app_name <name>        App name for OpenRouter dashboard
  --http_referer <url>     HTTP Referer for OpenRouter analytics

Settings file: ${getSettingsPath()}
`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  // ── model-info top-level command ────────────────────────────────
  if (args[0] === "model-info") {
    const modelId = args[1];
    if (!modelId || modelId.startsWith("--")) {
      die("Usage: llm-externalizer model-info <model-id> [--markdown] [--no-color]");
    }
    const flags = parseFlags(args.slice(2));
    await cmdModelInfo(modelId, flags);
    return;
  }

  if (args[0] !== "profile") {
    die(`Unknown command '${args[0]}'. Use 'profile' or 'model-info' subcommand, or --help.`);
  }

  const subcommand = args[1];
  const rest = args.slice(2);

  switch (subcommand) {
    case "list":
    case "ls":
      cmdList();
      break;

    case "add":
      if (!rest[0] || rest[0].startsWith("--")) {
        die(
          "Usage: profile add <name> --mode <mode> --api <api> --model <model>",
        );
      }
      cmdAdd(rest[0], rest.slice(1));
      break;

    case "select":
    case "use":
      if (!rest[0]) die("Usage: profile select <name>");
      cmdSelect(rest[0]);
      break;

    case "edit":
      if (!rest[0] || rest[0].startsWith("--")) {
        die("Usage: profile edit <name> --field <value> [...]");
      }
      cmdEdit(rest[0], rest.slice(1));
      break;

    case "remove":
    case "rm":
      if (!rest[0]) die("Usage: profile remove <name>");
      cmdRemove(rest[0]);
      break;

    case "rename":
    case "mv":
      if (!rest[0] || !rest[1])
        die("Usage: profile rename <old-name> <new-name>");
      cmdRename(rest[0], rest[1]);
      break;

    default:
      die(
        `Unknown profile command '${subcommand}'. Use: list, add, select, edit, remove, rename.`,
      );
  }
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
