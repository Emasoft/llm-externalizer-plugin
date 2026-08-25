/**
 * The grouped front door: `llm-ext <group> <action> [input] [--flag value ...]`.
 *
 * Pure translation layer (TRDD-DT11TE2Z) — it never touches dispatch, the
 * catalog, or any existing command. It only rewrites argv from the grouped
 * spelling to the flat command name + flags the existing CLI already
 * understands, then hands off. Every existing flat command keeps working
 * unchanged; this module only engages when argv[0] matches a group name.
 */

interface JsonSchemaProp {
  type?: string;
  description?: string;
  items?: JsonSchemaProp;
  oneOf?: JsonSchemaProp[];
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
}

/** One action: which existing command it dispatches to, and (optionally) the
 * flag a bare positional argument fills. */
export interface ActionSpec {
  command: string;
  /** Flag name the first non-flag argument is written to, if any. */
  positional?: string;
}

/**
 * The group → action → existing-command map (TRDD-DT11TE2Z table). Every
 * `command` here MUST name a tool that exists in the real catalog — verified
 * by `launcher.test.ts` against `buildTools()`, so a typo here fails the
 * build/test rather than silently 404ing at runtime.
 */
export const GROUPS: Readonly<Record<string, Readonly<Record<string, ActionSpec>>>> = {
  session: {
    compact: { command: "session_summary", positional: "transcript" },
  },
  llm: {
    ask: { command: "chat", positional: "input_files_paths" },
    code: { command: "code_task", positional: "input_files_paths" },
    cluster: { command: "cluster_synonyms", positional: "input_file" },
    summarize: { command: "summarize", positional: "input_file" },
    topics: { command: "topics", positional: "input_file" },
    "sem-deduplicate": { command: "sem_deduplicate", positional: "input_file" },
    describe: { command: "describe", positional: "input_file" },
  },
  scan: {
    folder: { command: "scan_folder", positional: "folder_path" },
    security: { command: "security_scan" },
    quality: { command: "high_quality_scan", positional: "folder_path" },
    impl: { command: "search_existing_implementations", positional: "folder_path" },
  },
  check: {
    imports: { command: "check_imports", positional: "input_files_paths" },
    refs: { command: "check_references", positional: "input_files_paths" },
    specs: { command: "check_against_specs", positional: "spec_file_path" },
    rules: { command: "rules_check", positional: "file_path" },
    plan: { command: "review_plan", positional: "input_files_paths" },
    diff: { command: "compare_files" },
  },
  scout: {
    run: { command: "mass_scout" },
    register: { command: "mass_scout_register" },
    preclassify: { command: "mass_scout_preclassify" },
    estimate: { command: "mass_scout_estimate" },
    search: { command: "mass_scout_search" },
    "search-xjob": { command: "mass_scout_search_xjob" },
    get: { command: "mass_scout_get" },
    export: { command: "mass_scout_export" },
    jobs: { command: "mass_scout_jobs_list" },
    "audit-sample": { command: "mass_scout_audit_sample" },
    "body-get": { command: "mass_scout_body_get" },
    "build-fieldset": { command: "mass_scout_build_fieldset" },
    "propose-fieldset": { command: "mass_scout_propose_fieldset" },
    diff: { command: "mass_scout_diff" },
    chain: { command: "mass_scout_chain" },
    "list-fieldsets": { command: "mass_scout_list_bundled_fieldsets" },
  },
  models: {
    info: { command: "or_model_info", positional: "model" },
    assess: { command: "assess_model", positional: "model" },
    health: { command: "check_model_health" },
    discover: { command: "discover_new_models" },
    replacements: { command: "check_tool_replacements" },
  },
  settings: {
    show: { command: "get_settings" },
    profile: { command: "profile" },
    profiles: { command: "list_profiles" },
    reset: { command: "reset" },
    status: { command: "discover" },
    "scan-local": { command: "scan_local_llm_services" },
  },
};

/** True when `name` is a known group — the launcher only engages then. */
export function isGroupName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GROUPS, name);
}

// ── Levenshtein + suggestions ───────────────────────────────────────────

/** Classic edit-distance DP. Small inputs (command/action names) only. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1, // deletion
        dp[j - 1] + 1, // insertion
        prev + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/** Max 3 candidates within edit distance <= threshold, closest first. Empty
 * when nothing is close enough — a confidently wrong guess is worse than
 * none (TRDD-DT11TE2Z requirement 2). */
