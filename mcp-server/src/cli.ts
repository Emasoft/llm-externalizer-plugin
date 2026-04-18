#!/usr/bin/env node
/**
 * CLI for LLM Externalizer.
 *
 * NOTE: Profile-mutating subcommands (add / select / edit / remove / rename)
 * are DISABLED by design. Model and profile configuration is user-only —
 * the user must edit ~/.llm-externalizer/settings.yaml manually with an
 * editor, then either restart Claude Code or call the MCP "reset" tool to
 * reload. Read-only subcommands (list, model-info, search-existing) remain
 * available.
 *
 * Usage:
 *   npx llm-externalizer profile list
 *   npx llm-externalizer model-info <model-id> [options]
 *   npx llm-externalizer search-existing "<description>" [<src-files>...] --in <path>
 */

import {
  ensureSettingsExist,
  getSettingsPath,
  resolveProfile,
} from "./config.js";
import {
  fetchOpenRouterModelInfo,
  formatModelInfoTable,
  formatModelInfoMarkdown,
  formatModelInfoJson,
} from "./or-model-info.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
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

// Mutation commands (add / select / edit / remove / rename) were removed.
// Model & profile configuration is user-only — edit ~/.llm-externalizer/settings.yaml
// manually, then restart Claude Code or call the MCP "reset" tool to reload.

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
  maxPayloadKb?: number;
  redactRegex?: string;
  timeoutMs?: number;
}

// Default CLI → MCP callTool timeout: 4 hours.
// A 10k-file scan packs into ~500 FFD batches at 400 KB/batch; each batch
// is one ensemble call (~10-60s with reasoning models). Worst case that's
// ~8h of wall time, but typical runs finish in under 2h. We pick 4h as the
// default because it's the sweet spot between "long enough for most 10k
// scans" and "short enough that a stuck call doesn't linger forever". Users
// can override with --timeout-hours <n> or set it to 0 to disable.
const DEFAULT_SEARCH_TIMEOUT_MS = 4 * 60 * 60 * 1000;

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
  if (cwdIsGit.error) {
    const err = cwdIsGit.error as NodeJS.ErrnoException;
    die(`Failed to spawn git: ${err.message}`);
  }
  if (cwdIsGit.status !== 0) {
    die("cwd is not a git repository; pass --diff <path> or run from inside a git checkout.");
  }
  const outPath = join(tmpdir(), `llm-ext-search-existing-diff-${Date.now()}.patch`);
  // 256 MB buffer is large enough to hold any realistic PR diff (a 10k-line
  // diff is ~1 MB, a 100k-line generated-code diff is ~15 MB). A PR touching
  // a megabyte of lockfile changes can exceed 64 MB; bumping here prevents
  // silent truncation. If this is still not enough we detect it below.
  const result = spawnSync(
    "git",
    ["diff", `${base}...HEAD`, "--", ...sourceFiles],
    { cwd: process.cwd(), encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
  // Detect three distinct failure modes explicitly:
  //   1. spawn error (git not on PATH, exec failure) — result.error is set
  //   2. git exit non-zero (bad ref, bad args) — result.status is non-zero
  //   3. maxBuffer overflow (ENOBUFS) — result.error.code === "ENOBUFS"
  //      OR the process was killed with SIGTERM, OR result.signal is set
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOBUFS") {
      die(
        `git diff ${base}...HEAD exceeded 256 MB buffer. The PR diff is too large ` +
          `for in-memory capture. Generate the diff manually with ` +
          `'git diff ${base}...HEAD -- <files> > /tmp/pr.patch' and pass it via --diff.`,
      );
    }
    die(`Failed to spawn git: ${err.message}`);
  }
  if (result.signal) {
    die(
      `git diff ${base}...HEAD was killed by signal ${result.signal}. ` +
        `Most likely the output exceeded the buffer; generate the diff ` +
        `manually and pass it via --diff.`,
    );
  }
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
  try {
    writeFileSync(outPath, diffText, "utf-8");
  } catch (err) {
    die(
      `Failed to write diff to '${outPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return outPath;
}

/** Auto-detect the default base branch: origin/HEAD, then main, then master. */
function autoDetectBase(): string {
  const originHead = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: process.cwd(), encoding: "utf-8" },
  );
  if (originHead.error) {
    const err = originHead.error as NodeJS.ErrnoException;
    die(`Failed to spawn git: ${err.message}`);
  }
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
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch (err) {
      die(
        `Cannot stat --in path '${fp}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isDir) die(`--in path is not a directory: ${fp}`);
  }
  for (const sf of sourceFiles) {
    const abs = isAbsolute(sf) ? sf : resolvePath(sf);
    if (!existsSync(abs)) die(`Source file not found: ${sf}`);
  }

  // timeout-hours is parsed as a float (e.g. 0.5 for 30 minutes). 0 disables.
  let timeoutMs: number | undefined = undefined;
  if (flags["timeout-hours"] && flags["timeout-hours"] !== "true") {
    const hours = Number(flags["timeout-hours"]);
    if (!Number.isFinite(hours) || hours < 0) {
      die(`Invalid --timeout-hours: ${flags["timeout-hours"]}`);
    }
    timeoutMs = hours === 0 ? 0 : Math.round(hours * 60 * 60 * 1000);
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
    maxPayloadKb:
      flags["max-payload-kb"] && /^\d+$/.test(flags["max-payload-kb"])
        ? Number(flags["max-payload-kb"])
        : undefined,
    redactRegex:
      flags["redact-regex"] && flags["redact-regex"] !== "true"
        ? flags["redact-regex"]
        : undefined,
    timeoutMs,
  };
}

