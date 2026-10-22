/**
 * compare_files benchmark RUNNER (TRDD-2G6D42LK).
 *
 * DRIVES THE REAL TOOL. The system prompt comes from `compareFilesSystemPrompt`
 * — the same seam index.ts's two modes now call — so this measures the command
 * rather than a prompt written here. That seam only exists because the two modes
 * previously asked DIFFERENT questions; a runner built before that was resolved
 * would have measured one mode and silently spoken for both.
 *
 * The user turn mirrors the tool's: the diff inside a fence, prefixed by the
 * before/after labels. The corpus supplies real `git show` output, so no diff is
 * computed here — that half is `git` and is not the model's work.
 *
 * WHAT IS GRADED: recall over the top-level symbols the diff changed, which is
 * exactly what the prompt instructs ("Identify changed code by
 * FUNCTION/CLASS/METHOD NAME, never by line number"). Precision is reported and
 * never gated — see score.ts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { chatCompletionWithRetry } from "../../provider/completion.js";
import type { ChatMessage, CompletionDeps } from "../../provider/types.js";
import { compareFilesSystemPrompt } from "../../compare-files/prompt.js";
import { FIXTURE_DIR, loadDataset } from "./dataset.js";
import {
  DEFAULT_COMPARE_FILES_THRESHOLDS,
  hallucinatedSymbols,
  passesThresholds,
  scoreAll,
  scoreDiff,
  type CaseScore,
  type CompareFilesScore,
} from "./score.js";

/** The completion boundary, injected so tests are hermetic and $0. */
export type ChatFn = (
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; model?: string },
  deps: CompletionDeps,
) => Promise<{ content: string }>;

export interface CompareFilesRunOptions {
  deps: CompletionDeps;
  /**
   * Default 4096. NOT tighter, for the reason P2b/P2c both record: on most
   * providers max_tokens bounds reasoning + visible content together, so a tight
   * cap truncates a reasoning model mid-thought and the scorer reads the empty
   * result as an unusable answer — failing a whole class of model for thinking.
   * A summary is short; the headroom costs nothing unless spent.
   */
  maxTokens?: number;
  temperature?: number;
  onProgress?: (done: number, total: number) => void;
  chatFn?: ChatFn;
}

export interface CompareFilesRunResult {
  modelId: string;
  caseScores: CaseScore[];
  aggregate: CompareFilesScore;
  /** Clears DEFAULT_COMPARE_FILES_THRESHOLDS (recall + coverage; precision ungated). */
  pass: boolean;
  failures: { id: string; reason: string }[];
  /** Symbols named that the diff did not change. Reported, NEVER gated. */
  hallucinations: { id: string; symbols: string[] }[];
}

export const COMPARE_FILES_MAX_OUTPUT_TOKENS = 4096;

export async function runCompareFilesBenchmarkOnModel(
  modelId: string,
  opts: CompareFilesRunOptions,
): Promise<CompareFilesRunResult> {
  const chat = opts.chatFn ?? (chatCompletionWithRetry as unknown as ChatFn);
  const cases = loadDataset();
  // The hallucination pool is every symbol ANY fixture changed: a symbol real
  // elsewhere in the corpus but absent from THIS diff is the interesting false
  // positive. Inventing a pool of arbitrary strings would measure nothing.
  const pool = [...new Set(cases.flatMap((c) => c.changedSymbols))];

  const caseScores: CaseScore[] = [];
  const failures: { id: string; reason: string }[] = [];
  const hallucinations: { id: string; symbols: string[] }[] = [];
  let done = 0;

  for (const c of cases) {
    const diff = readFileSync(join(FIXTURE_DIR, `${c.id}.diff`), "utf-8");
    let summary: string | null = null;
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: compareFilesSystemPrompt("") },
        {
          role: "user",
          content: `Compare the changes in commit ${c.id}.\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``,
        },
      ];
      const resp = await chat(
        messages,
        {
          temperature: opts.temperature ?? 0.1,
          maxTokens: opts.maxTokens ?? COMPARE_FILES_MAX_OUTPUT_TOKENS,
          model: modelId,
        },
        opts.deps,
      );
      summary = typeof resp.content === "string" && resp.content.length > 0 ? resp.content : null;
      if (summary === null) failures.push({ id: c.id, reason: "empty completion" });
    } catch (err) {
      failures.push({ id: c.id, reason: (err as Error).message });
    }

    caseScores.push(scoreDiff(c.id, c.changedSymbols, summary));
    if (summary !== null) {
      const bogus = hallucinatedSymbols(summary, c.changedSymbols, pool);
      if (bogus.length > 0) hallucinations.push({ id: c.id, symbols: bogus });
    }
    opts.onProgress?.(++done, cases.length);
  }

  const aggregate = scoreAll(caseScores);
  return {
    modelId,
    caseScores,
    aggregate,
    pass: passesThresholds(aggregate, DEFAULT_COMPARE_FILES_THRESHOLDS).pass,
    failures,
    hallucinations,
  };
}

/** Cost-estimation workload, measured from the REAL prompt + REAL corpus bytes. */
export function describeWorkload() {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".diff")).sort();
  let promptCharsPerModel = 0;
  for (const f of files) {
    const diff = readFileSync(join(FIXTURE_DIR, f), "utf-8");
    promptCharsPerModel +=
      compareFilesSystemPrompt("").length +
      `Compare the changes in commit ${f}.\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``.length;
  }
  return {
    tool: "compare_files",
    benchmark: "compare-files",
    callsPerModel: files.length,
    promptCharsPerModel,
    maxOutputTokensPerCall: COMPARE_FILES_MAX_OUTPUT_TOKENS,
  };
}
