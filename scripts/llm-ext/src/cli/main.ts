#!/usr/bin/env node
/**
 * llm-ext — the CLI. This is the ONLY runtime surface; there is no MCP server.
 *
 * Everything here is generated from the tool catalog (`buildTools`), never
 * hand-maintained: the command list, `--help`, and flag coercion all read the
 * same JSON Schema the tools have always declared. Add a tool to the catalog
 * and it shows up here with correct help and typed flags, automatically.
 *
 * The single job of this file is to be the ONE place where the engine's
 * `ToolResult` envelope is flattened into stdout + an exit code. Everything
 * upstream keeps returning the envelope.
 *
 * Output contract:
 *   STDOUT — the tool's text result (usually a report path). Nothing else, so
 *            `llm-ext scan-folder … | xargs cat` works.
 *   STDERR — banner, progress, diagnostics.
 *   exit 0 — success · exit 1 — the tool reported an error or the invocation
 *            was malformed.
 */

// WHY a lazy import and not a static one: loading ../index.js reads settings.yaml and may write it (default file, migration) at import time. `classify --help`, its typo errors and the other help paths of a classify command must touch no settings file (C4-03), so the engine is loaded only once a command is actually going to run.
const loadEngine = () => import("../index.js");
import {
  CLI_TOOLS_WITHOUT_RESOLVED_PROFILE,
  DEFAULT_PROFILE_NAME,
  effectiveProfileName,
  shouldFailProfileSelection,
  type ProfileType,
} from "../config.js";
import { describeAcceptedTypes, profileSelectionRefusal } from "../profile-accept.js";
import { selectedChatProfileErrors } from "../classifiers/profile-checks.js";
import { estimateToolRun, renderEstimate } from "../estimate.js";
import { buildTools } from "../tools/definitions.js";
import { GLOBAL_BOOLEAN_FLAGS, GROUPS, classifyHelpNote, classifySpecFor, isGroupName, resolveInvocation, runClassifyCommand, suggestCommand } from "./launcher.js";
import { readFileSync } from "node:fs";
import type { GlobalFetch } from "../classifiers/l0/transport.js";
import { BROKER_ARGV } from "../broker/protocol.js";
import { cancelAllBrokerJobs, setBrokerClientVersion, setBrokerQueueTimeoutMs } from "../broker/client.js";
import { extractTimeoutFlags, type TimeoutFlags } from "./timeout-flags.js";

/**
 * The published version, and the anchor `scripts/publish.py` rewrites on every
 * release before asserting the new value appears in `dist/llm-ext.js` — that
 * assert is what stops a stale bundle from shipping under a fresh tag.
 *
 * Keep it on ONE line in exactly this shape; publish.py matches it by regex.
 * The old anchor was the `version:` field of the `McpServer` constructor, which
 * went away with the server — leaving publish.py matching a literal that no
 * longer existed, which aborts the release. This is now the only anchor, so it
 * is load-bearing: do not reformat, inline, or compute it.
 */
const VERSION = "14.1.2";

// ── Catalog ──────────────────────────────────────────────────────────

interface JsonSchemaProp {
  type?: string;
  description?: string;
  default?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProp;
  oneOf?: JsonSchemaProp[];
}

interface ToolDef {
  name: string;
  description: string;
  acceptedProfileTypes: readonly ProfileType[];
  inputSchema?: {
    type?: string;
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
}

/** Canonical CLI command name for a tool: snake_case → kebab-case. */
function toKebab(toolName: string): string {
  return toolName.replace(/_/g, "-");
}

/**
 * Top-level verbs from the retired `dist/cli.js` entry point whose tool was
 * renamed in this catalog, so the old spelling resolves to nothing.
 *
 * These exist because the published npm bin `llm-externalizer` now points at
 * THIS CLI. Measured against the live catalog, exactly two of the seven legacy
 * verbs had no same-named tool — `profile`, `cluster-synonyms`,
 * `high-quality-scan`, `security-scan` and `mass-scout` all already resolve by
 * name. Without these two entries, re-pointing the bin would silently break
 * `llm-externalizer model-info <id>` and `llm-externalizer search-existing`,
 * both of which are documented and worked before.
 */
const LEGACY_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  "model-info": "or_model_info",
  "search-existing": "search_existing_implementations",
};

/**
 * Resolve a user-typed command to a tool name. kebab-case is canonical and
 * documented; the snake_case tool name is accepted silently so anything already
 * scripted against the old names keeps working without a second spelling in the
 * docs. Legacy verbs from the retired entry point are mapped first.
 */
function resolveCommand(input: string, tools: ToolDef[]): ToolDef | undefined {
  const wanted = input.trim().toLowerCase();
  const resolved = LEGACY_COMMAND_ALIASES[wanted] ?? wanted;
  return tools.find(
    (t) => t.name === resolved || toKebab(t.name) === resolved,
  );
}

// ── Flag parsing ─────────────────────────────────────────────────────

/** The tools that return instantly and take no arguments worth narrating. */
const QUIET_TOOLS = new Set([
  "discover",
  "get_settings",
  "profile",
  "list_profiles",
  "reset",
  "or_model_info",
  "or_model_info_json",
  "or_model_info_table",
  "scan_local_llm_services",
]);

