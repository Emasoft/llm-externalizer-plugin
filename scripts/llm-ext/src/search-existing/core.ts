/**
 * search-existing/core.ts — the importable search_existing_implementations
 * pipeline, extracted verbatim from index.ts's case body so it can run
 * in-process (e.g. from the benchmark runner) without the MCP server's
 * top-level main() side effects.
 *
 * The pipeline itself is mechanically unchanged. Every dependency that used
 * to be an index.ts-scoped binding (the model call, error classifier, report
 * writer, ensemble-label/onProgress/outputDir) is injected via SeiDeps, so
 * the caller controls the backend and persistence.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  sanitizeInputPath,
  parseRedactRegex,
  resolvePrompt,
  walkDir,
  scanFilesForSecrets,
  readAndGroupFiles,
  resolveAnswerMode,
  buildPerFileSectionPrompt,
  type RegexRedactOpts,
} from "../scan-pipeline.js";
import { splitPerFileSections, autoGroupByHeuristic } from "../grouping.js";

export type SeiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SeiToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface SeiDeps {
  useEnsemble: boolean;
  backendModel: string;
  callModel: (
    messages: SeiChatMessage[],
  ) => Promise<{ content?: string | null; model?: string | null }>;
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
  ensembleModelLabel: (useEnsemble: boolean) => string;
  onProgress?: (current: number, total: number, message: string) => void;
  outputDir?: string;
}

export async function runSearchExistingImplementations(
  args: Record<string, unknown>,
  deps: SeiDeps,
): Promise<SeiToolResult> {
        const {
          feature_description,
          folder_path: seiFolderPathRaw,
          source_files: seiSourceFilesRaw,
          diff_path: seiDiffPathRaw,
          extensions: seiExtensions,
          exclude_dirs: seiExcludeDirs,
          max_files: seiMaxFiles,
          redact_secrets: seiRedact,
          redact_regex: seiRedactRegexRaw,
          answer_mode: seiRawMode,
          use_gitignore: seiUseGitignore,
          scan_secrets: seiScan,
        } = args as {
          feature_description?: string;
          folder_path?: string | string[];
          source_files?: string | string[];
          diff_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          max_files?: number;
          redact_secrets?: boolean;
          redact_regex?: string;
          answer_mode?: number;
          use_gitignore?: boolean;
          scan_secrets?: boolean;
          max_payload_kb?: number;
        };
        const seiUseEnsemble = deps.useEnsemble;
        const seiBudgetBytes = ((args as { max_payload_kb?: number }).max_payload_kb ?? 400) * 1024;

        // Validate feature_description — mandatory
        if (typeof feature_description !== "string" || !feature_description.trim()) {
          return {
            content: [{ type: "text", text: "FAILED: feature_description is required (non-empty string)." }],
            isError: true,
          };
        }

        // Normalize folder_path to an array and validate each entry
        const folderPathsRaw: string[] = Array.isArray(seiFolderPathRaw)
          ? seiFolderPathRaw.filter((p) => typeof p === "string" && p.trim())
          : (typeof seiFolderPathRaw === "string" && seiFolderPathRaw.trim() ? [seiFolderPathRaw] : []);
        if (folderPathsRaw.length === 0) {
          return {
            content: [{ type: "text", text: "FAILED: folder_path is required (string or array of strings)." }],
            isError: true,
          };
        }
        // C1+H2: Sanitize each folder_path entry (traversal + symlink protection)
        const folderPaths: string[] = [];
        for (const fpRaw of folderPathsRaw) {
          let fp: string;
          try {
            fp = sanitizeInputPath(fpRaw);
          } catch (err) {
            return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
          }
          if (!existsSync(fp)) {
            return { content: [{ type: "text", text: `FAILED: Folder not found: ${fpRaw}` }], isError: true };
          }
          if (!statSync(fp).isDirectory()) {
            return { content: [{ type: "text", text: `FAILED: Not a directory: ${fpRaw}` }], isError: true };
          }
          folderPaths.push(fp);
        }

        // Normalize source_files (optional). Collect both the user-supplied
        // path AND the canonical (realpath-resolved) path so the later exclude
        // step can match files that walkDir may reach via a symlinked parent
        // directory. Without canonicalization, a source file reachable via
        // /pr/repo/src/retry.py but walked via /scan/link-to-repo/src/retry.py
        // would appear in the scan target list and produce a spurious
        // self-match in the LLM output.
        const sourceFiles: string[] = [];
        const sourceFilesCanonical = new Set<string>();
        if (seiSourceFilesRaw !== undefined && seiSourceFilesRaw !== null) {
          const raw = Array.isArray(seiSourceFilesRaw) ? seiSourceFilesRaw : [seiSourceFilesRaw];
          for (const sf of raw) {
            if (typeof sf !== "string" || !sf.trim()) continue;
            const resolved = resolve(sf);
            if (!existsSync(resolved)) {
              return {
                content: [{ type: "text", text: `FAILED: source_files entry not found: ${sf}` }],
                isError: true,
              };
            }
            sourceFiles.push(resolved);
            sourceFilesCanonical.add(resolved);
            try {
              sourceFilesCanonical.add(realpathSync(resolved));
            } catch {
              // realpath can fail on broken symlinks or permission errors — the
              // non-canonical resolve() path is already in the set, so the
              // exclude still works for the common (no symlink) case.
            }
          }
        }

        // Normalize diff_path (optional)
        let diffPathResolved: string | undefined = undefined;
        if (typeof seiDiffPathRaw === "string" && seiDiffPathRaw.trim()) {
          const r = resolve(seiDiffPathRaw);
          if (!existsSync(r)) {
            return {
              content: [{ type: "text", text: `FAILED: diff_path not found: ${seiDiffPathRaw}` }],
              isError: true,
            };
          }
          diffPathResolved = r;
        }

        // Auto-detect extensions from source_files if not explicitly supplied
        let seiEffectiveExts = seiExtensions;
        if ((!seiEffectiveExts || seiEffectiveExts.length === 0) && sourceFiles.length > 0) {
          const extSet = new Set<string>();
          for (const sf of sourceFiles) {
            const m = /\.[^./\\]+$/.exec(sf);
            if (m) extSet.add(m[0]);
          }
          if (extSet.size > 0) seiEffectiveExts = Array.from(extSet);
        }

        // Validate redact_regex. No initializer: the catch returns, so the
        // try's assignment is the only path forward (no-useless-assignment).
        let seiRegexRedact: RegexRedactOpts | null;
        try {
          seiRegexRedact = parseRedactRegex(seiRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // Build the specialized multi-file yes/no instructions.
        //
        // Key design notes:
        // 1. The instructions describe a MULTI-FILE review — the LLM sees a
        //    batch of files and outputs a section per file. This is what
        //    enables FFD bin-packing to scale to 10k+ codebase files with
        //    ~2-3 orders of magnitude fewer LLM calls than the per-file path.
        // 2. The reference source files and diff are passed separately via
        //    instructions_files_paths — the server's resolvePrompt helper
        //    reads them once and appends to each batch prompt, so the
        //    orchestrator never loads source file contents.
        // 3. Output is EXHAUSTIVE — no match cap. The reviewer may want to
        //    delete every existing copy and leave only the PR's new one, so
        //    we must report every occurrence.
        const descTrimmed = feature_description.trim();
        const hasRef = sourceFiles.length > 0 || !!diffPathResolved;
        const refBlock = hasRef
          ? "The reference implementation from the PR is appended to these instructions as " +
            (sourceFiles.length > 0
              ? "one or more source files"
              : "context") +
            (diffPathResolved
              ? ", followed by a unified diff showing the EXACT new lines (prefixed with '+'). " +
                "Focus on the new lines when reasoning about what the PR adds. "
              : ". ") +
            "The source files may contain many unrelated functions — only the one matching " +
            "the description above is relevant.\n\n"
          : "No reference source files were provided — rely purely on the feature description " +
            "above when reasoning about semantic equivalence.\n\n";
        const seiBasePrompt =
          "You are checking every file in this batch for an existing implementation of " +
          "this feature (or a helper that could be trivially composed to achieve it):\n\n" +
          `    ${descTrimmed}\n\n` +
          refBlock +
          "For EACH file in the batch, answer SEMANTIC equivalence: the same goal achieved " +
          "by different code still counts. Ignore naming differences and surface-level style.\n\n" +
          "Output format: each file gets its own section in the response, separated by '---'. " +
          "Per-file answer is one line per finding, no preamble, no explanation.\n\n" +
          "Section template:\n\n" +
          "## File: <absolute-file-path>\n\n" +
          "<one line per finding>\n\n" +
          "---\n\n" +
          "Per-finding line format:\n" +
          "    NO\n" +
          "  or\n" +
          "    YES symbol=<function-or-class-name> lines=<start-end>\n\n" +
          "EXHAUSTIVE: If a file contains MULTIPLE matches, output ALL of them as successive " +
          "YES lines. Do NOT cap the count. Do NOT keep only the most relevant. The reviewer " +
          "may want to delete EVERY existing copy and leave only the PR's new one, so every " +
          "occurrence MUST be listed.\n\n" +
          "Special case: if a file IS the reference (you recognize the PR code itself), " +
          "output:\n    NO (self-reference)\n\n" +
          "Produce exactly one section per input file, in the order they appear in the batch, " +
          "separated by '---'. Do NOT merge sections. Do NOT write rationale. Do NOT quote " +
          "code. Do NOT explain. One line per match per file. Nothing else.";

        // Ship source files + diff as reference context via resolvePrompt.
        // resolvePrompt reads and concatenates the referenced files onto the
        // base instructions string — the resulting seiBasePromptWithRef is
        // what every batch sees.
        const seiInstrFiles: string[] = [...sourceFiles];
        if (diffPathResolved) seiInstrFiles.push(diffPathResolved);
        const seiBasePromptWithRef = resolvePrompt(
          seiBasePrompt,
          seiInstrFiles.length > 0 ? seiInstrFiles : undefined,
        );
        if (!seiBasePromptWithRef.trim()) {
          return {
            content: [{ type: "text", text: "FAILED: specialized prompt came out empty (internal error)." }],
            isError: true,
          };
        }

        // Walk all folder_path entries, combine, dedupe, then exclude source_files
        // so the reference files are never scanned against themselves.
        // Default max_files is 10000 here (higher than scan_folder's 2500) because
        // this tool is designed for massive codebase reviews — with FFD batching
        // at 400 KB each, 10k files typically collapse into ~500 LLM calls.
        const fileSet = new Set<string>();
        const seiMaxFilesEffective = seiMaxFiles ?? 10000;
        for (const fp of folderPaths) {
          const walked = walkDir(fp, {
            extensions: seiEffectiveExts,
            maxFiles: seiMaxFilesEffective,
            exclude: seiExcludeDirs,
            useGitignore: seiUseGitignore !== false, // default true
          });
          for (const f of walked) fileSet.add(f);
        }
        // Exclude source files. Try both the non-canonical path (matches when
        // walkDir pushes the same display path) AND the realpath-canonicalized
        // path (catches symlinked-parent cases where walkDir reaches the same
        // file via a different display name). This is the fix for the self-
        // match leak: walkDir currently pushes display paths but does realpath
        // only for cycle detection, so a single scan could otherwise see the
        // reference files under both names and the naive delete-by-resolve()
        // path would miss the symlink variant.
        for (const walked of Array.from(fileSet)) {
          if (sourceFilesCanonical.has(walked)) {
            fileSet.delete(walked);
            continue;
          }
          try {
            const canonical = realpathSync(walked);
            if (sourceFilesCanonical.has(canonical)) {
              fileSet.delete(walked);
            }
          } catch {
            // If realpath fails on a walked path, leave it in — we'd rather
            // include it and accept a possible false self-match than drop a
            // file entirely due to a transient permission error.
          }
        }

        const files = Array.from(fileSet);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No matching files found after filtering. Folders: ${folderPaths.join(", ")}` +
                  (seiEffectiveExts?.length ? `; extensions: ${seiEffectiveExts.join(", ")}` : "") +
                  (sourceFiles.length ? `; excluded source_files: ${sourceFiles.length}` : ""),
              },
            ],
          };
        }
        if (files.length > seiMaxFilesEffective) {
          return {
            content: [
              {
                type: "text",
                text:
                  `FAILED: ${files.length} files matched, exceeding max_files=${seiMaxFilesEffective}. ` +
                  `Narrow folder_path, pass extensions, or raise max_files.`,
              },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found in discovered files.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (seiScan && !seiRedact) {
          const scanResult = scanFilesForSecrets(files);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        // ── FFD bin-packed batched scan ────────────────────────────────
        // Always batched, regardless of answer_mode. Per-file processing
        // for this tool would mean 10k LLM calls for a 10k codebase — not
        // viable. FFD packs files up to budgetBytes per batch; each batch
        // becomes one ensembleStreaming call, and the LLM emits per-file
        // sections in the response.
        const seiSystemMessage =
          "You are a code reviewer checking for duplicate implementations. " +
          "Output per-file NO/YES answers in the exact format specified in the user " +
          "prompt. Be terse — no rationale, no code quotes, no explanation. Identify " +
          "matches by function/class/method NAME, never by line number in prose.";
        const seiSystemBytes = Buffer.byteLength(seiSystemMessage, "utf-8");
        const seiBaseBytes = Buffer.byteLength(seiBasePromptWithRef, "utf-8");
        const seiPromptBytes = seiSystemBytes + seiBaseBytes + 2048; // +2k headroom for per-file-section hint, markers, etc.

        const { groups: seiGroups, autoBatched: seiAutoBatched, skipped: seiSkipped } =
          readAndGroupFiles(files, seiPromptBytes, seiRedact, seiBudgetBytes, seiRegexRedact);

        if (seiGroups.length === 0) {
          const reasons: string[] = [];
          if (seiSkipped.length > 0) {
            reasons.push(
              `${seiSkipped.length} file(s) exceeded the payload budget and were skipped`,
            );
          } else {
            reasons.push("no files fit within the payload budget");
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `FAILED: no batches could be formed. ${reasons.join("; ")}. ` +
                  `Raise max_payload_kb (current: ${Math.round(seiBudgetBytes / 1024)} KB) ` +
                  `or narrow folder_path to smaller files.`,
              },
            ],
            isError: true,
          };
        }

        const seiMode = resolveAnswerMode(seiRawMode, 2); // default: single merged report
        const seiBatchId = randomUUID();
        const seiBatchResponses: { idx: number; filePaths: string[]; content: string; model: string; error?: string }[] = [];
        let seiAborted = false;
        let seiAbortReason = "";

        for (let gi = 0; gi < seiGroups.length; gi++) {
          if (seiAborted) break;
          const group = seiGroups[gi];
          const groupPaths = group.map((fd) => fd.path);

          // Build the user message: base prompt + per-file section marker +
          // each file's fenced code block (already produced by readAndGroupFiles)
          let userContent = seiBasePromptWithRef;
          userContent += buildPerFileSectionPrompt(groupPaths);
          for (const fd of group) {
            userContent += `\n\n${fd.block}`;
          }

          const messages: SeiChatMessage[] = [
            { role: "system", content: seiSystemMessage },
            { role: "user", content: userContent },
          ];

          try {
            const resp = await deps.callModel(messages);
            seiBatchResponses.push({
              idx: gi,
              filePaths: groupPaths,
              content: resp.content ?? "",
              model: resp.model ?? deps.backendModel,
            });
            if (deps.onProgress) {
              deps.onProgress(
                gi + 1,
                seiGroups.length,
                `search_existing_implementations: batch ${gi + 1}/${seiGroups.length} done (${groupPaths.length} files)`,
              );
            }
          } catch (err) {
            const classified = deps.classifyError(err);
            seiBatchResponses.push({
              idx: gi,
              filePaths: groupPaths,
              content: "",
              model: deps.backendModel,
              error: classified.reason,
            });
            if (classified.unrecoverable && classified.serviceLevel) {
              seiAborted = true;
              seiAbortReason = `Unrecoverable: ${classified.reason}`;
            }
          }
        }

        const seiBatchOk = seiBatchResponses.filter((r) => !r.error && r.content.trim().length > 0);
        const seiBatchFailed = seiBatchResponses.filter((r) => r.error || !r.content.trim());

        // Catch zero-success before either output branch runs, so an all-
        // batches-failed run always returns isError: true. The earlier code
        // path silently skipped the mode-2 branch and fell through to the
        // mode-1 branch, which emitted "SEARCH COMPLETE — 0/N batches
        // processed" with isError: false if none of the failures were
        // service-level — a silent no-op that looked like success.
        if (seiBatchOk.length === 0) {
          const reason = seiAborted
            ? seiAbortReason
            : seiBatchFailed.length > 0
              ? `all ${seiBatchFailed.length} batch(es) failed or returned empty: ${seiBatchFailed[0].error ?? "empty response"}`
              : "no batches produced output";
          const failLines: string[] = [
            `FAILED: search_existing_implementations produced zero usable output (${seiBatchOk.length}/${seiGroups.length} batches succeeded, ${files.length} files discovered)`,
            `Reason: ${reason}`,
            `Folders: ${folderPaths.join(", ")}`,
            sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
            diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
            `Batch UUID: ${seiBatchId}`,
          ];
          if (seiBatchFailed.length > 0) {
            failLines.push("", "PER-BATCH FAILURES:");
            for (const r of seiBatchFailed) {
              failLines.push(
                `  Batch ${r.idx + 1}/${seiGroups.length} (${r.filePaths.length} files): ${r.error ?? "empty response"}`,
              );
            }
          }
          if (seiSkipped.length > 0) {
            failLines.push("", `SKIPPED (exceeded payload budget, ${seiSkipped.length}):`);
            for (const s of seiSkipped) failLines.push(`  ${s}`);
          }
          return {
            content: [{ type: "text", text: failLines.join("\n") }],
            isError: true,
          };
        }

        // Build output per answer_mode:
        //   mode 2 (default) — SINGLE REPORT: one merged .md with all batches
        //                      appended in per-batch sections.
        //   mode 0           — ONE REPORT PER FILE: splits each batch response
        //                      by `## File: <path>` markers and writes one .md
        //                      per input file. Batching is unchanged.
        //   mode 1           — ONE REPORT PER GROUP: auto-groups files via
        //                      autoGroupByHeuristic (subfolder/ext/basename)
        //                      and writes one merged .md per auto-group.
        if (seiMode === 2) {
          const sections: string[] = [];
          sections.push(`# LLM Externalizer — search_existing_implementations`);
          sections.push("");
          sections.push(`**Feature**: ${descTrimmed}`);
          sections.push(`**Folders**: ${folderPaths.join(", ")}`);
          sections.push(`**Files scanned**: ${files.length}`);
          sections.push(`**Batches**: ${seiGroups.length} (FFD bin-packed, ${seiAutoBatched ? "auto-batched" : "single batch"})`);
          if (sourceFiles.length > 0) sections.push(`**Reference source files**: ${sourceFiles.length}`);
          if (diffPathResolved) sections.push(`**Diff**: ${diffPathResolved}`);
          if (seiSkipped.length > 0) {
            sections.push("");
            sections.push(`**SKIPPED** (exceeded payload budget): ${seiSkipped.length}`);
            for (const s of seiSkipped) sections.push(`  - ${s}`);
          }
          sections.push("");
          for (const r of seiBatchOk) {
            sections.push(`---\n\n## Batch ${r.idx + 1}/${seiGroups.length} — ${r.filePaths.length} files`);
            sections.push("");
            sections.push(r.content.trim());
            sections.push("");
          }
          if (seiBatchFailed.length > 0) {
            sections.push("---\n\n## FAILED BATCHES");
            sections.push("");
            for (const r of seiBatchFailed) {
              sections.push(`### Batch ${r.idx + 1}/${seiGroups.length} — ${r.filePaths.length} files`);
              sections.push(`Error: ${r.error ?? "empty response"}`);
              sections.push("Files:");
              for (const fp of r.filePaths) sections.push(`  - ${fp}`);
              sections.push("");
            }
          }
          const mergedPath = deps.saveResponse(
            "search_existing_implementations",
            sections.join("\n"),
            {
              model: deps.ensembleModelLabel(seiUseEnsemble),
              task: descTrimmed,
              inputFile: folderPaths[0],
            },
            undefined,
            deps.outputDir,
          );
          const summary = [
            `SEARCH COMPLETE — ${seiBatchOk.length}/${seiGroups.length} batches processed, ${files.length} files scanned, ${seiSkipped.length} skipped`,
            `Folders: ${folderPaths.join(", ")}`,
            sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
            diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
            `Batch UUID: ${seiBatchId}`,
            `MERGED REPORT: ${mergedPath}`,
          ];
          if (seiBatchFailed.length > 0) {
            summary.push("", `FAILED BATCHES: ${seiBatchFailed.length} (see merged report for details)`);
          }
          if (seiAborted) summary.push("", `ABORTED: ${seiAbortReason}`);
          return {
            content: [{ type: "text", text: summary.join("\n") }],
            isError: seiAborted,
          };
        }

        // Mode 0 — split each batch's LLM response by `## File: <path>` markers
        // and save ONE report per input file. The prompt (via
        // buildPerFileSectionPrompt) already asks the LLM for this structure,
        // so we just parse, map each section back to its input path, and write
        // independent .md reports. Output is a list of `<input> -> <report>`
        // pairs so the orchestrator can navigate back to the file it asked
        // about. This is the user's mental model of "per-file reports": the
        // LLM still sees 1–5 files per batch (batching is unchanged), but
        // the persistence layer splits each batch response per file.
        if (seiMode === 0) {
          const seiPerFileReports: { inputPath: string; reportPath: string }[] = [];
          const seiPerFileMissing: { inputPath: string; batchIdx: number }[] = [];
          for (const r of seiBatchOk) {
            const sections = splitPerFileSections(r.content, r.filePaths);
            for (const fp of r.filePaths) {
              const body = sections.get(fp);
              if (!body || !body.trim()) {
                seiPerFileMissing.push({ inputPath: fp, batchIdx: r.idx });
                continue;
              }
              const header =
                `# search_existing_implementations — ${fp}\n\n` +
                `**Feature**: ${descTrimmed}\n` +
                `**Source file**: ${fp}\n` +
                `**Batch**: ${r.idx + 1}/${seiGroups.length}\n` +
                `**Model**: ${r.model}\n\n---\n\n`;
              const reportPath = deps.saveResponse(
                "search_existing_implementations",
                header + body.trim(),
                {
                  model: r.model,
                  task: descTrimmed,
                  inputFile: fp,
                },
                undefined,
                deps.outputDir,
              );
              seiPerFileReports.push({ inputPath: fp, reportPath });
            }
          }
          const seiModeZeroLines = [
            `SEARCH COMPLETE — ${seiBatchOk.length}/${seiGroups.length} batches processed, ${files.length} files scanned, ${seiSkipped.length} skipped`,
            `Folders: ${folderPaths.join(", ")}`,
            sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
            diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
            `Batch UUID: ${seiBatchId}`,
            "",
          ];
          if (seiPerFileReports.length > 0) {
            seiModeZeroLines.push(`REPORTS (one per input file, ${seiPerFileReports.length} total):`);
            for (const p of seiPerFileReports) {
              seiModeZeroLines.push(`  ${p.inputPath} -> ${p.reportPath}`);
            }
          }
          if (seiPerFileMissing.length > 0) {
            seiModeZeroLines.push(
              "",
              `MISSING SECTIONS (${seiPerFileMissing.length} files had no per-file section in the LLM response — raw batch content preserved in batch reports):`,
            );
            for (const m of seiPerFileMissing) {
              seiModeZeroLines.push(`  ${m.inputPath} (batch ${m.batchIdx + 1}/${seiGroups.length})`);
            }
          }
          if (seiSkipped.length > 0) {
            seiModeZeroLines.push("", `SKIPPED (exceeded payload budget, ${seiSkipped.length}):`);
            for (const s of seiSkipped) seiModeZeroLines.push(`  ${s}`);
          }
          if (seiBatchFailed.length > 0) {
            seiModeZeroLines.push("", `FAILED BATCHES (${seiBatchFailed.length}):`);
            for (const r of seiBatchFailed) {
              seiModeZeroLines.push(
                `  Batch ${r.idx + 1}/${seiGroups.length} (${r.filePaths.length} files): ${r.error ?? "empty response"}`,
              );
            }
          }
          if (seiAborted) seiModeZeroLines.push("", `ABORTED: ${seiAbortReason}`);
          return {
            content: [{ type: "text", text: seiModeZeroLines.join("\n") }],
            isError: seiAborted,
          };
        }

        // Mode 1: one report per auto-group.
        // We already have per-file sections produced by splitPerFileSections
        // (via buildPerFileSectionPrompt). The auto-grouper clusters files by
        // subfolder/extension/basename, then for each group we collect the
        // sections belonging to its files and write one merged report per
        // group. A single merged report per group keeps related findings
        // together without exploding to N files.
        const seiAutoGroups = autoGroupByHeuristic(files);
        // Index every per-file section across batches by file path so group
        // assembly is O(n) instead of O(n*batches).
        const seiSectionByPath = new Map<string, string>();
        const seiModelByPath = new Map<string, string>();
        const seiBatchIdxByPath = new Map<string, number>();
        for (const r of seiBatchOk) {
          const sections = splitPerFileSections(r.content, r.filePaths);
          for (const fp of r.filePaths) {
            const body = sections.get(fp);
            if (body && body.trim().length > 0) {
              seiSectionByPath.set(fp, body.trim());
              seiModelByPath.set(fp, r.model);
              seiBatchIdxByPath.set(fp, r.idx);
            }
          }
        }
        const seiGroupReportPaths: string[] = [];
        const seiGroupMissing: string[] = [];
        for (const fg of seiAutoGroups) {
          if (fg.files.length === 0) continue;
          const gid = fg.id || "auto";
          const sections: string[] = [];
          sections.push(
            `# search_existing_implementations — group ${gid}\n\n` +
              `**Feature**: ${descTrimmed}\n` +
              `**Files in group**: ${fg.files.length}\n\n` +
              fg.files.map((fp) => `  - ${fp}`).join("\n") +
              "\n\n---\n",
          );
          let anyBody = false;
          for (const fp of fg.files) {
            const body = seiSectionByPath.get(fp);
            if (!body) {
              seiGroupMissing.push(fp);
              continue;
            }
            anyBody = true;
            sections.push(`## File: ${fp}\n\n${body}\n`);
          }
          if (!anyBody) continue;
          const reportPath = deps.saveResponse(
            "search_existing_implementations",
            sections.join("\n"),
            {
              model: deps.ensembleModelLabel(seiUseEnsemble),
              task: descTrimmed,
              inputFile: fg.files[0],
              groupId: gid,
            },
            undefined,
            deps.outputDir,
          );
          seiGroupReportPaths.push(`[group:${gid}] ${reportPath}`);
        }

        const seiSummaryLines = [
          `SEARCH COMPLETE — ${seiBatchOk.length}/${seiGroups.length} batches processed, ${files.length} files scanned, ${seiSkipped.length} skipped`,
          `Folders: ${folderPaths.join(", ")}`,
          sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
          diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
          `Batch UUID: ${seiBatchId}`,
          "",
        ];
        if (seiGroupReportPaths.length > 0) {
          seiSummaryLines.push(`GROUP REPORTS (one per auto-group, ${seiGroupReportPaths.length} total):`);
          for (const p of seiGroupReportPaths) seiSummaryLines.push(`  ${p}`);
        }
        if (seiGroupMissing.length > 0) {
          seiSummaryLines.push(
            "",
            `MISSING SECTIONS (${seiGroupMissing.length} files had no per-file section in the LLM response):`,
          );
          for (const p of seiGroupMissing) seiSummaryLines.push(`  ${p}`);
        }
        if (seiSkipped.length > 0) {
          seiSummaryLines.push("", `SKIPPED (exceeded payload budget, ${seiSkipped.length}):`);
          for (const s of seiSkipped) seiSummaryLines.push(`  ${s}`);
        }
        if (seiBatchFailed.length > 0) {
          seiSummaryLines.push("", `FAILED BATCHES (${seiBatchFailed.length}):`);
          for (const r of seiBatchFailed) {
            seiSummaryLines.push(
              `  Batch ${r.idx + 1}/${seiGroups.length} (${r.filePaths.length} files): ${r.error ?? "empty response"}`,
            );
          }
        }
        if (seiAborted) seiSummaryLines.push("", `ABORTED: ${seiAbortReason}`);
        return {
          content: [{ type: "text", text: seiSummaryLines.join("\n") }],
          isError: seiAborted,
        };
}
