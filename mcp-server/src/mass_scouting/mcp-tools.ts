/**
 * MCP-tool surface for mass-scouting. Each tool is a thin wrapper that
 * builds a CLI argv from MCP arguments and delegates to `runMassScoutCli`.
 * That keeps the CLI semantics and the MCP semantics in lock-step — there
 * is exactly ONE source of truth for what each sub-command does, and one
 * test surface (`cli.test.ts`) covers both paths.
 *
 * `MASS_SCOUT_TOOLS` is the tool-definition array consumed by `index.ts`'s
 * `buildTools()`. `dispatchMassScoutTool(name, args)` returns the standard
 * MCP `{ content: [{type:"text", text}] }` envelope (with `isError: true`
 * when the underlying CLI returned a non-zero exit code).
 *
 * Why we delegate to the CLI rather than calling each module directly:
 * - The CLI already validates flags + error messages. Reproducing them
 *   here would drift over time.
 * - One test surface (`cli.test.ts`) verifies both code paths.
 * - The MCP layer is intentionally minimal — it just builds argv strings.
 */

import { runMassScoutCli, type CliResult, type CliRunOptions } from "./cli";
import { runSecurityTriageBenchmark } from "../benchmark/security-triage/index";
import { assessModelById, renderAssessmentText } from "../model-qualification/assess";
import { runCheckModelHealth, renderModelHealthText } from "../model-qualification/drift";

// ── Public types (mirror the CLI flag set, MCP-flavoured) ─────────────

/**
 * Standard MCP tool result envelope. Index signature matches the wider
 * `ServerResult` union from the MCP SDK so the dispatcher's return value
 * is assignable to the SDK's `setRequestHandler` callback type.
 */
export interface McpResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Subset of MCP tool definition that index.ts's buildTools() consumes. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build argv from a flag map. `undefined` values are dropped; `true`
 * values render as a bare `--key`; arrays render as comma-separated.
 */
function buildArgv(
  sub: string,
  flags: Record<string, string | number | boolean | string[] | undefined>,
): string[] {
  const out: string[] = [sub];
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === null) continue;
    if (v === false) continue;
    const flag = `--${k}`;
    if (v === true) {
      out.push(flag);
    } else if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out.push(flag, v.join(","));
    } else {
      out.push(flag, String(v));
    }
  }
  return out;
}

/** Convert a `CliResult` into the MCP envelope. */
function toMcp(r: CliResult): McpResult {
  const text =
    r.exitCode === 0 ? r.stdout : `${r.stdout}${r.stderr}`.trim();
  const env: McpResult = {
    content: [{ type: "text", text: text || "(no output)" }],
  };
  if (r.exitCode !== 0) env.isError = true;
  return env;
}

// ── Common JSON Schema fragments ───────────────────────────────────────

const dbPathProp = {
  type: "string",
  description:
    "Absolute path to the SQLite registry. Created if missing. " +
    "All sub-commands of a single workflow must point at the same db.",
};

const jobIdProp = {
  type: "string",
  description:
    "Stable job identifier (e.g. 'scout-2026-05-06-audit'). " +
    "Re-running scout with the same id resumes from where it left off.",
};

// ── Tool definitions ───────────────────────────────────────────────────

