/**
 * check-specs/core.ts — the importable check_against_specs pipeline, extracted
 * verbatim from index.ts's case body so it can run in-process (e.g. from a
 * benchmark runner) without the MCP server's top-level main() side effects.
 *
 * The pipeline itself is mechanically unchanged. Every dependency that used to
 * be an index.ts-scoped binding (path resolution, the multi-model ensemble call,
 * the footer/usage logger, the report writer, the ensemble-model label, the
 * default-max-tokens resolver, and the onProgress/outputDir/modelOverride
 * values) is injected via CheckSpecsDeps, so the caller controls the backend and
 * persistence.
 *
 * This mirrors search-existing/core.ts (SeiDeps), scan-folder/core.ts
 * (ScanFolderDeps) and code-task/core.ts (CodeTaskDeps). check_against_specs is
 * shaped like the code_task BATCH path — no per-file processFileCheck seam, no
 * rate-limited parallel executor: every LLM call goes through ensembleStreaming,
 * either one call per input file (answer_mode 0, ungrouped) or one call per FFD
 * bin-packed batch. So CheckSpecsDeps is CodeTaskDeps minus processFileCheck,
 * robustPerFileProcess, classifyError, getRateLimitConfig and defaultTemperature
 * (check_against_specs never sets a temperature — it takes the provider default).
 *
 * The auditor system prompt lives HERE, not in index.ts as an injected seam
 * (code_task's codeTaskSystemPrompt precedent), because the prompt IS the thing a
 * spec-compliance benchmark grades: a seam would force every benchmark to supply
 * its own copy and the two would drift. Its only index.ts-scoped inputs were the
 * FILE_FORMAT_EXAMPLE / BREVITY_RULES constants, which are pure strings and now
 * live in scan-pipeline.ts alongside the other pure prompt/file helpers — so the
 * core builds the REAL prompt while still importing ZERO from index.ts.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  parseRedactRegex,
  resolvePrompt,
  resolveAnswerMode,
  scanFilesForSecrets,
  readFileAsCodeBlock,
  readAndGroupFiles,
  FILE_FORMAT_EXAMPLE,
  BREVITY_RULES,
  type RegexRedactOpts,
} from "../scan-pipeline.js";
import {
  GROUP_HEADER_RE,
  GROUP_FOOTER_RE,
  parseFileGroups,
  hasNamedGroups,
  autoGroupByHeuristic,
} from "../grouping.js";
import type { ProgressFn } from "../rate-limiter.js";

export type CheckSpecsChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CheckSpecsToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Result of the multi-model ensemble call. Structurally a subset of index.ts's
 * StreamingResult (only the fields check_against_specs reads, plus the fields
 * formatFooter needs) — declared here to avoid importing from index.ts.
 * index.ts's ensembleStreaming returns the full StreamingResult, which this is
 * assignable to, and its formatFooter accepts the full StreamingResult.
 */
export interface CheckSpecsStreamingResult {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
  finishReason: string;
  truncated: boolean;
}

/** Options forwarded to the ensembleStreaming seam. Subset of index.ts's. */
export interface CheckSpecsEnsembleOptions {
  maxTokens?: number;
  onProgress?: ProgressFn;
  modelOverride?: string;
}

export interface CheckSpecsDeps {
  /** backend.type === "openrouter" — drives the multi-model ensemble path. */
  useEnsemble: boolean;
  /** index.ts's normalizePaths — string|string[]|undefined → string[]. */
  normalizePaths: (raw: string | string[] | undefined | null) => string[];
  /** index.ts's resolveFolderPath — folder_path → walked file paths. */
  resolveFolderPath: (
    folderPath: string,
    opts?: {
      extensions?: string[];
      excludeDirs?: string[];
      useGitignore?: boolean;
      recursive?: boolean;
      followSymlinks?: boolean;
      maxFiles?: number;
    },
  ) => { files: string[]; error?: string };
  /** Multi-model ensemble call seam (index.ts's ensembleStreaming). */
  ensembleStreaming: (
    messages: CheckSpecsChatMessage[],
    options: CheckSpecsEnsembleOptions,
    ensemble: boolean,
  ) => Promise<CheckSpecsStreamingResult>;
  /** Turns a StreamingResult into the report footer (records usage + logs). */
  formatFooter: (
    resp: CheckSpecsStreamingResult,
    toolName: string,
    filePath?: string,
  ) => string;
  saveResponse: (
    tool: string,
    content: string,
    meta: { model: string; task?: string; inputFile?: string; groupId?: string },
    unused: undefined,
    outputDir?: string,
  ) => string;
  /** Merged-report model label for batched/grouped output. */
  ensembleModelLabel: (useEnsemble: boolean) => string;
  /** Resolves the default max output tokens for the current model. */
  resolveDefaultMaxTokens: () => number;
  onProgress?: ProgressFn;
  outputDir?: string;
  /** Specific model override (e.g. free mode) forwarded to the LLM seam. */
  modelOverride?: string;
}