export function suggest(
  input: string,
  candidates: readonly string[],
  threshold = 3,
  max = 3,
): string[] {
  return candidates
    .map((c) => ({ c, d: levenshtein(input, c) }))
    .filter(({ d }) => d <= threshold)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map(({ c }) => c);
}

/** A suggestion for an unrecognized TOP-LEVEL token (`llm-ext <typo>`). */
export interface CommandSuggestion {
  /** "group" when at least one group name is close — the surface we lead
   * with, so it always wins when available. "flat" only when no group is
   * close enough, and callers MUST label it visibly differently (it is the
   * de-emphasized flat command surface, not the grouped one the user typed
   * into). */
  kind: "group" | "flat";
  names: string[];
}

/**
 * Suggest for a top-level token that matched neither a group nor a flat
 * command name. Groups first, flat names only as a distinctly-labelled
 * fallback — never mixed into one undifferentiated list (a group typo and
 * a flat-command typo are different kinds of mistake).
 */
export function suggestCommand(
  input: string,
  flatCommandNames: readonly string[],
): CommandSuggestion | null {
  const groupHint = suggest(input, Object.keys(GROUPS));
  if (groupHint.length > 0) return { kind: "group", names: groupHint };
  const flatHint = suggest(input, flatCommandNames);
  if (flatHint.length > 0) return { kind: "flat", names: flatHint };
  return null;
}

// ── Resolution ───────────────────────────────────────────────────────────

export type ResolveResult =
  | { kind: "dispatch"; command: string; argv: string[] }
  | { kind: "group-help"; group: string }
  | { kind: "action-help"; group: string; action: string; command: string }
  | { kind: "error"; message: string; suggestions: string[] };

/** Find the tool's declared output flag, if any: `output` wins over
 * `output_dir` (session_summary's convention), matching whichever the
 * target command actually declares. Undefined when the command has neither
 * — `-o`/`--output` is then passed through unmapped (and parseFlags will
 * reject it loudly rather than silently drop it, per the fail-fast rule). */
function outputFlagOf(tool: ToolDef | undefined): string | undefined {
  const props = tool?.inputSchema?.properties ?? {};
  if ("output" in props) return "output";
  if ("output_dir" in props) return "output_dir";
  return undefined;
}

/** The literals the flat parser accepts as an explicit boolean VALUE — kept in
 *  sync with `BOOLEAN_LITERALS` in main.ts, because that parser consumes the
 *  token after a boolean flag ONLY when it is one of these. */
const BOOLEAN_VALUE_LITERALS = new Set(["true", "false", "1", "0", "yes", "no", "on", "off"]);

/** Global boolean flags handled by main.ts OUTSIDE any tool schema (`--quiet`
 *  in parseFlags; `--estimate`/`--preview` stripped before dispatch; `--help`/
 *  `-h` short-circuits earlier). They appear in no tool's
 *  `inputSchema.properties`, so without this list the unknown-flag guess in
 *  `flagTakesValue` treated them as value-taking and swallowed the following
 *  POSITIONAL as their "value" (`llm-ext scan folder --quiet ./src` ate
 *  `./src`). Adding a global boolean flag to main.ts REQUIRES adding it here —
 *  launcher.test.ts iterates this set with the flag placed BEFORE the
 *  positional, so a missing entry fails the suite. `--profile` is deliberately
 *  absent: it TAKES a value, and extractProfileFlag() strips it from argv
 *  before resolveInvocation ever runs. */
export const GLOBAL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--quiet",
  "--estimate",
  "--preview",
  "--help",
  "-h",
]);

/**
 * Does `token` (a `-`-prefixed flag) consume the NEXT token as its value?
 *
 * Load-bearing for positional capture: a flag's value is itself a bare,
 * non-`-` token, so without this the FIRST such token wins the positional slot
 * — `llm-ext scan folder --instructions "find bugs" src/` rewrote
 * `"find bugs"` into `--folder_path`, leaving `--instructions` to swallow
 * `--folder_path` as its value and `src/` to die as an "unexpected argument".
 * The same hit `-o out.md` typed before the input.
 *
 * A GLOBAL boolean flag never takes a value (checked first — it is known, just
 * not in the schema). A truly UNKNOWN flag is assumed to take a value:
 * guessing the other way would let its argument win the positional slot, and
 * either way the flat parser then rejects the unknown flag by name.
 */
