// ── MCP Tool definitions ─────────────────────────────────────────────
// Extracted from index.ts (B1 Phase 4, TRDD-63314265): a PURE MOVE of
// buildTools() plus its 5 exclusive helper definitions (BATCHING_NOTE,
// answerModeSchema, maxRetriesSchema, folderSchemaProps, redactRegexSchema).
// The only behavioral change is that buildTools() now takes the dynamic
// limits text as a parameter (limitsText) instead of calling limitsBlock()
// internally — limitsBlock() reads backend module state and STAYS in
// index.ts. limitsBlock() is deterministic within one buildTools() call,
// so passing its result once is behavior-preserving.
//
// The 5 helpers are used ONLY by buildTools and are kept module-internal
// (not exported). Only buildTools is exported.
import { MASS_SCOUT_TOOLS } from "../mass_scouting/mcp-tools.js";

// Shared batching-reality note. Spliced into every multi-file tool
// description because callers repeatedly assumed that avoiding answer_mode: 0
// would let the LLM see the whole codebase at once. It does not. The LLM
// only ever sees 1–5 files per request (the contents of a single FFD batch
// or a single group). If you need global cross-file analysis (like "find
// duplicated declarations across this codebase"), use
// search_existing_implementations instead — it is purpose-built for it.
const BATCHING_NOTE =
  "\n\nBATCHING (READ THIS): The LLM never sees your whole set of input " +
  "files at once. Files are packed into LLM requests of typically 1-5 " +
  "files each — by default via First-Fit Decreasing bin packing into " +
  "~400 KB batches (sized to fit the context window), or one group per " +
  "request when ---GROUP:id--- markers are used. In ensemble mode each " +
  "file is reviewed by 3 different LLMs in parallel so every file receives " +
  "3 distinct responses; in free mode and local mode each file receives " +
  "only 1 response. answer_mode controls ONLY how reports are written to " +
  "disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER " +
  "FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/" +
  "namespace/basename/imports if no ---GROUP:id--- markers are supplied, " +
  "max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you " +
  "need cross-file analysis across the whole codebase, use " +
  "search_existing_implementations — it is purpose-built for it.";

// Reusable schema for answer_mode field
const answerModeSchema = {
  type: "number" as const,
  enum: [0, 1, 2],
  description:
    "Output file organization. Does NOT change how many files the LLM sees per request — " +
    "that is governed by the batching algorithm, not by this field. The LLM never sees your " +
    "whole set of input files at once: files are packed into LLM requests of typically 1-5 " +
    "files each (First-Fit Decreasing bin packing into ~400 KB batches, or one group per " +
    "request when ---GROUP:id--- markers are supplied). In ENSEMBLE mode each file is reviewed " +
    "by 3 different LLMs in parallel so every file receives 3 distinct responses; in FREE mode " +
    "and LOCAL mode each file receives only 1 response.\n\n" +
    "answer_mode : 0\n" +
    "NAME: ONE REPORT PER FILE\n" +
    "DESCRIPTION: One .md report is saved for every input file. Files are still batched into " +
    "LLM requests of typically 1-5 files each (FFD bin packing); each LLM response contains " +
    "structured per-file sections that the MCP server splits apart and persists as individual " +
    "reports. Output is a list of (input_file_path -> report_path) pairs.\n" +
    "FORMAT: markdown (.md)\n" +
    "WHEN TO USE: Downstream consumers (agents, tools, CI) need to pick up one file's review " +
    "without scanning an aggregate. Typical for per-file lint/audit pipelines and for fan-out " +
    "workflows that route each file's findings to a different handler.\n" +
    "ADVANTAGES: Trivially routed — one file in, one report out. Supports parallel execution " +
    "with retry and circuit breaker via max_retries.\n" +
    "DISADVANTAGES: N files = N report files on disk. Slightly more overhead when you only " +
    "want the big picture.\n\n" +
    "answer_mode : 1\n" +
    "NAME: ONE REPORT PER GROUP\n" +
    "DESCRIPTION: One .md report is saved per GROUP of files. Groups are either explicit " +
    "(---GROUP:id--- / ---/GROUP:id--- markers inside input_files_paths) or auto-generated. " +
    "When the caller supplies markers, files inside each ---GROUP:id--- block share a report. " +
    "When no markers are supplied, the MCP server auto-groups files intelligently using these " +
    "priorities, in order: 1) parent subfolder, 2) language/format (file extension), 3) " +
    "namespace/package (inferred from directory hierarchy), 4) shared filename prefix " +
    "(e.g. user.ts + user.test.ts), 5) shared imports/libraries. Each auto-group contains at " +
    "most 1 MB of source; oversized buckets are split into sub-groups by bin packing. The " +
    "LLM still processes each group in isolation and cannot cross-reference files across " +
    "groups.\n" +
    "FORMAT: markdown (.md)\n" +
    "WHEN TO USE: You want one report per logical chunk of the codebase (e.g. one report per " +
    "feature folder, one per module). Keeps related-file context together while still " +
    "producing separate files for independent groups.\n" +
    "ADVANTAGES: Balanced output — fewer files than mode 0, more granular than mode 2. Group " +
    "boundaries match natural project structure so reports are easy to route and review.\n" +
    "DISADVANTAGES: Group composition is a heuristic when markers are not supplied; callers " +
    "who need exact control must pass explicit ---GROUP:id--- markers.\n\n" +
    "answer_mode : 2\n" +
    "NAME: SINGLE REPORT\n" +
    "DESCRIPTION: Exactly one .md report is saved, merging the responses from every LLM batch " +
    "into a single document with per-batch and per-file sections.\n" +
    "FORMAT: markdown (.md)\n" +
    "WHEN TO USE: You want one top-level summary across all scanned files — e.g. a single " +
    "audit report to share with a reviewer or attach to a PR.\n" +
    "ADVANTAGES: Simplest output. One file path returned. Easy to email, attach, or hand off.\n" +
    "DISADVANTAGES: For very large scans the merged file can be long. Downstream per-file " +
    "routing requires re-parsing sections out of the single report.\n\n" +
    "Defaults per tool: scan_folder=0, chat/code_task/check_*=2, " +
    "search_existing_implementations=2.",
};