/** Accepted spellings for an explicit boolean value. */
const BOOLEAN_LITERALS = new Set([
  "true",
  "false",
  "1",
  "0",
  "yes",
  "no",
  "on",
  "off",
]);

function die(msg: string): never {
  process.stderr.write(`llm-ext: ${msg}\n`);
  process.exit(1);
}


/** Exit code of a command stopped by --command_timeout (the timeout(1) convention). */
const COMMAND_TIMEOUT_EXIT = 124;

/**
 * --command_timeout (USER ruling 2026-10-28): when it expires the command
 * stops: no further job is submitted, every job it still has at the local
 * broker is cancelled (DELETE), and it exits non-zero. Results the command
 * already wrote stay on disk; listing the unfinished files per tool is not
 * done yet (P1b report). The timer is unref'd: a command that finishes first
 * exits at once (no lingering handle, launcher-boot.test.ts).
 */
function armCommandTimeout(seconds: number): void {
  setTimeout(() => {
    const reason = `--command_timeout: the command ran longer than ${seconds} s and was stopped`;
    void cancelAllBrokerJobs(reason).then((n) => {
      process.stderr.write(`llm-ext: ${reason}; ${n} unfinished local job(s) cancelled; files without a result were not finished\n`);
      process.exit(COMMAND_TIMEOUT_EXIT);
    });
  }, seconds * 1000).unref();
}

function schemaTypeOf(prop: JsonSchemaProp | undefined): string {
  if (!prop) return "string";
  if (prop.type) return prop.type;
  // `oneOf: [string, string[]]` is the repo's idiom for "path or list of paths".
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) return "oneOf";
  return "string";
}

/**
 * Turn one raw `--flag` value into the JSON type the tool's schema declares.
 *
 * Arrays accept three spellings because all three occur in the wild: a JSON
 * array (`'["a","b"]'`), a comma-separated list (`a,b`), or the flag repeated.
 * Numbers and booleans are rejected loudly rather than coerced to NaN/false —
 * a silently-wrong `--max_files abc` would scan the wrong amount of the tree.
 */
function coerce(
  flag: string,
  raw: string,
  prop: JsonSchemaProp | undefined,
): unknown {
  const type = schemaTypeOf(prop);
  switch (type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) die(`--${flag} expects a number, got '${raw}'`);
      return n;
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return true;
      if (["false", "0", "no", "off"].includes(v)) return false;
      die(`--${flag} expects true/false, got '${raw}'`);
      break;
    }
    case "array":
    case "oneOf": {
      const trimmed = raw.trim();
      if (trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          die(`--${flag} looks like JSON but does not parse: ${trimmed}`);
        }
      }
      // A lone value stays a string for `oneOf: [string, string[]]` props —
      // the tools accept either, and not wrapping keeps their own logs honest.
      if (type === "oneOf" && !trimmed.includes(",")) return trimmed;
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    case "object": {
      try {
        return JSON.parse(raw);
      } catch {
        die(`--${flag} expects JSON, got '${raw}'`);
      }
      break;
    }
    default:
      return raw;
  }
  // Unreachable — every branch returns or dies. Present so TS sees a value.
  return raw;
}

interface ParsedArgs {
  args: Record<string, unknown>;
  quiet: boolean;
}

/**
 * `invocation` is the form the user actually typed (`scout run` when reached
 * through a group, the flat name otherwise). Errors quote it for the same
 * reason `--help` does: telling someone who typed `llm-ext scout run` that
 * "'mass-scout' requires --db_path" names a command they did not run and
 * re-exposes the internal name the grouped surface exists to hide.
 */
function parseFlags(argv: string[], tool: ToolDef, invocation: string): ParsedArgs {
  const props = tool.inputSchema?.properties ?? {};
  const out: Record<string, unknown> = {};
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      die(`unexpected argument '${token}' (all inputs are named flags)`);
    }
    let flag = token.slice(2);
    let raw: string | undefined;

    const eq = flag.indexOf("=");
    if (eq !== -1) {
      raw = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }

    // Global boolean flag — any flag handled like this MUST also be listed in
    // GLOBAL_BOOLEAN_FLAGS (launcher.ts), or the grouped launcher's unknown-
    // flag guess swallows the positional that follows it.
    if (flag === "quiet") {
      quiet = true;
      continue;
    }

    // Accept the kebab spelling of a parameter too, for the same reason the
    // command names accept both.
    const key = flag in props ? flag : flag.replace(/-/g, "_");
    const prop = props[key];
    if (!prop) {
      die(
        `unknown flag --${flag} for '${invocation}'. ` +
          `Run 'llm-ext ${invocation} --help' to see its parameters.`,
      );
    }

    if (raw === undefined) {
      if (schemaTypeOf(prop) === "boolean") {
        // Both spellings must work: a bare `--flag` AND an explicit
        // `--flag true|false`. Only consume the next token when it actually
        // looks like a boolean literal — otherwise `--quiet chat` would eat the
        // command. Getting this wrong is silent and nasty: an earlier version
        // always treated `--flag` as bare-true, so `--scan_secrets true` left
        // `true` dangling and died with "unexpected argument".
        const next = argv[i + 1];
        if (next !== undefined && BOOLEAN_LITERALS.has(next.toLowerCase())) {
          out[key] = coerce(flag, argv[++i], prop);
        } else {
          out[key] = true;
        }
        continue;
      }
      raw = argv[++i];
      if (raw === undefined) die(`--${flag} expects a value`);
    }

    out[key] = coerce(flag, raw, prop);
  }

  const missing = (tool.inputSchema?.required ?? []).filter((r) => !(r in out));
  if (missing.length > 0) {
    die(
      `'${invocation}' requires ${missing.map((m) => `--${m}`).join(", ")}`,
    );
  }

  return { args: out, quiet };
}

