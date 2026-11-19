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
  remoteOnlyClassifierRefusal,
  shouldFailProfileSelection,
  type ProfileType,
} from "../config.js";
import { describeAcceptedTypes, profileSelectionRefusal } from "../profile-accept.js";
import { selectedChatProfileErrors } from "../classifiers/profile-checks.js";
import { classifyCliUsage } from "../classifiers/catalog/spec.js";
import { estimateToolRun, renderEstimate } from "../estimate.js";
import { DRY_RUN_FLAGS, acceptedDryRunFlags, isProfileAware } from "./dry-run-flags.js";
import { buildTools } from "../tools/definitions.js";
import { GLOBAL_BOOLEAN_FLAGS, GROUPS, classifyHelpNote, classifySpecFor, hoistLeadingFlags, isClassifyTool, isGroupName, resolveInvocation, runClassifyCommand, runClassifyPing, suggestCommand } from "./launcher.js";
import { readFileSync } from "node:fs";
import type { GlobalFetch } from "../classifiers/l0/transport.js";
import { BROKER_ARGV, CALIBRATE_ARGV } from "../broker/protocol.js";
import { cancelAllBrokerJobs, setBrokerClientVersion, setBrokerQueueTimeoutMs } from "../broker/client.js";
import { commandStopExitCode, commandStopReason, enableStopOnErrors, STOP_ON_ERRORS_EXIT, stopCommand } from "../command-stop.js";
import { extractTimeoutFlags, NETWORK_GIVE_UP_FLAGS, STOP_ON_ERRORS_FLAGS, type TimeoutFlags } from "./timeout-flags.js";
import { NETWORK_GIVE_UP_MAX_S, RETRY_DEADLINE_MS } from "../retry-window.js";
import { setNetworkGiveUpOverrideS } from "../network-give-up.js";
import { readAllFrom } from "./read-all.js";
import { stopNoticeLine } from "./stop-notice.js";

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
const VERSION = "14.7.5";

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
  exitCommand(1);
}


/** How long a stopping command may take to write its partial results before it is ended anyway. */
const STOP_FLUSH_GRACE_MS = 30_000;

/** True once --command_timeout expired (the shared command-stop flag). */
function commandTimedOut(): boolean {
  return commandStopReason() !== null;
}

/**
 * Every explicit exit of the CLI goes through here (follow-up review m3): once
 * the command timed out it exits COMMAND_TIMEOUT_EXIT whatever path ends it
 * (an error, classify, estimate), never 0 or 1 after the stderr line said it
 * was stopped. Review m4 (kept on purpose): a command whose work was already
 * complete when the timer fired still exits 124; that is spec 15's letter.
 */
function exitCommand(code: number): never {
  process.exit(commandTimedOut() ? commandStopExitCode() : code);
}

/**
 * --command_timeout (USER ruling 2026-10-28, spec 15): when it expires the
 * command STOPS, it is not killed. The shared command-stop flag is set, so no
 * path starts a new request (broker, remote and the direct-fetch workers,
 * follow-up review M3); every job it still has at the local broker is
 * cancelled (DELETE); each call waiting ends with a CommandStoppedError. So
 * every unfinished file fails with the timeout as its reason, and the command
 * returns normally: it writes the per-file results already complete and its
 * summary lists the unfinished files (review m3: a process.exit straight from
 * this timer could cut off a report being written). process.exitCode is set
 * to COMMAND_TIMEOUT_EXIT at once, so every path that ends normally exits 124.
 * A command that cannot stop in STOP_FLUSH_GRACE_MS (an in-flight remote
 * request is not aborted) is ended anyway. Both timers are unref'd: a command
 * that finishes first exits at once (no lingering handle, launcher-boot.test.ts).
 */
function armCommandTimeout(seconds: number): void {
  setTimeout(() => {
    const reason = `--command_timeout: the command ran longer than ${seconds} s and was stopped`;
    stopCommand(reason);
    endStoppedCommand(reason);
  }, seconds * 1000).unref();
}

