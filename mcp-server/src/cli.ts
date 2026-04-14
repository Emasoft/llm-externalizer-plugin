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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

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
    // Friendly error messages per status code. See
    // docs/openrouter/errors-and-debugging.md for the full list.
    // die() returns `never`, so this chain always exits.
    const s = result.status;
    if (s === 400) die(`OpenRouter rejected the request for '${modelId}' (400 Bad Request). ${result.error}`);
    if (s === 401) die("OpenRouter authentication failed (401). Check that $OPENROUTER_API_KEY is set and valid.");
    if (s === 402) die("OpenRouter credit exhausted (402). Add credits at https://openrouter.ai/credits or use a :free model.");
    if (s === 403) die(`OpenRouter blocked the request for '${modelId}' (403 Forbidden). The model may require moderation approval or be unavailable in your region.`);
    if (s === 404) die(`OpenRouter returned 404 for model '${modelId}'. Check the id — case-sensitive, with vendor prefix and any ':free' / ':thinking' suffix.`);
    if (s === 408) die("OpenRouter request timed out (408). Retry in a moment.");
    if (s === 429) die("OpenRouter rate limit hit (429). Wait a few seconds before retrying.");
    if (s === 502 || s === 503 || s === 504)
      die(`OpenRouter upstream error (${s}). The provider is down or unreachable — retry later.`);
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
      // CLI is more permissive than the MCP tool — relative paths are
      // resolved against process.cwd() the way users expect on a shell.
      // We still warn (on stderr via die if anything) and reject obvious
      // mistakes like empty strings.
      if (!jsonFlag.trim()) {
        die("--json filepath must be a non-empty path");
      }
      const filepath = isAbsolute(jsonFlag) ? jsonFlag : resolvePath(jsonFlag);
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

// ── search-existing-implementations ──────────────────────────────────
//
// Spawns the MCP server as a child process, calls the
// search_existing_implementations tool, prints the text result, exits.
// This is a thin shell over the MCP tool — all the heavy lifting
// (walking, per-file dispatch, ensemble, auto-batching) happens in
// index.ts. The CLI is just a convenience wrapper for shell/CI use.

interface SearchExistingOpts {
  description: string;
  folderPaths: string[];
  sourceFiles: string[];
  diffPath?: string;
  base?: string;
  free: boolean;
  outputDir?: string;
  extensions?: string[];
  excludeDirs?: string[];
  useGitignore?: boolean;
  answerMode?: number;
  maxFiles?: number;
}

/** Locate the compiled server entry point (dist/index.js) next to this CLI. */
function findServerScript(): string {
  // dist/cli.js → ../dist/index.js (same dir when running from dist/)
  // src/cli.ts → ../dist/index.js (when running via ts-node or similar)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "index.js"),           // running from dist/
    join(here, "..", "dist", "index.js"), // running from src/
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  die(
    `Cannot locate MCP server entry point. Looked for:\n  ${candidates.join("\n  ")}`,
  );
}

