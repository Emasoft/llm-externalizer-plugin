/**
 * The two global dry-run flags and which command accepts which (TRDD-58CFBQHN).
 *
 * WHY this is its own module: cli/main.ts runs main() on import, so a test can never import anything from it; the table below is bound to the real behaviour by dry-run-flags.test.ts, which has to reach it.
 */

/**
 * The two global dry-run flags: the single definition both the argv strip in main() and the per-command help read.
 * WHY one table: help printed neither flag (issue 16 item 5) because the strip and the help were separate places; a second hand-written list would drift again.
 */
export const DRY_RUN_FLAGS = {
  estimate: { flag: "--estimate", help: "Dry run: print the predicted cost of this command instead of running it; nothing is sent to a model." },
  preview: { flag: "--preview", help: "Dry run: list every candidate file with its included or excluded verdict instead of running; nothing is sent to a model." },
} as const;

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
export const PROFILE_AWARE_TOOLS = [
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
] as const;

export type ProfileAwareTool = (typeof PROFILE_AWARE_TOOLS)[number];

/** Type guard: whether a command name is one of the profile-aware commands (the only ones whose help lists --profile and the dry-run flags). */
export function isProfileAware(name: string): name is ProfileAwareTool {
  return (PROFILE_AWARE_TOOLS as readonly string[]).includes(name);
}

/**
 * Which dry-run flag each profile-aware command accepts: the one source the per-command help reads.
 * WHY: help must not advertise a flag the command refuses (TRDD-58CFBQHN). Before this table every profile-aware command listed both flags, and 14 of the 23 refused one or both.
 * `estimate` is true when estimateToolRun (src/estimate.ts) models the tool; `preview` is true when the preview resolver (buildEstimateDeps().resolveFiles, src/index.ts) accepts the tool's own input. Change an entry whenever either gains or loses support for a tool: dry-run-flags.test.ts calls both for every tool and fails when an entry disagrees with what they do.
 * A `false` is one of four kinds, named per entry: DESIGN (estimate only: the command has its own cost control), GAP-RESOLVER (`gap: TRDD-51JRJ3M6`: the resolver reads only input_files_paths and folder_path, so it ignores the tool's own input parameter), GAP-ESTIMATOR (`gap: TRDD-ZVZFKNLP`: estimateToolRun answers "does not model X yet") or NO-INPUT (preview only: the command takes no file-path input to list; any path it takes is configuration or output, and its entry names the real input).
 * The keys are typed by PROFILE_AWARE_TOOLS, so tsc fails on a missing or extra entry.
 */
export const DRY_RUN_SUPPORT: Readonly<Record<ProfileAwareTool, { readonly estimate: boolean; readonly preview: boolean }>> = {
  chat: { estimate: true, preview: true },
  code_task: { estimate: true, preview: true },
  // estimate: GAP-ESTIMATOR (gap: TRDD-ZVZFKNLP). preview: GAP-RESOLVER (gap: TRDD-51JRJ3M6), its input is `transcript`/`session_id`.
  session_summary: { estimate: false, preview: false },
  // The four text tools take one `input_file`: estimate resolves it itself, preview does not (GAP-RESOLVER, gap: TRDD-51JRJ3M6).
  summarize: { estimate: true, preview: false },
  topics: { estimate: true, preview: false },
  sem_deduplicate: { estimate: true, preview: false },
  describe: { estimate: true, preview: false },
  // estimate: GAP-ESTIMATOR (gap: TRDD-ZVZFKNLP), the deprecated batch_check is not modelled. preview: accepted, it takes input_files_paths like the generic resolver expects.
  batch_check: { estimate: false, preview: true },
  scan_folder: { estimate: true, preview: true },
  high_quality_scan: { estimate: true, preview: true },
  compare_files: { estimate: true, preview: true },
  check_references: { estimate: true, preview: true },
  check_imports: { estimate: true, preview: true },
  check_against_specs: { estimate: true, preview: true },
  search_existing_implementations: { estimate: true, preview: true },
  // estimate: estimateToolRun models it as one call but resolves files only from input_files_paths/folder_path, so `input_file` fails (GAP-RESOLVER, gap: TRDD-51JRJ3M6). preview: same cause.
  cluster_synonyms: { estimate: false, preview: false },
  // estimate: DESIGN for the four below, the scouting subsystem has its own estimator (--budget-usd / mass-scout-estimate).
  // mass_scout and mass_scout_chain preview: NO-INPUT, the files to process are the rows of the job registry (real input: db_path + job_id / source_job, plus a fieldset file as configuration); source_root is only recorded on the job row.
  mass_scout: { estimate: false, preview: false },
  mass_scout_chain: { estimate: false, preview: false },
  // preview: GAP-RESOLVER (gap: TRDD-51JRJ3M6), the optional `samples` parameter is a list of file paths the resolver does not read.
  mass_scout_propose_fieldset: { estimate: false, preview: false },
  // preview: GAP-RESOLVER (gap: TRDD-51JRJ3M6), its files are `targets[].file_path` / `targets[].path_glob` (relative to `folder_root`), not input_files_paths or folder_path. Built CLI, `scan security --folder_root <dir> --targets <file_path or path_glob target> --preview`: "preview: no input_files_paths or folder_path given" (the resolver refuses; checked 2026-11-13). Snippet targets carry inline code and no file: only file_path / path_glob targets are resolver gaps, so a snippet-only scan has nothing to list even after TRDD-51JRJ3M6.
  security_scan: { estimate: false, preview: false },
  // estimate: GAP-ESTIMATOR (gap: TRDD-ZVZFKNLP) for the three below. preview: NO-INPUT. Real inputs, none a candidate file: security_triage_benchmark = optional model ids (`models`) scored against a labeled golden dataset; search_existing_benchmark = optional model ids + `qualifying_top_n` scored against a golden fixture codebase; check_tool_replacements = optional model ids, read from the model-health ledger. All three also take `force`, `allow_paid_models_tests` and an `output_dir` that only receives the report.
  security_triage_benchmark: { estimate: false, preview: false },
  search_existing_benchmark: { estimate: false, preview: false },
  check_tool_replacements: { estimate: false, preview: false },
};

/** The dry-run flag rows a command's help lists: only the flags it accepts. Throws for a name that is not a profile-aware command: nothing there decides which flags to list. */
export function acceptedDryRunFlags(toolName: string): Array<{ flag: string; help: string }> {
  // WHY the runtime check stays although the table is typed: the name arrives as a string from the CLI.
  if (!isProfileAware(toolName)) {
    throw new Error(`no dry-run flag entry for '${toolName}': it is not a profile-aware command (PROFILE_AWARE_TOOLS in src/cli/dry-run-flags.ts)`);
  }
  const support = DRY_RUN_SUPPORT[toolName];
  return [
    ...(support.estimate ? [DRY_RUN_FLAGS.estimate] : []),
    ...(support.preview ? [DRY_RUN_FLAGS.preview] : []),
  ];
}
