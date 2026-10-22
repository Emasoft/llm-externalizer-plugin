/**
 * check_imports PHASE-1 PROMPT — the single definition (TRDD-f45eeaa0).
 *
 * WHY THIS MODULE EXISTS. check_imports is two-phase: the LLM extracts file/import
 * references from a file's TEXT, then the server resolves each against disk. Phase
 * 1 is the only half a model performs, so it is the only half a benchmark can
 * score — and a benchmark that rebuilds the prompt itself measures a prompt its
 * author wrote, not the tool. `scan-folder/bench-runner.ts` states the doctrine:
 * drive the REAL pipeline, "rather than looping over files ourselves — that is
 * what makes this a benchmark of scan_folder and not of an ad-hoc prompt that
 * resembles it."
 *
 * Until now there WAS no seam to drive: the messages were built inline inside the
 * `case "check_imports":` block in index.ts — TWICE, once on the grouped path and
 * once on the ungrouped one. Two copies of a prompt is a drift hazard on its own
 * (fix one, forget the other, and the two paths silently disagree about what the
 * tool asks for). Extracting it gives the benchmark prompt fidelity and collapses
 * the duplication in the same move.
 *
 * DELIBERATELY PURE. The network call, usage accounting and logging stay where
 * they were; only message CONSTRUCTION moves. That keeps the extraction
 * behaviour-preserving and reviewable — the two former copies were verified
 * character-identical before being replaced by this one.
 *
 * NOTE FOR ANYONE SCORING THIS: the prompt asks for strictly more than import
 * specifiers ("file path strings, configuration references … Be exhaustive"), so a
 * benchmark oracle that derives only import specifiers must NOT gate on precision.
 * See benchmark/check-imports/score.ts, which scores recall-only for exactly this
 * reason.
 */

import type { ChatMessage } from "../provider/types.js";

export interface CheckImportsExtractPromptInput {
  /** Detected language for the file, e.g. "typescript". */
  lang: string;
  /** The caller's extra instructions, if any (prepended to the user turn). */
  userPrompt?: string;
  /** The file rendered as a labelled code block (readFileAsCodeBlock output). */
  fileBlock: string;
  /**
   * The shared file-format example appended to the system turn. Passed in rather
   * than imported so this module stays free of index.ts (which would be a cycle:
   * index.ts is the CLI entry point and imports this).
   */
  fileFormatExample: string;
}

/** The system turn. Exported separately so a test can assert it verbatim. */
export function checkImportsExtractSystemPrompt(
  lang: string,
  fileFormatExample: string,
): string {
  return (
    `Expert ${lang} developer. Extract ALL file path references and import statements from the source code. ` +
    "The source file is labeled with its full path inside a filename tag before the file-content tag — reference it by that path. " +
    "Include: import/require paths, file path strings, configuration references. " +
    'Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. ' +
    "Include both local (relative) and package imports. Be exhaustive." +
    fileFormatExample
  );
}

/** The exact message pair phase 1 sends. The benchmark drives THIS. */
export function buildCheckImportsExtractMessages(
  input: CheckImportsExtractPromptInput,
): ChatMessage[] {
  const { lang, userPrompt, fileBlock, fileFormatExample } = input;
  return [
    { role: "system", content: checkImportsExtractSystemPrompt(lang, fileFormatExample) },
    {
      role: "user",
      content:
        `${userPrompt ? userPrompt + "\n\n" : ""}Extract all import and file references from:\n\n` +
        fileBlock,
    },
  ];
}
