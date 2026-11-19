/**
 * chat tool handler: the body of index.ts's `case "chat"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { isCommandStopped, failedHeader, unfinishedFileLines, abortReasonText, runOutcome } from "../command-stop.js";
import { GROUP_HEADER_RE, GROUP_FOOTER_RE, parseFileGroups, hasNamedGroups, autoGroupByHeuristic } from "../grouping.js";
import { type ChatMessage } from "../provider/types.js";
import { gateLLMResponse, gateFailureMessage } from "../response-gate.js";
import { type RegexRedactOpts, parseRedactRegex, resolvePrompt, scanFilesForSecrets, scanForSecrets, resolveAnswerMode, buildPreInstructions, redactSecrets, fenceBackticks, FILE_FORMAT_EXAMPLE, BREVITY_RULES, readAndGroupFiles } from "../scan-pipeline.js";
import type { CaseCall, CaseDeps, ToolResult } from "./dispatch-deps.js";

export async function handleChat(call: CaseCall, deps: Pick<CaseDeps, "DEFAULT_TEMPERATURE" | "activeResolved" | "ensembleAllowed" | "ensembleModelLabel" | "ensembleStreaming" | "formatFooter" | "normalizePaths" | "processFileCheck" | "resolveDefaultMaxTokens" | "resolveFolderPath" | "robustPerFileProcess" | "saveResponse">): Promise<ToolResult> {
  const { args, backend, onProgress, modelOverride, outputDir } = call;
  const { DEFAULT_TEMPERATURE, ensembleAllowed, ensembleModelLabel, ensembleStreaming, formatFooter, normalizePaths, processFileCheck, resolveDefaultMaxTokens, resolveFolderPath, robustPerFileProcess, saveResponse } = deps;
  const {
    instructions,
    instructions_files_paths,
    input_files_paths: chatInputPathsRaw,
    input_files_content,
    system,
    answer_mode: rawAnswerMode,
    scan_secrets: chatScan,
    redact_secrets: chatRedact,
    max_payload_kb: chatMaxPayloadKb,
    max_retries: chatMaxRetries,
    redact_regex: chatRedactRegexRaw,
    folder_path: chatFolderPath,
    extensions: chatExtensions,
    exclude_dirs: chatExcludeDirs,
    use_gitignore: chatUseGitignore,
    recursive: chatRecursive,
    follow_symlinks: chatFollowSymlinks,
    max_files: chatMaxFiles,
    line_numbers: chatLineNumbers,
  } = args as {
    instructions?: string;
    instructions_files_paths?: string | string[];
    input_files_paths?: string | string[];
    input_files_content?: string;
    system?: string;
    answer_mode?: number;
    scan_secrets?: boolean;
    redact_secrets?: boolean;
    max_retries?: number;
    max_payload_kb?: number;
    redact_regex?: string;
    folder_path?: string;
    extensions?: string[];
    exclude_dirs?: string[];
    use_gitignore?: boolean;
    recursive?: boolean;
    follow_symlinks?: boolean;
    max_files?: number;
    line_numbers?: boolean;
  };
  // Ensemble ON for the openrouter backend and for a mode-local profile with two or more members (P8, ensembleAllowed)
  const useEnsemble = ensembleAllowed(backend, deps.activeResolved);
  const chatBudgetBytes = (chatMaxPayloadKb ?? 400) * 1024;

  // Validate redact_regex upfront — fail fast on invalid patterns
  // No initial value: the catch below returns, so a null here was never read (no-useless-assignment flags it in this module).
  let chatRegexRedact: RegexRedactOpts | null;
  try {
    chatRegexRedact = parseRedactRegex(chatRedactRegexRaw);
  } catch (err) {
    return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
  }
  const chatPrompt = resolvePrompt(
    instructions,
    instructions_files_paths,
  );
  if (!chatPrompt.trim() && !input_files_content) {
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
  let chatFilePaths = normalizePaths(chatInputPathsRaw);
  if (chatFolderPath) {
    const folderResult = resolveFolderPath(chatFolderPath, {
      extensions: chatExtensions,
      excludeDirs: chatExcludeDirs,
      useGitignore: chatUseGitignore,
      recursive: chatRecursive,
      followSymlinks: chatFollowSymlinks,
      maxFiles: chatMaxFiles,
    });
    if (folderResult.error && folderResult.files.length === 0 && chatFilePaths.length === 0) {
      return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
    }
    chatFilePaths = [...chatFilePaths, ...folderResult.files];
  }

  // scan_secrets: abort if any secrets are found in input files or inline content.
  // When redact_secrets is also true, skip the abort — downstream redaction handles it.
  if (chatScan && !chatRedact) {
    // Filter out group markers before scanning — they are delimiters, not file paths
    const chatRealFiles = chatFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
    if (chatRealFiles.length > 0) {
      const scanResult = scanFilesForSecrets(chatRealFiles);
      if (scanResult.found)
        return {
          content: [{ type: "text", text: scanResult.report }],
          isError: true,
        };
    }
    if (input_files_content) {
      const inlineScan = scanForSecrets(input_files_content);
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

  // Always use model's maximum output capacity — no user override
  const maxTokens = resolveDefaultMaxTokens();
  const chatMode = resolveAnswerMode(rawAnswerMode, 0);

  // Build prompt base: pre-instructions + unfenced instructions + optional fenced inline content
  const chatHasFiles = chatFilePaths.length > 0 || !!input_files_content;
  let promptBase =
    // WHY files only: inline input_files_content is fenced unnumbered, so the numbered-line rule must not be claimed for it.
    buildPreInstructions(chatHasFiles, "read", chatLineNumbers === true && chatFilePaths.length > 0) + chatPrompt;
  if (input_files_content) {
    let inlineContent = input_files_content;
    if (chatRedact) inlineContent = redactSecrets(inlineContent).redacted;
    const fence = fenceBackticks(inlineContent);
    promptBase += `\n\n${fence}\n${inlineContent}\n${fence}`;
  }

  // If no input_files_paths, just send the prompt (answer_mode irrelevant)
  if (chatFilePaths.length === 0) {
    const messages: ChatMessage[] = [];
    messages.push({ role: "system", content: (system || "") + FILE_FORMAT_EXAMPLE + BREVITY_RULES });
    messages.push({ role: "user", content: promptBase });
    const resp = await ensembleStreaming(
      messages,
      { temperature: DEFAULT_TEMPERATURE, maxTokens, onProgress, modelOverride },
      useEnsemble,
    );
    const footer = formatFooter(resp, "chat");
    // Shared response gate (TRDD-P4ULUV1R): empty AND echoed responses
    // are failures — "the model printed something" is not success.
    const chatVerdict = gateLLMResponse(resp.content, promptBase);
    if (chatVerdict !== null) {
      return {
        content: [
          { type: "text", text: `FAILED: ${gateFailureMessage(chatVerdict)}.` },
        ],
        isError: true,
      };
    }
    const savedPath = saveResponse(
      "chat",
      resp.content + footer,
      { model: resp.model, task: chatPrompt },
      undefined,
      outputDir,
    );
    return { content: [{ type: "text", text: savedPath }] };
  }

  // ── Group-aware processing ──
  // answer_mode=1 means "one report per group". Groups come from either:
  //   • explicit ---GROUP:id--- markers in input_files_paths, or
  //   • auto-grouping by subfolder/extension/basename when no markers
  //     were supplied (see autoGroupByHeuristic).
  // answer_mode=0 is per-file, answer_mode=2 is a single merged report.
  let chatFileGroups = parseFileGroups(chatFilePaths);
  let chatEffectivelyGrouped = hasNamedGroups(chatFileGroups);
  if (chatMode === 1 && !chatEffectivelyGrouped) {
    const autoGroups = autoGroupByHeuristic(chatFilePaths);
    if (autoGroups.length > 0) {
      chatFileGroups = autoGroups;
      chatEffectivelyGrouped = true;
    }
  }

  // Process each group (or single unnamed group for backward compat)
  const allGroupReports: string[] = [];
  /** Follow-up review M2: files of batches whose call threw, as "FAILED: <file> — <reason>" lines. */
  const chatFailedLines: string[] = [];
  for (const fg of chatFileGroups) {
    const fgPaths = fg.files;
    if (fgPaths.length === 0) continue;
    const fgId = fg.id; // empty string for unnamed/backward-compat

    // ── Mode 0: one output file per input file (separate LLM calls) ──
    if (chatMode === 0 && !chatEffectivelyGrouped) {
      const chatRetries = chatMaxRetries ?? 1;
      if (chatRetries > 1) {
        // Robust path: parallel + retry + circuit breaker
        const rpResult = await robustPerFileProcess(fgPaths, {
          task: chatPrompt, maxRetries: chatRetries,
          redact: chatRedact, regexRedact: chatRegexRedact,
          onProgress, ensemble: useEnsemble,
          budgetBytes: chatBudgetBytes, toolName: "chat",
          lineNumbers: chatLineNumbers,
          modelOverride, outputDir,
        });
        const lines = rpResult.succeeded.map((r) => r.reportPath ?? `DONE: ${r.filePath}`);
        // Follow-up review M1/m2: once stopped, every non-success file (skipped ones too) is listed, and the abort reason is the stop.
        if (rpResult.failed.length > 0 && !isCommandStopped()) lines.push("", failedHeader(rpResult.failed.length, fgPaths.length), ...rpResult.failed.map((r) => `  ${r.filePath}: ${r.error}`));
        lines.push(...unfinishedFileLines(rpResult.results));
        if (rpResult.aborted) lines.push("", `ABORTED: ${abortReasonText(rpResult.abortReason)}`);
        return { content: [{ type: "text", text: lines.join("\n") }], ...runOutcome(rpResult.aborted, rpResult.failed.length, rpResult.succeeded.length) };
      }
      // Simple sequential path (max_retries=1, no retry)
      // Follow-up review M2: a file whose call THROWS (a --command_timeout stop
      // above all) is recorded as "FAILED: <file> — <reason>" and the loop goes
      // on; before, the first throw dropped every finished report path.
      const perFileResults: string[] = [];
      let failedFiles = 0;
      for (const fp of fgPaths) {
        let result: Awaited<ReturnType<typeof processFileCheck>>;
        try {
          result = await processFileCheck(fp, chatPrompt, {
            maxTokens,
            redact: chatRedact,
            regexRedact: chatRegexRedact,
            onProgress,
            ensemble: useEnsemble,
            maxBytes: chatBudgetBytes,
            lineNumbers: chatLineNumbers,
            modelOverride, outputDir,
          });
        } catch (err) {
          failedFiles++;
          perFileResults.push(`FAILED: ${fp} — ${(err as Error).message}`);
          continue;
        }
        if (!(result.success && result.reportPath)) failedFiles++;
        perFileResults.push(
          result.success && result.reportPath
            ? result.reportPath
            : `FAILED: ${fp} — ${result.error}`,
        );
      }
      // Any failed file (a thrown call or a failed result) is an error with the finished paths listed (TRDD-PN84WC1L: a failed result used to exit 0).
      return {
        content: [{ type: "text", text: perFileResults.join("\n") }],
        ...runOutcome(false, failedFiles, perFileResults.length - failedFiles),
      };
    }

    // Group files by configurable payload budget for auto-batching.
    // A single user/auto group may still exceed the LLM context window,
    // in which case FFD splits it across multiple LLM calls; the
    // per-group merge path below stitches them back into one report.
    const chatPromptBytes =
      Buffer.byteLength(promptBase, "utf-8") +
      (system ? Buffer.byteLength(system, "utf-8") : 0);
    const { groups, autoBatched, skipped: chatSkipped } = readAndGroupFiles(
      fgPaths,
      chatPromptBytes,
      chatRedact,
      chatBudgetBytes,
      chatRegexRedact,
      chatLineNumbers,
    );

    // Collect results for this file group (merged-per-group output)
    const batchResults: string[] = [];
    if (chatSkipped.length > 0) {
      const skipNote = `SKIPPED (exceeds ${chatBudgetBytes / 1024} KB payload budget): ${chatSkipped.length} file(s)\n${chatSkipped.map((f) => `  - ${f}`).join("\n")}`;
      batchResults.push(skipNote);
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      let userContent = promptBase;
      for (const fd of group) {
        userContent += `\n\n${fd.block}`;
      }
      const messages: ChatMessage[] = [];
      messages.push({ role: "system", content: (system || "") + FILE_FORMAT_EXAMPLE + BREVITY_RULES });
      messages.push({ role: "user", content: userContent });
      // Follow-up review M2: a failed batch (a --command_timeout stop above all)
      // is recorded per file and the loop goes on, so the batches and
      // groups already answered are still written and reported.
      let resp: Awaited<ReturnType<typeof ensembleStreaming>>;
      try {
        resp = await ensembleStreaming(
          messages,
          { temperature: DEFAULT_TEMPERATURE, maxTokens, onProgress, modelOverride },
          useEnsemble,
        );
      } catch (err) {
        for (const fd of group) chatFailedLines.push(`FAILED: ${fd.path} — ${(err as Error).message}`);
        continue;
      }
      const footer = formatFooter(resp, "chat", group[0]?.path);
      // Shared response gate (TRDD-P4ULUV1R): an echoed group answer is
      // dropped exactly like an empty one — including it would present
      // the input back as if it were analysis.
      if (gateLLMResponse(resp.content, userContent) === null) {
        if (autoBatched) {
          const fileList = group.map((fd) => fd.path).join(", ");
          batchResults.push(
            `## Batch ${gi + 1}/${groups.length}\n\nFiles: ${fileList}\n\n${resp.content}${footer}`,
          );
        } else {
          batchResults.push(resp.content + footer);
        }
      }
    }

    // Merge batch results into one report for this group.
    if (batchResults.length === 0) continue; // skip empty groups
    const finalContent = batchResults.join("\n\n---\n\n");
    const chatMergedModel = ensembleModelLabel(useEnsemble);
    const savedPath = saveResponse(
      "chat",
      finalContent,
      { model: chatMergedModel, task: chatPrompt, inputFile: fgPaths[0], groupId: fgId || undefined },
      undefined,
      outputDir,
    );

    if (chatEffectivelyGrouped) {
      const labelId = fgId || "auto";
      allGroupReports.push(`[group:${labelId}] ${savedPath}`);
    } else {
      // Single unnamed group — return directly (mode 0/2 backward compat)
      return { content: [{ type: "text", text: [savedPath, ...chatFailedLines].join("\n") }], ...runOutcome(false, chatFailedLines.length, 1) };
    }
  }

  // Grouped mode: return all per-group report paths
  if (allGroupReports.length === 0) {
    return {
      content: [{ type: "text", text: chatFailedLines.length > 0 ? chatFailedLines.join("\n") : "FAILED: LLM returned empty response for all groups." }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: [...allGroupReports, ...chatFailedLines].join("\n") }], ...runOutcome(false, chatFailedLines.length, allGroupReports.length) };
}
