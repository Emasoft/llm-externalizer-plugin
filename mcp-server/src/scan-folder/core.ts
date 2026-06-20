/**
 * scan-folder/core.ts — the importable scan_folder pipeline, extracted
 * verbatim from index.ts's case body so it can run in-process (e.g. from a
 * benchmark runner) without the MCP server's top-level main() side effects.
 *
 * The pipeline itself is mechanically unchanged. Every dependency that used to
 * be an index.ts-scoped binding (the per-file LLM call, error classifier,
 * report writer, rate-limit config, default-max-tokens resolver, the
 * backend-derived useEnsemble/backendModel values, onProgress/outputDir/
 * modelOverride) is injected via ScanFolderDeps, so the caller controls the
 * backend and persistence.
 *
 * This mirrors search-existing/core.ts (SeiDeps). scan_folder differs from
 * search_existing in that it processes one file per LLM call (via the injected
 * processFileCheck seam) under a rate-limited parallel executor, rather than
 * FFD-batching many files into one ensembleStreaming call — so ScanFolderDeps
 * adds the per-file-call seam (processFileCheck), the rate-limit config seam
 * (getRateLimitConfig), the default-max-tokens seam (resolveDefaultMaxTokens),
 * and the modelOverride value that processFileCheck forwards. It does NOT use
 * SeiDeps's ensembleModelLabel (scan_folder labels reports with backendModel
 * directly).
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import {
  sanitizeInputPath,
  parseRedactRegex,
  resolvePrompt,
  walkDir,
  scanFilesForSecrets,
  resolveAnswerMode,
  type RegexRedactOpts,
} from "../scan-pipeline.js";
import { autoGroupByHeuristic } from "../grouping.js";
import { rateLimitedParallel, type ProgressFn } from "../rate-limiter.js";

export type ScanFolderToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Outcome of one file's LLM check. Structurally identical to index.ts's
 * FileProcessResult — declared here so the core does not import from index.ts.
 * index.ts's real processFileCheck returns the same shape, so it is assignable.
 */
export interface ScanFolderFileResult {
  filePath: string;
  success: boolean;
  reportPath?: string;
  backupPath?: string;
  error?: string;
  noChange?: boolean;
}

/**
 * Options forwarded to the per-file processFileCheck seam. Structurally a
 * subset of index.ts's ProcessOptions (only the fields scan_folder sets) —
 * declared here to avoid importing from index.ts. index.ts's processFileCheck
 * accepts the full ProcessOptions, which this is assignable to.
 */
