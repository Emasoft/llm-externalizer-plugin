/**
 * batch_check tool handler: the body of index.ts's `case "batch_check"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { isCommandStopped, failedHeader, unfinishedFileLines, abortReasonText, runOutcome } from "../command-stop.js";
import { GROUP_HEADER_RE, GROUP_FOOTER_RE, parseFileGroups, hasNamedGroups, autoGroupByHeuristic } from "../grouping.js";
import { mergePieceDir } from "../project-root.js";
import { rateLimitedParallel } from "../rate-limiter.js";
import { resolveAnswerMode, type RegexRedactOpts, parseRedactRegex, scanFilesForSecrets, resolvePrompt } from "../scan-pipeline.js";
import { formatUsageTotals } from "../usage-totals.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CaseCall, CaseDeps, FileProcessResult, ToolResult } from "./dispatch-deps.js";

export async function handleBatchCheck(call: CaseCall, deps: Pick<CaseDeps, "activeResolved" | "classifyError" | "ensembleAllowed" | "getRateLimitConfig" | "normalizePaths" | "processFileCheck" | "recordFailedOutcome" | "resolveDefaultMaxTokens" | "resolveFolderPath" | "saveResponse">): Promise<ToolResult> {
  const { args, backend, onProgress, modelOverride, outputDir } = call;
  const { classifyError, ensembleAllowed, getRateLimitConfig, normalizePaths, processFileCheck, recordFailedOutcome, resolveDefaultMaxTokens, resolveFolderPath, saveResponse } = deps;
  const {
    instructions: bcInstructions,
    instructions_files_paths: bcInstructionsFilesPaths,
    input_files_paths: bcInputPaths,
    answer_mode: bcRawMode,
    scan_secrets: bcScan,
    redact_secrets: bcRedact,
    redact_regex: bcRedactRegexRaw,
    max_payload_kb: bcMaxPayloadKb,
    folder_path: bcFolderPath,
    extensions: bcExtensions,
    exclude_dirs: bcExcludeDirs,
    use_gitignore: bcUseGitignore,
    recursive: bcRecursive,
    follow_symlinks: bcFollowSymlinks,
    max_files: bcMaxFiles,
  } = args as {
    instructions?: string;
    instructions_files_paths?: string | string[];
    input_files_paths: string[];
    answer_mode?: number;
    scan_secrets?: boolean;
    redact_secrets?: boolean;
    redact_regex?: string;
    max_payload_kb?: number;
    folder_path?: string;
    extensions?: string[];
    exclude_dirs?: string[];
    use_gitignore?: boolean;
    recursive?: boolean;
    follow_symlinks?: boolean;
    max_files?: number;
  };
  const bcUseEnsemble = ensembleAllowed(backend, deps.activeResolved); // P8: one predicate (see ensembleAllowed)
  const bcBudgetBytes = (bcMaxPayloadKb ?? 400) * 1024;
  const bcMode = resolveAnswerMode(bcRawMode, 0);

  // Validate redact_regex
  let bcRegexRedact: RegexRedactOpts | null = null;
  try {
    bcRegexRedact = parseRedactRegex(bcRedactRegexRaw);
  } catch (err) {
    return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
  }

  let bcNormalizedPaths = normalizePaths(bcInputPaths);
  if (bcFolderPath) {
    const folderResult = resolveFolderPath(bcFolderPath, {
      extensions: bcExtensions, excludeDirs: bcExcludeDirs,
      useGitignore: bcUseGitignore, recursive: bcRecursive,
      followSymlinks: bcFollowSymlinks, maxFiles: bcMaxFiles,
    });
    if (folderResult.error && folderResult.files.length === 0 && bcNormalizedPaths.length === 0) {
      return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
    }
    bcNormalizedPaths = [...bcNormalizedPaths, ...folderResult.files];
  }
  if (bcNormalizedPaths.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "FAILED: input_files_paths or folder_path is required.",
        },
      ],
      isError: true,
    };
  }

  // Deduplicate file paths to avoid redundant LLM calls
  const uniqueFiles = [...new Set(bcNormalizedPaths)];

  // scan_secrets: abort if any secrets are found in input files.
  // When redact_secrets is also true, skip the abort — downstream redaction handles it.
  if (bcScan && !bcRedact) {
    // Filter out group markers before scanning
    const realFiles = uniqueFiles.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
    if (realFiles.length > 0) {
      const scanResult = scanFilesForSecrets(realFiles);
      if (scanResult.found)
        return {
          content: [{ type: "text", text: scanResult.report }],
          isError: true,
        };
    }
  }

  // ── Group-aware: if groups present (or mode 1 auto-groups),
  // process each group independently. answer_mode=1 uses the
  // heuristic auto-grouper when no ---GROUP:id--- markers are given.
  let bcFileGroups = parseFileGroups(uniqueFiles);
  let bcEffectivelyGrouped = hasNamedGroups(bcFileGroups);
  if (bcMode === 1 && !bcEffectivelyGrouped) {
    const autoGroups = autoGroupByHeuristic(uniqueFiles);
    if (autoGroups.length > 0) {
      bcFileGroups = autoGroups;
      bcEffectivelyGrouped = true;
    }
  }
  if (bcEffectivelyGrouped) {
    const bcGroupReports: string[] = [];
    for (const fg of bcFileGroups) {
      if (fg.files.length === 0) continue;
      const gid = fg.id || "auto";
      const gBatchId = randomUUID();
      const gTask = resolvePrompt(bcInstructions, bcInstructionsFilesPaths).trim() ||
        "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures.";
      const gRl = await getRateLimitConfig();
      // Circuit-breaker + retry, mirroring the non-grouped branch below. The tool's
      // documented contract ("3 attempts for recoverable errors; aborts on 3+
      // consecutive failures") must apply equally to grouped runs — without this
      // the grouped path would retry zero times and keep hammering a dead backend.
      const gRecentOutcomes: boolean[] = [];
      let gAborted = false;
      let gAbortReason = "";
      let gTotalAttempts = 0;
      const gMaxTotalAttempts = fg.files.length * 2;
      const gTasks = fg.files.map((filePath, idx) => async () => {
        if (gAborted) {
          return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (++gTotalAttempts > gMaxTotalAttempts) {
            gAborted = true;
            gAbortReason = `Global retry budget exhausted (${gMaxTotalAttempts} total attempts)`;
          }
          if (gAborted) {
            return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
          }
          try {
            const result = await processFileCheck(filePath, gTask, {
              maxTokens: resolveDefaultMaxTokens(),
              batchId: gBatchId, fileIndex: idx,
              redact: bcRedact, regexRedact: bcRegexRedact, onProgress, ensemble: bcUseEnsemble, maxBytes: bcBudgetBytes, modelOverride,
              // TRDD-PNU8XECB: a grouped run always merges these per-file pieces into one report per group,
              // so the pieces are intermediate (reports_dev) and only the merged report lands in reports/.
              outputDir: mergePieceDir(outputDir, true),
            });
            gRecentOutcomes.push(result.success);
            return result;
          } catch (err) {
            const classified = classifyError(err);
            if (classified.unrecoverable) {
              if (classified.serviceLevel) {
                gAborted = true;
                gAbortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
              }
              // A closed retry window is final for this file but still a failed
              // outcome (see the batch_check loop below).
              if (classified.countsAsFailure && recordFailedOutcome(gRecentOutcomes)) {
                gAborted = true;
                gAbortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
              }
              return { filePath, success: false, error: classified.reason } as FileProcessResult;
            }
            if (attempt < 3) {
              const delayMs = Math.pow(3, attempt - 1) * 1000;
              await new Promise((r) => setTimeout(r, delayMs));
              continue;
            }
            gRecentOutcomes.push(false);
            if (
              gRecentOutcomes.length >= 3 &&
              gRecentOutcomes.slice(-3).every((v) => !v)
            ) {
              gAborted = true;
              gAbortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
            }
            return { filePath, success: false, error: `Failed after 3 retries: ${classified.reason}` } as FileProcessResult;
          }
        }
        return { filePath, success: false, error: "Unexpected retry loop exit" } as FileProcessResult;
      });
      const gAll = await rateLimitedParallel(gTasks, gRl.rps, gRl.maxInFlight, onProgress);
      const gSucceeded = gAll.filter((r) => r.success);
      // Merge into one report per group
      const reportSections: string[] = [];
      for (const r of gSucceeded) {
        const content = r.reportPath && existsSync(r.reportPath)
          ? readFileSync(r.reportPath, "utf-8") : "";
        reportSections.push(`## File: ${r.filePath}\n\n${content}`);
      }
      const gFailed: FileProcessResult[] = gAll.filter((r) => !r.success);
      if (gFailed.length > 0) {
        reportSections.push(`## FAILED (${gFailed.length})\n\n${gFailed.map((r) => `- ${r.filePath}: ${r.error}`).join("\n")}`);
      }
      if (gAborted) {
        reportSections.push(`## BATCH ABORTED\n\n${gAbortReason}`);
      }
      if (reportSections.length > 0) {
        const mergedContent = reportSections.join("\n\n---\n\n");
        const mergedPath = saveResponse(
          "batch_check",
          mergedContent,
          { model: backend.model, task: gTask, inputFile: fg.files[0], groupId: gid },
          undefined,
          outputDir,
        );
        bcGroupReports.push(`[group:${gid}] ${mergedPath}`);
      }
    }
    if (bcGroupReports.length === 0) {
      return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
    }
    return { content: [{ type: "text", text: bcGroupReports.join("\n") }] };
  }

  const batchId = randomUUID();
  const defaultTask =
    "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures. Be specific — reference line numbers and function names.";
  // Resolve prompt from instructions + instructions_files_paths
  const bcPrompt = resolvePrompt(
    bcInstructions,
    bcInstructionsFilesPaths,
  );
  const resolvedTask = bcPrompt.trim() || defaultTask;
  const bcRl = await getRateLimitConfig();

  // Sliding window of recent completion outcomes for circuit breaker.
  // Under parallel execution, "consecutive" is meaningless — instead we track
  // the last N completions and abort if the tail is all failures.
  const recentOutcomes: boolean[] = [];
  let aborted = false;
  let abortReason = "";
  // H3: Global retry cap — max 2× file count total attempts to prevent quota exhaustion
  let totalAttempts = 0;
  const maxTotalAttempts = uniqueFiles.length * 2;

  const tasks = uniqueFiles.map((filePath, idx) => async () => {
    // If batch was aborted by a prior task, skip remaining files
    if (aborted) {
      return {
        filePath,
        success: false,
        error: "Batch aborted",
      } as FileProcessResult;
    }

    // Retry loop — up to 3 attempts for recoverable errors
    for (let attempt = 1; attempt <= 3; attempt++) {
      // H3: Check global retry budget before each attempt
      if (++totalAttempts > maxTotalAttempts) {
        aborted = true;
        abortReason = `Global retry budget exhausted (${maxTotalAttempts} total attempts)`;
      }
      // Re-check abort flag before each retry to avoid wasting calls after abort
      if (aborted) {
        return {
          filePath,
          success: false,
          error: "Batch aborted",
        } as FileProcessResult;
      }
      try {
        const result = await processFileCheck(filePath, resolvedTask, {
          maxTokens: resolveDefaultMaxTokens(),
          batchId,
          fileIndex: idx,
          redact: bcRedact,
          regexRedact: bcRegexRedact,
          onProgress,
          ensemble: bcUseEnsemble,
          maxBytes: bcBudgetBytes,
          modelOverride,
          // TRDD-PNU8XECB: modes 1/2 merge these per-file pieces into one final report, so the
          // pieces are intermediate (reports_dev); in mode 0 the per-file reports are the deliverable.
          outputDir: mergePieceDir(outputDir, bcMode === 1 || bcMode === 2),
        });
        recentOutcomes.push(result.success);
        // Report per-file batch progress
        if (onProgress) {
          const completed = recentOutcomes.length;
          onProgress(
            completed,
            uniqueFiles.length,
            `batch_check: ${completed}/${uniqueFiles.length} files done`,
          );
        }
        return result;
      } catch (err) {
        const classified = classifyError(err);
        if (classified.unrecoverable) {
          if (classified.serviceLevel) {
            // Service-level error (auth/payment) — abort the entire batch
            aborted = true;
            abortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
          }
          // A closed retry window is final for this file but still a failed
          // outcome: without this the "3 of the last 3 failed" abort never
          // saw it (only the retried-then-exhausted path below pushed false).
          if (classified.countsAsFailure && recordFailedOutcome(recentOutcomes)) {
            aborted = true;
            abortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
          }
          // File-level error (not found) — fail this file only, don't abort batch
          return {
            filePath,
            success: false,
            error: classified.reason,
          } as FileProcessResult;
        }
        // Recoverable — retry with exponential backoff (1s, 3s)
        if (attempt < 3) {
          const delayMs = Math.pow(3, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        // All retries exhausted — record failure in sliding window
        // Check if last 3 completions are all failures
        if (recordFailedOutcome(recentOutcomes)) {
          aborted = true;
          abortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
        }
        return {
          filePath,
          success: false,
          error: `Failed after 3 retries: ${classified.reason}`,
        } as FileProcessResult;
      }
    }
    return {
      filePath,
      success: false,
      error: "Unexpected retry loop exit",
    } as FileProcessResult;
  });

  const batchResults = await rateLimitedParallel(tasks, bcRl.rps, bcRl.maxInFlight, onProgress);

  // Categorize results
  const succeeded = batchResults.filter((r) => r.success);
  const failed = batchResults.filter(
    (r) => !r.success && r.error !== "Batch aborted",
  );
  const skipped = batchResults.filter((r) => r.error === "Batch aborted");

  // For modes 1/2: merge individual report files into one output
  // BUT: skip merge if any files failed — incomplete merge is misleading
  if ((bcMode === 1 || bcMode === 2) && succeeded.length > 0) {
    if (failed.length > 0 || aborted) {
      // Some files failed — skip merge, fall through to mode-0 per-file listing
      // so the agent sees exactly which files succeeded and which failed
    } else {
      // All files succeeded — safe to merge reports
      const reportSections: string[] = [];
      for (const r of succeeded) {
        const content =
          r.reportPath && existsSync(r.reportPath)
            ? readFileSync(r.reportPath, "utf-8")
            : "";
        reportSections.push(`## File: ${r.filePath}\n\n${content}`);
      }
      const mergedContent = reportSections.join("\n\n---\n\n");
      const mergedPath = saveResponse(
        "batch_check",
        mergedContent,
        { model: backend.model, task: resolvedTask, inputFile: uniqueFiles[0] },
        undefined,
        outputDir,
      );
      const bcSummary: string[] = [
        `BATCH CHECK COMPLETE — ${succeeded.length} succeeded (${uniqueFiles.length} total) — ${formatUsageTotals(batchResults)}`,
        `Batch UUID: ${batchId}`,
        `MERGED REPORT: ${mergedPath}`,
      ];
      return { content: [{ type: "text", text: bcSummary.join("\n") }] };
    }
  }

  // Mode 0 (default): list individual report paths
  const summaryLines: string[] = [
    `BATCH CHECK COMPLETE — ${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped (${uniqueFiles.length} total) — ${formatUsageTotals(batchResults)}`,
    `Batch UUID: ${batchId}`,
    "",
  ];
  if (uniqueFiles.length < bcNormalizedPaths.length) {
    summaryLines.push(
      `Note: ${bcNormalizedPaths.length - uniqueFiles.length} duplicate path(s) removed.`,
    );
  }

  if (succeeded.length > 0) {
    summaryLines.push("REPORTS:");
    for (const r of succeeded) {
      summaryLines.push(`  ${r.reportPath}`);
    }
  }
  // Follow-up review M1/m2: once stopped, every non-success file is named (skipped ones too), instead of FAILED and a SKIPPED count.
  if (failed.length > 0 && !isCommandStopped()) {
    summaryLines.push("", failedHeader(failed.length, uniqueFiles.length));
    for (const r of failed) {
      summaryLines.push(`  ${r.filePath}: ${r.error}`);
    }
  }
  if (skipped.length > 0 && !isCommandStopped()) {
    summaryLines.push(
      "",
      `SKIPPED (batch aborted): ${skipped.length} file(s)`,
    );
  }
  summaryLines.push(...unfinishedFileLines(batchResults));
  if (aborted) {
    summaryLines.push("", `BATCH ABORTED: ${abortReasonText(abortReason)}`);
  }
  return {
    content: [{ type: "text", text: summaryLines.join("\n") }],
    ...runOutcome(aborted, failed.length, succeeded.length),
  };
}