function flagTakesValue(token: string, next: string | undefined, tool: ToolDef | undefined): boolean {
  if (token.includes("=")) return false; // `--flag=value` carries its own value
  if (GLOBAL_BOOLEAN_FLAGS.has(token)) return false; // global bool — never eats a token
  if (next === undefined || next.startsWith("-")) return false;
  const props = tool?.inputSchema?.properties ?? {};
  const name = token.replace(/^-+/, "");
  const prop = props[name] ?? props[name.replace(/-/g, "_")];
  if (!prop) return true; // unknown flag — never steal what might be its value
  if (prop.type === "boolean") return BOOLEAN_VALUE_LITERALS.has(next.toLowerCase());
  return true;
}

/**
 * Rewrite `<group> <action> [positional] [--flags...]` into the flat
 * `<command> [--flags...]` the existing dispatcher already understands.
 * Pure — no I/O, no process.exit. `tools` is the real catalog (or a test
 * double) so `-o`/`--output` can be mapped to whatever output flag the
 * target command actually declares.
 */
export function resolveInvocation(argv: string[], tools: readonly ToolDef[]): ResolveResult {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const group = argv[0];
  const actions = GROUPS[group];
  if (!actions) {
    return {
      kind: "error",
      message: `unknown group '${group}'.`,
      suggestions: suggest(group, Object.keys(GROUPS)),
    };
  }

  const rest = argv.slice(1);
  // No action token at all, OR the action slot holds a FLAG (`scan --quiet`,
  // `scan --help`) rather than an action name — a global flag with no action
  // is not an unknown-action error, it is "show me this group". Any leading
  // `-`-prefixed token counts, not just the ones this launcher happens to
  // know by name, so a global flag added later doesn't need a matching edit
  // here to keep working.
  if (rest.length === 0 || rest[0].startsWith("-")) {
    return { kind: "group-help", group };
  }

  const actionName = rest[0];
  const spec = actions[actionName];
  if (!spec) {
    return {
      kind: "error",
      message: `unknown action '${actionName}' in group '${group}'.`,
      // Grouped form (`scan folder`, not bare `folder`) — the user typed a
      // grouped invocation, so the suggestion must stay in that vocabulary
      // rather than leaking the flat command surface being de-emphasized.
      suggestions: suggest(actionName, Object.keys(actions)).map((a) => `${group} ${a}`),
    };
  }

  const tail = rest.slice(1);
  if (tail.includes("--help") || tail.includes("-h")) {
    return { kind: "action-help", group, action: actionName, command: spec.command };
  }

  const tool = byName.get(spec.command);
  const outFlag = outputFlagOf(tool);
  const out: string[] = [];
  let consumedPositional = false;

  // True while the PREVIOUS token was a flag still owed its value — that value
  // is a bare token and must never be mistaken for the positional input.
  let awaitingFlagValue = false;

  for (let i = 0; i < tail.length; i++) {
    const token = tail[i];
    if (token === "-o" || token === "--output") {
      if (!outFlag) {
        // This command declares no output parameter at all (it writes to a
        // fixed reports dir). Passing `-o` through would reach the flat parser,
        // which rejects it as "unexpected argument (all inputs are named
        // flags)" — actively misleading, since `-o` IS a named flag and the
        // real problem is that THIS action has nowhere to put it. Say that.
        return {
          kind: "error",
          message: `'${group} ${actionName}' has no output option — it writes its report to the project's reports directory.`,
          suggestions: [],
        };
      }
      out.push(`--${outFlag}`);
      // Either way the next bare token is this flag's PATH, not the positional.
      awaitingFlagValue = tail[i + 1] !== undefined && !tail[i + 1].startsWith("-");
      continue;
    }
    if (token.startsWith("-")) {
      out.push(token);
      awaitingFlagValue = flagTakesValue(token, tail[i + 1], tool);
      continue;
    }
    if (awaitingFlagValue) {
      out.push(token);
      awaitingFlagValue = false;
      continue;
    }
    if (!consumedPositional && spec.positional) {
      out.push(`--${spec.positional}`, token);
      consumedPositional = true;
      continue;
    }
    out.push(token);
  }

  return { kind: "dispatch", command: spec.command, argv: out };
}