// ── Help ─────────────────────────────────────────────────────────────

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (line.length <= 96) return line;
  // Cut at a WORD boundary. A blind slice(0,93) ends mid-word ("Filter..."),
  // which reads as a rendering glitch rather than as an abbreviation. Fall
  // back to the hard slice when the first 93 chars contain no space at all.
  const cut = line.slice(0, 93);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/**
 * Placeholder shown for a group action's positional argument.
 *
 * Keyed by the `positional` flag name in GROUPS, so an example is DERIVED from
 * the same table that decides what the positional actually writes to — it
 * cannot drift out of sync the way a hand-written per-command example does.
 * A positional this map does not know still renders (`<name>`), it just reads
 * less concretely; that is why the fallback exists rather than a throw.
 */
const EXAMPLE_ARG: Readonly<Record<string, string>> = {
  file_path: "./notes.md",
  folder_path: "./src",
  input_file: "./notes.md",
  input_files_paths: "./src/api.ts",
  model: "z-ai/glm-5.2:free",
  spec_file_path: "./spec.md",
  transcript: "./session.jsonl",
};

/** The concrete example argument for a positional, or a readable placeholder. */
function exampleArgFor(positional: string | undefined): string {
  if (positional === undefined) return "";
  return EXAMPLE_ARG[positional] ?? `<${positional}>`;
}

/**
 * Would `llm-ext <invocation> <positional>` actually run?
 *
 * Only when every SCHEMA-required flag is the positional itself — otherwise the
 * printed one-liner dies in parseFlags before reaching the tool. `llm-ext scout
 * run` shipped as an "Example" while mass_scout requires four flags, so pasting
 * it produced `'mass-scout' requires --db_path, --fields_file, --job_id,
 * --source_root`. An example that cannot run is worse than no example.
 *
 * A few handlers refuse on a flag the SCHEMA does not mark required, so the
 * schema check alone is not enough: `llm-ext scan folder ./src` passed it and
 * still died with "FAILED: instructions or instructions_files_paths is
 * required." Those tools are listed explicitly below rather than by
 * re-implementing each handler's validation here: the list duplicates only the
 * FACT that a requirement exists, not the validation itself.
 *
 * It is fail-SILENT in both directions and nothing warns you. A sixth handler
 * that grows a requirement is not listed, so its example quietly breaks again;
 * an entry whose handler drops its requirement suppresses a good example
 * forever. The paired test in grouped-help-shape.test.ts only catches a listed
 * tool LEAKING BACK into an example — it cannot catch either drift above.
 * Adding a handler-level `required` check means adding a line here.
 */
const HANDLER_REQUIRES_BEYOND_SCHEMA: ReadonlySet<string> = new Set([
  "chat", // src/index.ts — instructions | instructions_files_paths
  "code_task", // src/code-task/core.ts — same pair
  "scan_folder", // src/scan-folder/core.ts — same pair
  "search_existing_implementations", // src/search-existing/core.ts — feature_description
  // NOT check_against_specs: its handler demands spec_file_path, which IS its
  // positional (GROUPS: check specs), so the schema check already covers it.
  // Listing it here would suppress a perfectly good example.
]);

function exampleIsRunnable(tool: ToolDef, positional: string | undefined): boolean {
  if (HANDLER_REQUIRES_BEYOND_SCHEMA.has(tool.name)) return false;
  // WHY: a classify command needs a JSON input (--input or stdin) that no schema field marks required, so a bare one-liner would wait on stdin.
  if (classifySpecFor(tool.name) !== undefined) return false;
  return (tool.inputSchema?.required ?? []).every((r) => r === positional);
}

