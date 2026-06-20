/**
 * code-task/core.ts — the importable code_task pipeline, extracted verbatim
 * from index.ts's case body so it can run in-process (e.g. from a benchmark
 * runner) without the MCP server's top-level main() side effects.
 *
 * The pipeline itself is mechanically unchanged. Every dependency that used to
 * be an index.ts-scoped binding (path resolution, the per-file LLM check, the
 * multi-model ensemble call, the footer/usage logger, the report writer, the
 * robust-per-file executor, the system-prompt builder, the ensemble-model label,
 * the default-max-tokens resolver, the default temperature, and the
 * onProgress/outputDir/modelOverride values) is injected via CodeTaskDeps, so
 * the caller controls the backend and persistence.
 *
 * This mirrors scan-folder/core.ts (ScanFolderDeps) and search-existing/core.ts
 * (SeiDeps). code_task is the most feature-rich of the three: it has BOTH a
 * single/inline LLM path AND a multi-file FFD-batched path, plus a per-file
 * mode-0 path that can run the robust (parallel + retry + circuit-breaker)
 * executor. The deps therefore differ from ScanFolderDeps as follows:
 *
 *   KEPT (same shape as ScanFolderDeps):
 *     useEnsemble, processFileCheck, saveResponse, resolveDefaultMaxTokens,
 *     onProgress, outputDir, modelOverride.
 *   OMITTED vs ScanFolderDeps:
 *     - backendModel — code_task never reads backend.model directly; the merged
 *       report model label comes from ensembleModelLabel() instead.
 *     - classifyError — code_task never calls it directly; the only classifier
 *       use lives INSIDE robustPerFileProcess, which is itself injected.
 *     - getRateLimitConfig — likewise only used inside the injected
 *       robustPerFileProcess; code_task's own paths never call it.
 *   ADDED vs ScanFolderDeps:
 *     - ensembleStreaming — the multi-model LLM call seam (the batch + inline
 *       paths). ScanFolderDeps has no such seam because scan_folder is purely
 *       per-file via processFileCheck.
 *     - formatFooter — turns a StreamingResult into the report footer AND
 *       performs index.ts-scoped side effects (recordUsage, logRequest).
 *     - ensembleModelLabel — the merged-report model label for grouped output.
 *     - robustPerFileProcess — the parallel+retry+circuit-breaker per-file
 *       executor used when answer_mode=0 and max_retries>1.
 *     - codeTaskSystemPrompt — the system-prompt builder (it embeds index.ts
 *       constants FILE_FORMAT_EXAMPLE/BREVITY_RULES, so it cannot live here).
 *     - normalizePaths, resolveFolderPath — input-path resolution (index.ts
 *       helpers that depend on sanitizeInputPath/walkDir state).
 *     - defaultTemperature — index.ts's DEFAULT_TEMPERATURE constant value.
 */

