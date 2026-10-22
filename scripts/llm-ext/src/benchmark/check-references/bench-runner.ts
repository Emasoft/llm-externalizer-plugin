/**
 * check_references benchmark RUNNER (TRDD-2G6D42LK).
 *
 * Asks the model the tool's own question — given a consumer file and the
 * dependency it imports from, does the imported symbol still exist? — and grades
 * the binary verdict against truth derived from the bytes.
 *
 * The completion boundary is injected (defaults to the real call) so the
 * orchestration is testable at $0. Phase-2-style resolution is not simulated:
 * the dataset already knows whether the dependency exports the symbol, because
 * that is decidable, and re-deciding it here would score a regex rather than a
 * model.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { chatCompletionWithRetry } from "../../provider/completion.js";
import type { ChatMessage, CompletionDeps } from "../../provider/types.js";
import { FIXTURE_DIR, loadDataset } from "./dataset.js";
import {
  DEFAULT_CHECK_REFERENCES_THRESHOLDS,
  passesThresholds,
  scoreAll,
  scoreCorpus,
  type CaseScore,
  type CheckReferencesScore,
} from "./score.js";

export type ChatFn = (
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; model?: string },
  deps: CompletionDeps,
) => Promise<{ content: string }>;

export interface CheckReferencesRunOptions {
  deps: CompletionDeps;
  maxTokens?: number;
  temperature?: number;
  onProgress?: (done: number, total: number) => void;
  chatFn?: ChatFn;
}

export interface CheckReferencesRunResult {
  modelId: string;
  caseScores: CaseScore[];
  aggregate: CheckReferencesScore;
  pass: boolean;
  failures: { symbol: string; reason: string }[];
  verdicts: { symbol: string; expected: boolean; reported: boolean | null }[];
}

export const CHECK_REFERENCES_MAX_OUTPUT_TOKENS = 4096;

/**
 * Read a BROKEN / OK verdict out of the reply.
 *
 * Anchored and ORDER-INDEPENDENT: the reply is searched for an explicit token
 * rather than "does it contain the word broken", because a model explaining
 * "this is NOT broken" would otherwise be scored as saying broken. An unreadable
 * reply returns null — an unusable answer, never a silent "OK".
 */
export function parseVerdict(reply: string): boolean | null {
  const m = /\bVERDICT\s*:\s*(BROKEN|OK)\b/i.exec(reply);
  if (m) return m[1].toUpperCase() === "BROKEN";
  return null;
}

export async function runCheckReferencesBenchmarkOnModel(
  modelId: string,
  opts: CheckReferencesRunOptions,
): Promise<CheckReferencesRunResult> {
  const chat = opts.chatFn ?? (chatCompletionWithRetry as unknown as ChatFn);
  const cases = loadDataset();
  const failures: { symbol: string; reason: string }[] = [];
  const verdicts: { symbol: string; expected: boolean; reported: boolean | null }[] = [];
  let done = 0;

  for (const c of cases) {
    const dir = join(FIXTURE_DIR, c.symbol);
    let reported: boolean | null = null;
    try {
      const consumer = readFileSync(join(dir, "consumer.ts"), "utf-8");
      const dependency = readFileSync(join(dir, "dependency.ts"), "utf-8");
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "Expert code reviewer. Decide whether a named import binding is still valid: " +
            "does the DEPENDENCY module export the named symbol? " +
            "Answer on a single anchored line, exactly `VERDICT: BROKEN` or `VERDICT: OK`, " +
            "then optionally one sentence of justification.",
        },
        {
          role: "user",
          content:
            `Symbol: ${c.symbol}\n\n## CONSUMER\n\`\`\`ts\n${consumer}\n\`\`\`\n\n` +
            `## DEPENDENCY\n\`\`\`ts\n${dependency}\n\`\`\``,
        },
      ];
      const resp = await chat(
        messages,
        {
          temperature: opts.temperature ?? 0,
          maxTokens: opts.maxTokens ?? CHECK_REFERENCES_MAX_OUTPUT_TOKENS,
          model: modelId,
        },
        opts.deps,
      );
      reported = parseVerdict(resp.content ?? "");
      if (reported === null) failures.push({ symbol: c.symbol, reason: "no anchored VERDICT line" });
    } catch (err) {
      failures.push({ symbol: c.symbol, reason: (err as Error).message });
    }
    verdicts.push({ symbol: c.symbol, expected: c.broken, reported });
    opts.onProgress?.(++done, cases.length);
  }

  const caseScores = [
    scoreCorpus(verdicts.map((v) => ({ symbol: v.symbol, broken: v.expected, reported: v.reported }))),
  ];
  const aggregate = scoreAll(caseScores);
  return {
    modelId,
    caseScores,
    aggregate,
    pass: passesThresholds(aggregate, DEFAULT_CHECK_REFERENCES_THRESHOLDS).pass,
    failures,
    verdicts,
  };
}

/** Cost-estimation workload, measured from the REAL prompt + REAL fixture bytes. */
export function describeWorkload() {
  const dirs = readdirSync(FIXTURE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  let promptCharsPerModel = 0;
  for (const d of dirs) {
    promptCharsPerModel +=
      readFileSync(join(FIXTURE_DIR, d, "consumer.ts"), "utf-8").length +
      readFileSync(join(FIXTURE_DIR, d, "dependency.ts"), "utf-8").length +
      400; // the anchored instruction pair
  }
  return {
    tool: "check_references",
    benchmark: "check-references",
    callsPerModel: dirs.length,
    promptCharsPerModel,
    maxOutputTokensPerCall: CHECK_REFERENCES_MAX_OUTPUT_TOKENS,
  };
}