function printGlobalHelp(tools: ToolDef[]): void {
  process.stdout.write(
    "llm-ext — offload bounded LLM work to cheaper models.\n\n" +
      "Usage:\n" +
      "  llm-ext <group> <action> [input] [--flag value ...]\n" +
      "  llm-ext <group> --help        list that group's actions\n" +
      "  llm-ext <group> <action> --help  show that action's parameters\n" +
      "  llm-ext --help                this list\n" +
      "  llm-ext --help --all          also list every flat command (advanced)\n" +
      "  llm-ext --version             print the version\n\n" +
      "Global flags:\n" +
      "  --quiet                       suppress the banner and progress lines\n" +
      "  --profile <name>              use this settings.yaml profile for this call only\n" +
      "  --queue_timeout <s>           local broker: longest a queued job waits before its model is\n" +
      "                                forced onto the server (default 300; waiting is never an error)\n" +
      "  --command_timeout <s>         stop the whole command after <s> seconds, cancel its queued\n" +
      "                                jobs and exit 124 (aliases --command-timeout, --timeout)\n\n" +
      "Groups:\n",
  );
  const groupWidth = Math.max(...Object.keys(GROUPS).map((g) => g.length));
  for (const [group, actions] of Object.entries(GROUPS)) {
    process.stdout.write(
      `  ${group.padEnd(groupWidth)}  ${Object.keys(actions).join(", ")}\n`,
    );
  }
  // Every line here is run before it is edited. `llm ask ./prompt.md --profile
  // free` used to sit in this block and failed twice over: `chat` refuses
  // without --instructions, and `free` is only present when settings.yaml was
  // machine-generated — a hand-authored one has no such profile and the call
  // dies with "unknown profile 'free'".
  process.stdout.write(
    "\nExamples:\n" +
      "  llm-ext llm summarize ./notes.md --max_chars 500\n" +
      '  llm-ext scan folder ./src --instructions "list the exported symbols"\n' +
      "  llm-ext session compact ./session.jsonl -o /tmp\n" +
      '  llm-ext llm ask ./src/api.ts --instructions "explain this file"\n',
  );
  process.stdout.write(
    "\nReports are written to <project>/reports/llm-externalizer/ and the path " +
      "is printed on stdout.\n",
  );
  if (process.argv.includes("--all")) {
    const width = Math.max(...tools.map((t) => toKebab(t.name).length));
    process.stdout.write("\nAll flat commands (advanced — the groups above dispatch to these):\n");
    for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      process.stdout.write(
        `  ${toKebab(t.name).padEnd(width)}  ${firstLine(t.description)}\n`,
      );
    }
  }
}

/**
 * Per-group help.
 *
 * Lists each action with WHAT IT DOES, taken from the catalog description —
 * the same source `--help --all` uses. It previously printed `action ->
 * flat-command-name`, which exposed an internal name the grouped syntax does
 * not even accept, and told the reader nothing about the action's purpose.
 */
function printGroupHelp(group: string, tools: ToolDef[]): void {
  const actions = GROUPS[group];
  process.stdout.write(`llm-ext ${group} <action>\n\nActions:\n`);
  const width = Math.max(...Object.keys(actions).map((a) => a.length));
  for (const [action, spec] of Object.entries(actions)) {
    const tool = resolveCommand(spec.command, tools);
    process.stdout.write(
      // A blank cell would HIDE a group-table/catalog desync, while the
      // action-help path die()s loudly on the identical condition. Same fault,
      // same visibility.
      `  ${action.padEnd(width)}  ${tool ? firstLine(tool.description) : "(missing from catalog — group table out of sync)"}\n`,
    );
  }
  // One worked example, from the first action whose positional alone satisfies
  // every required flag — so the line is one the reader can literally paste.
  // Groups where no action qualifies (every action needs explicit flags) get no
  // Example rather than a decorative one that fails.
  const runnable = Object.entries(actions)
    .map(([action, spec]) => ({ action, spec, tool: resolveCommand(spec.command, tools) }))
    .find((e) => e.tool && exampleIsRunnable(e.tool, e.spec.positional));
  if (runnable) {
    const arg = exampleArgFor(runnable.spec.positional);
    process.stdout.write(
      `\nExample:\n  llm-ext ${group} ${runnable.action}${arg ? ` ${arg}` : ""}\n`,
    );
  }
  process.stdout.write(
    `\nRun 'llm-ext ${group} <action> --help' for that action's parameters.\n`,
  );
}

/**
 * Tools whose handler issues (or can issue) a real model/network request —
 * so `--profile <name>` (parsed centrally in extractProfileFlag(), never a
 * per-tool schema field — see its doc comment) actually changes what the
 * command does. Everything NOT in this set only reads local state or the
 * public OpenRouter catalog (no chat/completion request), so showing
 * `--profile` on it would be misleading.
 *
 * This is the single source of truth `printToolHelp()` consults — a new
 * LLM-calling command is discoverable-by-default ONLY once added here.
 * Classification is by READING each handler (dispatchCallToolInner in
 * ../index.ts and dispatchMassScoutTool in ../mass_scouting/mcp-tools.ts),
 * not by guessing from the name — notably this EXCLUDES `assess_model`,
 * `check_model_health`, `discover_new_models` (public catalog fetch only,
 * see RECONCILE_SKIP_TOOLS's own doc comment in ../index.ts), `review_plan`
 * and `rules_check` (both explicitly "no LLM" in their case bodies), and
 * most `mass_scout_*` sub-actions (register/preclassify/estimate/search/
 * search_xjob/get/export/jobs_list/audit_sample/body_get/build_fieldset/
 * diff/list_bundled_fieldsets — local SQLite + regex only, verified via
 * cli.ts: none of those handlers accept `opts.apiKey`/`opts.fetchImpl`).
 * It INCLUDES `code_task` and `session_summary` even though the unrelated
 * `LLM_TOOLS_SET` in ../index.ts (which only drives `reset`'s in-flight
 * drain wait) omits them — that set is not an exhaustive "sends a model
 * request" predicate and is intentionally left untouched here.
 */