/**
 * The strict spec-compliance auditor prompt. Exported so a benchmark can assert
 * on it (and so nothing has to re-declare it).
 */
export const CHECK_SPECS_SYSTEM_PROMPT =
  "You are a strict specification compliance auditor. You will receive a SPECIFICATION FILE " +
  "and one or more SOURCE FILES. Your job is to find every violation of the specification " +
  "in the source files.\n\n" +
  "RULES:\n" +
  "1. The specification is the ABSOLUTE source of truth. Every rule, restriction, format, " +
  "API contract, forbidden pattern, and requirement in the spec MUST be followed exactly.\n" +
  "2. Report ONLY VIOLATIONS — things implemented WRONGLY or FORBIDDEN patterns used. " +
  "Do NOT report MISSING features — some requirements may be implemented in other files " +
  "that are not included here.\n" +
  "3. For each violation, report:\n" +
  "   - **File**: which source file\n" +
  "   - **Location**: function/class/method name (NEVER line numbers)\n" +
  "   - **Spec rule violated**: quote the exact spec text\n" +
  "   - **What the code does**: describe the actual behavior\n" +
  "   - **Severity**: CRITICAL (security/data loss), HIGH (wrong behavior), " +
  "MEDIUM (non-compliance), LOW (style/convention)\n" +
  "4. If a source file has NO violations, explicitly state: 'CLEAN — no spec violations found.'\n" +
  "5. At the end, provide a SUMMARY with total violation counts by severity.\n" +
  "6. Be specific and actionable — reference concrete function names, variable names, and code patterns.\n" +
  "\nSPEC FORMAT: The specification file is wrapped in <specs-filename> and <specs-file-content> tags (distinct from source file tags).\n" +
  FILE_FORMAT_EXAMPLE + BREVITY_RULES;