async function cmdSearchExisting(rawArgs: string[]): Promise<void> {
  const opts = parseSearchExistingArgs(rawArgs);

  // Resolve the diff path: explicit --diff → use as-is; --base → generate via git;
  // neither → auto-detect base branch and generate, but ONLY if source files exist.
  // With no source files and no base, skip the diff entirely.
  let diffPath = opts.diffPath;
  let autoGeneratedDiffPath: string | undefined;
  if (!diffPath && opts.sourceFiles.length > 0) {
    const base = opts.base ?? autoDetectBase();
    diffPath = generateGitDiff(base, opts.sourceFiles);
    autoGeneratedDiffPath = diffPath;
    info(`Generated PR diff via git: ${diffPath}`);
  } else if (opts.diffPath) {
    const abs = isAbsolute(opts.diffPath) ? opts.diffPath : resolvePath(opts.diffPath);
    if (!existsSync(abs)) die(`--diff file not found: ${opts.diffPath}`);
    diffPath = abs;
  }

  // Build the tool arguments — omit fields that are undefined so the server
  // sees a minimal call and its schema defaults apply. Never default
  // answer_mode on the CLI side — let the server decide (2 = single merged
  // report for this tool). The earlier v3.14.x CLI defaulted to 0, which
  // invisibly forced the handler into its mode-1 fallback path. Omitting
  // keeps CLI and direct MCP callers in sync.
  const toolArgs: Record<string, unknown> = {
    feature_description: opts.description,
    folder_path: opts.folderPaths.length === 1 ? opts.folderPaths[0] : opts.folderPaths,
  };
  if (opts.sourceFiles.length > 0) toolArgs.source_files = opts.sourceFiles;
  if (diffPath) toolArgs.diff_path = diffPath;
  if (opts.extensions) toolArgs.extensions = opts.extensions;
  if (opts.excludeDirs) toolArgs.exclude_dirs = opts.excludeDirs;
  if (opts.useGitignore === false) toolArgs.use_gitignore = false;
  if (opts.maxFiles !== undefined) toolArgs.max_files = opts.maxFiles;
  if (opts.maxPayloadKb !== undefined) toolArgs.max_payload_kb = opts.maxPayloadKb;
  if (opts.answerMode !== undefined) toolArgs.answer_mode = opts.answerMode;
  if (opts.redactRegex) toolArgs.redact_regex = opts.redactRegex;
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

  // Effective timeout: --timeout-hours override, else DEFAULT_SEARCH_TIMEOUT_MS.
  // 0 disables (the MCP SDK treats 0 as "no timeout" via undefined upstream).
  const effectiveTimeoutMs =
    opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_SEARCH_TIMEOUT_MS;

  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "search_existing_implementations", arguments: toolArgs },
      undefined,
      effectiveTimeoutMs > 0 ? { timeout: effectiveTimeoutMs } : undefined,
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
    if (autoGeneratedDiffPath) {
      try {
        unlinkSync(autoGeneratedDiffPath);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

function printUsage(): void {
  info(`LLM Externalizer — CLI

Profile mutation is DISABLED. Edit ${getSettingsPath()} manually with your
editor to change models, profiles, or API keys. Then restart Claude Code, or
call the MCP "reset" tool, to reload.

Usage:
  llm-externalizer profile list                          # read-only profile inspector
  llm-externalizer model-info <model-id> [--markdown | --json [file]] [--no-color]
  llm-externalizer search-existing "<description>" [<src-files>...] --in <path> [--base <ref>] [--diff <path>] [--free]

Disabled (would change settings.yaml — do this manually instead):
  llm-externalizer profile add | select | edit | remove | rename

search-existing batches the codebase into FFD-packed LLM requests of typically
1-5 files each, or one group per request if you pass ---GROUP:id--- markers.
The LLM never sees the whole codebase at once — each file is compared against
the description + optional source files + optional diff, so no cross-file
visibility is needed. In ensemble mode each file receives 3 different LLM
responses (3 models in parallel); in --free mode each file receives 1
response from the free Nemotron model.

answer_mode (all LLM Externalizer tools):
  0 = ONE REPORT PER FILE     — one .md per input file, batching unchanged.
  1 = ONE REPORT PER GROUP    — one .md per group. If ---GROUP:id--- markers
                                are not supplied, the MCP server auto-groups
                                files by subfolder/extension/basename with
                                1 MB per group.
  2 = SINGLE REPORT (merged)  — one .md for the whole operation.

search-existing flags:
  --in <path>            (MANDATORY) Codebase folder to scan. Repeat or comma-separate.
  --src <path>           Alternative to positional source-file args. Repeatable.
  --base <ref>           Git ref to diff against (default: origin/HEAD → main → master).
                         Only used when source files are given.
  --diff <path>          Pre-made unified-diff file (overrides --base).
  --extensions <a,b>     Language extensions to scan. Auto-detected from src files.
  --exclude-dirs <a,b>   Extra dirs to skip.
  --max-files <n>        Max files to walk (default 10000).
  --max-payload-kb <n>   Max batch payload size in KB (default 400). Larger packs
                         more files per LLM call.
  --no-gitignore         Disable .gitignore filtering (default: enabled).
  --answer-mode <n>      Output organization — see the answer_mode table above.
                         Default for search-existing is 2 (single merged report).
  --redact-regex <pat>   Custom JavaScript regex to redact matching tokens from
                         file content before sending to the LLM.
  --free                 Use free Nemotron model (lower quality, prompts logged).
  --output-dir <path>    Custom reports directory.
  --timeout-hours <n>    Max wall time for the whole scan (default 4 hours).
                         Pass 0 to disable. Accepts fractional hours (e.g. 0.5 = 30 min).

Settings file: ${getSettingsPath()}

To change models, profiles, API keys, URLs, timeouts, or the active profile:
open the settings file above in your editor, make the edits, save, and then
either restart Claude Code or call the MCP "reset" tool to reload. The CLI
mutation subcommands (add / select / edit / remove / rename) were removed on
purpose — only the user may change configuration, not agents.
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

  // Profile-mutating subcommands are disabled. Model / profile configuration
  // is user-only: edit ~/.llm-externalizer/settings.yaml manually with an
  // editor, then restart Claude Code or call the MCP "reset" tool to reload.
  // list / ls stays — it is read-only.
  const MUTATING_SUBCOMMANDS = new Set([
    "add",
    "select",
    "use",
    "edit",
    "remove",
    "rm",
    "rename",
    "mv",
  ]);

  if (MUTATING_SUBCOMMANDS.has(subcommand)) {
    die(
      `'profile ${subcommand}' is disabled. Model and profile configuration is user-only. ` +
        `Edit ${getSettingsPath()} manually in your editor, then restart Claude Code ` +
        "or call the MCP 'reset' tool to reload. " +
        "Use 'profile list' to inspect the current configuration.",
    );
  }

  switch (subcommand) {
    case "list":
    case "ls":
      cmdList();
      break;

    default:
      die(
        `Unknown profile command '${subcommand}'. Only 'list' is available — ` +
          "profile mutation was disabled by design. Edit " +
          `${getSettingsPath()} manually to change models or profiles.`,
      );
  }
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