const PROFILE_AWARE_TOOLS = new Set([
  // Flat catalog (src/tools/definitions.ts) — central LLM pipeline.
  "chat",
  "code_task",
  "session_summary",
  "summarize",
  "topics",
  "sem_deduplicate",
  "describe",
  "batch_check",
  "scan_folder",
  "high_quality_scan",
  "compare_files",
  "check_references",
  "check_imports",
  "check_against_specs",
  "search_existing_implementations",
  "cluster_synonyms",
  // mass_scouting (src/mass_scouting/mcp-tools.ts) — actions whose CLI
  // handler resolves a model via resolveCliModel()/opts.apiKey and sends it.
  "mass_scout",
  "mass_scout_chain",
  "mass_scout_propose_fieldset",
  "security_scan",
  "security_triage_benchmark",
  "search_existing_benchmark",
  "check_tool_replacements",
]);

/** The default and range of a numeric parameter that declares them (classify thresholds), else nothing. */
function rangeNote(prop: JsonSchemaProp): string {
  if (prop.default === undefined || prop.minimum === undefined || prop.maximum === undefined) return "";
  return ` (default ${prop.default}, range ${prop.minimum}..${prop.maximum})`;
}

/**
 * Per-action help.
 *
 * `inv` is the GROUPED invocation the user actually typed (`llm-ext llm
 * summarize`). It is load-bearing, not decoration: without it this printed the
 * flat catalog name (`llm-ext summarize`) as the header even when reached via
 * a group — a usage line naming a command form the grouped syntax rejects. The
 * flat path passes no `inv` and still legitimately shows the flat name, which
 * is what that path accepts.
 */
function printToolHelp(
  tool: ToolDef,
  inv?: { group: string; action: string },
): void {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const invocation = inv ? `${inv.group} ${inv.action}` : toKebab(tool.name);
  const positional = inv ? GROUPS[inv.group]?.[inv.action]?.positional : undefined;
  process.stdout.write(`llm-ext ${invocation}\n\n${tool.description}\n`);
  const note = classifyHelpNote(tool.name);
  if (note !== undefined) process.stdout.write(`${note}\n`);
  // Usage + example. The positional is otherwise INVISIBLE in help: the reader
  // sees only `--input_file` and cannot tell the same value may be passed
  // bare, which is how every doc and skill actually calls these commands.
  const arg = exampleArgFor(positional);
  process.stdout.write(
    `\nUsage:\n  llm-ext ${invocation}` +
      (positional ? ` [${positional}]` : "") +
      " [--flag value ...]\n",
  );
  if (exampleIsRunnable(tool, positional)) {
    process.stdout.write(
      `\nExample:\n  llm-ext ${invocation}${arg ? ` ${arg}` : ""}\n`,
    );
  }
  if (positional) {
    process.stdout.write(
      `  (the bare argument is written to --${positional})\n`,
    );
  }
  // WHY printed for every command (not only profile-aware ones): these are the types the runtime check enforces, so the reader sees them before meeting a refusal.
  process.stdout.write(`\nAccepted profile types: ${describeAcceptedTypes(tool.acceptedProfileTypes)}\n`);
  const keys = Object.keys(props);
  const showProfile = PROFILE_AWARE_TOOLS.has(tool.name);
  if (keys.length === 0 && !showProfile) {
    process.stdout.write("\nTakes no parameters.\n");
    return;
  }
  process.stdout.write("\nParameters:\n");
  const width = Math.max(...keys.map((k) => k.length), "profile".length);
  for (const key of keys.sort()) {
    const prop = props[key];
    const tag = required.has(key) ? " (required)" : "";
    process.stdout.write(
      `  --${key.padEnd(width)}  [${schemaTypeOf(prop)}]${tag} ${firstLine(prop.description ?? "")}${rangeNote(prop)}\n`,
    );
  }
  if (showProfile) {
    process.stdout.write(
      `  --${"profile".padEnd(width)}  [string] Selects the settings profile for this invocation only ` +
        // WHY (TRDD-G6XT3AY9): state the precedence explicitly -- flag beats
        // `active:`, `active:` beats the built-in default -- so a user who
        // omits --profile knows WHY a given profile ran without re-deriving
        // it from effectiveProfileName()'s source.
        "(a key under `profiles:` in ~/.llm-externalizer/settings.yaml). " +
        "When omitted, the `active:` key in settings.yaml decides, and " +
        `'${DEFAULT_PROFILE_NAME}' is used when that is missing too. ` +
        "Never modifies settings.yaml. An unknown name fails fast and lists the available profiles.\n",
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Strip a global `--profile <name>` (or `--profile=<name>`) from anywhere in
 * argv and return its value. Handled centrally here — not as a per-tool
 * schema field — so it works identically on every command, positioned
 * before OR after the group/action/flat command name (`llm-ext --profile
 * free llm ask …` and `llm-ext llm ask … --profile free` both work), the
 * same way `--quiet` is a global flag rather than a per-tool parameter.
 */
function extractProfileFlag(argv: string[]): { argv: string[]; profile?: string } {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--profile") {
      const value = argv[i + 1];
      if (value === undefined) die("--profile expects a value");
      return { argv: [...argv.slice(0, i), ...argv.slice(i + 2)], profile: value };
    }
    if (token.startsWith("--profile=")) {
      return {
        argv: [...argv.slice(0, i), ...argv.slice(i + 1)],
        profile: token.slice("--profile=".length),
      };
    }
  }
  return { argv };
}

async function readAllStdin(): Promise<Buffer> {
  // WHY fail fast: with no --input and a terminal on stdin the command would wait for typing that never comes.
  if (process.stdin.isTTY) throw new Error("no --input given and stdin is a terminal; pass --input <file.json>, pipe the JSON, or name files (- reads stdin)");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // WHY the raw Buffer (IN-01): the file reader sniffs NUL bytes and reports invalid UTF-8, which a decoded string has already lost; the JSON path decodes it.
  return Buffer.concat(chunks);
}

/** First token that is not a global `--profile <name>` / `--profile=<name>` pair or a global boolean flag: the command word as the user typed it. */
function leadingToken(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") { i++; continue; }
    if (argv[i].startsWith("--profile=")) continue;
    // WHY skip the global boolean flags: `llm-ext --quiet classify --help` must stay inert; a leading --quiet made the command word look like a non-classify one, so the engine loaded and the settings file was touched.
    if (GLOBAL_BOOLEAN_FLAGS.has(argv[i])) continue;
    return argv[i];
  }
  return undefined;
}