const maxRetriesSchema = {
  type: "number" as const,
  description:
    "Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). " +
    "Set to 3 for robust batch processing with exponential backoff and circuit breaker. " +
    "When > 1, enables parallel execution and automatic abort after 3 consecutive failures.",
};

// Reusable schema properties for folder-based file discovery
const folderSchemaProps = {
  folder_path: {
    type: "string" as const,
    description:
      "Absolute path to a folder to scan. " +
      "All matching files are processed. Can be combined with input_files_paths.",
  },
  extensions: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      'File extensions to include when using folder_path. E.g., [".ts", ".py"]. ' +
      "If not set, all non-binary files are included.",
  },
  exclude_dirs: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      "Additional directory names to skip when scanning folder_path. " +
      "Hidden dirs, node_modules, .git, dist, build are always skipped.",
  },
  use_gitignore: {
    type: "boolean" as const,
    description:
      "Use .gitignore rules to filter files (via git ls-files). Default: true. " +
      "Set false to include gitignored files.",
  },
  recursive: {
    type: "boolean" as const,
    description:
      "Recurse into subdirectories when scanning folder_path. Default: true.",
  },
  follow_symlinks: {
    type: "boolean" as const,
    description:
      "Follow symbolic links to files and directories. Default: true. " +
      "Circular symlinks are detected and skipped automatically.",
  },
  max_files: {
    type: "number" as const,
    description:
      "Maximum number of files to discover from folder_path. Default: 2500.",
  },
  output_dir: {
    type: "string" as const,
    description:
      "Absolute path to a custom output directory for reports. " +
      "Default: <main-project-dir>/reports/llm-externalizer/, anchored on " +
      "$CLAUDE_PROJECT_DIR VERBATIM (the dir Claude Code operates in), then " +
      "falling back to $PWD/reports/llm-externalizer/. NEVER derived from git " +
      "(no `git worktree list`, no git-root climb) — that picks the wrong dir " +
      "in worktrees, per-subfolder-git monorepos, and git-less roots. " +
      "Per-call override wins unconditionally; $LLM_OUTPUT_DIR also overrides " +
      "the default.",
  },
  free: {
    type: "boolean" as const,
    description:
      "Use the free Nemotron 3 Super model (nvidia/nemotron-3-super-120b-a12b:free) " +
      "instead of the ensemble. No cost, single model, 262K context. " +
      "LOW QUALITY: significantly lower intelligence than ensemble — more false positives, missed bugs, shallow analysis. " +
      "WARNING: prompts are logged by the provider — do not use with sensitive/proprietary code.",
  },
};

const redactRegexSchema = {
  type: "string" as const,
  description:
    "JavaScript regex pattern to redact matching strings from file content before sending to LLM. " +
    "Applied after secret redaction. Alphanumeric matches → [REDACTED:USER_PATTERN], " +
    "numeric-only matches → zero-padded placeholder. Invalid regex returns an error with details.",
};

// Shared input properties for the folder-scanning tools — scan_folder and
// high_quality_scan (TRDD-DBUSM55E) take the IDENTICAL inputs, so the schema
// lives in one const and the two can never drift. `as const` on each type
// literal keeps the JSON-schema field types narrow (matching folderSchemaProps).
const scanFolderSchemaProps = {
  folder_path: {
    type: "string" as const,
    description: "Absolute path to the folder to scan recursively.",
  },
  rules: {
    type: "string" as const,
    description:
      "Explicit per-path rules-file path (highest layer; see rules_check). Omitted: " +
      "<repo>/.llm-ext/rules.yaml, then ~/.llm-externalizer/rules.yaml, then none.",
  },
  diff_workspace: {
    type: "boolean" as const,
    description:
      "Diff mode: review only files changed in the workspace (staged + unstaged + " +
      "untracked vs HEAD). Overrides folder_path. Mutually exclusive with the other diff args.",
  },
  diff_from: {
    type: "string" as const,
    description:
      "Diff mode: base ref of a range (merge-base '...' semantics with diff_to). " +
      "Requires diff_to.",
  },
  diff_to: {
    type: "string" as const,
    description: "Diff mode: head ref of the range. Requires diff_from.",
  },
  diff_commit: {
    type: "string" as const,
    description: "Diff mode: review one commit's changes (vs its parent).",
  },
  extensions: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      'File extensions to include (e.g. [".ts", ".py"]). If omitted, includes all files.',
  },
  exclude_dirs: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      "Additional directory names to skip (hidden dirs, node_modules, .git are always skipped).",
  },
  max_files: {
    type: "number" as const,
    description:
      "Maximum number of files to process (default: 2500). Safety limit to prevent runaway scans.",
  },
  instructions: {
    type: "string" as const,
    description: "What to look for or do with each file.",
  },
  instructions_files_paths: {
    oneOf: [
      { type: "string" as const },
      { type: "array" as const, items: { type: "string" as const } },
    ],
    description: "File(s) containing instructions.",
  },
  scan_secrets: {
    type: "boolean" as const,
    description:
      "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
  },
  redact_secrets: {
    type: "boolean" as const,
    description:
      "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
  },
  use_gitignore: {
    type: "boolean" as const,
    description:
      "Use .gitignore rules to filter files (via git ls-files). When true, only files not ignored by git are included. Falls back to manual walk if not in a git repo. Default: true.",
  },
  answer_mode: answerModeSchema,
  redact_regex: redactRegexSchema,
  max_payload_kb: {
    type: "number" as const,
    description:
      "Max file size in KB per file. Default: 400. Files exceeding this are skipped and reported.",
  },
};

