/**
 * Thin CLI adapter for the `cluster_synonyms` capability — the second of the
 * three mandated surfaces (MCP tool + CLI subcommand + Claude Code slash
 * command), all wired to the SAME core (`runClusterSynonyms` in
 * cluster_synonyms_main.ts). This adapter does NOT reimplement any clustering
 * logic; it only parses the rich tool input and forwards a validated
 * ClusterSynonymsInvocation to the core, then formats the result for stdout.
 *
 * The input rides `--input-json '<json>'` (same convention security_scan uses)
 * because the tool input is a nested object — flat `--key value` flags would
 * be lossy. An explicit `--output-dir` flag overrides the `output_dir`
 * embedded in the JSON (belt-and-braces with the MCP dispatch, which passes
 * output_dir both ways).
 *
 * The real LLM transport (rate-limiting / retry / model-fallback) lives in the
 * MCP server (index.ts wires chatCompletionWithRetry as the rawLlmCall). The
 * production top-level `llm-externalizer cluster-synonyms` verb therefore
 * spawns the server and calls the `cluster_synonyms` tool over stdio (mirroring
 * cmdSearchExisting) — reusing parseClusterSynonymsInput from this module so
 * both surfaces share one parser. Tests inject a deterministic rawLlmCall
 * through the hooks argument here, exercising the same parse → core → format
 * path without any network call.
 */

import {
  runClusterSynonyms,
  type ClusterSynonymsHooks,
  type ClusterSynonymsInvocation,
} from "./cluster_synonyms_main.js";

/** Stdout / stderr / exit-code triple — same shape mass_scouting/cli.ts uses
 *  so callers can plumb it to the process uniformly. */
export interface ClusterCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Parse `--key value` and `--key=value` from argv. Repeated keys win-last. */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

/**
 * Parse the `cluster-synonyms` CLI args (`--input-json` + optional
 * `--output-dir` override) into a validated ClusterSynonymsInvocation, or an
 * `{ error }` usage object. This is the SINGLE source of truth for turning the
 * JSON-encoded tool input into an invocation — both the testable adapter below
 * and the production top-level verb in cli.ts call it, so the CLI surface and
 * the MCP surface stay shape-identical.
 *
 * String-typed fields are validated to be actual strings (not numbers/objects
 * smuggled through the JSON) so a malformed payload fails fast here rather than
 * deep inside the core.
 */
export function parseClusterSynonymsInput(
  args: string[],
): ClusterSynonymsInvocation | { error: string } {
  const flags = parseFlags(args);

  const inputJson = flags["input-json"];
  if (inputJson === undefined || inputJson === "" || inputJson === "true") {
    return {
      error:
        "--input-json is required (JSON-encoded {input_file, output_dir, " +
        "embeddings_file?, policy_file?, resume_from?})",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch (e) {
    return { error: `--input-json is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "--input-json must decode to a JSON object." };
  }
  const obj = parsed as Record<string, unknown>;

  // An explicit --output-dir flag wins over output_dir embedded in the JSON
  // (the MCP dispatch passes output_dir both ways for belt-and-braces).
  if (flags["output-dir"] && flags["output-dir"] !== "true") {
    obj.output_dir = flags["output-dir"];
  }

  const asString = (key: string): string | undefined | { error: string } => {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") return { error: `'${key}' must be a string.` };
    return v;
  };

  const inputFile = asString("input_file");
  if (inputFile !== undefined && typeof inputFile === "object") return inputFile;
  const outputDir = asString("output_dir");
  if (outputDir !== undefined && typeof outputDir === "object") return outputDir;
  const embeddingsFile = asString("embeddings_file");
  if (embeddingsFile !== undefined && typeof embeddingsFile === "object") return embeddingsFile;
  const policyFile = asString("policy_file");
  if (policyFile !== undefined && typeof policyFile === "object") return policyFile;
  const resumeFrom = asString("resume_from");
  if (resumeFrom !== undefined && typeof resumeFrom === "object") return resumeFrom;

  if (!inputFile) return { error: "cluster_synonyms requires 'input_file' (a JSONL path)." };
  if (!outputDir) return { error: "cluster_synonyms requires 'output_dir'." };

  return {
    input_file: inputFile,
    output_dir: outputDir,
    ...(embeddingsFile !== undefined ? { embeddings_file: embeddingsFile } : {}),
    ...(policyFile !== undefined ? { policy_file: policyFile } : {}),
    ...(resumeFrom !== undefined ? { resume_from: resumeFrom } : {}),
  };
}

/** Format a successful core result into the same human-readable block the MCP
 *  dispatch emits, so CLI and MCP callers see identical output. */
function formatResult(r: Awaited<ReturnType<typeof runClusterSynonyms>>): string {
  return (
    `cluster_synonyms OK\n` +
    `  items_in:        ${r.stats.items_in}\n` +
    `  clusters_out:    ${r.stats.clusters_out}\n` +
    `  reduction_pct:   ${r.stats.reduction_pct.toFixed(2)}%\n` +
    `  llm_calls_total: ${r.stats.llm_calls_total}\n` +
    `  walltime_s:      ${r.stats.walltime_seconds.toFixed(2)}\n` +
    `  budget_exhausted: ${r.stats.budget_exhausted}\n` +
    `  warnings:        ${r.stats.warnings.length}\n` +
    `  outputs:\n` +
    `    ${r.clusters_jsonl}\n` +
    `    ${r.clusters_summary_json}\n` +
    `    ${r.stats_json}\n` +
    `    ${r.checkpoint_sqlite}\n`
  );
}

/**
 * Run the `cluster-synonyms` CLI subcommand: parse `--input-json`, then call
 * the SAME runClusterSynonyms core with the supplied hooks. Hooks carry the
 * rawLlmCall (the server injects its rate-limited chatCompletionWithRetry;
 * tests inject a deterministic mock) plus optional embeddings / pre-flight /
 * profile overrides. Returns a {stdout, stderr, exitCode} triple — never
 * throws on a usage error or a clean core failure, so the caller can plumb it
 * straight to the process. (A genuinely unexpected throw is caught and mapped
 * to exitCode 1 too, so a CLI invocation always exits cleanly.)
 */
export async function runClusterSynonymsCli(
  args: string[],
  hooks: ClusterSynonymsHooks,
): Promise<ClusterCliResult> {
  const parsed = parseClusterSynonymsInput(args);
  if ("error" in parsed) {
    return { stdout: "", stderr: `Error: ${parsed.error}\n`, exitCode: 1 };
  }

  try {
    const result = await runClusterSynonyms(parsed, hooks);
    if (!result.ok) {
      return {
        stdout: "",
        stderr: `Error: cluster_synonyms failed: ${result.errors.join("; ")}\n`,
        exitCode: 1,
      };
    }
    return { stdout: formatResult(result), stderr: "", exitCode: 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: "", stderr: `Error: cluster_synonyms threw: ${msg}\n`, exitCode: 1 };
  }
}
