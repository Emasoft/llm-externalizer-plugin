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

import {
  boot,
  buildEstimateDeps,
  dispatchCallTool,
  limitsBlock,
  overrideActiveProfile,
  warmEstimatePricing,
  writeBootBanner,
} from "../index.js";
import { estimateToolRun, renderEstimate } from "../estimate.js";
import { buildTools } from "../tools/definitions.js";
import { GROUPS, isGroupName, resolveInvocation, suggestCommand } from "./launcher.js";

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
const VERSION = "13.5.4";

// ── Catalog ──────────────────────────────────────────────────────────

interface JsonSchemaProp {
  type?: string;
  description?: string;
  items?: JsonSchemaProp;
  oneOf?: JsonSchemaProp[];
}

interface ToolDef {
  name: string;
  description: string;
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

function parseFlags(argv: string[], tool: ToolDef): ParsedArgs {
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
        `unknown flag --${flag} for '${toKebab(tool.name)}'. ` +
          `Run 'llm-ext ${toKebab(tool.name)} --help' to see its parameters.`,
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
      `'${toKebab(tool.name)}' requires ${missing.map((m) => `--${m}`).join(", ")}`,
    );
  }

  return { args: out, quiet };
}

// ── Help ─────────────────────────────────────────────────────────────

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 96 ? `${line.slice(0, 93)}...` : line;
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
      "  --profile <name>              use this settings.yaml profile for this call only\n\n" +
      "Groups:\n",
  );
  const groupWidth = Math.max(...Object.keys(GROUPS).map((g) => g.length));
  for (const [group, actions] of Object.entries(GROUPS)) {
    process.stdout.write(
      `  ${group.padEnd(groupWidth)}  ${Object.keys(actions).join(", ")}\n`,
    );
  }
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

function printGroupHelp(group: string): void {
  const actions = GROUPS[group];
  process.stdout.write(`llm-ext ${group} <action>\n\nActions:\n`);
  const width = Math.max(...Object.keys(actions).map((a) => a.length));
  for (const [action, spec] of Object.entries(actions)) {
    process.stdout.write(
      `  ${action.padEnd(width)}  -> ${toKebab(spec.command)}\n`,
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

function printToolHelp(tool: ToolDef): void {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  process.stdout.write(`llm-ext ${toKebab(tool.name)}\n\n${tool.description}\n`);
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
      `  --${key.padEnd(width)}  [${schemaTypeOf(prop)}]${tag} ${firstLine(prop.description ?? "")}\n`,
    );
  }
  if (showProfile) {
    process.stdout.write(
      `  --${"profile".padEnd(width)}  [string] Use this settings profile for this invocation only ` +
        "(built-in, or a key under `profiles:` in ~/.llm-externalizer/settings.yaml). " +
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

async function main(): Promise<void> {
  const { argv, profile: profileOverride } = extractProfileFlag(process.argv.slice(2));
  // The catalog's descriptions are backend-dependent, so build it per run.
  const tools = buildTools(limitsBlock()) as ToolDef[];

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
  if (isGroupName(argv[0])) {
    const resolved = resolveInvocation(argv, tools);
    switch (resolved.kind) {
      case "group-help":
        printGroupHelp(resolved.group);
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
        printToolHelp(actionTool);
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

  // --estimate (task #187): dry-run the invocation and print the predicted
  // cost INSTEAD of dispatching. Stripped before parseFlags because it is a
  // global flag, not part of any tool's schema. The paid-mode rules/skills
  // tell agents to run this before every paid operation.
  const estimateIdx = rest.indexOf("--estimate");
  const wantEstimate = estimateIdx !== -1;
  if (wantEstimate) rest.splice(estimateIdx, 1);

  // --preview (TRDD-SCLGL8T4): dry-run the FILE SELECTION and print every
  // candidate's verdict — included, or excluded WITH the reason — via the
  // same walker the real run uses. Composes with --estimate (selection +
  // price in one dry-run). Zero LLM sends either way.
  const previewIdx = rest.indexOf("--preview");
  const wantPreview = previewIdx !== -1;
  if (wantPreview) rest.splice(previewIdx, 1);

  const { args, quiet } = parseFlags(rest, tool);

  // --profile <name>: apply BEFORE boot() so publishFreeState()/the boot
  // banner and every downstream getCurrentBackend()/activeResolved read
  // reflect the override for the whole invocation. Never mutates
  // settings.yaml — see overrideActiveProfile()'s doc comment in index.ts.
  if (profileOverride !== undefined) {
    const result = overrideActiveProfile(profileOverride);
    if (!result.ok) die(result.error);
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