export function buildTools(limitsText: string) {
  const allTools = [
    {
      name: "chat",
      description:
        "General-purpose LLM call. More capable than Haiku, costs less. " +
        "Offloads bounded work (summarise, generate, translate, compare) to a separate LLM.\n\n" +
        "Files via input_files_paths are read from disk (saves your context).\n\n" +
        "FILE GROUPING: Organize files into named groups using ---GROUP:id--- / ---/GROUP:id--- " +
        "markers in input_files_paths. Each group is processed in COMPLETE ISOLATION (no cross-group " +
        "LLM calls) and produces its own SEPARATE report file with the group ID in the filename. " +
        "Output: one line per group: [group:id] /path/to/report_group-id_....md. " +
        "WHY: Each downstream agent only reads the report for its own group, " +
        "saving context tokens by not loading findings about files it is not responsible for. " +
        "Without markers, all files are processed together (backward compatible).\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context in instructions.\n\n" +
        "OUTPUT: Saved to .md file, returns only the file path." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Task instructions for the LLM. Placed BEFORE input-files content in the prompt. " +
              "Be specific about expected output format.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing instructions (appended to instructions).",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "One or more absolute file paths. Accepts a single string OR an array. " +
              "Files are read from disk, code-fenced, and included in the prompt after the instructions. " +
              "Auto-batched if they exceed context window. " +
              "ALWAYS prefer this over input_files_content — saves your context tokens. " +
              "GROUPING: Insert ---GROUP:id--- before a group of files and ---/GROUP:id--- after " +
              "to process groups in isolation. Each group produces its own report. " +
              'Example: ["---GROUP:auth---", "/path/auth.ts", "---/GROUP:auth---", "---GROUP:api---", "/path/api.ts", "---/GROUP:api---"]',
          },
          input_files_content: {
            type: "string",
            description:
              "Inline content, code-fenced in the prompt. " +
              "DISCOURAGED — wastes your context tokens. Use input_files_paths instead. " +
              "Only for short snippets that are not on disk.",
          },
          ...folderSchemaProps,
          system: {
            type: "string",
            description:
              'Persona. Be specific: "Senior TypeScript dev" not "helpful assistant".',
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. Prevents leaking sensitive data to the remote service.",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max total payload per batch in KB (prompt + instructions + files). " +
              "Default: 400. Must fit within the weakest ensemble model's context. " +
              "Lower if you see hallucinations or truncations on large batches.",
          },
        },
        required: [],
      },
    },
    // custom_prompt was merged into chat — both have identical schemas/behavior.
    // The 'custom_prompt' case in the switch handler still works for backward compatibility.
    {
      name: "code_task",
      description:
        "Code analysis with optimised code-review system prompt. " +
        "More capable than Haiku, costs less. Less capable than Sonnet/Opus.\n\n" +
        "Pass input_files_paths (read from disk, language auto-detected). " +
        "Be specific in instructions.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context.\n\n" +
        "OUTPUT: Saved to .md file, returns only the file path." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Your instructions/notes for the LLM — placed BEFORE input-files content so the LLM reads them first. " +
              'Be specific: "Find bugs", "Explain this", "Add error handling to fetchData", "Write tests".',
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing instructions (appended to instructions).",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "One or more absolute paths to source files. Read from disk, code-fenced, " +
              "language auto-detected. ALWAYS prefer this over input_files_content — saves your context tokens.",
          },
          input_files_content: {
            type: "string",
            description:
              "Inline source code, code-fenced. DISCOURAGED — wastes your context tokens. " +
              "Use input_files_paths instead. Only for short snippets not on disk.",
          },
          ...folderSchemaProps,
          language: {
            type: "string",
            description:
              "Programming language (auto-detected from input_files_paths extension if not set).",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. Prevents leaking sensitive data to the remote service.",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max total payload per batch in KB (prompt + instructions + files). " +
              "Default: 400. Must fit within the weakest ensemble model's context. " +
              "Lower if you see hallucinations or truncations on large batches.",
          },
          rules: {
            type: "string",
            description:
              "Explicit per-path rules-file path (highest layer; see rules_check). Omitted: " +
              "<repo>/.llm-ext/rules.yaml, then ~/.llm-externalizer/rules.yaml, then none.",
          },
          diff_workspace: {
            type: "boolean",
            description:
              "Diff mode: review only workspace-changed files (staged+unstaged+untracked vs HEAD).",
          },
          diff_from: {
            type: "string",
            description: "Diff mode: base ref (merge-base '...' semantics; requires diff_to).",
          },
          diff_to: {
            type: "string",
            description: "Diff mode: head ref (requires diff_from).",
          },
          diff_commit: {
            type: "string",
            description: "Diff mode: one commit's changes (vs its parent).",
          },
        },
        required: ["instructions"],
      },
    },
    {
      name: "review_plan",
      description:
        "Delegate-mode code review: emit the deterministic review scaffolding — resolved file " +
        "set (same walker as scan_folder), the review rubric, and a per-file protocol — WITHOUT " +
        "calling any LLM ($0, no API key, ~1s). The HOST agent then performs the actual review " +
        "with its own model. Use when the caller (e.g. Claude Code on a subscription) should do " +
        "the reviewing itself instead of spending external tokens. Accepts the same file inputs " +
        "as scan_folder: input_files_paths OR folder_path (+ extensions, exclude_dirs, " +
        "use_gitignore).",
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description: "Explicit absolute file paths to review (wins over folder_path).",
          },
          folder_path: {
            type: "string",
            description: "Folder to expand via the standard walker (gitignore-aware).",
          },
          extensions: {
            type: "array",
            items: { type: "string" },
            description: "Optional extension filter for folder_path expansion.",
          },
          exclude_dirs: {
            type: "array",
            items: { type: "string" },
            description: "Directory names to exclude from folder_path expansion.",
          },
          use_gitignore: {
            type: "boolean",
            description: "Respect .gitignore during folder expansion (default true).",
          },
          instructions: {
            type: "string",
            description:
              "Extra review instructions APPENDED to the built-in real-defects-only rubric.",
          },
          rules: {
            type: "string",
            description:
              "Explicit rules-file path (highest layer). Omitted: <repo>/.llm-ext/rules.yaml, " +
              "then ~/.llm-externalizer/rules.yaml, then none. See rules_check.",
          },
          diff_workspace: {
            type: "boolean",
            description:
              "Diff mode: plan covers workspace-changed files and EMBEDS their hunks.",
          },
          diff_from: {
            type: "string",
            description: "Diff mode: base ref (merge-base '...' semantics; requires diff_to).",
          },
          diff_to: {
            type: "string",
            description: "Diff mode: head ref (requires diff_from).",
          },
          diff_commit: {
            type: "string",
            description: "Diff mode: one commit's changes (vs its parent).",
          },
        },
      },
    },
    {
      name: "rules_check",
      description:
        "Show which per-path review rule applies to a file, and from which layer " +
        "(--rules explicit > <repo>/.llm-ext/rules.yaml > ~/.llm-externalizer/rules.yaml > none). " +
        "Pure lookup, no LLM call — the debug surface of the layered rules engine that " +
        "augments scan_folder / code_task / review_plan instructions per matching path glob " +
        "(first entry wins, declaration order, case-insensitive globs with **, *, ?, {a,b}, [abc]).",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description: "The file path to look up (absolute or repo-relative).",
          },
          rules: {
            type: "string",
            description: "Explicit rules-file path overriding the layered lookup.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "discover",
      description:
        "Check service availability, active profile, auth status, available profiles and API presets. " +
        "Returns: status (online/offline), active profile name/mode/model, auth token status " +
        "(shows whether env vars like $LM_API_TOKEN or $OPENROUTER_API_KEY are resolved), " +
        "context window, concurrency mode, response latency, session usage, and lists of " +
        "available profiles/presets for editing guidance. Call this before delegating work.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "or_model_info",
      description:
        "Query OpenRouter for detailed information about a specific model by its EXACT id " +
        "(e.g. 'nvidia/nemotron-3-super-120b-a12b:free' or 'anthropic/claude-sonnet-4'). " +
        "Returns model metadata, per-endpoint provider info, context length, pricing, " +
        "supported request-body parameters (reasoning, temperature, top_p, etc.), " +
        "quantization, uptime, latency percentiles, and throughput. Uses the " +
        "/v1/models/{id}/endpoints OpenRouter endpoint. Only works when the active " +
        "profile is configured for OpenRouter. Use this before calling a new model " +
        "to verify which parameters it accepts and what pricing applies.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description:
              "Exact OpenRouter model id (e.g. 'nvidia/nemotron-3-super-120b-a12b:free'). " +
              "Must match the id as listed in OpenRouter — case sensitive, includes the " +
              "vendor prefix and any ':free' / ':thinking' suffix.",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "or_model_info_table",
      description:
        "Same as or_model_info but returns the data formatted as a human-readable " +
        "Unicode-bordered table with ANSI colors. Use this for terminal display; use " +
        "or_model_info for programmatic consumption or contexts where ANSI escape codes " +
        "are not rendered. Takes the same `model` input (exact OpenRouter id). Colors: " +
        "green = good (high uptime, low latency, free pricing), yellow = borderline, " +
        "red = poor. Headers bold cyan. Compares multiple endpoints side-by-side in a " +
        "single table if the model has multiple hosting providers.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description:
              "Exact OpenRouter model id (case-sensitive, vendor-prefixed, with any " +
              "':free' / ':thinking' suffix).",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "or_model_info_json",
      description:
        "Same as or_model_info but returns the raw OpenRouter response data as pretty " +
        "JSON. Use this when you need the unprocessed fields (every numeric value, " +
        "every field OpenRouter exposes) to pipe into another tool or parse in code. " +
        "Takes the same `model` input plus an optional `file_path` — when set, the " +
        "JSON is written to that file (absolute path recommended) instead of being " +
        "returned inline, and the tool result contains only the absolute path. This " +
        "mirrors the CLI `llm-externalizer model-info <id> --json [file]`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description:
              "Exact OpenRouter model id (case-sensitive, vendor-prefixed, with any " +
              "':free' / ':thinking' suffix).",
          },
          file_path: {
            type: "string",
            description:
              "Optional absolute path to write the JSON to. When set, the tool result " +
              "contains only the resolved file path, not the JSON itself — saves " +
              "caller context tokens. When omitted, the JSON is returned inline.",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "reset",
      description:
        "Full soft-restart. NOT IMMEDIATE — waits for all currently running LLM requests to finish " +
        "before resetting. Then: reloads settings.yaml from disk, clears all caches " +
        "(model list, concurrency, LM Studio detection), resets session counters (tokens/cost/calls), " +
        "re-resolves the active profile, and notifies the client to refresh the tool list. " +
        "Use when settings were changed externally, the backend is misbehaving, or you need a clean slate.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_settings",
      description:
        "Read-only view of settings.yaml. Copies the current settings file to the output " +
        "directory and returns the copy's path. The MCP cannot write settings — model & " +
        "profile changes are user-only. Edit ~/.llm-externalizer/settings.yaml manually in " +
        "your editor, then call the 'reset' tool (or restart Claude Code) to reload.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "profile",
      description:
        "Read-only view of the profiles defined in settings.yaml. With no arguments, lists " +
        "every profile (name, whether it is active, mode, backend, model(s), and whether " +
        "free_only is set). With `show`, prints the full resolved detail for that one " +
        "profile (concrete model, protocol, timeout, context window, free pool, per-tool " +
        "overrides). This tool cannot add, switch, edit, or remove a profile — profile " +
        "configuration is user-only. Edit ~/.llm-externalizer/settings.yaml manually to " +
        "change the active profile or a profile's fields, then call 'reset' to reload.",
      inputSchema: {
        type: "object" as const,
        properties: {
          show: {
            type: "string",
            description:
              "Name of one profile to show full resolved detail for. Omit to list every " +
              "profile instead.",
          },
        },
      },
    },
    {
      name: "session_summary",
      description:
        "Compaction-style summary of a whole Claude Code session, streamed from its JSONL " +
        "transcript via map-reduce (never loads the file into memory). $0 by construction: " +
        "always uses the biggest free, text-emitting OpenRouter model available today (no " +
        "hard context floor unless min_context is given). Falls back down the ranked model " +
        "list automatically if the active model is delisted, stops being free, or exhausts " +
        "its daily cap mid-run, re-chunking the remaining work to the new model's context. " +
        "Checkpoints after every chunk/fold, so an interrupted run resumes instead of " +
        "restarting: re-run the same command and it picks up where it left off automatically. " +
        "With neither transcript nor session_id, summarizes the most recently modified " +
        "transcript for the current project.",
      inputSchema: {
        type: "object" as const,
        properties: {
          transcript: {
            type: "string",
            description:
              "Absolute path to a session's .jsonl transcript. Wins over session_id and the default.",
          },
          session_id: {
            type: "string",
            description:
              "A session UUID; resolved to ~/.claude/projects/<project-slug>/<session_id>.jsonl " +
              "for the current project.",
          },
          prune: {
            type: "string",
            description:
              "One of 'aggressive' (default — drops tool-result payloads, pasted file " +
              "contents, thinking blocks; keeps user/assistant prose, tool names + arg " +
              "summaries, errors), 'moderate' (head/tail-truncates each tool result), or " +
              "'none' (no pruning).",
          },
          min_context: {
            type: "number",
            description:
              "Optional hard floor on context_length. Default: none — the biggest free, " +
              "text-emitting model available today is used, whatever its context is. Set " +
              "this only to require a guarantee and fail instead of accepting a smaller model.",
          },
          resume: {
            type: "boolean",
            description:
              "Require an existing, matching checkpoint at the checkpoint path — fails fast " +
              "if none is found, instead of silently starting a fresh run. Omit (or false) to " +
              "start fresh when no checkpoint exists and resume automatically when one does.",
          },
          checkpoint: {
            type: "string",
            description:
              "Absolute path to the checkpoint file. Default: a path derived deterministically " +
              "from the resolved transcript path under ~/.llm-externalizer/session-summary-checkpoints/.",
          },
          output: {
            type: "string",
            description:
              "Absolute path to a custom output directory for the summary report. Default: " +
              "<main-project-dir>/reports/llm-externalizer/, same resolution as every other tool.",
          },
          stdout: {
            type: "boolean",
            description:
              "Print the summary TEXT directly to stdout instead of writing a report file and " +
              "returning its path (the default). Opt-in — NOT the same as `output`, which sets " +
              "the report DIRECTORY. In this mode stdout carries ONLY the summary text (no " +
              "header, no file is written); banner/progress still go to stderr.",
          },
          max_chunk_tokens: {
            type: "number",
            description:
              "Override the per-chunk token budget. Default: the smaller of 25,000 and the " +
              "selected model's own context window (minus completion + prompt overhead) — " +
              "summarization quality collapses long before a model's context LIMIT is " +
              "reached, so the window alone is not used as the chunk size. Smaller chunks " +
              "also parallelize better under concurrency (see concurrency). Raise this only " +
              "if you have measured that a bigger chunk still summarizes well on your " +
              "selected model.",
          },
          concurrency: {
            type: "number",
            description:
              "How many chunk requests run in flight at once. Default: AUTO — sized to the " +
              "chunk count (capped at 28) so every chunk runs in ONE wave, which is what makes " +
              "wall-clock the slowest single chunk rather than waves x slowest. The cap is " +
              "measured live against the free tier's burst behavior (a 32-concurrent burst was " +
              "clean; 64 started tripping its ~20-requests/minute sub-minute limit), and sits " +
              "below that edge to leave headroom for the rest of the ensemble's traffic. " +
              "Requests are staggered on launch so a burst never lands in a single instant. " +
              "Set to 1 to force the original sequential behavior.",
          },
          chunk_timeout_s: {
            type: "number",
            description:
              "Per-chunk deadline in seconds. Default: 120 — deliberately far tighter than the " +
              "global 300s request timeout, because under concurrency the wall-clock is the " +
              "SLOWEST chunk, not the average one (measured spread on same-sized chunks was " +
              "4.4x: 90s to 400s). A chunk exceeding this aborts and is retried or rotated to " +
              "another free model like any other transient, instead of dragging the whole run. " +
              "Raise it for a slow model or a huge chunk; an explicit value is honored verbatim.",
          },
        },
      },
    },
    // ── Batch Operations ────────────────────────────────────────────────
    {
      name: "batch_check",
      description:
        "DEPRECATED: Use chat or code_task with answer_mode=0 and max_retries=3 instead.\n\n" +
        "Same prompt applied to EACH file separately — one report per file.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE merged report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.\n\n" +
        "Retry: 3 attempts for recoverable errors. Aborts on auth/payment errors or 3+ consecutive failures.",
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Prompt applied to every input-file. Default: comprehensive bug-finding. " +
              'Can be ANY instruction: "Summarise in 3 bullets", "Extract function signatures", etc.',
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing instructions (appended to instructions).",
          },
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute paths to the files to process (one report per input-file).",
          },
          input_files_content: {
            type: "string",
            description:
              "NOT SUPPORTED for batch_check — files must be on disk via input_files_paths.",
          },
          ...folderSchemaProps,
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          answer_mode: answerModeSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max file size in KB per file. Default: 400. Files exceeding this are skipped and reported.",
          },
        },
        required: [],
      },
    },
    // ── Specialized Operations ─────────────────────────────────────────
    {
      name: "scan_folder",
      description:
        "Auto-discover files from a directory tree and run the given instructions " +
        "against each. Filters by extension, skips hidden dirs/node_modules/.git/" +
        "dist/build.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: scanFolderSchemaProps,
        required: ["folder_path"],
      },
    },
    {
      name: "high_quality_scan",
      description:
        "HIGH-QUALITY single-model variant of scan_folder. Runs the given " +
        "instructions against each discovered file using ONE strong remote model " +
        "(default z-ai/glm-5.2) at maximum reasoning effort with prompt caching — " +
        "NOT the 3-model cheap ensemble. Use when review QUALITY matters more than " +
        "cost: deep audits, security review, subtle-bug hunts.\n\n" +
        "Requires the OpenRouter backend with available credit: the high-quality " +
        "model is PAID by design, so this tool FAIL-FASTS (it does NOT silently " +
        "downgrade) under a local backend, free_only mode, or exhausted credit — " +
        "use scan_folder for those. Configure the model via `high_quality_model` " +
        "in settings.yaml (id, reasoning_effort, cache, min_quantization, provider).\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: scanFolderSchemaProps,
        required: ["folder_path"],
      },
    },
    {
      name: "search_existing_implementations",
      description:
        "Search a codebase for an existing implementation of a specified feature. " +
        "THE CANONICAL WAY to answer 'does this already exist in the codebase?' or " +
        "'does this PR duplicate existing code?'. Works even though the LLM never " +
        "sees the whole codebase at once — see the batching note below.\n\n" +
        "The server walks the target folder(s), filters by language extension, " +
        "FFD-packs all matching files into batches up to max_payload_kb per LLM " +
        "request (typically 1–5 files per batch, depending on file sizes), and asks " +
        "the LLM (ensemble by default) to emit per-file YES/NO answers for every " +
        "file in the batch. Each batch is ONE LLM call — for a 10k-file codebase " +
        "this is typically ~500 calls instead of 10k. The LLM never needs global " +
        "codebase visibility because every file is checked against a REFERENCE " +
        "(feature_description + optional source_files + optional diff_path), not " +
        "against other files in the codebase.\n\n" +
        "BATCHING vs ANSWER_MODE (important): batching behavior is the same in all " +
        "modes. The LLM always sees 1–5 files per request. answer_mode only " +
        "controls how the per-file output is persisted to disk:\n" +
        "  - answer_mode 0: one .md per input file (MCP splits each batch response " +
        "by per-file section markers and saves one report per original file; " +
        "returns a list of (input_file -> report_file) pairs).\n" +
        "  - answer_mode 1: one .md per batch (per LLM request).\n" +
        "  - answer_mode 2 (default): one .md for the whole operation, merged.\n\n" +
        "The feature_description is the primary signal. Optionally pass PR source " +
        "files (shipped as reference context and automatically excluded from the " +
        "scan to avoid self-match) and/or a unified diff (to focus the LLM on the " +
        "new lines). Both are optional — the tool also works as a pure description-" +
        "based scan.\n\n" +
        "Per-file answer is terse — either 'NO' or one-or-more 'YES symbol=<name> " +
        "lines=<a-b>' lines. EXHAUSTIVE: the LLM reports every occurrence in every " +
        "file, no cap — so a reviewer can delete every duplicate and keep only the " +
        "PR's new one. Ensemble mode runs all configured models in parallel so " +
        "reviewers can spot false positives from model disagreement.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include the brief " +
        "context in feature_description." + limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          // Inherit the shared folder-scan props — exposes extensions,
          // exclude_dirs, use_gitignore, recursive, follow_symlinks, max_files,
          // output_dir, free. Overridden below where SEI needs different semantics.
          ...folderSchemaProps,
          feature_description: {
            type: "string" as const,
            description:
              "Concise one-sentence description of the feature to look for. " +
              "The source files (if any) may contain many unrelated functions — " +
              "this string is what tells the LLM which one matters. Required.",
          },
          // Override folder_path: SEI accepts a single path OR an array of paths.
          folder_path: {
            oneOf: [
              { type: "string" as const },
              { type: "array" as const, items: { type: "string" as const } },
            ],
            description:
              "Absolute path(s) to the codebase folder(s) to scan. Single folder " +
              "or list of folders; each entry is walked recursively. Required.",
          },
          // Override max_files: SEI defaults to 10000 (vs scan_folder's 2500)
          // because this tool is designed for massive-codebase PR-review scans.
          max_files: {
            type: "number" as const,
            description:
              "Maximum number of files to walk (default: 10000 for this tool, " +
              "higher than scan_folder's 2500). The FFD batcher packs files up " +
              "to max_payload_kb per batch, so a 10k-file codebase typically " +
              "fits in ~500 LLM calls.",
          },
          source_files: {
            oneOf: [
              { type: "string" as const },
              { type: "array" as const, items: { type: "string" as const } },
            ],
            description:
              "Optional absolute path(s) to the PR's new/modified files. Their " +
              "contents are shipped to the LLM as reference context, and the paths " +
              "are automatically excluded from the scan target list so they don't " +
              "self-match (symlinks are canonicalized via realpathSync). Omit for " +
              "pure description-based scans.",
          },
          diff_path: {
            type: "string" as const,
            description:
              "Optional absolute path to a unified-diff file showing the exact PR " +
              "changes. The server ships it alongside source_files as reference " +
              "context so the LLM focuses on the NEW lines (prefixed with '+').",
          },
          scan_secrets: {
            type: "boolean" as const,
            description:
              "Scan input files for secrets and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean" as const,
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer .env.",
          },
          answer_mode: answerModeSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number" as const,
            description:
              "Max batch payload size in KB (default: 400). Controls FFD bin " +
              "packing: larger values pack more files per LLM call. " +
              "search_existing_implementations default answer_mode is 2 " +
              "(SINGLE REPORT). Mode 1 (ONE REPORT PER GROUP) auto-clusters " +
              "files by subfolder/extension heuristic and emits one merged " +
              "report per group. Mode 0 (ONE REPORT PER FILE) splits each " +
              "batch response by per-file section so every scanned file gets " +
              "its own report. Batching (1-5 files per LLM call) is always " +
              "active — this tool is designed to scale to 10k-file codebases.",
          },
        },
        required: ["feature_description", "folder_path"],
      },
    },
    {
      name: "compare_files",
      description:
        "Compare files — auto-computes unified diff, LLM summarises differences. " +
        "Three modes:\n\n" +
        "1. PAIR MODE: input_files_paths with exactly 2 paths (before, after).\n" +
        "2. BATCH MODE: file_pairs array of [fileA, fileB] pairs for batch comparison.\n" +
        "3. GIT DIFF MODE: git_repo + from_ref + to_ref to compare files between " +
        "two commits/tags. Diffs computed via git, LLM summarises each.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in file_pairs " +
        "to produce separate reports per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description:
              'Two absolute file paths: [before, after]. For batch comparisons, use file_pairs instead.',
          },
          file_pairs: {
            type: "array",
            items: {
              type: "array" as const,
              items: { type: "string" as const },
              minItems: 2,
              maxItems: 2,
            },
            description:
              'Array of [fileA, fileB] pairs for batch comparison. ' +
              'Supports ---GROUP:id--- markers: use ["---GROUP:id---"] as a single-element entry ' +
              'between pairs to group them. Each group produces its own report.',
          },
          git_repo: {
            type: "string",
            description:
              "Absolute path to a git repository. Used with from_ref and to_ref for git diff mode.",
          },
          from_ref: {
            type: "string",
            description:
              "Git ref (commit hash, tag, branch) for the 'before' version. Used with git_repo.",
          },
          to_ref: {
            type: "string",
            description:
              "Git ref (commit hash, tag, branch) for the 'after' version. Used with git_repo. Defaults to HEAD.",
          },
          instructions: {
            type: "string",
            description:
              'Optional focus area (e.g. "focus on API changes", "check for regressions").',
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing comparison instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          max_payload_kb: {
            type: "number",
            description:
              "Max file size in KB per file. Default: 400. Files exceeding this are skipped.",
          },
        },
        required: [],
      },
    },
    {
      name: "check_references",
      description:
        "Check source file for broken symbol references. Auto-resolves local imports, reads dependencies, " +
        "LLM validates all symbols exist.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Source file(s) to check for broken references.",
          },
          ...folderSchemaProps,
          instructions: {
            type: "string",
            description: "Optional additional context or focus areas.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing additional instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max payload in KB (prompt + files). Default: 400. Lower if you see hallucinations.",
          },
        },
        required: [],
      },
    },
    {
      name: "check_imports",
      description:
        "Two-phase import checker: (1) LLM extracts import paths, (2) server validates each exists on disk. " +
        "Detects broken imports after file moves/renames.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Source file(s) to check for broken imports.",
          },
          ...folderSchemaProps,
          project_root: {
            type: "string",
            description:
              "Project root for resolving relative imports. Defaults to the source file's directory.",
          },
          instructions: {
            type: "string",
            description: "Optional additional context.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing additional instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max payload in KB (prompt + files). Default: 400. Lower if you see hallucinations.",
          },
        },
        required: [],
      },
    },
    {
      name: "check_against_specs",
      description:
        "Compare source files against a specification file. The spec file defines requirements, rules, " +
        "API parameters, output formats, restrictions, forbidden patterns, forbidden endpoints/services/tools, etc. " +
        "Each source file is strictly examined for spec violations: wrong implementations, missed rules, " +
        "forbidden patterns used, incorrect API contracts, wrong output formats, etc.\n\n" +
        "Accepts individual files via input_files_paths OR an entire folder via folder_path (recursive). " +
        "Files are auto-batched using FFD bin packing — the spec file is included in EVERY batch.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "NOTE: The LLM does NOT have the full project — some requirements may be implemented elsewhere. " +
        "Therefore only VIOLATIONS of the spec are reported (things done wrong), not MISSING features " +
        "(things not yet implemented). Everything that IS implemented must follow the spec exactly.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context in instructions.\n\n" +
        "OUTPUT: Violation report saved to .md file, returns only the file path." +
        BATCHING_NOTE +
        limitsText,
      inputSchema: {
        type: "object" as const,
        properties: {
          spec_file_path: {
            type: "string",
            description:
              "Absolute path to the specification file (requirements, rules, API contracts, restrictions). " +
              "This is the source of truth — all source files are checked against it. " +
              "Included in EVERY batch when files are split across multiple requests.",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Source file(s) to check against the spec. Use this OR folder_path (not both).",
          },
          folder_path: {
            type: "string",
            description:
              "Absolute path to a folder to scan recursively. All matching files are checked against the spec. " +
              "Use this OR input_files_paths (not both).",
          },
          extensions: {
            type: "array",
            items: { type: "string" },
            description:
              'File extensions to include when using folder_path. E.g., [".ts", ".py"]. ' +
              "If not set, all non-binary files are included.",
          },
          exclude_dirs: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional directory names to skip when scanning folder_path. " +
              "Hidden dirs, node_modules, .git, dist, build are always skipped.",
          },
          use_gitignore: {
            type: "boolean",
            description:
              "Use git ls-files to respect .gitignore rules when scanning folders. Default: true. Set false to include gitignored files.",
          },
          max_files: {
            type: "number",
            description:
              "Maximum number of files to process when using folder_path. Default: 2500. " +
              "Safety limit to prevent runaway scans on large directory trees.",
          },
          instructions: {
            type: "string",
            description:
              "Optional additional context or focus areas. E.g., 'Focus on API response format violations' " +
              "or 'Check if forbidden endpoints are used'.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing additional instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM.",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max payload in KB (prompt + spec + source files) per batch. Default: 400. " +
              "The spec file is always included — remaining budget is for source files.",
          },
        },
        required: ["spec_file_path"],
      },
    },
    {
      name: "cluster_synonyms",
      description:
        "Cluster SENTENCES (or short labels treated as sentences) by full-sentence " +
        "meaning equivalence. ZERO orchestrator tokens — file-in, file-out. The whole " +
        "batch+verify+canonicalise loop runs inside the MCP server; you get only " +
        "output paths back.\n\n" +
        "PURPOSE: aggregate synonymous / equivalent-meaning items across a large term " +
        "set. Designed for taxonomy work, ontology cleanup, label canonicalisation. " +
        "NOT a word-level synonym lookup — the unit of comparison is the full " +
        "sentence/label.\n\n" +
        "SCALE: the whole corpus and its embeddings are held in memory, so the " +
        "practical ceiling is heap-bound — tens-of-thousands to low-hundreds-of- " +
        "thousands of items on a typical Node heap with the default 384-dim " +
        "embeddings, more with policy.compute_embeddings=false. A pre-flight guard " +
        "estimates the footprint and FAILS FAST with guidance (raise " +
        "--max-old-space-size, disable embeddings, split the corpus, or set " +
        "policy.skip_memory_guard) instead of OOM-ing mid-run.\n\n" +
        "PIPELINE: Pre-flight model benchmark → Phase 0 setup (load JSONL, embeddings) " +
        "→ Phase 1 embedding-clustered batching + per-batch grouping → Phase 2 cross- " +
        "cluster verification with transitive-closure merge (>=3 distinct items from each " +
        "cluster must co-occur in the same response) → Phase 3 canonical-label selection " +
        "→ Phase 4 emit clusters.jsonl + clusters_summary.json + stats.json + " +
        "checkpoint.sqlite.\n\n" +
        "RESUMABLE: pass resume_from to a prior checkpoint.sqlite to continue.\n" +
        "BUDGET-CAPPED: policy.budget_max_llm_calls aborts cleanly when hit.\n" +
        "FAILURE-RECOVERY: each failed batch retries 3x, then splits in half and " +
        "recurses (max depth 3 → 8 leaf sub-batches, 45-call hard cap per source batch).\n" +
        "BACKEND-AGNOSTIC: uses the active profile's model selection.\n\n" +
        "STATUS: all phases live — embedding-clustered batching + recursive-split- " +
        "and-retry ladder (Phase 1), cross-cluster transitive-closure verification " +
        "(Phase 2), and canonical-label selection (Phase 3 — LLM mode when " +
        "policy.canonical_label_mode=llm, else a length heuristic). Phases 2-3 run " +
        "when the LLM budget allows; clusters.jsonl reflects Phase-1 grouping refined " +
        "by Phase-2 merges, with Phase-3 canonical labels surfaced in " +
        "clusters_summary.json (TRDD-220ea89f).",
      inputSchema: {
        type: "object" as const,
        properties: {
          input_file: {
            type: "string",
            description:
              "Absolute path to a JSONL file. Each line is a JSON object with " +
              "an 'id' (string) and a 'sentence' (string, the text to cluster); optional " +
              "'context' (free-text disambiguator). Field 'label' is accepted as an " +
              "alias for 'sentence'.",
          },
          output_dir: {
            type: "string",
            description:
              "Absolute path to the output directory. Will be created if missing. " +
              "Contains clusters.jsonl, clusters_summary.json, stats.json, checkpoint.sqlite.",
          },
          embeddings_file: {
            type: "string",
            description:
              "Optional. Absolute path to a precomputed float32 memmap file " +
              "(one row per input item, dimension D). Requires a sibling .meta.json " +
              "with {shape:[N,D], dtype, model}. If absent, the tool computes its own " +
              "embeddings via the Python sidecar (sentence-transformers/all-MiniLM-L6-v2).",
          },
          policy_file: {
            type: "string",
            description:
              "Optional. Absolute path to a JSON file with policy knobs. See the " +
              "TRDD for the full list — defaults apply per field if omitted. " +
              "Backend / model / ensemble are NOT policy knobs — they come from the " +
              "active llm-externalizer profile.",
          },
          resume_from: {
            type: "string",
            description:
              "Optional. Absolute path to a prior checkpoint.sqlite from this tool. " +
              "When set, the run resumes from where the prior invocation stopped " +
              "(after the budget cap, an abort, or any other early termination).",
          },
        },
        required: ["input_file", "output_dir"],
      },
    },
  ];
  // Append the mass-scouting tool surface (8 tools — see TRDD §15).
  // These are thin shims around the CLI dispatcher in mass_scouting/cli.ts;
  // every tool corresponds 1:1 to a `bin/llm-externalizer mass-scout <sub>`
  // CLI invocation.
  return [...allTools, ...MASS_SCOUT_TOOLS];
}