const isClassifyWord = (word: string | undefined): boolean =>
  word === "classify" || (word !== undefined && classifySpecFor(word.replaceAll("-", "_")) !== undefined);

async function main(): Promise<void> {
  // TRDD-1OOAH3LD: `llm-ext __broker <engine>` turns this process into the
  // per-engine request broker (broker/server.ts). Checked before loadEngine so
  // a broker never reads, creates or migrates settings; the broker module is
  // imported lazily so ordinary commands never load it.
  if (process.argv[2] === BROKER_ARGV) {
    const { runBrokerMain } = await import("../broker/server.js");
    await runBrokerMain(process.argv[3], VERSION);
  }
  setBrokerClientVersion(VERSION);
  // WHY the engine is loaded HERE for every non-classify command: the static import it replaces loaded it before main() ran, so settings were read/created/migrated before any usage error (`--profile` with no value) or help. Only a classify command defers it (see loadEngine).
  // WHY "" for a classify command's tool list: its descriptions carry no limits text, and limitsBlock() needs the engine.
  // Global timeout flags (USER rulings 2026-10-28): stripped FIRST, so the
  // command word, --profile and the classify parser never see them.
  let timeouts: TimeoutFlags;
  try {
    timeouts = extractTimeoutFlags(process.argv.slice(2));
  } catch (err) {
    die((err as Error).message);
  }
  if (timeouts.queueTimeoutS !== undefined) setBrokerQueueTimeoutMs(timeouts.queueTimeoutS * 1000);
  if (timeouts.commandTimeoutS !== undefined) armCommandTimeout(timeouts.commandTimeoutS);
  let engine = isClassifyWord(leadingToken(timeouts.argv)) ? undefined : await loadEngine();
  const { argv, profile: profileOverride } = extractProfileFlag(timeouts.argv);
  // The catalog's descriptions are backend-dependent, so build it per run.
  const tools = buildTools(engine ? engine.limitsBlock() : "") as ToolDef[];

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printGlobalHelp(tools);
    return;
  }

  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // The grouped launcher (TRDD-DT11TE2Z) is a pure argv rewrite that engages
  // ONLY when argv[0] names a group — an existing flat command name (e.g.
  // `session_summary`) is never a group name, so it falls through to the
  // unchanged flat path below untouched.
  let commandName: string;
  let rest: string[];
  // Set only on the grouped path — the form the user typed, for error messages.
  // `argv[0] argv[1]` IS that form: resolveInvocation only reaches "dispatch"
  // after argv[1] resolved to a real action of the argv[0] group.
  let groupedInvocation: string | undefined;
  if (isGroupName(argv[0])) {
    const resolved = resolveInvocation(argv, tools);
    switch (resolved.kind) {
      case "group-help":
        printGroupHelp(resolved.group, tools);
        return;
      case "action-help": {
        const actionTool = resolveCommand(resolved.command, tools);
        // A GROUPS entry naming a command the catalog does not have is a build
        // bug (launcher.test.ts asserts against the real catalog). Say so and
        // fail — exiting 0 with no output would read as "this action has no
        // parameters", which is a different and wrong answer.
        if (!actionTool) {
          die(
            `'${resolved.group} ${resolved.action}' maps to unknown command ` +
              `'${resolved.command}' — the group table is out of sync with the catalog.`,
          );
        }
        printToolHelp(actionTool, {
          group: resolved.group,
          action: resolved.action,
        });
        return;
      }
      case "error": {
        process.stderr.write(`llm-ext: ${resolved.message}\n`);
        if (resolved.suggestions.length > 0) {
          process.stderr.write(
            `  did you mean: ${resolved.suggestions.join(", ")}?\n`,
          );
        }
        process.exit(1);
        return;
      }
      case "dispatch":
        commandName = resolved.command;
        rest = resolved.argv;
        groupedInvocation = `${argv[0]} ${argv[1]}`;
        break;
    }
  } else {
    commandName = argv[0];
    rest = argv.slice(1);
  }

  const tool = resolveCommand(commandName, tools);
  if (!tool) {
    // A mistyped GROUP name (e.g. 'scna') never reaches the launcher's own
    // did-you-mean (isGroupName() is exact-match by design), so it falls
    // through to here. Groups are the surface we lead with, so they are
    // suggested FIRST and exclusively when any are close enough; the flat
    // catalog is only offered as a distinctly-labelled fallback when no
    // group is close, so a group typo never gets muddied with a flat name.
    const hint = suggestCommand(commandName, tools.map((t) => toKebab(t.name)));
    process.stderr.write(
      `llm-ext: unknown command '${commandName}'. Run 'llm-ext --help' for the list.\n`,
    );
    if (hint) {
      const label = hint.kind === "group" ? "did you mean group" : "did you mean flat command";
      process.stderr.write(`  ${label}: ${hint.names.join(", ")}?\n`);
    }
    process.exit(1);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printToolHelp(tool);
    return;
  }

  // WHY here: a classify command is parsed by the runner itself (kebab flags, `-o`, its own refusals), so the generic flag parser and the --estimate/--preview strip below must not see it; the runner refuses those two as unknown options.
  const classifySpec = classifySpecFor(tool.name);

  // --estimate (task #187): dry-run the invocation and print the predicted
  // cost INSTEAD of dispatching. Stripped before parseFlags because it is a
  // global flag, not part of any tool's schema. The paid-mode rules/skills
  // tell agents to run this before every paid operation. Global boolean flags
  // stripped here MUST also be listed in GLOBAL_BOOLEAN_FLAGS (launcher.ts).
  const estimateIdx = classifySpec ? -1 : rest.indexOf("--estimate");
  const wantEstimate = estimateIdx !== -1;
  if (wantEstimate) rest.splice(estimateIdx, 1);

  // --preview (TRDD-SCLGL8T4): dry-run the FILE SELECTION and print every
  // candidate's verdict — included, or excluded WITH the reason — via the
  // same walker the real run uses. Composes with --estimate (selection +
  // price in one dry-run). Zero LLM sends either way.
  const previewIdx = classifySpec ? -1 : rest.indexOf("--preview");
  const wantPreview = previewIdx !== -1;
  if (wantPreview) rest.splice(previewIdx, 1);

  const { args, quiet } = classifySpec ? { args: {} as Record<string, unknown>, quiet: false } : parseFlags(rest, tool, groupedInvocation ?? toKebab(tool.name));

  // --profile <name>: apply BEFORE boot() so publishFreeState()/the boot
  // banner and every downstream getCurrentBackend()/activeResolved read
  // reflect the override for the whole invocation. Never mutates
  // settings.yaml — see overrideActiveProfile()'s doc comment in index.ts.
  // WHY (TRDD-G6XT3AY9): precedence is --profile flag > `active:` in
  // settings.yaml > the built-in default -- effectiveProfileName() is the
  // one place that implements "active: ?? free", so this and every other
  // reader (validateSettings, settings show/status) agree.
  // WHY a snapshot here: overrideActiveProfile() below overwrites the live `active` with the selected name (index.ts applyNewSettings), so the PT-03 check must read the settings as loaded from disk.
  engine ??= await loadEngine();
  const { boot, buildEstimateDeps, dispatchCallTool, getActiveSettings, overrideActiveProfile, isScoutingOnlyTool, profileGateRefusal, warmEstimatePricing, writeBootBanner } = engine;
  const settingsAsLoaded = getActiveSettings();
  // WHY (PT-05 follow-up): --profile on a scouting-only command names the SCOUTING profile mass scouting resolves its model from; a scouting profile is not a valid `active:`, so the active text profile is left alone and the name travels as the tool argument `profile`.
  const scoutingOnly = isScoutingOnlyTool(tool.name);
  // WHY (C4-03): a classify command takes a CLASSIFIER profile, which is never a valid `active:` (a text profile), so like a scouting command it leaves the active text profile alone; the name travels to the runner as its own --profile flag.
  const activeOverride = scoutingOnly || classifySpec ? undefined : profileOverride;
  if (scoutingOnly && profileOverride !== undefined) args.profile = profileOverride;
  const effectiveProfile = activeOverride ?? effectiveProfileName(getActiveSettings());
  // WHY skipped for classify: the text profile chain is not used by a decision, and a dangling `active:` must not stop a command that never reads it.
  if (!classifySpec) {
    const result = overrideActiveProfile(
      effectiveProfile,
      activeOverride !== undefined ? "flag" : "default",
    );
    // WHY (TRDD-G6XT3AY9 amendment): a dangling `active:` fails the
    // invocation ONLY when it is what got selected (no --profile -- an
    // explicit --profile typo always fails here) AND the tool actually needs
    // a resolved profile. `settings show`/`settings status`/`discover`/
    // `settings profile` fall through and run on whatever boot() resolved
    // (null `activeResolved`, handled by each of them already) so the user
    // can see and fix the broken key instead of the CLI dying before it
    // even dispatches. shouldFailProfileSelection is exported from config.ts
    // (not defined here) so the gate is unit-testable -- this file runs
    // `main().catch()` at import and can never be imported by a test.
    if (!result.ok && shouldFailProfileSelection(result.ok, tool.name, activeOverride !== undefined)) {
      die(result.error);
    }
  }

  // WHY here, before boot() and every dispatch: PT-03 refuses a profile whose type the command does not accept before any model call can happen (E80, E81, E81i); the table is tool.acceptedProfileTypes (tools/definitions.ts).
  // WHY not for classify: the runner applies the same check (profileSelectionRefusal) to `--profile`, else `active_classifier:`, and deliberately ignores `active:`; checking `active:` here refused the default invocation.
  if (!classifySpec) {
    const refusal = profileSelectionRefusal({
      command: groupedInvocation ?? toKebab(tool.name),
      accepted: tool.acceptedProfileTypes,
      viewsSettings: CLI_TOOLS_WITHOUT_RESOLVED_PROFILE.has(tool.name),
      profileFlag: profileOverride,
      settings: settingsAsLoaded,
    });
    if (refusal !== undefined) die(refusal);
  }

  // C4-03: a classify command runs the one decision runner. What is and is not loaded: the engine (index.ts) IS loaded above, so settings.yaml is read/created/migrated and its messages go to stderr; boot() is NOT called (it only publishes the free-mode state and installs the usage rule, which a decision never reads); no estimate/preview, no tool dispatch. stdout carries only the envelope. process.exitCode, not process.exit, so stdout is flushed and the runner's code (0, 1, 3, 4, 5, Ctrl-C) reaches the shell unchanged.
  if (classifySpec) {
    process.exitCode = await runClassifyCommand(classifySpec, rest, profileOverride, {
      settings: settingsAsLoaded,
      fetch: globalThis.fetch as GlobalFetch,
      readFile: (path) => readFileSync(path, "utf8"),
      readStdin: readAllStdin,
      stdout: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }

  // WHY here, after the PT-03 type check and before boot(): a free, paid or scouting profile whose model is a decisions model cannot answer chat requests (PF-02). The guard reads the cached catalog only, so selecting a profile never touches the network; the classifier checks run in the classifier resolver.
  {
    const guard = await selectedChatProfileErrors(getActiveSettings(), profileOverride ?? effectiveProfile, tool.acceptedProfileTypes, globalThis.fetch);
    if (guard.length > 0) die(guard.join("\n"));
  }
  // boot() publishes the free-mode state; dispatchCallTool refuses without it.
  await boot();

  if (wantPreview) {
    const deps = buildEstimateDeps();
    const excluded: Array<{ path: string; reason: string }> = [];
    const resolved = deps.resolveFiles(args, (path, reason) =>
      excluded.push({ path, reason }),
    );
    if (resolved.error) {
      process.stderr.write(`preview: ${resolved.error}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `PREVIEW (dry-run — nothing was sent) — ${tool.name}\n` +
        `included: ${resolved.files.length}   excluded: ${excluded.length}\n`,
    );
    for (const f of resolved.files) process.stdout.write(`  + ${f}\n`);
    for (const e of excluded) process.stdout.write(`  - ${e.path} (${e.reason})\n`);
    if (args.use_gitignore !== false) {
      process.stdout.write(
        "note: gitignored files are omitted upstream by git ls-files and cannot be listed here\n",
      );
    }
    if (!wantEstimate) return;
    // fall through: --preview --estimate composes
  }

  if (wantEstimate) {
    // Warm pricing with one $0 GET /models; the estimator itself sends nothing
    // (estimateToolRun is pure). Estimation errors propagate to main().catch —
    // fail-fast beats printing a fabricated number.
    // WHY (TRDD-CQSODQ78): an estimate must not price a run the real command refuses; the real run is gated in dispatchCallTool, which this branch never reaches.
    const gate = profileGateRefusal(tool.name);
    if (gate) {
      process.stderr.write(`${gate.message}\n`);
      process.exit(1);
    }
    await warmEstimatePricing();
    const estimate = estimateToolRun(tool.name, args, buildEstimateDeps());
    process.stdout.write(`${renderEstimate(estimate)}\n`);
    return;
  }

  const verbose = !quiet && !QUIET_TOOLS.has(tool.name);
  if (verbose) writeBootBanner();

  const result = await dispatchCallTool(tool.name, args, { progress: verbose });

  const text = result.content.map((c) => c.text).join("\n");
  if (result.isError) {
    process.stderr.write(`${text}\n`);
    process.exit(1);
  }
  process.stdout.write(`${text}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `llm-ext: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
