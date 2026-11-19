/**
 * DRY_RUN_SUPPORT (cli/dry-run-flags.ts) is bound to what --estimate and --preview really do (TRDD-58CFBQHN).
 *
 * For each of the 23 profile-aware commands this calls the real estimateToolRun and the real preview file resolver (buildEstimateDeps().resolveFiles, the function main.ts's --preview branch calls) with a minimal valid input built from the command's own schema over real files in a temp dir, and asserts: the flag is refused exactly when the table says it is not accepted. No mocks.
 * The only injected seams are the pure ones estimate.test.ts also injects (model slots, pricing, refusal gate): they decide the price of an accepted run, never whether the tool is modelled. Resolution and file sizes are the engine's own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateToolRun, type EstimateDeps } from "../estimate.js";
import { DRY_RUN_SUPPORT, PROFILE_AWARE_TOOLS } from "./dry-run-flags.js";

/** The commands under test: the profile-aware list. It is not read from the table, so the expectations never come from the table being checked; tsc ties the table's keys to this list. */
const TOOLS = PROFILE_AWARE_TOOLS;

/** What each refusal says, so a throw from a bad input cannot pass for a refusal. */
const ESTIMATE_REFUSAL = /does not model|carry their own estimator|runs through the mass_scouting subsystem|file resolution failed/;
const PREVIEW_REFUSAL = /no input_files_paths or folder_path given/;

let root: string;
let file: string;
let second: string;
let jsonl: string;
let dir: string;
let engineDeps: EstimateDeps;

/** Minimal valid arguments per command, from its own inputSchema (tools/definitions.ts), the way the CLI would deliver them. */
function argsFor(tool: (typeof TOOLS)[number]): Record<string, unknown> {
  switch (tool) {
    case "chat":
    case "code_task":
      return { instructions: "review", input_files_paths: [file] };
    case "check_imports":
    case "check_references":
      return { input_files_paths: [file] };
    case "check_against_specs":
      return { input_files_paths: [file], spec_file_path: second };
    case "compare_files":
      return { input_files_paths: [file, second] };
    case "batch_check":
      return { input_files_paths: [file] };
    case "scan_folder":
    case "high_quality_scan":
      return { instructions: "review", folder_path: dir };
    case "search_existing_implementations":
      return { feature_description: "parse a number", folder_path: dir };
    case "summarize":
    case "topics":
    case "sem_deduplicate":
    case "describe":
      return { input_file: file };
    case "cluster_synonyms":
      return { input_file: jsonl, output_dir: join(root, "out") };
    case "session_summary":
      return { transcript: jsonl };
    case "security_scan":
      return { targets: [{ id: "t1", category: "injection", snippet: "eval(x)" }] };
    case "mass_scout":
      return { db_path: join(root, "s.sqlite"), fields_file: second, job_id: "j1", source_root: dir };
    case "mass_scout_chain":
      return { db_path: join(root, "s.sqlite"), filter: "$.a:=:1", new_fields_file: second, new_job_id: "j2", source_job: "j1" };
    case "mass_scout_propose_fieldset":
      return { goal: "find the error handlers" };
    case "check_tool_replacements":
    case "security_triage_benchmark":
    case "search_existing_benchmark":
      return { output_dir: join(root, "out") };
  }
}

function tryEstimate(tool: (typeof TOOLS)[number]): { accepted: boolean; message: string } {
  try {
    estimateToolRun(tool, argsFor(tool), engineDeps);
    return { accepted: true, message: "" };
  } catch (err) {
    return { accepted: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function tryPreview(tool: (typeof TOOLS)[number]): { accepted: boolean; message: string } {
  const resolved = engineDeps.resolveFiles(argsFor(tool));
  return resolved.error === undefined && resolved.files.length > 0
    ? { accepted: true, message: "" }
    : { accepted: false, message: resolved.error ?? "no files" };
}

beforeAll(async () => {
  // WHY /tmp and not tmpdir(): the file resolver only accepts paths under the cwd, home or /tmp (sanitizeInputPath), and macOS tmpdir() is /var/folders. The llm-ext- prefix lets the suite's leak guard (test-tmpdir-guard.ts) see it; mkdtempSync is cleaned by test-tmpdir-tracker.ts and afterAll removes it too.
  root = mkdtempSync("/tmp/llm-ext-dryrun-flags-");
  dir = join(root, "src");
  mkdirSync(dir);
  file = join(dir, "a.ts");
  second = join(dir, "b.ts");
  jsonl = join(root, "in.jsonl");
  writeFileSync(file, "export const a = 1;\n", "utf-8");
  writeFileSync(second, "export const b = 2;\n", "utf-8");
  writeFileSync(jsonl, '{"id":"1","text":"x"}\n', "utf-8");
  const { buildEstimateDeps } = await import("../index.js");
  const real = buildEstimateDeps();
  engineDeps = {
    resolveFiles: real.resolveFiles,
    fileSizeBytes: real.fileSizeBytes,
    fileLineCount: real.fileLineCount,
    ensembleSlots: () => [{ id: "vendor/model-paid", maxOutput: 8000 }],
    pricingFor: () => ({ inputUsdPerM: 1, outputUsdPerM: 2 }),
    defaultMaxTokens: () => 4000,
    slotRefusal: () => null,
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("DRY_RUN_SUPPORT is bound to the real --estimate and --preview behaviour", () => {
  it.each(TOOLS)("%s: --estimate is refused exactly when the table says it is not accepted", (tool) => {
    const got = tryEstimate(tool);
    expect(got.accepted, got.message).toBe(DRY_RUN_SUPPORT[tool].estimate);
    if (!got.accepted) expect(got.message).toMatch(ESTIMATE_REFUSAL);
  });

  it.each(TOOLS)("%s: --preview is refused exactly when the table says it is not accepted", (tool) => {
    const got = tryPreview(tool);
    expect(got.accepted, got.message).toBe(DRY_RUN_SUPPORT[tool].preview);
    if (!got.accepted) expect(got.message).toMatch(PREVIEW_REFUSAL);
  });
});
