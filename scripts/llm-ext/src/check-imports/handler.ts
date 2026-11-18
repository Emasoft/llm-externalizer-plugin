/**
 * check_imports tool handler: the body of index.ts's `case "check_imports"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { buildCheckImportsExtractMessages } from "../check-imports/prompt.js";
import { GROUP_HEADER_RE, GROUP_FOOTER_RE, parseFileGroups, hasNamedGroups, autoGroupByHeuristic } from "../grouping.js";
import { EXTRACT_PATHS_SCHEMA } from "../provider/completion.js";
import { type ChatMessage } from "../provider/types.js";
import { type RegexRedactOpts, parseRedactRegex, scanFilesForSecrets, resolvePrompt, resolveAnswerMode, detectLang, readFileAsCodeBlock, FILE_FORMAT_EXAMPLE } from "../scan-pipeline.js";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve, join, extname } from "node:path";
import type { CaseCall, CaseDeps, ToolResult } from "../tools/dispatch-deps.js";

export async function handleCheckImports(call: CaseCall, deps: Pick<CaseDeps, "chatCompletionJSONWithFreeRotation" | "logRequest" | "normalizePaths" | "recordUsage" | "resolveDefaultMaxTokens" | "resolveFolderPath" | "saveResponse">): Promise<ToolResult> {
  const { args, backend, onProgress, outputDir } = call;
  const { chatCompletionJSONWithFreeRotation, logRequest, normalizePaths, recordUsage, resolveDefaultMaxTokens, resolveFolderPath, saveResponse } = deps;
  const {
    input_files_paths: ciInputPathsRaw,
    project_root,
    instructions: ciInstructions,
    instructions_files_paths: ciInstructionsFilesPaths,
    redact_secrets: ciRedact,
    answer_mode: ciRawMode,
    scan_secrets: ciScan,
    max_payload_kb: ciMaxPayloadKb,
    redact_regex: ciRedactRegexRaw,
    folder_path: ciFolderPath,
    extensions: ciExtensions,
    exclude_dirs: ciExcludeDirs,
    use_gitignore: ciUseGitignore,
    recursive: ciRecursive,
    follow_symlinks: ciFollowSymlinks,
    max_files: ciMaxFiles,
  } = args as {
    input_files_paths: string | string[];
    project_root?: string;
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
  // check_imports uses chatCompletionJSON directly (not ensembleStreaming),
  // so the backend type is not referenced in this case body (other than
  // via the shared snapshot for the saveResponse() metadata).
  const ciBudgetBytes = (ciMaxPayloadKb ?? 400) * 1024;

  // No initial value: the catch below returns, so a null here was never read (no-useless-assignment flags it in this module).
  let ciRegexRedact: RegexRedactOpts | null;
  try { ciRegexRedact = parseRedactRegex(ciRedactRegexRaw); }
  catch (err) { return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true }; }

  let ciFilePathsAll = [...new Set(normalizePaths(ciInputPathsRaw))];
  if (ciFolderPath) {
    const folderResult = resolveFolderPath(ciFolderPath, {
      extensions: ciExtensions, excludeDirs: ciExcludeDirs,
      useGitignore: ciUseGitignore, recursive: ciRecursive,
      followSymlinks: ciFollowSymlinks, maxFiles: ciMaxFiles,
    });
    if (folderResult.error && folderResult.files.length === 0 && ciFilePathsAll.length === 0) {
      return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
    }
    ciFilePathsAll = [...new Set([...ciFilePathsAll, ...folderResult.files])];
  }
  if (ciFilePathsAll.length === 0) {
    return {
      content: [
        { type: "text", text: "FAILED: input_files_paths or folder_path is required." },
      ],
      isError: true,
    };
  }

  // scan_secrets: abort if any secrets are found.
  // When redact_secrets is also true, skip the abort — downstream redaction handles it.
  if (ciScan && !ciRedact) {
    const ciRealFiles = ciFilePathsAll.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
    if (ciRealFiles.length > 0) {
      const scanResult = scanFilesForSecrets(ciRealFiles);
      if (scanResult.found)
        return {
          content: [{ type: "text", text: scanResult.report }],
          isError: true,
        };
    }
  }

  const ciPrompt = resolvePrompt(
    ciInstructions,
    ciInstructionsFilesPaths,
  );
  const ciMode = resolveAnswerMode(ciRawMode, 0);

  // ── Group-aware processing ──
  // answer_mode=1 means "one report per group". Auto-group the files
  // when the caller did not supply ---GROUP:id--- markers.
  let ciFileGroups = parseFileGroups(ciFilePathsAll);
  let ciEffectivelyGrouped = hasNamedGroups(ciFileGroups);
  if (ciMode === 1 && !ciEffectivelyGrouped) {
    const autoGroups = autoGroupByHeuristic(ciFilePathsAll);
    if (autoGroups.length > 0) {
      ciFileGroups = autoGroups;
      ciEffectivelyGrouped = true;
    }
  }
  if (ciEffectivelyGrouped) {
    const ciGroupReports: string[] = [];
    for (const fg of ciFileGroups) {
      if (fg.files.length === 0) continue;
      const gid = fg.id || "auto";
      const gReports: string[] = [];
      for (const filePath of fg.files) {
        if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
        const ciLang = detectLang(filePath);
        const fileDir = dirname(filePath);
        const ciResolveBase = project_root || fileDir;
        // Prompt built by the SHARED seam (TRDD-f45eeaa0). It used to be
        // inline here AND on the ungrouped path below — two copies of one
        // prompt, which drift the day one is edited. The benchmark drives
        // this same function, so it scores the real tool.
        const extractMessages: ChatMessage[] = buildCheckImportsExtractMessages({
          lang: ciLang,
          userPrompt: ciPrompt,
          fileBlock: readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact),
          fileFormatExample: FILE_FORMAT_EXAMPLE,
        });
        const extractResp = await chatCompletionJSONWithFreeRotation(extractMessages, { temperature: 0, maxTokens: resolveDefaultMaxTokens(), jsonSchema: EXTRACT_PATHS_SCHEMA, onProgress });
        recordUsage(extractResp.usage);
        logRequest({ tool: "check_imports", model: extractResp.model, status: "success", usage: extractResp.usage, filePath });
        const rawPaths = extractResp.parsed.paths;
        const extractedPaths: string[] = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === "string") : [];
        const validPaths: string[] = []; const brokenPaths: string[] = []; const packageImports: string[] = [];
        for (const importPath of extractedPaths) {
          if (!importPath.startsWith(".") && !importPath.startsWith("/")) { packageImports.push(importPath); continue; }
          const resolveDir = importPath.startsWith(".") ? fileDir : ciResolveBase;
          const resolvedBase = importPath.startsWith("/") ? resolve(importPath) : join(resolveDir, importPath);
          if (!resolvedBase.startsWith(ciResolveBase) && !resolvedBase.startsWith(fileDir)) { packageImports.push(importPath); continue; }
          let found = existsSync(resolvedBase) && statSync(resolvedBase).isFile();
          if (!found && !extname(resolvedBase)) {
            for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".json"]) { if (existsSync(resolvedBase + ext)) { found = true; break; } }
            if (!found) { for (const ext of [".ts", ".tsx", ".js", ".jsx"]) { if (existsSync(join(resolvedBase, `index${ext}`))) { found = true; break; } } }
          }
          (found ? validPaths : brokenPaths).push(importPath);
        }
        const lines = [`# Import Check: ${filePath}`, "", `**Total**: ${extractedPaths.length}, **Valid**: ${validPaths.length}, **BROKEN**: ${brokenPaths.length}, **Packages**: ${packageImports.length}`, ""];
        if (brokenPaths.length > 0) lines.push("## BROKEN IMPORTS", "", ...brokenPaths.map((p) => `- \`${p}\``), "");
        if (validPaths.length > 0) lines.push("## Valid", "", ...validPaths.map((p) => `- \`${p}\``), "");
        gReports.push(lines.join("\n"));
      }
      if (gReports.length > 0) {
        const mergedPath = saveResponse(
          "check_imports",
          gReports.join("\n\n---\n\n"),
          { model: backend.model, task: "Check imports", inputFile: fg.files[0], groupId: gid },
          undefined,
          outputDir,
        );
        ciGroupReports.push(`[group:${gid}] ${mergedPath}`);
      }
    }
    if (ciGroupReports.length === 0) {
      return { content: [{ type: "text", text: "No reports generated." }], isError: true };
    }
    return { content: [{ type: "text", text: ciGroupReports.join("\n") }] };
  }

  // Non-grouped: existing behavior
  const ciFilePaths = ciFilePathsAll;
  const ciReports: string[] = [];
  const ciReportPaths: string[] = [];

  for (const filePath of ciFilePaths) {
    if (!existsSync(filePath)) {
      ciReports.push(`## ${filePath}\n\nFAILED: File not found.`);
      ciReportPaths.push("(skipped — file not found)");
      continue;
    }
    const ciLang = detectLang(filePath);
    const fileDir = dirname(filePath);
    // Use project_root for resolving imports if provided, fall back to file's directory
    const ciResolveBase = project_root || fileDir;

    // Phase 1: Ask LLM to extract all file/import references
    const extractMessages: ChatMessage[] = buildCheckImportsExtractMessages({
      lang: ciLang,
      userPrompt: ciPrompt,
      fileBlock: readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact),
      fileFormatExample: FILE_FORMAT_EXAMPLE,
    });

    const extractResp = await chatCompletionJSONWithFreeRotation(
      extractMessages,
      {
        temperature: 0,
        maxTokens: resolveDefaultMaxTokens(),
        jsonSchema: EXTRACT_PATHS_SCHEMA,
        onProgress,
      },
    );
    recordUsage(extractResp.usage);
    logRequest({
      tool: "check_imports",
      model: extractResp.model,
      status: "success",
      usage: extractResp.usage,
      filePath,
    });

    const rawPaths = extractResp.parsed.paths;
    const extractedPaths: string[] = Array.isArray(rawPaths)
      ? rawPaths.filter((p): p is string => typeof p === "string")
      : [];

    // Phase 2: Validate each path on disk
    const validPaths: string[] = [];
    const brokenPaths: string[] = [];
    const packageImports: string[] = [];

    for (const importPath of extractedPaths) {
      // Skip package/module imports (not relative paths)
      if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
        packageImports.push(importPath);
        continue;
      }
      // Dot-relative imports (./foo, ../bar) resolve against the file's own directory,
      // NOT project_root. Only absolute paths use ciResolveBase.
      const resolveDir = importPath.startsWith(".")
        ? fileDir
        : ciResolveBase;
      const resolvedBase = importPath.startsWith("/")
        ? resolve(importPath)
        : join(resolveDir, importPath);
      // Reject paths resolving outside allowed project directories to prevent filesystem oracle attacks.
      if (!resolvedBase.startsWith(ciResolveBase) && !resolvedBase.startsWith(fileDir)) {
        packageImports.push(importPath);
        continue;
      }
      let found = false;

      if (existsSync(resolvedBase) && statSync(resolvedBase).isFile()) {
        found = true;
      }
      if (!found && !extname(resolvedBase)) {
        for (const ext of [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".py",
          ".go",
          ".rs",
          ".json",
        ]) {
          if (existsSync(resolvedBase + ext)) {
            found = true;
            break;
          }
        }
        if (!found) {
          for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
            if (existsSync(join(resolvedBase, `index${ext}`))) {
              found = true;
              break;
            }
          }
        }
      }

      if (found) {
        validPaths.push(importPath);
      } else {
        brokenPaths.push(importPath);
      }
    }

    // Build report
    const ciReportLines: string[] = [
      `# Import Check: ${filePath}`,
      "",
      `**Total references extracted**: ${extractedPaths.length}`,
      `**Local valid**: ${validPaths.length}`,
      `**Local BROKEN**: ${brokenPaths.length}`,
      `**Package imports** (not checked): ${packageImports.length}`,
      "",
    ];
    if (brokenPaths.length > 0) {
      ciReportLines.push(
        "## BROKEN IMPORTS",
        "",
        ...brokenPaths.map((p) => `- \`${p}\``),
        "",
      );
    }
    if (validPaths.length > 0) {
      ciReportLines.push(
        "## Valid Imports",
        "",
        ...validPaths.map((p) => `- \`${p}\``),
        "",
      );
    }
    if (packageImports.length > 0) {
      ciReportLines.push(
        "## Package Imports (not checked)",
        "",
        ...packageImports.map((p) => `- \`${p}\``),
        "",
      );
    }

    const ciReportText = ciReportLines.join("\n");
    if (ciMode === 0) {
      const rp = saveResponse(
        "check_imports",
        ciReportText,
        { model: extractResp.model, task: "Check imports", inputFile: filePath },
        undefined,
        outputDir,
      );
      ciReportPaths.push(rp);
    } else {
      ciReports.push(ciReportText);
    }
  }

  if (ciMode === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            ciReportPaths.length > 0
              ? ciReportPaths.join("\n")
              : "No reports generated.",
        },
      ],
    };
  }
  if (ciReports.length === 0) {
    return {
      content: [{ type: "text", text: "No reports generated." }],
      isError: true,
    };
  }
  const ciMergedPath = saveResponse(
    "check_imports",
    ciReports.join("\n\n---\n\n"),
    { model: backend.model, task: "Check imports", inputFile: ciFilePaths[0] },
    undefined,
    outputDir,
  );
  return { content: [{ type: "text", text: ciMergedPath }] };
}