export async function runCheckAgainstSpecs(
  args: Record<string, unknown>,
  deps: CheckSpecsDeps,
): Promise<CheckSpecsToolResult> {
        const {
          spec_file_path: csSpecPath,
          input_files_paths: csInputPathsRaw,
          folder_path: csFolderPath,
          extensions: csExtensions,
          exclude_dirs: csExcludeDirs,
          use_gitignore: csUseGitignore,
          instructions: csInstructions,
          instructions_files_paths: csInstructionsFilesPaths,
          scan_secrets: csScan,
          redact_secrets: csRedact,
          answer_mode: csRawMode,
          max_payload_kb: csMaxPayloadKb,
          redact_regex: csRedactRegexRaw,
        } = args as {
          spec_file_path: string;
          input_files_paths?: string | string[];
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          instructions?: string;
          instructions_files_paths?: string | string[];
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          answer_mode?: number;
          max_payload_kb?: number;
        };
        const csUseEnsemble = deps.useEnsemble;
        const csBudgetBytes = (csMaxPayloadKb ?? 400) * 1024;
        const csMode = resolveAnswerMode(csRawMode, 0);

        // Validate redact_regex upfront. No initializer: the catch returns, so the
        // try's assignment is the only path forward (no-useless-assignment).
        let csRegexRedact: RegexRedactOpts | null;
        try {
          csRegexRedact = parseRedactRegex(csRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // Validate required params
        if (!csSpecPath) {
          return {
            content: [{ type: "text", text: "FAILED: spec_file_path is required." }],
            isError: true,
          };
        }

        // Reject if both folder_path and input_files_paths are provided
        const csNormalized = deps.normalizePaths(csInputPathsRaw);

        // Resolve source files from input_files_paths AND/OR folder_path (can combine both)
        let csFilePaths: string[] = [...csNormalized];
        if (csFolderPath) {
          const csFolderResult = deps.resolveFolderPath(csFolderPath, {
            extensions: csExtensions,
            excludeDirs: csExcludeDirs,
            useGitignore: csUseGitignore,
            maxFiles: (args as { max_files?: number }).max_files,
          });
          if (csFolderResult.error && csFolderResult.files.length === 0 && csFilePaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${csFolderResult.error}` }], isError: true };
          }
          csFilePaths = [...csFilePaths, ...csFolderResult.files];
        }
        if (csFilePaths.length === 0) {
          return {
            content: [{ type: "text", text: "FAILED: Provide input_files_paths or folder_path." }],
            isError: true,
          };
        }

        // Read the spec file. regexRedact is deliberately null here: the caller's
        // custom redact_regex targets SOURCE files, and applying it to the spec
        // could mangle the very rules the audit is checked against.
        let csSpecBlock: string;
        try {
          csSpecBlock = readFileAsCodeBlock(csSpecPath, undefined, csRedact, csBudgetBytes, null, "specs-");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `FAILED: Cannot read spec file: ${errMsg}` }],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found (filter out group markers).
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (csScan && !csRedact) {
          const csRealFiles = csFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          const scanResult = scanFilesForSecrets([csSpecPath, ...csRealFiles]);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        // Resolve additional instructions
        const csExtraInstructions = resolvePrompt(csInstructions, csInstructionsFilesPaths);

        // The spec-compliance system prompt (module constant — see file header).
        const csSystemPrompt = CHECK_SPECS_SYSTEM_PROMPT;

        // Compute prompt bytes for budget
        const csSpecBytes = Buffer.byteLength(csSpecBlock, "utf-8");
        const csSystemBytes = Buffer.byteLength(csSystemPrompt, "utf-8");
        const csExtraBytes = Buffer.byteLength(csExtraInstructions, "utf-8");
        const csPromptBytes = csSpecBytes + csSystemBytes + csExtraBytes;

        // ── Group-aware processing (only for input_files_paths, not folder_path) ──
        // answer_mode=1 means "one report per group". Auto-group the input
        // files when the caller did not supply ---GROUP:id--- markers.
        // folder_path input already normalizes to a single unnamed group, so
        // auto-grouping works on csFilePaths regardless of the source.
        let csFileGroups = csFolderPath
          ? [{ id: "", files: csFilePaths }]
          : parseFileGroups(csFilePaths);
        let csEffectivelyGrouped = hasNamedGroups(csFileGroups);
        if (csMode === 1 && !csEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(csFilePaths);
          if (autoGroups.length > 0) {
            csFileGroups = autoGroups;
            csEffectivelyGrouped = true;
          }
        }
        const csAllGroupReports: string[] = [];

        for (const fg of csFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id;

          // Mode 0 (non-grouped only): one output report per input file
          if (csMode === 0 && !csEffectivelyGrouped) {
            const csPerFileResults: string[] = [];
            for (const fp of fgPaths) {
              if (!existsSync(fp)) {
                csPerFileResults.push(`FAILED: ${fp} — File not found`);
                continue;
              }
              let fpBlock: string;
              try {
                fpBlock = readFileAsCodeBlock(fp, undefined, csRedact, csBudgetBytes, csRegexRedact);
              } catch (err) {
                csPerFileResults.push(`FAILED: ${fp} — ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              let fpUserContent = "## SPECIFICATION (source of truth)\n\n" + csSpecBlock + "\n\n";
              if (csExtraInstructions) {
                fpUserContent += "## ADDITIONAL INSTRUCTIONS\n\n" + csExtraInstructions + "\n\n";
              }
              fpUserContent += "## SOURCE FILES TO CHECK\n\n" + fpBlock;
              const fpMessages: CheckSpecsChatMessage[] = [
                { role: "system", content: csSystemPrompt },
                { role: "user", content: fpUserContent },
              ];
              const fpResp = await deps.ensembleStreaming(
                fpMessages,
                {
                  maxTokens: deps.resolveDefaultMaxTokens(),
                  onProgress: deps.onProgress,
                  modelOverride: deps.modelOverride, // honours --free and credit-exhausted auto-fallback
                },
                csUseEnsemble,
              );
              if (fpResp.content.trim().length === 0) {
                csPerFileResults.push(`FAILED: ${fp} — LLM returned empty response`);
                continue;
              }
              const fpFooter = deps.formatFooter(fpResp, "check_against_specs", fp);
              const fpReportPath = deps.saveResponse("check_against_specs", fpResp.content + fpFooter, {
                model: deps.ensembleModelLabel(csUseEnsemble),
                task: `Spec compliance: ${basename(csSpecPath)} vs ${basename(fp)}`,
                inputFile: fp,
              }, undefined, deps.outputDir);
              csPerFileResults.push(fpReportPath);
            }
            return { content: [{ type: "text", text: csPerFileResults.join("\n") }] };
          }

          // Group source files using FFD bin packing
          const { groups: csGroups, autoBatched: csAutoBatched, skipped: csSkipped } =
            readAndGroupFiles(fgPaths, csPromptBytes, csRedact, csBudgetBytes, csRegexRedact);

          const csBatchResults: string[] = [];
          if (csSkipped.length > 0) {
            csBatchResults.push(
              `SKIPPED (exceeds ${csBudgetBytes / 1024} KB payload budget): ${csSkipped.length} file(s)\n` +
              csSkipped.map((f) => `  - ${f}`).join("\n"),
            );
          }

          for (let gi = 0; gi < csGroups.length; gi++) {
            const group = csGroups[gi];
            let userContent =
              "## SPECIFICATION (source of truth)\n\n" + csSpecBlock + "\n\n";
            if (csExtraInstructions) {
              userContent += "## ADDITIONAL INSTRUCTIONS\n\n" + csExtraInstructions + "\n\n";
            }
            userContent += "## SOURCE FILES TO CHECK\n\n";
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }

            const csMessages: CheckSpecsChatMessage[] = [
              { role: "system", content: csSystemPrompt },
              { role: "user", content: userContent },
            ];

            const csResp = await deps.ensembleStreaming(
              csMessages,
              {
                maxTokens: deps.resolveDefaultMaxTokens(),
                onProgress: deps.onProgress,
                modelOverride: deps.modelOverride,
              },
              csUseEnsemble,
            );
            const csFooter = deps.formatFooter(csResp, "check_against_specs", group[0]?.path);
            if (csResp.content.trim().length > 0) {
              if (csAutoBatched) {
                const fileList = group.map((fd) => fd.path).join(", ");
                csBatchResults.push(
                  `## Batch ${gi + 1}/${csGroups.length}\n\nFiles: ${fileList}\n\n${csResp.content}${csFooter}`,
                );
              } else {
                csBatchResults.push(csResp.content + csFooter);
              }
            }
          }

          if (csBatchResults.length === 0) continue;
          const csFinalContent = csBatchResults.join("\n\n---\n\n");
          const csMergedModel = deps.ensembleModelLabel(csUseEnsemble);
          const csReportPath = deps.saveResponse(
            "check_against_specs",
            csFinalContent,
            {
              model: csMergedModel,
              task: `Spec compliance: ${basename(csSpecPath)} vs ${fgPaths.length} file(s)`,
              inputFile: fgPaths[0],
              groupId: fgId || undefined,
            },
            undefined,
            deps.outputDir,
          );

          if (csEffectivelyGrouped) {
            const labelId = fgId || "auto";
            csAllGroupReports.push(`[group:${labelId}] ${csReportPath}`);
          } else {
            return { content: [{ type: "text", text: csReportPath }] };
          }
        }

        // Grouped: return per-group reports
        if (csEffectivelyGrouped) {
          if (csAllGroupReports.length === 0) {
            return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
          }
          return { content: [{ type: "text", text: csAllGroupReports.join("\n") }] };
        }
        return { content: [{ type: "text", text: "FAILED: LLM returned empty response." }], isError: true };
}