export interface ScanFolderProcessOptions {
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

export interface ScanFolderDeps {
  useEnsemble: boolean;
  backendModel: string;
  /**
   * Per-file LLM check seam (index.ts's processFileCheck). Runs one file
   * through the ensemble and writes its intermediate per-file report.
   */
  processFileCheck: (
    filePath: string,
    task: string,
    options: ScanFolderProcessOptions,
  ) => Promise<ScanFolderFileResult>;
  classifyError: (err: unknown) => {
    reason: string;
    unrecoverable?: boolean;
    serviceLevel?: boolean;
  };
  saveResponse: (
    tool: string,
    content: string,
    meta: { model: string; task: string; inputFile: string; groupId?: string },
    unused: undefined,
    outputDir?: string,
  ) => string;
  /** Resolves the adaptive {rps, maxInFlight} budget for the parallel executor. */
  getRateLimitConfig: () => Promise<{ rps: number; maxInFlight: number }>;
  /** Resolves the default max output tokens for the current model. */
  resolveDefaultMaxTokens: () => number;
  onProgress?: ProgressFn;
  outputDir?: string;
  /** Specific model override (e.g. free mode) forwarded to processFileCheck. */
  modelOverride?: string;
}

export async function runScanFolder(
  args: Record<string, unknown>,
  deps: ScanFolderDeps,
): Promise<ScanFolderToolResult> {
        const {
          folder_path,
          extensions,
          exclude_dirs,
          max_files,
          instructions: sfInstructions,
          instructions_files_paths: sfInstructionsFilesPaths,
          redact_secrets: sfRedact,
          redact_regex: sfRedactRegexRaw,
          answer_mode: sfRawMode,
          use_gitignore: sfUseGitignore,
          scan_secrets: sfScan,
        } = args as {
          folder_path: string;
          extensions?: string[];
          exclude_dirs?: string[];
          max_files?: number;
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          redact_regex?: string;
          answer_mode?: number;
          use_gitignore?: boolean;
          scan_secrets?: boolean;
          max_payload_kb?: number;
        };
        const sfUseEnsemble = deps.useEnsemble;
        const sfBudgetBytes = ((args as { max_payload_kb?: number }).max_payload_kb ?? 400) * 1024;

        // Validate redact_regex
        let sfRegexRedact: RegexRedactOpts | null = null;
        try {
          sfRegexRedact = parseRedactRegex(sfRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // C1+H2: Sanitize folder_path (traversal + symlink protection)
        let sfFolderPath: string;
        try {
          sfFolderPath = sanitizeInputPath(folder_path);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        if (!existsSync(sfFolderPath)) {
          return {
            content: [
              {
                type: "text",
                text: `FAILED: Folder not found: ${folder_path}`,
              },
            ],
            isError: true,
          };
        }
        // Validate it's a directory, not a file
        if (!statSync(sfFolderPath).isDirectory()) {
          return {
            content: [
              { type: "text", text: `FAILED: Not a directory: ${folder_path}` },
            ],
            isError: true,
          };
        }
        const sfPrompt = resolvePrompt(
          sfInstructions,
          sfInstructionsFilesPaths,
        );
        if (!sfPrompt.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: instructions or instructions_files_paths is required.",
              },
            ],
            isError: true,
          };
        }

        // walkDir auto-skips binary extensions, hidden dirs, node_modules, .git, etc.
        // When use_gitignore is true, uses git ls-files to respect .gitignore rules.
        const files = walkDir(sfFolderPath, {
          extensions,
          maxFiles: max_files ?? 2500,
          exclude: exclude_dirs,
          useGitignore: sfUseGitignore !== false, // default true
        });
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files found in ${folder_path} matching the criteria.`,
              },
            ],
          };
        }

        // scan_secrets: abort if any secrets are found in discovered files.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (sfScan && !sfRedact) {
          const scanResult = scanFilesForSecrets(files);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        const sfMode = resolveAnswerMode(sfRawMode, 0);
        const batchId = randomUUID();
        const sfRl = await deps.getRateLimitConfig();
        const recentOutcomes: boolean[] = [];
        let aborted = false;
        let abortReason = "";

        const tasks = files.map((filePath, idx) => async () => {
          if (aborted)
            return {
              filePath,
              success: false,
              error: "Batch aborted",
            } as ScanFolderFileResult;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (aborted)
              return {
                filePath,
                success: false,
                error: "Batch aborted",
              } as ScanFolderFileResult;
            try {
              const result = await deps.processFileCheck(filePath, sfPrompt, {
                maxTokens: deps.resolveDefaultMaxTokens(),
                batchId,
                fileIndex: idx,
                redact: sfRedact,
                regexRedact: sfRegexRedact,
                onProgress: deps.onProgress,
                ensemble: sfUseEnsemble,
                maxBytes: sfBudgetBytes,
                modelOverride: deps.modelOverride,
                outputDir: deps.outputDir,
              });
              recentOutcomes.push(result.success);
              // Report per-file batch progress
              if (deps.onProgress) {
                const completed = recentOutcomes.length;
                deps.onProgress(
                  completed,
                  files.length,
                  `scan_folder: ${completed}/${files.length} files done`,
                );
              }
              return result;
            } catch (err) {
              const classified = deps.classifyError(err);
              if (classified.unrecoverable) {
                if (classified.serviceLevel) {
                  aborted = true;
                  abortReason = `Unrecoverable: ${classified.reason}`;
                }
                return {
                  filePath,
                  success: false,
                  error: classified.reason,
                } as ScanFolderFileResult;
              }
              if (attempt < 3) {
                await new Promise((r) =>
                  setTimeout(r, Math.pow(3, attempt - 1) * 1000),
                );
                continue;
              }
              recentOutcomes.push(false);
              if (
                recentOutcomes.length >= 3 &&
                recentOutcomes.slice(-3).every((v) => !v)
              ) {
                aborted = true;
                abortReason = `3 consecutive failures. Last: ${classified.reason}`;
              }
              return {
                filePath,
                success: false,
                error: `Failed after 3 retries: ${classified.reason}`,
              } as ScanFolderFileResult;
            }
          }
          return {
            filePath,
            success: false,
            error: "Unexpected retry loop exit",
          } as ScanFolderFileResult;
        });

        const batchResults = await rateLimitedParallel(tasks, sfRl.rps, sfRl.maxInFlight, deps.onProgress);
        const succeeded = batchResults.filter((r) => r.success);
        const failed = batchResults.filter(
          (r) => !r.success && r.error !== "Batch aborted",
        );
        const skipped = batchResults.filter((r) => r.error === "Batch aborted");

        if (sfMode === 2 && succeeded.length > 0) {
          // Mode 2 — single merged report containing every file's per-file output.
          const sections: string[] = [];
          for (const r of succeeded) {
            const content =
              r.reportPath && existsSync(r.reportPath)
                ? readFileSync(r.reportPath, "utf-8")
                : "";
            sections.push(`## File: ${r.filePath}\n\n${content}`);
          }
          const mergedPath = deps.saveResponse(
            "scan_folder",
            sections.join("\n\n---\n\n"),
            { model: deps.backendModel, task: sfPrompt, inputFile: folder_path },
            undefined,
            deps.outputDir,
          );
          const summary = [
            `SCAN COMPLETE — ${succeeded.length} processed, ${failed.length} failed, ${skipped.length} skipped (${files.length} files found)`,
            `Folder: ${folder_path}`,
            `Batch UUID: ${batchId}`,
            `MERGED REPORT: ${mergedPath}`,
          ];
          if (failed.length > 0) {
            summary.push("", "FAILED:");
            for (const r of failed) summary.push(`  ${r.filePath}: ${r.error}`);
          }
          if (aborted) summary.push("", `ABORTED: ${abortReason}`);
          return {
            content: [{ type: "text", text: summary.join("\n") }],
            isError: aborted,
          };
        }

        if (sfMode === 1 && succeeded.length > 0) {
          // Mode 1 — one merged report per auto-group (by subfolder/ext/basename).
          //
          // scan_folder is inherently per-file: every file already got its
          // own LLM call and its own intermediate per-file report. Mode 1
          // therefore performs POST-HOC output grouping — we cluster the
          // finished per-file reports by autoGroupByHeuristic() and merge
          // each cluster into one group-level .md. This contrasts with
          // chat / code_task / check_* where auto-grouping happens BEFORE
          // the LLM call so batches can share cross-file context. The
          // scan_folder design is a deliberate trade-off: per-file LLM calls
          // give every file its own focused audit, and mode 1 keeps the disk
          // output organised by directory without changing what the LLM saw.
          const succeededPaths = succeeded.map((r) => r.filePath);
          const sfAutoGroups = autoGroupByHeuristic(succeededPaths);
          const pathToResult = new Map<string, ScanFolderFileResult>();
          for (const r of succeeded) pathToResult.set(r.filePath, r);
          const sfGroupReportPaths: string[] = [];
          for (const fg of sfAutoGroups) {
            if (fg.files.length === 0) continue;
            const sections: string[] = [];
            for (const fp of fg.files) {
              const r = pathToResult.get(fp);
              if (!r) continue;
              const content =
                r.reportPath && existsSync(r.reportPath)
                  ? readFileSync(r.reportPath, "utf-8")
                  : "";
              sections.push(`## File: ${fp}\n\n${content}`);
            }
            if (sections.length === 0) continue;
            const gid = fg.id || "auto";
            const groupPath = deps.saveResponse(
              "scan_folder",
              sections.join("\n\n---\n\n"),
              { model: deps.backendModel, task: sfPrompt, inputFile: fg.files[0], groupId: gid },
              undefined,
              deps.outputDir,
            );
            sfGroupReportPaths.push(`[group:${gid}] ${groupPath}`);
          }
          const summary = [
            `SCAN COMPLETE — ${succeeded.length} processed, ${failed.length} failed, ${skipped.length} skipped (${files.length} files found)`,
            `Folder: ${folder_path}`,
            `Batch UUID: ${batchId}`,
          ];
          if (sfGroupReportPaths.length > 0) {
            summary.push("", `GROUP REPORTS (${sfGroupReportPaths.length}):`);
            for (const line of sfGroupReportPaths) summary.push(`  ${line}`);
          }
          if (failed.length > 0) {
            summary.push("", "FAILED:");
            for (const r of failed) summary.push(`  ${r.filePath}: ${r.error}`);
          }
          if (aborted) summary.push("", `ABORTED: ${abortReason}`);
          return {
            content: [{ type: "text", text: summary.join("\n") }],
            isError: aborted,
          };
        }

        // Mode 0: list individual reports
        const sfSummaryLines = [
          `SCAN COMPLETE — ${succeeded.length} processed, ${failed.length} failed, ${skipped.length} skipped (${files.length} files found)`,
          `Folder: ${folder_path}`,
          `Batch UUID: ${batchId}`,
          "",
        ];
        if (succeeded.length > 0) {
          sfSummaryLines.push("REPORTS:");
          for (const r of succeeded) sfSummaryLines.push(`  ${r.reportPath}`);
        }
        if (failed.length > 0) {
          sfSummaryLines.push("", "FAILED:");
          for (const r of failed)
            sfSummaryLines.push(`  ${r.filePath}: ${r.error}`);
        }
        if (aborted) sfSummaryLines.push("", `ABORTED: ${abortReason}`);
        return {
          content: [{ type: "text", text: sfSummaryLines.join("\n") }],
          isError: aborted,
        };
}