export const MASS_SCOUT_TOOLS: McpToolDef[] = [
  {
    name: "mass_scout_register",
    description:
      "mass-scouting Phase 1: register every file under a folder (or a " +
      "supplied file list) into the SQLite body cache. Files larger than " +
      "the model's register cap (default 50% of context) are recorded as " +
      "skipped. Idempotent — re-registering the same body returns the " +
      "existing short_id.\n\nRETURNS: one-line counter summary " +
      "(registered/already_registered/skipped_too_big/skipped_read_error).",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        folder_path: {
          type: "string",
          description:
            "Absolute path to the folder to walk. Mutually exclusive with file_paths.",
        },
        file_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit list of absolute file paths. Mutually exclusive with folder_path.",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter the walk to these extensions (e.g. ['.ts', '.md']). Only used with folder_path.",
        },
        exclude_dirs: {
          type: "array",
          items: { type: "string" },
          description:
            "Additional directory names to skip during the walk. Built-in skips: .git, node_modules, .venv, dist, build, .idea, .vscode, tmp, vendor, __pycache__, target, .next, .cache, .turbo, out.",
        },
        model: {
          type: "string",
          description:
            "Model id (default: qwen/qwen-2.5-7b-instruct). Used to compute the register byte-cap.",
        },
        max_context_pct_register: {
          type: "number",
          description:
            "Override the default 50% of context cap. 0..1 fraction.",
        },
        git_diff: {
          type: "string",
          description:
            "Restrict registration to files changed since this git ref " +
            "(uses `git diff --name-only <ref>...HEAD`). Requires folder_path. " +
            "Use for incremental / PR-review scouting.",
        },
        no_gitignore: {
          type: "boolean",
          description:
            "Bypass .gitignore filtering. Default: gitignored files are skipped.",
        },
      },
      required: ["db_path"],
    },
  },
  {
    name: "mass_scout_preclassify",
    description:
      "mass-scouting Phase 2: cheap script-only classifier. Reads body bytes " +
      "from the cache (no disk re-read), assigns each file a bucket — " +
      "binary, rules_to_eval, has_frontmatter, documentation, sourcecode, " +
      "config, log_to_classify, unknown — plus language and format tags.\n\n" +
      "RETURNS: total / classified / skipped / by-bucket counts.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        reclassify: {
          type: "boolean",
          description:
            "Re-run the classifier on already-classified rows (default: false).",
        },
        limit: {
          type: "number",
          description:
            "Only process this many rows. Useful for incremental runs.",
        },
      },
      required: ["db_path"],
    },
  },
  {
    name: "mass_scout_estimate",
    description:
      "mass-scouting Phase 3: cost / time estimate for a fieldset against " +
      "the registered files. Honors the budget gate (--budget_usd). Pure — " +
      "no LLM calls.\n\nRETURNS: files_eligible, files_skipped_too_big, " +
      "total_input_tokens, total_output_tokens, est_cost_usd, est_seconds, " +
      "budget_allowed.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        fields_file: {
          type: "string",
          description:
            "Absolute path to the JSON fieldset file (see TRDD §5 for format).",
        },
        model: {
          type: "string",
          description: "Model id. Default: qwen/qwen-2.5-7b-instruct.",
        },
        bucket: {
          type: "string",
          description:
            "Optional preclassifier bucket filter (e.g. 'sourcecode').",
        },
        workers: {
          type: "number",
          description:
            "Worker count for the ETA calculation. Default: 16 — matches " +
            "the scout phase's default so est_seconds reflects a real run.",
        },
        per_call_seconds: {
          type: "number",
          description: "Avg seconds per LLM call for the ETA. Default: 1.0.",
        },
        budget_usd: {
          type: "number",
          description:
            "If supplied, refuses to schedule when est_cost_usd exceeds this value.",
        },
        expected_output_bytes: {
          type: "number",
          description:
            "Estimated output JSON size per file. Default: 200.",
        },
        max_context_pct_scout: {
          type: "number",
          description: "Override the default 40% scout cap. 0..1 fraction.",
        },
        max_context_pct_register: {
          type: "number",
          description:
            "Override the default 50% register cap. 0..1 fraction.",
        },
        input_price_per_m: {
          type: "number",
          description:
            "USD per 1M input tokens (overrides KNOWN_PRICING). Must come with output_price_per_m + context_window.",
        },
        output_price_per_m: {
          type: "number",
          description:
            "USD per 1M output tokens (overrides KNOWN_PRICING).",
        },
        context_window: {
          type: "number",
          description: "Tokens (overrides KNOWN_PRICING).",
        },
        live_context: {
          type: "boolean",
          description:
            "Query OpenRouter for the active provider's actual context_length " +
            "and use it as the cap (overrides KNOWN_PRICING.context_window). " +
            "Recommended when you don't know whether your account routes to a " +
            "smaller-cap endpoint (e.g. 32K vs 128K). Requires OPENROUTER_API_KEY.",
        },
      },
      required: ["db_path", "fields_file"],
    },
  },
  {
    name: "mass_scout",
    description:
      "mass-scouting Phase 4: actually call the LLM on every eligible file. " +
      "Compiles the fieldset into a JSON Schema, fans calls out via the " +
      "scout worker, applies fix_envelope repairs, runs the required-keys " +
      "validator, persists results + FTS rows. Writes a markdown report " +
      "under <main-project-dir>/reports/mass_scouting/ (override with " +
      "output_dir).\n\nRETURNS: " +
      "files_total/ok/failed/skipped_too_big, retries, cost_usd, report path.\n\n" +
      "ENV: $OPENROUTER_API_KEY must be set.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        fields_file: {
          type: "string",
          description:
            "Absolute path to the JSON fieldset file (see TRDD §5).",
        },
        job_id: jobIdProp,
        source_root: {
          type: "string",
          description:
            "Original folder the files came from. Recorded on the job row for the report.",
        },
        model: {
          type: "string",
          description: "Default: qwen/qwen-2.5-7b-instruct.",
        },
        workers: {
          type: "number",
          description: "Concurrent OpenRouter calls. Default: 16.",
        },
        max_retries: {
          type: "number",
          description:
            "Per-file retry budget (excluding first attempt). Default: 1.",
        },
        bucket: {
          type: "string",
          description: "Optional preclassifier bucket filter.",
        },
        no_smoke_test: {
          type: "boolean",
          description:
            "Skip the 5-file smoke test that runs sequentially before fan-out.",
        },
        no_resume: {
          type: "boolean",
          description:
            "Re-process files even if they already have a result row for this job_id.",
        },
        max_context_pct_scout: {
          type: "number",
          description: "Override the default 40% scout cap. 0..1.",
        },
        output_dir: {
          type: "string",
          description:
            "Absolute path for the markdown report directory. Defaults to " +
            "<main-project-dir>/reports/mass_scouting/. Pass this when running " +
            "as an MCP server so the report lands in the user's project " +
            "rather than the plugin's install cache.",
        },
        live_context: {
          type: "boolean",
          description:
            "Query OpenRouter for the actual provider context_length and " +
            "use it instead of KNOWN_PRICING.context_window. Same flag as " +
            "mass_scout_estimate.",
        },
      },
      required: ["db_path", "fields_file", "job_id", "source_root"],
    },
  },
  {
    name: "mass_scout_search",
    description:
      "mass-scouting Phase 5: per-job search. Three modes (auto-routed):\n" +
      "  - regex   — explicit --regex OR a query that matches a built-in " +
      "    pattern ('all emails', 'urls of domain X', 'all ipv4', etc.)\n" +
      "  - fts     — FTS5 query against the per-job index\n" +
      "  - structured — JSON1 path filters against result_json\n" +
      "  - combined — fts + structured (intersected)\n\n" +
      "Filters use 'path:OP:value' format (OP = =, !=, >, >=, <, <=, LIKE).",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        job_id: jobIdProp,
        query: {
          type: "string",
          description:
            "FTS5 query OR a natural-language query that may match a built-in regex pattern.",
        },
        regex: {
          type: "string",
          description:
            "Explicit regex pattern. Forces regex mode regardless of query.",
        },
        force_llm: {
          type: "boolean",
          description: "Suppress the regex bypass even on trivial queries.",
        },
        force_regex: {
          type: "boolean",
          description:
            "Force regex mode. Requires either an explicit `regex` or a query that matches a named pattern.",
        },
        filter: {
          type: "string",
          description:
            "Comma-comma-separated structured filters. Each one is 'path:OP:value'. Example: '$.is_async:=:true,,$.complexity:>=:5'.",
        },
        limit: {
          type: "number",
          description: "Max hits returned. Default: 50.",
        },
        offset: {
          type: "number",
          description: "Skip the first N hits (FTS / structured only).",
        },
        json: {
          type: "boolean",
          description:
            "Return results as JSON instead of a human-readable table.",
        },
      },
      required: ["db_path", "job_id"],
    },
  },
  {
    name: "mass_scout_search_xjob",
    description:
      "Cross-job federated search. Same flags as mass_scout_search but " +
      "takes job_ids (a list) and returns merged results tagged with the " +
      "originating job. Per-job hits are bm25-ranked and capped by limit_per_job; " +
      "the merged list is capped by limit_merged.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        job_ids: {
          type: "array",
          items: { type: "string" },
          description: "Two or more job_ids to federate across.",
        },
        query: {
          type: "string",
          description:
            "Free-text query — auto-routed to the regex bypass for " +
            "patterns like 'all emails', 'urls of domain X', 'all ipv4'; " +
            "otherwise interpreted as an FTS5 query over the per-job index.",
        },
        regex: {
          type: "string",
          description:
            "Explicit regex executed over cached file bodies. Use to " +
            "force the regex bypass when auto-routing wouldn't match.",
        },
        force_llm: {
          type: "boolean",
          description:
            "Force the LLM-search path even if regex/FTS would normally " +
            "handle the query. Costs the model.",
        },
        force_regex: {
          type: "boolean",
          description: "Force the regex bypass — skip FTS / structured.",
        },
        filter: {
          type: "string",
          description:
            "Comma-comma-separated structured filters using " +
            "'path:OP:value' (OP = =, !=, >, >=, <, <=, LIKE). " +
            "Example: '$.is_async:=:true,,$.complexity:>=:5'.",
        },
        limit_per_job: {
          type: "number",
          description: "Cap per source job before merging. Default 100.",
        },
        limit_merged: {
          type: "number",
          description: "Cap on the final merged hit list. Default 200.",
        },
        json: {
          type: "boolean",
          description: "Return JSON instead of human-readable text.",
        },
      },
      required: ["db_path", "job_ids"],
    },
  },
  {
    name: "mass_scout_get",
    description:
      "Retrieve one file row by short_id. Optionally include the result " +
      "row for a specific job by passing job_id.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        short_id: {
          type: "number",
          description: "Positive integer short_id from registerFile.",
        },
        job_id: {
          type: "string",
          description:
            "Optional. When supplied, the result row from mass_scout_results is included.",
        },
      },
      required: ["db_path", "short_id"],
    },
  },
  {
    name: "mass_scout_export",
    description:
      "Dump every result row of a job to JSONL or CSV under " +
      "<main-project-dir>/reports/mass_scouting/. Useful for follow-up " +
      "analysis in pandas, jq, etc.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        job_id: jobIdProp,
        format: {
          type: "string",
          description: "'jsonl' (default) or 'csv'.",
        },
        output_dir: {
          type: "string",
          description:
            "Absolute path for the export directory. Defaults to " +
            "<main-project-dir>/reports/mass_scouting/.",
        },
      },
      required: ["db_path", "job_id"],
    },
  },
  {
    name: "mass_scout_jobs_list",
    description:
      "List every mass-scouting job in a DB with key metadata " +
      "(fieldset, model, ok/total, cost, started_at). Use this to " +
      "discover what work has already been done before starting a new scout.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        json: {
          type: "boolean",
          description: "Return as a JSON array instead of a table.",
        },
      },
      required: ["db_path"],
    },
  },
  {
    name: "mass_scout_audit_sample",
    description:
      "Pick N random results from a finished job and print them ALONGSIDE " +
      "the cached file body. The standard human-trust check: did the model " +
      "actually understand the file? Returns a structured `samples` array " +
      "in JSON mode for downstream review pipelines.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        job_id: jobIdProp,
        sample: {
          type: "number",
          description: "How many random samples to pull. Default: 5.",
        },
        body_truncate: {
          type: "number",
          description:
            "Per-body excerpt cap in chars. Default: 1000.",
        },
        json: {
          type: "boolean",
          description: "Return JSON instead of human-readable markdown.",
        },
      },
      required: ["db_path", "job_id"],
    },
  },
  {
    name: "mass_scout_body_get",
    description:
      "Print the cached file body for a given short_id. The body cache " +
      "is the read-once-from-disk source of truth — exposing it here " +
      "lets follow-up subagents re-analyse a file without touching the " +
      "filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: dbPathProp,
        short_id: {
          type: "number",
          description: "Positive integer short_id from mass_scout_register.",
        },
      },
      required: ["db_path", "short_id"],
    },
  },
  {
    name: "mass_scout_build_fieldset",
    description:
      "Compose a JSON fieldset from --field shorthand tokens. Use this " +
      "when you know the shape you want and prefer one-liner field defs " +
      "over hand-writing JSON. Forms supported by the shorthand parser: " +
      "`name:bool=desc`, `name:string(120)=desc`, `name:enum(a,b,c)=desc`, " +
      "`name:array_string(8)=desc`, `name:array_enum(a,b,c)(8)=desc`, " +
      "`name:int(1-10)=desc`, `name:number(0.0-1.0)=desc`. Use array_enum " +
      "(not array_string) for a fixed tag vocabulary so the model cannot " +
      "drift off your allowed values.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Fieldset name (lowercase identifier).",
        },
        field: {
          type: "array",
          items: { type: "string" },
          description:
            "One or more shorthand tokens like 'is_async:bool=true if file uses async/await'.",
        },
        out: {
          type: "string",
          description:
            "Optional path to write the JSON fieldset (otherwise stdout).",
        },
      },
      required: ["name", "field"],
    },
  },
  {
    name: "mass_scout_propose_fieldset",
    description:
      "Ask the LLM to propose a fieldset JSON for a natural-language " +
      "goal, optionally seeded with sample files. The biggest UX cliff " +
      "in mass-scouting is 'what fields do I write?' — this tool resolves " +
      "it. Returns the validated fieldset JSON.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "One-sentence statement of what the user wants to find/extract.",
        },
        samples: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of sample file paths to seed the model with real content.",
        },
        model: {
          type: "string",
          description:
            "Model id used to compose the fieldset. Default: qwen/qwen-2.5-7b-instruct.",
        },
        out: {
          type: "string",
          description:
            "Optional path to write the JSON fieldset (otherwise stdout).",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "mass_scout_diff",
    description:
      "Compare two scout jobs row-by-row and report which fingerprints " +
      "are only in one, only in the other, identical, or have changed " +
      "fields. Use to confirm that a re-scout (after a fieldset tweak, " +
      "model swap, or partial re-register) actually changed the data " +
      "you expected — and didn't silently regress other rows. Output " +
      "is a human summary by default, JSON with `json: true`.",
    inputSchema: {
      type: "object",
      properties: {
        db_path: { type: "string", description: "Path to the SQLite DB." },
        from_job: { type: "string", description: "Baseline job_id." },
        to_job: { type: "string", description: "Comparison job_id." },
        json: {
          type: "boolean",
          description: "Return JSON instead of human-readable summary.",
        },
      },
      required: ["db_path", "from_job", "to_job"],
    },
  },
  {
    name: "mass_scout_chain",
    description:
      "Run a second scout pass on the subset of rows from a prior job " +
      "that match a JSON-extract filter. Use to drill deeper into a " +
      "high-value slice (e.g. files where job-A flagged severity=" +
      "'critical') without re-scouting the whole tree. The new job " +
      "uses a fresh fieldset, so you can extract DIFFERENT fields " +
      "from the matched subset. Filter syntax: '$.path:OP:value' " +
      "where OP is one of =, !=, >, >=, <, <=, LIKE (e.g. " +
      "'$.severity:=:critical', '$.score:>=:0.8', " +
      "'$.summary:LIKE:auth%').",
    inputSchema: {
      type: "object",
      properties: {
        db_path: { type: "string", description: "Path to the SQLite DB." },
        source_job: {
          type: "string",
          description: "Job to chain from (its results are the input set).",
        },
        new_job_id: {
          type: "string",
          description:
            "Job id for the new chained scout. Must not already exist.",
        },
        new_fields_file: {
          type: "string",
          description: "Path to the new fieldset JSON for this job.",
        },
        filter: {
          type: "string",
          description:
            "JSON-extract filter using '$.path:OP:value' syntax. " +
            "Operators: =, !=, >, >=, <, <=, LIKE.",
        },
        model: {
          type: "string",
          description: "Model id to use for the new job.",
        },
        workers: {
          type: "number",
          description: "Concurrency. Default 4.",
        },
        max_retries: {
          type: "number",
          description: "Per-file retries. Default 1.",
        },
      },
      required: [
        "db_path",
        "source_job",
        "new_job_id",
        "new_fields_file",
        "filter",
      ],
    },
  },
  {
    name: "mass_scout_list_bundled_fieldsets",
    description:
      "List the plugin-shipped fieldsets that other tools accept as " +
      "fields_file: 'bundled:<name>'. The biggest UX cliff in mass-" +
      "scouting is 'what fields do I write?' — these standard sets " +
      "(code-audit, skill-audit, security-audit, pr-review) cover the " +
      "common cases with no fieldset authoring required.",
    inputSchema: {
      type: "object",
      properties: {
        json: {
          type: "boolean",
          description:
            "If true, return a JSON list of {name, path, fields[]} " +
            "objects so a caller can pick the right one programmatically.",
        },
      },
      required: [],
    },
  },
  {
    name: "security_scan",
    description:
      "Dedicated, INJECTION-HARDENED security triage for suspected-malicious " +
      "code. NOT the mass_scout pipeline — a bespoke judge with a " +
      "nonce-delimited untrusted-data envelope, a hardened system prompt, " +
      "strict json_schema output, an in-band injection pre-scan, and " +
      "fail-safe-to-'uncertain' on EVERY error/deviation (never a silent " +
      "not_threat). Adjudicates a batch of targets (inline snippet | " +
      "file_path+line+context_lines window | path_glob) and emits per-item " +
      "verdicts {verdict: threat|not_threat|uncertain, confidence, reason, " +
      "injection_observed}. RETURNS: counts + JSON/markdown report paths. " +
      "ENV: $OPENROUTER_API_KEY (absent ⇒ all verdicts 'uncertain').",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          description:
            "Work items. Each has id + category + EXACTLY ONE payload of: " +
            "snippet (inline code) | file_path (+optional line, context_lines) | " +
            "path_glob (expands to files). Optional per-item: language.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              category: { type: "string" },
              language: { type: "string" },
              snippet: { type: "string" },
              file_path: { type: "string" },
              line: { type: "number" },
              context_lines: { type: "number" },
              path_glob: { type: "string" },
            },
            required: ["id", "category"],
          },
        },
        category_rubrics: {
          type: "object",
          description:
            "Per-category adjudication rubric, placed in the SYSTEM prompt " +
            "(snippet content can never alter it). Keys = category names.",
          additionalProperties: { type: "string" },
        },
        default_verdict_on_error: {
          type: "string",
          // F2 (aegis 2026-05-23): not_threat is intentionally NOT offered — the
          // fail-safe must never fail open. The validator rejects it too.
          enum: ["threat", "uncertain"],
          description:
            "Verdict on any error/deviation. Default 'uncertain'. May be " +
            "'uncertain' or 'threat' only — never 'not_threat' (the fail-safe " +
            "must never fail open).",
        },
        budget_usd: {
          type: "number",
          description:
            "Whole-job hard pre-flight gate (all-or-nothing). Refuses the " +
            "entire job if the estimate exceeds this; never a silent partial.",
        },
        model: {
          type: "string",
          description: "OpenRouter model id. Default qwen/qwen-2.5-7b-instruct.",
        },
        git_diff_ref: {
          type: "string",
          description:
            "Incremental: for path_glob targets, only files changed since " +
            "this git ref. Shape-validated against injection.",
        },
        folder_root: {
          type: "string",
          description: "Root for relative path_glob / git_diff_ref. Default cwd.",
        },
        output_dir: {
          type: "string",
          description:
            "Report/export dir; defaults to <main-root>/reports/security_scan/.",
        },
        workers: { type: "number", description: "Concurrent judge calls. Default 8." },
        max_retries: {
          type: "number",
          description: "Per-call validation retries. Default 1.",
        },
      },
      required: ["targets"],
    },
  },
  {
    name: "security_triage_benchmark",
    description:
      "Assess OpenRouter model(s) for the security_scan triage task against a " +
      "labeled GOLDEN DATASET, scored via the REAL judge pipeline (same " +
      "injection-hardened prompt + schema + clamp). Recommends the best " +
      "SAME-OR-CHEAPER model that PASSES the benchmark (zero under-flags on " +
      "critical judge-manipulation + visible-taint cases AND score >= 0.5); a " +
      "pricier model is NEVER auto-selected. With no `models`, auto-discovers " +
      "candidates that meet this tool's per-tool requirements and are not " +
      "pricier than the incumbent default. RETURNS: recommendation + JSON/" +
      "markdown report paths. Cached per-model-per-day. ENV: $OPENROUTER_API_KEY " +
      "(required — a benchmark you cannot run is useless).",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          description:
            "Explicit OpenRouter model id(s) to assess. When omitted, " +
            "auto-discover the same-or-cheaper candidate pool.",
          items: { type: "string" },
        },
        force: {
          type: "boolean",
          description: "Ignore the per-model-per-day cache and re-run.",
        },
        output_dir: {
          type: "string",
          description:
            "Report dir; defaults to <main-root>/reports/security-triage-benchmark/.",
        },
      },
      required: [],
    },
  },
  {
    name: "assess_model",
    description:
      "Assess ONE OpenRouter model against EVERY LLM tool's per-tool " +
      "REQUIREMENTS (TRDD-f45eeaa0) — FREE: makes NO LLM call (no token cost), " +
      "only a public model-catalog fetch (no API key). Reports, per tool, " +
      "whether the model " +
      "meets that tool's hard requirements (cost/context/output/params) and " +
      "whether the tool ALSO has a benchmark gate to run before assignment. Does " +
      "NOT run any benchmark. RETURNS: a per-tool OK/NO table + which qualifying " +
      "tools still need a benchmark pass.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "OpenRouter model id, e.g. 'google/gemini-2.5-flash'.",
        },
      },
      required: ["model"],
    },
  },
  {
    name: "check_model_health",
    description:
      "Self-check the CONFIGURED model(s) of the active profile (TRDD-828238b5) " +
      "— FREE: makes NO LLM call (no token cost), only a public model-catalog " +
      "fetch (no API key). For the main / second / third model and every " +
      "tool_models entry it reports: (1) PRESENCE — is the id still in the " +
      "OpenRouter catalog or deprecated/removed; (2) COST DRIFT — has the price " +
      "moved vs a seeded baseline; (3) REQUIREMENTS REGRESSION — does it still " +
      "meet the requirements of every tool it serves. ADVISORY only — writes a " +
      "report and returns its path; never changes settings (the server is " +
      "read-only). Takes no arguments.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

/** Set of MCP tool names provided by mass-scouting. Used by index.ts's dispatcher. */
export const MASS_SCOUT_TOOL_NAMES: ReadonlySet<string> = new Set(
  MASS_SCOUT_TOOLS.map((t) => t.name),
);

// ── Dispatch ───────────────────────────────────────────────────────────

/**
 * Convert an MCP tool call to a CLI argv and run it. Returns the standard
 * `{ content, isError }` envelope. Tests inject `opts` to mock the
 * fetcher / api key / main-root for the scout sub-command.
 */
export async function dispatchMassScoutTool(
  name: string,
  args: Record<string, unknown>,
  opts: CliRunOptions = {},
): Promise<McpResult> {
  switch (name) {
    case "mass_scout_register":
      return toMcp(
        await runMassScoutCli(
          buildArgv("register", {
            db: str(args.db_path),
            root: str(args.folder_path),
            files: arrJoin(args.file_paths),
            extensions: arrJoin(args.extensions),
            "exclude-dirs": arrJoin(args.exclude_dirs),
            model: str(args.model),
            "max-context-pct-register": num(args.max_context_pct_register),
            "git-diff": str(args.git_diff),
            "no-gitignore": bool(args.no_gitignore),
          }),
          opts,
        ),
      );
    case "mass_scout_preclassify":
      return toMcp(
        await runMassScoutCli(
          buildArgv("preclassify", {
            db: str(args.db_path),
            reclassify: bool(args.reclassify),
            limit: num(args.limit),
          }),
          opts,
        ),
      );
    case "mass_scout_estimate":
      return toMcp(
        await runMassScoutCli(
          buildArgv("estimate", {
            db: str(args.db_path),
            "fields-file": str(args.fields_file),
            model: str(args.model),
            bucket: str(args.bucket),
            workers: num(args.workers),
            "per-call-seconds": num(args.per_call_seconds),
            "budget-usd": num(args.budget_usd),
            "expected-output-bytes": num(args.expected_output_bytes),
            "max-context-pct-scout": num(args.max_context_pct_scout),
            "max-context-pct-register": num(args.max_context_pct_register),
            "input-price-per-m": num(args.input_price_per_m),
            "output-price-per-m": num(args.output_price_per_m),
            "context-window": num(args.context_window),
            "live-context": bool(args.live_context),
          }),
          opts,
        ),
      );
    case "mass_scout":
      return toMcp(
        await runMassScoutCli(
          buildArgv("scout", {
            db: str(args.db_path),
            "fields-file": str(args.fields_file),
            "job-id": str(args.job_id),
            "source-root": str(args.source_root),
            model: str(args.model),
            workers: num(args.workers),
            "max-retries": num(args.max_retries),
            bucket: str(args.bucket),
            "no-smoke-test": bool(args.no_smoke_test),
            "no-resume": bool(args.no_resume),
            "max-context-pct-scout": num(args.max_context_pct_scout),
            "output-dir": str(args.output_dir),
            "live-context": bool(args.live_context),
          }),
          opts,
        ),
      );
    case "mass_scout_search":
      return toMcp(
        await runMassScoutCli(
          buildArgv("search", {
            db: str(args.db_path),
            "job-id": str(args.job_id),
            query: str(args.query),
            regex: str(args.regex),
            "force-llm": bool(args.force_llm),
            "force-regex": bool(args.force_regex),
            filter: str(args.filter),
            limit: num(args.limit),
            offset: num(args.offset),
            json: bool(args.json),
          }),
          opts,
        ),
      );
    case "mass_scout_search_xjob":
      return toMcp(
        await runMassScoutCli(
          buildArgv("search-xjob", {
            db: str(args.db_path),
            "job-ids": arrJoin(args.job_ids),
            query: str(args.query),
            regex: str(args.regex),
            "force-llm": bool(args.force_llm),
            "force-regex": bool(args.force_regex),
            filter: str(args.filter),
            "limit-per-job": num(args.limit_per_job),
            "limit-merged": num(args.limit_merged),
            json: bool(args.json),
          }),
          opts,
        ),
      );
    case "mass_scout_get":
      return toMcp(
        await runMassScoutCli(
          buildArgv("get", {
            db: str(args.db_path),
            "short-id": num(args.short_id),
            "job-id": str(args.job_id),
          }),
          opts,
        ),
      );
    case "mass_scout_export":
      return toMcp(
        await runMassScoutCli(
          buildArgv("export", {
            db: str(args.db_path),
            "job-id": str(args.job_id),
            format: str(args.format),
            "output-dir": str(args.output_dir),
          }),
          opts,
        ),
      );
    case "mass_scout_jobs_list":
      return toMcp(
        await runMassScoutCli(
          buildArgv("jobs-list", {
            db: str(args.db_path),
            json: bool(args.json),
          }),
          opts,
        ),
      );
    case "mass_scout_audit_sample":
      return toMcp(
        await runMassScoutCli(
          buildArgv("audit-sample", {
            db: str(args.db_path),
            "job-id": str(args.job_id),
            sample: num(args.sample),
            "body-truncate": num(args.body_truncate),
            json: bool(args.json),
          }),
          opts,
        ),
      );
    case "mass_scout_body_get":
      return toMcp(
        await runMassScoutCli(
          buildArgv("body-get", {
            db: str(args.db_path),
            "short-id": num(args.short_id),
          }),
          opts,
        ),
      );
    case "mass_scout_build_fieldset": {
      // --field is repeatable; build the argv manually so we emit
      // one --field flag per token instead of joining with commas.
      const argv: string[] = ["build-fieldset"];
      const name = str(args.name);
      if (name) argv.push("--name", name);
      if (Array.isArray(args.field)) {
        for (const f of args.field) {
          if (typeof f === "string" && f.length > 0) {
            argv.push("--field", f);
          }
        }
      }
      const outPath = str(args.out);
      if (outPath) argv.push("--out", outPath);
      return toMcp(await runMassScoutCli(argv, opts));
    }
    case "mass_scout_propose_fieldset":
      return toMcp(
        await runMassScoutCli(
          buildArgv("propose-fieldset", {
            goal: str(args.goal),
            samples: arrJoin(args.samples),
            model: str(args.model),
            out: str(args.out),
          }),
          opts,
        ),
      );
    case "mass_scout_diff":
      return toMcp(
        await runMassScoutCli(
          buildArgv("diff", {
            db: str(args.db_path),
            from: str(args.from_job),
            to: str(args.to_job),
            json: bool(args.json),
          }),
          opts,
        ),
      );
    case "mass_scout_chain":
      return toMcp(
        await runMassScoutCli(
          buildArgv("chain", {
            db: str(args.db_path),
            "source-job": str(args.source_job),
            "new-job-id": str(args.new_job_id),
            "new-fields-file": str(args.new_fields_file),
            filter: str(args.filter),
            model: str(args.model),
            workers: num(args.workers),
            "max-retries": num(args.max_retries),
          }),
          opts,
        ),
      );
    case "mass_scout_list_bundled_fieldsets":
      return toMcp(
        await runMassScoutCli(
          buildArgv("list-bundled-fieldsets", {
            json: bool(args.json),
          }),
          opts,
        ),
      );
    case "security_scan": {
      // The rich input (nested targets[] + category_rubrics) can't ride flat
      // flags, so we JSON-encode the recognized fields into --input-json and
      // forward to the security-scan subcommand (whose body calls our
      // self-contained runSecurityScan, NOT the mass_scout pipeline — TRDD §2).
      // We re-build the object (rather than passing args verbatim) so unknown
      // keys are dropped and the downstream validator sees a clean shape.
      const inputObj: Record<string, unknown> = {};
      if (Array.isArray(args.targets)) inputObj.targets = args.targets;
      if (
        typeof args.category_rubrics === "object" &&
        args.category_rubrics !== null
      ) {
        inputObj.category_rubrics = args.category_rubrics;
      }
      const dv = str(args.default_verdict_on_error);
      if (dv) inputObj.default_verdict_on_error = dv;
      const budget = num(args.budget_usd);
      if (budget !== undefined) inputObj.budget_usd = budget;
      const model = str(args.model);
      if (model) inputObj.model = model;
      const gitRef = str(args.git_diff_ref);
      if (gitRef) inputObj.git_diff_ref = gitRef;
      const folderRoot = str(args.folder_root);
      if (folderRoot) inputObj.folder_root = folderRoot;
      const outputDir = str(args.output_dir);
      if (outputDir) inputObj.output_dir = outputDir;
      const workers = num(args.workers);
      if (workers !== undefined) inputObj.workers = workers;
      const maxRetries = num(args.max_retries);
      if (maxRetries !== undefined) inputObj.max_retries = maxRetries;
      return toMcp(
        await runMassScoutCli(
          ["security-scan", "--input-json", JSON.stringify(inputObj)],
          opts,
        ),
      );
    }
    case "security_triage_benchmark": {
      // In-process call to the triage orchestrator (NOT a CLI delegation — this
      // is a distinct subsystem, not a mass_scout sub-command). Honors test
      // injection (fetchImpl / apiKey / mainRoot) from CliRunOptions.
      const models = Array.isArray(args.models)
        ? (args.models.filter((m) => typeof m === "string" && m.length > 0) as string[])
        : undefined;
      const result = await runSecurityTriageBenchmark({
        models: models && models.length > 0 ? models : undefined,
        force: args.force === true,
        outputDir: str(args.output_dir),
        apiKey: opts.apiKey,
        mainRoot: opts.mainRoot,
        fetchImpl: opts.fetchImpl,
      });
      const text = [
        result.summaryLine,
        `recommended_model=${result.recommendedModelId}`,
        `changed=${result.changed}`,
        `spend=$${result.costUsd.toFixed(6)}`,
        `report=${result.mdReportPath}`,
        `json=${result.jsonReportPath}`,
      ].join("\n");
      return { content: [{ type: "text", text }], isError: false };
    }
    case "assess_model": {
      // Free cross-tool requirements assessment (TRDD-f45eeaa0): no LLM call /
      // no token cost — only a public OpenRouter catalog fetch (no API key).
      // Tests inject opts.modelCatalogFetch so the dispatch stays network-free.
      const modelId = str(args.model);
      if (!modelId) {
        return {
          content: [{ type: "text", text: "assess_model requires a 'model' id" }],
          isError: true,
        };
      }
      try {
        const assessment = await assessModelById(
          modelId,
          opts.modelCatalogFetch ? { fetchModels: opts.modelCatalogFetch } : {},
        );
        return {
          content: [{ type: "text", text: renderAssessmentText(assessment) }],
          isError: false,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: (e as Error).message }],
          isError: true,
        };
      }
    }
    case "check_model_health": {
      // Free configured-model self-check (TRDD-828238b5 A2): no LLM call / no
      // token cost — one public catalog fetch + a JSON diff vs the seeded
      // baseline. Resolves the active profile internally; writes a report and
      // returns its path. Tests inject opts.modelCatalogFetch (network-free).
      try {
        const { report, reportPath } = await runCheckModelHealth(
          opts.modelCatalogFetch ? { fetchModels: opts.modelCatalogFetch } : {},
        );
        const text = `${renderModelHealthText(report)}\n\nReport: ${reportPath}`;
        return {
          content: [{ type: "text", text }],
          isError: report.summary.critical > 0,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: (e as Error).message }],
          isError: true,
        };
      }
    }
    default:
      return {
        content: [
          { type: "text", text: `unknown mass_scout tool: ${name}` },
        ],
        isError: true,
      };
  }
}

// ── Coerce helpers ─────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return v === true ? true : undefined;
}
function arrJoin(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const items = v.filter((x) => typeof x === "string" && x.length > 0);
    return items.length > 0 ? items.join(",") : undefined;
  }
  return undefined;
}