/** Parse repeatable / comma-separated list flags like --in a --in b,c */
function collectListFlag(args: string[], flagName: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${flagName}`) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out.push(...next.split(",").map((s) => s.trim()).filter(Boolean));
        i++;
      }
    } else if (a.startsWith(`--${flagName}=`)) {
      const value = a.slice(flagName.length + 3);
      out.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

/** Generate a PR diff via git diff <base>...HEAD -- <src-files>, return the temp path. */
function generateGitDiff(base: string, sourceFiles: string[]): string {
  if (sourceFiles.length === 0) {
    die("--base requires at least one --src <file>; cannot generate a diff with no files.");
  }
  const cwdIsGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  if (cwdIsGit.status !== 0) {
    die("cwd is not a git repository; pass --diff <path> or run from inside a git checkout.");
  }
  const outPath = join(tmpdir(), `llm-ext-search-existing-diff-${Date.now()}.patch`);
  const result = spawnSync(
    "git",
    ["diff", `${base}...HEAD`, "--", ...sourceFiles],
    { cwd: process.cwd(), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    die(
      `git diff ${base}...HEAD failed: ${result.stderr?.trim() || "unknown error"}`,
    );
  }
  const diffText = result.stdout ?? "";
  if (!diffText.trim()) {
    die(
      `diff vs ${base} is empty for ${sourceFiles.length} source file(s); nothing to review.`,
    );
  }
  writeFileSync(outPath, diffText, "utf-8");
  return outPath;
}

/** Auto-detect the default base branch: origin/HEAD, then main, then master. */
function autoDetectBase(): string {
  const originHead = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: process.cwd(), encoding: "utf-8" },
  );
  if (originHead.status === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim();
  }
  for (const ref of ["main", "master"]) {
    const check = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    if (check.status === 0) return ref;
  }
  die(
    "Cannot auto-detect base branch (no origin/HEAD, main, or master). " +
      "Pass --base <ref> or --diff <path> explicitly.",
  );
}

/** Parse the `search-existing` CLI args into a structured options record. */
function parseSearchExistingArgs(args: string[]): SearchExistingOpts {
  // Positional args: first non-flag arg is the description; subsequent
  // non-flag args are source files (positional). Flags override.
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx !== -1) {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = "true";
        }
      }
    } else {
      positional.push(a);
    }
  }

  // Description comes from --description flag, else first positional arg.
  const description =
    flags.description ?? flags.desc ?? positional.shift() ?? "";
  if (!description.trim()) {
    die(
      'Missing description. Usage: llm-externalizer search-existing "<description>" [<src-files>...] --in <path> ...',
    );
  }

  // Positional remainder: source files (optional)
  const positionalSources = positional.slice();

  // Collect list flags
  const folderPaths = collectListFlag(args, "in");
  const srcFromFlag = collectListFlag(args, "src");
  const sourceFiles = [...positionalSources, ...srcFromFlag];
  const excludeDirs = collectListFlag(args, "exclude-dirs");
  const extensions = collectListFlag(args, "extensions");

  if (folderPaths.length === 0) {
    die("--in <path> is required (codebase folder to scan). Can be repeated or comma-separated.");
  }

  // Validate paths exist before calling the server
  for (const fp of folderPaths) {
    const abs = isAbsolute(fp) ? fp : resolvePath(fp);
    if (!existsSync(abs)) die(`--in path not found: ${fp}`);
    if (!statSync(abs).isDirectory()) die(`--in path is not a directory: ${fp}`);
  }
  for (const sf of sourceFiles) {
    const abs = isAbsolute(sf) ? sf : resolvePath(sf);
    if (!existsSync(abs)) die(`Source file not found: ${sf}`);
  }

  return {
    description,
    folderPaths: folderPaths.map((p) => (isAbsolute(p) ? p : resolvePath(p))),
    sourceFiles: sourceFiles.map((p) => (isAbsolute(p) ? p : resolvePath(p))),
    diffPath: flags.diff && flags.diff !== "true" ? flags.diff : undefined,
    base: flags.base && flags.base !== "true" ? flags.base : undefined,
    free: flags.free === "true",
    outputDir:
      flags["output-dir"] && flags["output-dir"] !== "true"
        ? flags["output-dir"]
        : undefined,
    extensions: extensions.length > 0 ? extensions : undefined,
    excludeDirs: excludeDirs.length > 0 ? excludeDirs : undefined,
    useGitignore: flags["no-gitignore"] === "true" ? false : undefined, // default true server-side
    answerMode:
      flags["answer-mode"] && /^\d+$/.test(flags["answer-mode"])
        ? Number(flags["answer-mode"])
        : undefined,
    maxFiles:
      flags["max-files"] && /^\d+$/.test(flags["max-files"])
        ? Number(flags["max-files"])
        : undefined,
  };
}

async function cmdSearchExisting(rawArgs: string[]): Promise<void> {
  const opts = parseSearchExistingArgs(rawArgs);

  // Resolve the diff path: explicit --diff → use as-is; --base → generate via git;
  // neither → auto-detect base branch and generate, but ONLY if source files exist.
  // With no source files and no base, skip the diff entirely.
  let diffPath = opts.diffPath;
  if (!diffPath && opts.sourceFiles.length > 0) {
    const base = opts.base ?? autoDetectBase();
    diffPath = generateGitDiff(base, opts.sourceFiles);
    info(`Generated PR diff via git: ${diffPath}`);
  } else if (opts.diffPath) {
    const abs = isAbsolute(opts.diffPath) ? opts.diffPath : resolvePath(opts.diffPath);
    if (!existsSync(abs)) die(`--diff file not found: ${opts.diffPath}`);
    diffPath = abs;
  }

  // Build the tool arguments — omit fields that are undefined so the server
  // sees a minimal call.
  const toolArgs: Record<string, unknown> = {
    feature_description: opts.description,
    folder_path: opts.folderPaths.length === 1 ? opts.folderPaths[0] : opts.folderPaths,
    answer_mode: opts.answerMode ?? 0,
  };
  if (opts.sourceFiles.length > 0) toolArgs.source_files = opts.sourceFiles;
  if (diffPath) toolArgs.diff_path = diffPath;
  if (opts.extensions) toolArgs.extensions = opts.extensions;
  if (opts.excludeDirs) toolArgs.exclude_dirs = opts.excludeDirs;
  if (opts.useGitignore === false) toolArgs.use_gitignore = false;
  if (opts.maxFiles) toolArgs.max_files = opts.maxFiles;
  if (opts.free) toolArgs.free = true;
  if (opts.outputDir) toolArgs.output_dir = opts.outputDir;

  // Spawn the MCP server as a child process and call the tool via stdio.
  const serverScript = findServerScript();
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverScript],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client(
    { name: "llm-externalizer-cli", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "search_existing_implementations", arguments: toolArgs },
      undefined,
      { timeout: 900_000 }, // 15 min — full scans on large codebases can take time
    );
    const content = result.content as Array<{ type: string; text: string }>;
    for (const c of content) {
      if (c.type === "text") info(c.text);
    }
    if (result.isError) {
      process.exit(1);
    }
  } finally {
    try {
      await transport.close();
    } catch {
      /* ignore cleanup errors */
    }
  }
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
  llm-externalizer search-existing "<description>" [<src-files>...] --in <path> [--base <ref>] [--diff <path>] [--free]

search-existing flags:
  --in <path>          (MANDATORY) Codebase folder to scan. Repeat or comma-separate.
  --src <path>         Alternative to positional source-file args. Repeatable.
  --base <ref>         Git ref to diff against (default: origin/HEAD → main → master).
                       Only used when source files are given.
  --diff <path>        Pre-made unified-diff file (overrides --base).
  --extensions <a,b>   Language extensions to scan. Auto-detected from src files.
  --exclude-dirs <a,b> Extra dirs to skip.
  --max-files <n>      Max files to process (default 2500).
  --no-gitignore       Disable .gitignore filtering (default: enabled).
  --answer-mode <n>    0 = per-file reports (default), 1/2 = merged.
  --free               Use free Nemotron model (lower quality, prompts logged).
  --output-dir <path>  Custom reports directory.

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

  // ── search-existing top-level command ───────────────────────────
  if (args[0] === "search-existing" || args[0] === "search-existing-implementations") {
    await cmdSearchExisting(args.slice(1));
    return;
  }

  if (args[0] !== "profile") {
    die(`Unknown command '${args[0]}'. Use 'profile', 'model-info', or 'search-existing' subcommand, or --help.`);
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