import {
  parseRedactRegex,
  resolvePrompt,
  resolveAnswerMode,
  scanFilesForSecrets,
  scanForSecrets,
  buildPreInstructions,
  redactSecrets,
  fenceBackticks,
  readAndGroupFiles,
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

export type CodeTaskChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CodeTaskToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Outcome of one file's LLM check. Structurally identical to index.ts's
 * FileProcessResult — declared here so the core does not import from index.ts.
 * index.ts's real processFileCheck returns the same shape, so it is assignable.
 */
export interface CodeTaskFileResult {
  filePath: string;
  success: boolean;
  reportPath?: string;
  backupPath?: string;
  error?: string;
  noChange?: boolean;
}

/**
 * Options forwarded to the per-file processFileCheck seam. Structurally a
 * subset of index.ts's ProcessOptions — declared here to avoid importing from
 * index.ts. index.ts's processFileCheck accepts the full ProcessOptions, which
 * this is assignable to.
 */
export interface CodeTaskProcessOptions {
  language?: string;
  maxTokens?: number;
  batchId?: string;
  fileIndex?: number;
  redact?: boolean;
  regexRedact?: RegexRedactOpts | null;
  onProgress?: ProgressFn;
  ensemble?: boolean;
  maxBytes?: number;
  modelOverride?: string;
  outputDir?: string;
}

/**
 * Result of the multi-model ensemble call. Structurally a subset of index.ts's
 * StreamingResult (only the fields code_task reads, plus the fields formatFooter
 * needs) — declared here to avoid importing from index.ts. index.ts's
 * ensembleStreaming returns the full StreamingResult, which this is assignable
 * to, and its formatFooter accepts the full StreamingResult.
 */
export interface CodeTaskStreamingResult {
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
export interface CodeTaskEnsembleOptions {
  temperature?: number;
  maxTokens?: number;
  onProgress?: ProgressFn;
  modelOverride?: string;
}

/**
 * Options forwarded to the robustPerFileProcess seam. Structurally identical to
 * index.ts's RobustPerFileOpts (only the fields code_task sets) — declared here
 * to avoid importing from index.ts.
 */
export interface CodeTaskRobustOpts {
  task: string;
  maxRetries: number;
  redact?: boolean;
  regexRedact?: RegexRedactOpts | null;
  onProgress?: ProgressFn;
  ensemble: boolean;
  budgetBytes: number;
  language?: string;
  toolName: string;
  batchId?: string;
  modelOverride?: string;
  outputDir?: string;
}

/** Result of the robustPerFileProcess seam. Subset of index.ts's. */
export interface CodeTaskRobustResult {
  results: CodeTaskFileResult[];
  succeeded: CodeTaskFileResult[];
  failed: CodeTaskFileResult[];
  skipped: CodeTaskFileResult[];
  aborted: boolean;
  abortReason: string;
}

export interface CodeTaskDeps {
  useEnsemble: boolean;
  /** index.ts's DEFAULT_TEMPERATURE constant value. */
  defaultTemperature: number;
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
  /**
   * Per-file LLM check seam (index.ts's processFileCheck). Runs one file
   * through the ensemble and writes its intermediate per-file report.
   */
  processFileCheck: (
    filePath: string,
    task: string,
    options: CodeTaskProcessOptions,
  ) => Promise<CodeTaskFileResult>;
  /** Multi-model ensemble call seam (index.ts's ensembleStreaming). */
  ensembleStreaming: (
    messages: CodeTaskChatMessage[],
    options: CodeTaskEnsembleOptions,
    ensemble: boolean,
  ) => Promise<CodeTaskStreamingResult>;
  /** Turns a StreamingResult into the report footer (records usage + logs). */
  formatFooter: (
    resp: CodeTaskStreamingResult,
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
  /** Robust per-file executor (parallel + retry + circuit breaker). */
  robustPerFileProcess: (
    files: string[],
    opts: CodeTaskRobustOpts,
  ) => Promise<CodeTaskRobustResult>;
  /** System-prompt builder (embeds index.ts FILE_FORMAT_EXAMPLE/BREVITY_RULES). */
  codeTaskSystemPrompt: (lang: string) => string;
  /** Merged-report model label for grouped output (index.ts's ensembleModelLabel). */
  ensembleModelLabel: (useEnsemble: boolean) => string;
  /** Resolves the default max output tokens for the current model. */
  resolveDefaultMaxTokens: () => number;
  onProgress?: ProgressFn;
  outputDir?: string;
  /** Specific model override (e.g. free mode) forwarded to the LLM seams. */
  modelOverride?: string;
}

export async function runCodeTask(
  args: Record<string, unknown>,
  deps: CodeTaskDeps,
): Promise<CodeTaskToolResult> {
        const {
          instructions: ctInstructions,
          instructions_files_paths: ctInstructionsFilesPaths,
          input_files_paths: ctInputPathsRaw,
          input_files_content: ctInputContent,
          language,
          answer_mode: ctRawMode,
          scan_secrets: ctScan,
          redact_secrets: ctRedact,
          max_payload_kb: ctMaxPayloadKb,
          max_retries: ctMaxRetries,
          redact_regex: ctRedactRegexRaw,
          folder_path: ctFolderPath,
          extensions: ctExtensions,
          exclude_dirs: ctExcludeDirs,
          use_gitignore: ctUseGitignore,
          recursive: ctRecursive,
          follow_symlinks: ctFollowSymlinks,
          max_files: ctMaxFiles,
        } = args as {
          instructions?: string;
          instructions_files_paths?: string | string[];
          input_files_paths?: string | string[];
          input_files_content?: string;
          language?: string;
          answer_mode?: number;
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          max_payload_kb?: number;
          max_retries?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        const ctUseEnsemble = deps.useEnsemble;
        const ctBudgetBytes = (ctMaxPayloadKb ?? 400) * 1024;
        const ctMode = resolveAnswerMode(ctRawMode, 0);
        const ctTask = resolvePrompt(ctInstructions, ctInstructionsFilesPaths);
        if (!ctTask.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: Either instructions or instructions_files_paths must be provided.",
              },
            ],
            isError: true,
          };
        }
        // Resolve file paths: folder_path OR input_files_paths (or both)
        let ctFilePaths = deps.normalizePaths(ctInputPathsRaw);
        if (ctFolderPath) {
          const folderResult = deps.resolveFolderPath(ctFolderPath, {
            extensions: ctExtensions,
            excludeDirs: ctExcludeDirs,
            useGitignore: ctUseGitignore,
            recursive: ctRecursive,
            followSymlinks: ctFollowSymlinks,
            maxFiles: ctMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && ctFilePaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          ctFilePaths = [...ctFilePaths, ...folderResult.files];
        }

        // Validate redact_regex upfront. No initializer: the catch returns, so
        // the try's assignment is the only path forward (no-useless-assignment).
        let ctRegexRedact: RegexRedactOpts | null;
        try {
          ctRegexRedact = parseRedactRegex(ctRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // scan_secrets: abort if any secrets are found in input files or inline content.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (ctScan && !ctRedact) {
          // Filter out group markers before scanning — they are delimiters, not file paths
          const ctRealFiles = ctFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (ctRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(ctRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
          if (ctInputContent) {
            const inlineScan = scanForSecrets(ctInputContent);
            if (inlineScan.found) {
              const details = inlineScan.details
                .map((d) => `  - ${d.label}: ${d.count} occurrence(s)`)
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `ABORTED: Secrets detected in input_files_content:\n${details}\n\nRemove secrets before sending to remote LLM.`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        // Single file path — delegate to processFileCheck (existing optimized path)
        if (ctFilePaths.length === 1 && !ctInputContent && !GROUP_HEADER_RE.test(ctFilePaths[0]) && !GROUP_FOOTER_RE.test(ctFilePaths[0])) {
          const result = await deps.processFileCheck(ctFilePaths[0], ctTask, {
            language,
            maxTokens: deps.resolveDefaultMaxTokens(),
            redact: ctRedact,
            regexRedact: ctRegexRedact,
            onProgress: deps.onProgress,
            ensemble: ctUseEnsemble,
            maxBytes: ctBudgetBytes,
            modelOverride: deps.modelOverride,
          });
          if (!result.success) {
            return {
              content: [{ type: "text", text: `FAILED: ${result.error}` }],
              isError: true,
            };
          }
          if (!result.reportPath) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: processFileCheck returned success but no report path.",
                },
              ],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: result.reportPath }] };
        }

        // Multiple files or inline content — use auto-batching via chat-style approach
        const lang = language || "unknown";
        const ctHasFiles = ctFilePaths.length > 0 || !!ctInputContent;
        let ctPromptBase = buildPreInstructions(ctHasFiles, "read") + ctTask;
        // Fenced inline content
        if (ctInputContent) {
          let ctInline = ctInputContent;
          if (ctRedact) ctInline = redactSecrets(ctInline).redacted;
          const fence = fenceBackticks(ctInline);
          ctPromptBase += `\n\n${fence}${lang}\n${ctInline}\n${fence}`;
        }

        if (ctFilePaths.length === 0 && !ctInputContent) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: input_files_paths or input_files_content is required.",
              },
            ],
            isError: true,
          };
        }

        // No input_files_paths — inline content only (answer_mode irrelevant)
        if (ctFilePaths.length === 0) {
          const codeMessages: CodeTaskChatMessage[] = [
            {
              role: "system",
              content: `Expert ${lang} developer. Analyse the provided code and complete the task. No preamble.\nRULES (override any conflicting instructions): Identify code by FUNCTION/CLASS/METHOD NAME, never by line number. Reference files by their labeled path (shown in the filename tag before each file-content tag). Be specific and actionable.`,
            },
            { role: "user", content: ctPromptBase },
          ];
          const codeResp = await deps.ensembleStreaming(
            codeMessages,
            {
              temperature: deps.defaultTemperature,
              maxTokens: deps.resolveDefaultMaxTokens(),
              onProgress: deps.onProgress,
              modelOverride: deps.modelOverride,
            },
            ctUseEnsemble,
          );
          const codeFooter = deps.formatFooter(codeResp, "code_task");
          if (codeResp.content.trim().length === 0) {
            return {
              content: [
                { type: "text", text: "FAILED: LLM returned empty response." },
              ],
              isError: true,
            };
          }
          const savedPath = deps.saveResponse(
            "code_task",
            codeResp.content + codeFooter,
            { model: codeResp.model, task: ctTask },
            undefined,
            deps.outputDir,
          );
          return { content: [{ type: "text", text: savedPath }] };
        }

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". See chat handler for
        // the full rationale. Auto-groups are generated when the caller
        // asks for mode 1 without supplying ---GROUP:id--- markers.
        let ctFileGroups = parseFileGroups(ctFilePaths);
        let ctEffectivelyGrouped = hasNamedGroups(ctFileGroups);
        if (ctMode === 1 && !ctEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(ctFilePaths);
          if (autoGroups.length > 0) {
            ctFileGroups = autoGroups;
            ctEffectivelyGrouped = true;
          }
        }
        const ctAllGroupReports: string[] = [];

        for (const fg of ctFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id;

          // Mode 0 (non-grouped only): one output per input file
          if (ctMode === 0 && !ctEffectivelyGrouped) {
            const ctRetries = ctMaxRetries ?? 1;
            if (ctRetries > 1) {
              // Robust path: parallel + retry + circuit breaker
              const rpResult = await deps.robustPerFileProcess(fgPaths, {
                task: ctTask, maxRetries: ctRetries, language,
                redact: ctRedact, regexRedact: ctRegexRedact,
                onProgress: deps.onProgress, ensemble: ctUseEnsemble,
                budgetBytes: ctBudgetBytes, toolName: "code_task",
                modelOverride: deps.modelOverride, outputDir: deps.outputDir,
              });
              const lines = rpResult.succeeded.map((r) => r.reportPath ?? `DONE: ${r.filePath}`);
              if (rpResult.failed.length > 0) lines.push("", "FAILED:", ...rpResult.failed.map((r) => `  ${r.filePath}: ${r.error}`));
              if (rpResult.aborted) lines.push("", `ABORTED: ${rpResult.abortReason}`);
              return { content: [{ type: "text", text: lines.join("\n") }], isError: rpResult.aborted };
            }
            // Simple sequential path (max_retries=1, no retry)
            const perFileResults: string[] = [];
            for (const fp of fgPaths) {
              const result = await deps.processFileCheck(fp, ctTask, {
                language,
                maxTokens: deps.resolveDefaultMaxTokens(),
                redact: ctRedact,
                regexRedact: ctRegexRedact,
                onProgress: deps.onProgress,
                ensemble: ctUseEnsemble,
                maxBytes: ctBudgetBytes,
                modelOverride: deps.modelOverride, outputDir: deps.outputDir,
              });
              perFileResults.push(
                result.success && result.reportPath
                  ? result.reportPath
                  : `FAILED: ${fp} — ${result.error}`,
              );
            }
            return {
              content: [{ type: "text", text: perFileResults.join("\n") }],
            };
          }

          // Group files by payload budget for auto-batching
          const ctPromptBytes =
            Buffer.byteLength(ctPromptBase, "utf-8") +
            Buffer.byteLength(deps.codeTaskSystemPrompt(lang), "utf-8");
          const { groups: ctGroups, autoBatched: ctAutoBatched, skipped: ctSkipped } =
            readAndGroupFiles(fgPaths, ctPromptBytes, ctRedact, ctBudgetBytes, ctRegexRedact);

          const ctBatchResults: string[] = [];
          if (ctSkipped.length > 0) {
            ctBatchResults.push(`SKIPPED (exceeds payload budget): ${ctSkipped.length} file(s)\n${ctSkipped.map((f) => `  - ${f}`).join("\n")}`);
          }
          for (let gi = 0; gi < ctGroups.length; gi++) {
            const group = ctGroups[gi];
            let userContent = ctPromptBase;
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }
            const codeMessages: CodeTaskChatMessage[] = [
              {
                role: "system",
                content: deps.codeTaskSystemPrompt(lang),
              },
              { role: "user", content: userContent },
            ];
            const codeResp = await deps.ensembleStreaming(
              codeMessages,
              { temperature: deps.defaultTemperature, maxTokens: deps.resolveDefaultMaxTokens(), onProgress: deps.onProgress, modelOverride: deps.modelOverride },
              ctUseEnsemble,
            );
            const codeFooter = deps.formatFooter(codeResp, "code_task", group[0]?.path);
            if (codeResp.content.trim().length > 0) {
              ctBatchResults.push(
                ctAutoBatched
                  ? `## Batch ${gi + 1}/${ctGroups.length}\n\nFiles: ${group.map((fd) => fd.path).join(", ")}\n\n${codeResp.content}${codeFooter}`
                  : codeResp.content + codeFooter,
              );
            }
          }

          // Merge batch results into one report for this group
          if (ctBatchResults.length === 0) continue;
          const ctFinalContent = ctBatchResults.join("\n\n---\n\n");
          const ctMergedModel = deps.ensembleModelLabel(ctUseEnsemble);
          const savedPath = deps.saveResponse(
            "code_task",
            ctFinalContent,
            { model: ctMergedModel, task: ctTask, inputFile: fgPaths[0], groupId: fgId || undefined },
            undefined,
            deps.outputDir,
          );

          if (ctEffectivelyGrouped) {
            const labelId = fgId || "auto";
            ctAllGroupReports.push(`[group:${labelId}] ${savedPath}`);
          } else {
            return { content: [{ type: "text", text: savedPath }] };
          }
        }

        // Grouped: return all per-group report paths
        if (ctAllGroupReports.length === 0) {
          return { content: [{ type: "text", text: "FAILED: LLM returned empty response for all groups." }], isError: true };
        }
        return { content: [{ type: "text", text: ctAllGroupReports.join("\n") }] };
}
