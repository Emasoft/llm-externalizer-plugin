/**
 * check_references tool handler: the body of index.ts's `case "check_references"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { GROUP_HEADER_RE, GROUP_FOOTER_RE, parseFileGroups, hasNamedGroups, autoGroupByHeuristic } from "../grouping.js";
import { type ChatMessage } from "../provider/types.js";
import { gateLLMResponse } from "../response-gate.js";
import { type RegexRedactOpts, parseRedactRegex, scanFilesForSecrets, resolvePrompt, resolveAnswerMode, detectLang, extractLocalImports, readFileAsCodeBlock, FILE_FORMAT_EXAMPLE, BREVITY_RULES } from "../scan-pipeline.js";
import { existsSync, readFileSync } from "node:fs";
import type { CaseCall, CaseDeps, ToolResult } from "./dispatch-deps.js";

export async function handleCheckReferences(call: CaseCall, deps: Pick<CaseDeps, "DEFAULT_TEMPERATURE" | "activeResolved" | "capDependencyBlocks" | "ensembleAllowed" | "ensembleStreaming" | "formatFooter" | "normalizePaths" | "resolveDefaultMaxTokens" | "resolveFolderPath" | "saveResponse">): Promise<ToolResult> {
  const { args, backend, onProgress, modelOverride, outputDir } = call;
  const { DEFAULT_TEMPERATURE, capDependencyBlocks, ensembleAllowed, ensembleStreaming, formatFooter, normalizePaths, resolveDefaultMaxTokens, resolveFolderPath, saveResponse } = deps;
  const {
    input_files_paths: crInputPathsRaw,
    instructions: crInstructions,
    instructions_files_paths: crInstructionsFilesPaths,
    redact_secrets: crRedact,
    answer_mode: crRawMode,
    scan_secrets: crScan,
    max_payload_kb: crMaxPayloadKb,
    redact_regex: crRedactRegexRaw,
    folder_path: crFolderPath,
    extensions: crExtensions,
    exclude_dirs: crExcludeDirs,
    use_gitignore: crUseGitignore,
    recursive: crRecursive,
    follow_symlinks: crFollowSymlinks,
    max_files: crMaxFiles,
  } = args as {
    input_files_paths: string | string[];
    instructions?: string;
    instructions_files_paths?: string | string[];
    redact_secrets?: boolean;
    answer_mode?: number;
    scan_secrets?: boolean;
    max_payload_kb?: number;
    redact_regex?: string;
    folder_path?: string;
    extensions?: string[];
    exclude_dirs?: string[];
    use_gitignore?: boolean;
    recursive?: boolean;
    follow_symlinks?: boolean;
    max_files?: number;
  };
  const crUseEnsemble = ensembleAllowed(backend, deps.activeResolved); // P8: one predicate (see ensembleAllowed)
  const crBudgetBytes = (crMaxPayloadKb ?? 400) * 1024;

  // No initial value: the catch below returns, so a null here was never read (no-useless-assignment flags it in this module).
  let crRegexRedact: RegexRedactOpts | null;
  try { crRegexRedact = parseRedactRegex(crRedactRegexRaw); }
  catch (err) { return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true }; }

  let crFilePathsAll = [...new Set(normalizePaths(crInputPathsRaw))];
  if (crFolderPath) {
    const folderResult = resolveFolderPath(crFolderPath, {
      extensions: crExtensions, excludeDirs: crExcludeDirs,
      useGitignore: crUseGitignore, recursive: crRecursive,
      followSymlinks: crFollowSymlinks, maxFiles: crMaxFiles,
    });
    if (folderResult.error && folderResult.files.length === 0 && crFilePathsAll.length === 0) {
      return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
    }
    crFilePathsAll = [...new Set([...crFilePathsAll, ...folderResult.files])];
  }
  if (crFilePathsAll.length === 0) {
    return {
      content: [
        { type: "text", text: "FAILED: input_files_paths or folder_path is required." },
      ],
      isError: true,
    };
  }

  // scan_secrets: abort if any secrets are found.
  // When redact_secrets is also true, skip the abort — downstream redaction handles it.
  if (crScan && !crRedact) {
    const crRealFiles = crFilePathsAll.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
    if (crRealFiles.length > 0) {
      const scanResult = scanFilesForSecrets(crRealFiles);
      if (scanResult.found)
        return {
          content: [{ type: "text", text: scanResult.report }],
          isError: true,
        };
    }
  }

  const crPrompt = resolvePrompt(
    crInstructions,
    crInstructionsFilesPaths,
  );
  const crMode = resolveAnswerMode(crRawMode, 0);

  // ── Group-aware processing ──
  // answer_mode=1 means "one report per group". If the caller did not
  // supply ---GROUP:id--- markers, auto-group files by heuristic so
  // the grouped-output path below can run unchanged.
  let crFileGroups = parseFileGroups(crFilePathsAll);
  let crEffectivelyGrouped = hasNamedGroups(crFileGroups);
  if (crMode === 1 && !crEffectivelyGrouped) {
    const autoGroups = autoGroupByHeuristic(crFilePathsAll);
    if (autoGroups.length > 0) {
      crFileGroups = autoGroups;
      crEffectivelyGrouped = true;
    }
  }

  if (crEffectivelyGrouped) {
    const crGroupReports: string[] = [];
    for (const fg of crFileGroups) {
      if (fg.files.length === 0) continue;
      const gid = fg.id || "auto";
      const gReports: string[] = [];
      for (const filePath of fg.files) {
        if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
        const src = readFileSync(filePath, "utf-8");
        const lang = detectLang(filePath);
        const deps = extractLocalImports(filePath, src);
        const depBlocks: string[] = [];
        for (const dp of deps) { try { depBlocks.push(readFileAsCodeBlock(dp, undefined, crRedact, crBudgetBytes, crRegexRedact)); } catch { /* skip */ } }
        const srcBlock = readFileAsCodeBlock(filePath, undefined, crRedact, crBudgetBytes, crRegexRedact);
        // P7 round 3 (M4): one request carries the source AND every dependency, so under a calibrated budget the total is capped.
        depBlocks.splice(0, depBlocks.length, ...capDependencyBlocks(filePath, srcBlock, depBlocks, crBudgetBytes));
        const msgs: ChatMessage[] = [
          { role: "system", content: `Expert ${lang} developer. Check the source file for broken or outdated references to functions, variables, constants, types, and classes. Cross-reference all symbols against the dependency files provided. Report each broken reference with: the symbol name, the function/class/method where it is used (never by line number), and what is wrong. Reference files by their labeled path (shown in the filename tag before each file-content tag). If all references are valid, say so.` + FILE_FORMAT_EXAMPLE + BREVITY_RULES },
          { role: "user", content: `${crPrompt ? crPrompt + "\n\n" : ""}Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n${depBlocks.length > 0 ? `## Local Dependencies (${deps.length} files)\n\n${depBlocks.join("\n\n")}` : "## No local dependencies resolved."}` },
        ];
        const resp = await ensembleStreaming(msgs, { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride }, crUseEnsemble, src.split("\n").length);
        const footer = formatFooter(resp, "check_references", filePath);
        // Shared response gate (TRDD-P4ULUV1R): an echoed reply (the
        // source file returned verbatim) is dropped like an empty one.
        if (gateLLMResponse(resp.content, String(msgs[1].content)) === null) {
          const depInfo = deps.length > 0 ? `\n\nDependencies checked: ${deps.map((p) => `\`${p}\``).join(", ")}` : "";
          gReports.push(`## File: ${filePath}${depInfo}\n\n${resp.content}${footer}`);
        }
      }
      if (gReports.length > 0) {
        const mergedPath = saveResponse(
          "check_references",
          gReports.join("\n\n---\n\n"),
          { model: backend.model, task: "Check references", inputFile: fg.files[0], groupId: gid },
          undefined,
          outputDir,
        );
        crGroupReports.push(`[group:${gid}] ${mergedPath}`);
      }
    }
    if (crGroupReports.length === 0) {
      return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
    }
    return { content: [{ type: "text", text: crGroupReports.join("\n") }] };
  }

  // Non-grouped: existing behavior
  const crFilePaths = crFilePathsAll;
  const crReports: string[] = [];
  const crReportPaths: string[] = [];

  for (const filePath of crFilePaths) {
    if (!existsSync(filePath)) {
      crReports.push(`## ${filePath}\n\nFAILED: File not found.`);
      crReportPaths.push("(skipped — file not found)");
      continue;
    }
    const crSourceCode = readFileSync(filePath, "utf-8");
    const crLang = detectLang(filePath);

    // Auto-resolve local imports and read dependency files
    const depPaths = extractLocalImports(filePath, crSourceCode);
    const depBlocks: string[] = [];
    for (const dp of depPaths) {
      try {
        depBlocks.push(readFileAsCodeBlock(dp, undefined, crRedact, crBudgetBytes, crRegexRedact));
      } catch {
        /* skip unreadable */
      }
    }

    const srcBlock = readFileAsCodeBlock(filePath, undefined, crRedact, crBudgetBytes, crRegexRedact);
    // P7 round 3 (M4): one request carries the source AND every dependency, so under a calibrated budget the total is capped.
    depBlocks.splice(0, depBlocks.length, ...capDependencyBlocks(filePath, srcBlock, depBlocks, crBudgetBytes));
    const crMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          `Expert ${crLang} developer. Check the source file for broken or outdated references to ` +
          "functions, variables, constants, types, and classes. Cross-reference all symbols against the " +
          "dependency files provided. Report each broken reference with: the symbol name, the function/class/method " +
          "where it is used (never by line number), and what is wrong (missing, renamed, wrong signature, deprecated). " +
          "Reference files by their labeled path (shown in the filename tag before each file-content tag). If all references are valid, say so." +
          FILE_FORMAT_EXAMPLE + BREVITY_RULES,
      },
      {
        role: "user",
        content:
          `${crPrompt ? crPrompt + "\n\n" : ""}` +
          `Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n` +
          (depBlocks.length > 0
            ? `## Local Dependencies (${depPaths.length} files)\n\n${depBlocks.join("\n\n")}`
            : "## No local dependencies resolved — check for external import issues."),
      },
    ];

    const crLineCount = crSourceCode.split("\n").length;
    const crResp = await ensembleStreaming(
      crMessages,
      {
        temperature: DEFAULT_TEMPERATURE,
        maxTokens: resolveDefaultMaxTokens(),
        onProgress,
        modelOverride,
      },
      crUseEnsemble,
      crLineCount,
    );
    const crFooter = formatFooter(crResp, "check_references", filePath);

    // Shared response gate (TRDD-P4ULUV1R): echo dropped like empty.
    if (gateLLMResponse(crResp.content, String(crMessages[1].content)) === null) {
      const depInfo =
        depPaths.length > 0
          ? `\n\nDependencies checked: ${depPaths.map((p) => `\`${p}\``).join(", ")}`
          : "";
      if (crMode === 0) {
        const rp = saveResponse(
          "check_references",
          crResp.content + crFooter + depInfo,
          { model: crResp.model, task: "Check references", inputFile: filePath },
          undefined,
          outputDir,
        );
        crReportPaths.push(rp);
      } else {
        crReports.push(
          `## File: ${filePath}${depInfo}\n\n${crResp.content}${crFooter}`,
        );
      }
    }
  }

  if (crMode === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            crReportPaths.length > 0
              ? crReportPaths.join("\n")
              : "FAILED: LLM returned empty response.",
        },
      ],
      isError: crReportPaths.length === 0,
    };
  }
  if (crReports.length === 0) {
    return {
      content: [
        { type: "text", text: "FAILED: LLM returned empty response." },
      ],
      isError: true,
    };
  }
  const crMergedPath = saveResponse(
    "check_references",
    crReports.join("\n\n---\n\n"),
    { model: backend.model, task: "Check references", inputFile: crFilePaths[0] },
    undefined,
    outputDir,
  );
  return { content: [{ type: "text", text: crMergedPath }] };
}