/**
 * What every stop does once it is set, whichever flag set it: the exit code, every broker job cancelled, and the bounded
 * exit. WHY shared: --stop_on_errors with siblings still in flight (a parallel scan with one dead model and seven requests
 * waiting for their HTTP timeout) must end in the same bounded time as --command_timeout, not wait for them. The exit code
 * is the one the FIRST stop recorded: a --command_timeout firing after a --stop_on_errors stop must not turn 6 into 124.
 */
function endStoppedCommand(reason: string): void {
  process.exitCode = commandStopExitCode();
  void cancelAllBrokerJobs(reason).then(({ cancelled, failed }) => {
    process.stderr.write(`${stopNoticeLine(reason, cancelled, failed)}\n`);
  });
  setTimeout(() => {
    process.stderr.write(`llm-ext: the stopped command did not end within ${STOP_FLUSH_GRACE_MS / 1000} s; exiting\n`);
    process.exit(commandStopExitCode());
  }, STOP_FLUSH_GRACE_MS).unref();
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
 * Repeats are merged by parseFlags (one level, duplicates kept, in order).
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
    // WHY (TRDD-23J3NYW8): a bare `--` (the POSIX end of options) means nothing here: every input is a named flag, and a grouped command's positional is turned into its flag by the launcher before this parser runs. It used to fall through to "unknown flag -- for ...", which names no flag anyone can look up. Rejected by name rather than supported: support would need the launcher's positional capture to take every token after it, and the classify path keeps its own `--` handling (run-decision.ts).
    if (token === "--") {
      die(`a bare '--' is not supported by '${invocation}': its inputs are named flags (plus the positional argument, where the command has one), so remove the '--'. Run 'llm-ext ${invocation} --help' to see its parameters.`);
    }
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

    // WHY (TRDD-OK1NN5RN): a repeated array/oneOf flag used to overwrite the earlier value, so
    // `--input_files_paths a --input_files_paths b` (or a positional file plus the same flag, which the
    // launcher turns into two occurrences) silently ran on b alone. Accumulate instead, as coerce()'s doc
    // comment and the usage-patterns.md skill references state. Concatenate ONE level only: --file_pairs values are arrays
    // of [a, b] pairs and must stay pairs. Values are kept in order with duplicates, the same as one JSON
    // array: nothing is de-duplicated because duplicates carry meaning (GROUP markers are parsed by
    // parseFileGroups, compare-files needs exactly two paths, mass-scout-build-fieldset reports a duplicate
    // field name, instruction files are concatenated in order). Consumers that want unique paths
    // (batch_check, check_references, check_imports) already de-duplicate themselves.
    // A single occurrence is untouched: a lone oneOf value stays a string. A repeated scalar is refused (TRDD-WB9N5UDV), below.
    const value = coerce(flag, raw, prop);
    const kind = schemaTypeOf(prop);
    if ((kind === "array" || kind === "oneOf") && key in out) {
      const prev = out[key];
      out[key] = [...(Array.isArray(prev) ? prev : [prev]), ...(Array.isArray(value) ? value : [value])];
    } else if (key in out) {
      // WHY (TRDD-WB9N5UDV): a repeated scalar used to keep only its last value and drop the rest silently; fail fast. Booleans continue above and stay last-wins.
      die(`--${flag} was given more than once; it takes a single value. If the command also takes a positional input, that input already supplies --${key}.`);
    } else {
      out[key] = value;
    }
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
      "  --queue_timeout <s>           local broker: once a queued job nears this wait, its model gets\n" +
      "                                the server after the current model's minimum slice (default 300;\n" +
      "                                a large value lets the job wait; waiting is never an error)\n" +
      "  --command_timeout <s>         stop the whole command after <s> seconds, cancel its queued\n" +
      "                                jobs and exit 124 (aliases --command-timeout, --timeout)\n" +
      `  ${NETWORK_GIVE_UP_FLAGS[0].padEnd(30)}stop retrying the remote service after <s> seconds of consecutive network failures,\n` +
      "                                only when a local profile is ready now (default 30; alias --network-give-up;\n" +
      `                                settings.yaml: network_give_up_seconds; 1-${NETWORK_GIVE_UP_MAX_S}, below the ${RETRY_DEADLINE_MS / 1000} s retry window)\n` +
      `  ${STOP_ON_ERRORS_FLAGS[0].padEnd(30)}end the command on the first model that does not respond or is not\n` +
      "                                found, instead of falling back; finished results are kept;\n" +
      `                                exit ${STOP_ON_ERRORS_EXIT} (alias ${STOP_ON_ERRORS_FLAGS[1]}); waiting for memory is no failure\n\n` +
      // Governor D13 (TRDD-ZTO9K8EK): the settings and env of the machine-wide limits, so they are findable from --help.
      "Local inference governor (settings.yaml local_governor; each key has an env override):\n" +
      "  enabled: true                 LLM_EXT_GOVERNOR_ENABLED; false opts this config dir out: its\n" +
      "                                local sends take no lease and are not counted\n" +
      "  ram_limit_pct: 80             LLM_EXT_GOVERNOR_RAM_LIMIT_PCT (50-99): no load or inference\n" +
      "                                starts while RAM used is at or over it\n" +
      "  cpu_limit_pct: 80             LLM_EXT_GOVERNOR_CPU_LIMIT_PCT (10-100; 100 disables the CPU limit)\n" +
      "  max_inferences: 8             LLM_EXT_GOVERNOR_MAX_INFERENCES (1-256), machine-wide\n" +
      "  server_threads: 0             LLM_EXT_GOVERNOR_SERVER_THREADS (0 = half the thread budget,\n" +
      "                                else 1 up to cores x cpu_limit_pct / 100)\n" +
      "  llm-ext models server-status  shows the figures, the limits and the last denial\n\n" +
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
    // TRDD-PNU8XECB: name both roots so a user knows where per-file pieces and benchmark output went.
    "\nFinal reports are written to <project>/reports/llm-externalizer/ and the path " +
      "is printed on stdout; intermediate output (per-file pieces of a merged run, " +
      "model-pool benchmarks) goes to <project>/reports_dev/llm-externalizer/.\n",
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
  // A classify action that takes files has leading positionals of its own (the filter question, the rank query):
  // the usage shows them, from the same line its parser prints on a usage error (classifyCliUsage).
  const classifySpec = classifySpecFor(tool.name);
  const fileUsage = classifySpec !== undefined ? classifyCliUsage(classifySpec) : undefined;
  process.stdout.write(
    fileUsage !== undefined
      ? `\nUsage:\n  ${fileUsage} [--flag value ...]\n  llm-ext ${invocation} --input <file.json> [--flag value ...]   (or the JSON input on stdin)\n`
      : `\nUsage:\n  llm-ext ${invocation}` + (positional ? ` [${positional}]` : "") + " [--flag value ...]\n",
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
  const showProfile = isProfileAware(tool.name);
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
  // WHY the same set as --profile, but filtered: the flags matter for the commands that can send a model request, and each of those lists only the dry-run flags it accepts (DRY_RUN_SUPPORT). Help must not advertise a flag the command refuses (TRDD-58CFBQHN).
  if (showProfile) {
    for (const { flag, help } of acceptedDryRunFlags(tool.name)) {
      process.stdout.write(`  ${flag.padEnd(width + 2)}  [boolean] ${help}\n`);
    }
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

/**
 * Global dry-run/quiet flags typed BEFORE the group (`llm-ext --quiet scan --help`) move to the end of argv.
 * WHY: global help advertises them as global, but the dispatcher takes argv[0] as the group/command word, so a leading flag was refused as an unknown command. Behind the command they hit the existing per-command handling (--estimate/--preview strip, --quiet in parseFlags). --help/-h stay put: argv[0] help is handled before dispatch.
 */
function hoistLeadingGlobalFlags(argv: string[]): string[] {
  // Derived, not hand-listed: every global boolean flag and both dry-run flags, except help (handled before dispatch).
  const hoistable = new Set(
    [...GLOBAL_BOOLEAN_FLAGS, ...Object.values(DRY_RUN_FLAGS).map((d) => d.flag)].filter((f) => f !== "--help" && f !== "-h"),
  );
  return hoistLeadingFlags(argv, hoistable);
}

async function readAllStdin(): Promise<Buffer> {
  // WHY fail fast: with no --input and a terminal on stdin the command would wait for typing that never comes.
  if (process.stdin.isTTY) throw new Error("no --input given and stdin is a terminal; pass --input <file.json>, pipe the JSON, or name files (- reads stdin)");
  return readAllFrom(process.stdin);
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
  word === "classify" || (word !== undefined && isClassifyTool(word.replaceAll("-", "_")));

async function main(): Promise<void> {
  // TRDD-1OOAH3LD, TRDD-ZGSGGHQG: `llm-ext __broker` turns this process into
  // the local-model request broker (broker/server.ts), one for every local
  // engine. Checked before loadEngine so a broker never reads, creates or
  // migrates settings; the broker module is imported lazily so ordinary
  // commands never load it.
  if (process.argv[2] === BROKER_ARGV) {
    const { runBrokerMain } = await import("../broker/server.js");
    await runBrokerMain(VERSION);
  }
  // P6: `llm-ext __calibrate` is the detached calibration runner (calibration/runner.ts); like the broker it never loads
  // settings at start; Phase C only reads scout_accuracy_threshold from settings.yaml (read-only, config.loadSettings).
  if (process.argv[2] === CALIBRATE_ARGV) {
    const { runCalibratorMain } = await import("../calibration/runner.js");
    const { phaseA } = await import("../calibration/phase-a.js");
    const { phaseB } = await import("../calibration/phase-b.js");
    const { phaseC } = await import("../calibration/phase-c.js");
    // P6b: all three phases; the runner writes the ok record only when A, B and C passed.
    await runCalibratorMain(VERSION, [phaseA, phaseB, phaseC]);
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
  // TRDD-PN0N4290: the flag wins over settings.yaml network_give_up_seconds (read when each dispatch builds its retry clock).
  setNetworkGiveUpOverrideS(timeouts.networkGiveUpS);
  if (timeouts.commandTimeoutS !== undefined) armCommandTimeout(timeouts.commandTimeoutS);
  if (timeouts.stopOnErrors === true) enableStopOnErrors(endStoppedCommand);
  let engine = isClassifyWord(leadingToken(timeouts.argv)) ? undefined : await loadEngine();
  const { argv: profileStripped, profile: profileOverride } = extractProfileFlag(timeouts.argv);
  const argv = hoistLeadingGlobalFlags(profileStripped);
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
        exitCommand(1);
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
    exitCommand(1);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printToolHelp(tool);
    return;
  }

  // WHY here: a classify command is parsed by the runner itself (kebab flags, `-o`, its own refusals), so the generic flag parser and the --estimate/--preview strip below must not see it. The launcher handles the two dry-run flags instead: runClassifyCommand refuses --preview and hoists --estimate to the front of the runner argv; runClassifyPing refuses both (launcher.ts).
  const classifySpec = classifySpecFor(tool.name);
  // C4-07: ping is run like a decision (own parser, classifier profile, no estimate/preview/boot) but has no spec; every guard below reads this, not classifySpec.
  const isClassify = isClassifyTool(tool.name);

  // --estimate (task #187): dry-run the invocation and print the predicted
  // cost INSTEAD of dispatching. Stripped before parseFlags because it is a
  // global flag, not part of any tool's schema. The paid-mode rules/skills
  // tell agents to run this before every paid operation. Global boolean flags
  // stripped here MUST also be listed in GLOBAL_BOOLEAN_FLAGS (launcher.ts).
  // WHY indexOf over all of `rest`: the flag is found anywhere in argv, including after a bare `--` (where it would otherwise be a file name); it is spliced out before parseFlags, which then rejects the leftover `--` by name (TRDD-23J3NYW8; pinned in estimate-positional-cli.test.ts).
  const estimateIdx = isClassify ? -1 : rest.indexOf(DRY_RUN_FLAGS.estimate.flag);
  const wantEstimate = estimateIdx !== -1;
  if (wantEstimate) rest.splice(estimateIdx, 1);

  // --preview (TRDD-SCLGL8T4): dry-run the FILE SELECTION and print every
  // candidate's verdict — included, or excluded WITH the reason — via the
  // same walker the real run uses. Composes with --estimate (selection +
  // price in one dry-run). Zero LLM sends either way.
  // WHY indexOf over all of `rest`: same as --estimate above, the flag is found anywhere in argv, including after a bare `--`.
  const previewIdx = isClassify ? -1 : rest.indexOf(DRY_RUN_FLAGS.preview.flag);
  const wantPreview = previewIdx !== -1;
  if (wantPreview) rest.splice(previewIdx, 1);

  const { args, quiet } = isClassify ? { args: {} as Record<string, unknown>, quiet: false } : parseFlags(rest, tool, groupedInvocation ?? toKebab(tool.name));

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
  const activeOverride = scoutingOnly || isClassify ? undefined : profileOverride;
  if (scoutingOnly && profileOverride !== undefined) args.profile = profileOverride;
  const effectiveProfile = activeOverride ?? effectiveProfileName(getActiveSettings());
  // WHY skipped for classify: the text profile chain is not used by a decision, and a dangling `active:` must not stop a command that never reads it.
  if (!isClassify) {
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
  if (!isClassify) {
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
  if (isClassify) {
    // TRDD-1L9VMEY7 (USER 2026-11-16: "a remote only profile must not exist"): a remote classifier profile with the local decider
    // fallback disabled in settings.yaml is refused here, for ping and every decision alike, and only here: refusing it when
    // settings.yaml loads would stop every llm-ext command, and the runners' localFallback seam must stay a test seam.
    const remoteOnly = remoteOnlyClassifierRefusal(settingsAsLoaded, profileOverride);
    if (remoteOnly !== undefined) die(remoteOnly);
    const io = {
      settings: settingsAsLoaded,
      fetch: globalThis.fetch as GlobalFetch,
      // WHY here and not inside the runner: RunDeps.settings is narrowed to the three profile keys, so the local decider section travels as its own seam.
      localFallback: settingsAsLoaded.local_fallback,
      stdout: (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
      stderr: (line: string) => process.stderr.write(`${line}\n`),
    };
    // C4-07: ping (no spec) reads no input; a decision reads its JSON or files.
    process.exitCode = classifySpec === undefined
      ? await runClassifyPing(rest, profileOverride, io)
      : await runClassifyCommand(classifySpec, rest, profileOverride, { ...io, readFile: (path) => readFileSync(path, "utf8"), readStdin: readAllStdin });
    // Follow-up review m3: the runner's own code would overwrite the timeout's 124.
    if (commandTimedOut()) process.exitCode = commandStopExitCode();
    return;
  }

  // WHY here, after the PT-03 type check and before boot(): a free, paid or scouting profile whose model is a decisions model cannot answer chat requests (PF-02). The guard reads the cached catalog only, so selecting a profile never touches the network; the classifier checks run in the classifier resolver.
  {
    const guard = await selectedChatProfileErrors(getActiveSettings(), profileOverride ?? effectiveProfile, tool.acceptedProfileTypes, globalThis.fetch);
    if (guard.length > 0) die(guard.join("\n"));
  }
  // boot() publishes the free-mode state; dispatchCallTool refuses without it.
  await boot();

  // WHY (TRDD-UVU9S4RV): chat declares input_files_paths as string-or-array and coerce() keeps a lone positional file a string; the estimate/preview file resolver reads only arrays, so it counted that file as zero. The real tools normalise string|string[] themselves, so the dry runs get the same view; `args` itself stays untouched for the real dispatch.
  const dryRunArgs: Record<string, unknown> =
    typeof args.input_files_paths === "string" ? { ...args, input_files_paths: [args.input_files_paths] } : args;

  if (wantPreview) {
    const deps = buildEstimateDeps();
    const excluded: Array<{ path: string; reason: string }> = [];
    const resolved = deps.resolveFiles(dryRunArgs, (path, reason) =>
      excluded.push({ path, reason }),
    );
    if (resolved.error) {
      process.stderr.write(`preview: ${resolved.error}\n`);
      exitCommand(1);
    }
    process.stdout.write(
      // WHY (TRDD-HUBGO80N): the preview sends nothing: no request in any measured run, the preview branch only resolves files.
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
      // WHY (empty-pool-refreshable): the gate text says a background benchmark is refreshing the pool, which is true only after a real command started the repair (index.ts dispatch). An estimate starts nothing, so on a never-populated pool that sentence is false and sends the user to wait for work that is not running. Say what is actually true and what to do. Not started from here: the repair is a long free benchmark, not a dry-run side effect.
      // WHY (paid-unpopulated, TRDD-P10QMUW7): the paid gate text says the paid profile "is being benchmarked now", which is true only after a real command started it (index.ts finally -> detached detector -> populateDefaultProfile; measured: default-profile-paid.log appears after one real run, not after --estimate). The gate sets this reason only when nothing is running, queued or opted out. An estimate starts nothing, so say what is true and what to do. Not started from here: it is a ~15 minute billable benchmark, not a dry-run side effect.
      const estimateText =
        gate.reason === "empty-pool-refreshable"
          ? "free profile: no usable free model yet (0 available), and nothing is populating the pool: an estimate starts no work. Run the command once without --estimate (it populates the free pool first, no cost), then re-run --estimate.\n"
          : gate.reason === "paid-unpopulated"
            ? "paid profile: not benchmarked yet, and nothing is benchmarking it: an estimate starts no work. Run the command once without --estimate to start the paid benchmark (needs a valid OpenRouter key; about 15 minutes; it spends from the daily paid-benchmark budget), then re-run --estimate.\n"
            : `${gate.message}\n`;
      process.stderr.write(estimateText);
      exitCommand(1);
    }
    await warmEstimatePricing();
    const estimate = estimateToolRun(tool.name, dryRunArgs, buildEstimateDeps());
    process.stdout.write(`${renderEstimate(estimate)}\n`);
    return;
  }

  const verbose = !quiet && !QUIET_TOOLS.has(tool.name);
  if (verbose) writeBootBanner();

  const result = await dispatchCallTool(tool.name, args, { progress: verbose });

  const text = result.content.map((c) => c.text).join("\n");
  if (commandTimedOut()) {
    // Spec 15: the stopped command's own result IS the partial report (the
    // per-file results already written, and the unfinished files listed as
    // failed with the timeout reason). exitCode, not exit: stdout is flushed.
    process.stdout.write(`${text}\n`);
    process.exitCode = commandStopExitCode();
    return;
  }
  if (result.isError) {
    // TRDD-PN84WC1L: a run with some failed files but some results (partial) keeps its
    // summary, report paths included, on stdout where a clean run printed it, so a caller
    // reading stdout does not lose the good results; stderr gets one line, the exit is 1.
    if (result.partial === true) {
      process.stdout.write(`${text}\n`);
      process.stderr.write("llm-ext: some files failed or the run was aborted; see the FAILED / ABORTED block of the summary on stdout\n");
      exitCommand(1);
    }
    process.stderr.write(`${text}\n`);
    exitCommand(1);
  }
  process.stdout.write(`${text}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `llm-ext: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  // A command that failed while stopping (the timeout ended it) still exits as a timeout.
  exitCommand(1);
});
