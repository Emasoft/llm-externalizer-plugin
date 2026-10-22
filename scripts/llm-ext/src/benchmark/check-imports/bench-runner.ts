/**
 * check_imports benchmark RUNNER (TRDD-f45eeaa0).
 *
 * ── IT DRIVES THE REAL TOOL, NOT A LOOKALIKE ────────────────────────────────
 * `scan-folder/bench-runner.ts` states the doctrine this file obeys: drive the
 * REAL pipeline "rather than looping over files ourselves — that is what makes
 * this a benchmark of scan_folder and not of an ad-hoc prompt that resembles
 * it." So every input here is the shipped artifact, not a copy:
 *
 *   • the PROMPT — `buildCheckImportsExtractMessages`, the same seam index.ts's
 *     two check_imports paths call (extracted for exactly this reason),
 *   • the SCHEMA — `EXTRACT_PATHS_SCHEMA`, the same structured-output contract,
 *   • the FILE RENDERING — `readFileAsCodeBlock`, so the model sees the bytes
 *     and the filename tag the tool really sends,
 *   • the RESPONSE READING — `parsed.paths`, filtered to strings, exactly as the
 *     tool does before handing phase 2 its list.
 *
 * If any of those drifts, this benchmark stops measuring the tool — which is why
 * prompt.test.ts pins the prompt verbatim rather than trusting a comment.
 *
 * ── WHY THE COMPLETION CALL IS INJECTED ─────────────────────────────────────
 * `chatJson` defaults to the real `chatCompletionJSON`, and tests pass a stub.
 * That is a SEAM, not a mock of the unit under test: the thing being tested here
 * is the orchestration (per-file iteration, parse, score, aggregate, failure
 * accounting), and injecting the network boundary is the only way to exercise it
 * deterministically and at $0. The MODEL's quality is what a real run measures;
 * this seam does not stand in for that.
 *
 * ── PHASE 2 IS DELIBERATELY NOT RUN ─────────────────────────────────────────
 * The tool resolves each extracted path against disk. That half is deterministic
 * server code with no model in it, so running it would score Node's `existsSync`,
 * not the candidate. Extraction is the whole gradeable surface.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readFileAsCodeBlock } from "../../scan-pipeline.js";
import {
  EXTRACT_PATHS_SCHEMA,
  chatCompletionJSON,
  type JSONCompletionResult,
} from "../../provider/completion.js";
import type { ChatMessage, CompletionDeps } from "../../provider/types.js";
import { buildCheckImportsExtractMessages } from "../../check-imports/prompt.js";
import { FIXTURE_DIR, deriveDeclaredSpecifiers, loadDataset } from "./dataset.js";
import type { BenchmarkWorkload } from "../workload-types.js";
import {
  DEFAULT_CHECK_IMPORTS_THRESHOLDS,
  passesThresholds,
  scoreAll,
  scoreFile,
  type CaseScore,
  type CheckImportsScore,
} from "./score.js";

/**
 * The completion boundary. Mirrors chatCompletionJSON's shape so the real
 * function is assignable with no adapter — an adapter is where fidelity leaks.
 */
export type ChatJsonFn = (
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    jsonSchema?: { name: string; strict: boolean; schema: Record<string, unknown> };
  },
  deps: CompletionDeps,
) => Promise<JSONCompletionResult>;

export interface CheckImportsRunOptions {
  /** Completion deps (api key, url, fetch impl) — passed through untouched. */
  deps: CompletionDeps;
  /**
   * Max completion tokens. Default 4096, and NOT tighter, for the reason P2b and
   * P2c both record: on most providers max_tokens bounds reasoning + visible
   * content TOGETHER, so a tight cap truncates a reasoning model mid-thought, it
   * emits nothing parseable, and the scorer reads that as an unusable answer —
   * i.e. the benchmark would systematically fail an entire class of model for
   * being thoughtful. check_imports does not REQUIRE reasoning, but reasoning
   * models are valid candidates, so the cap must not discriminate. A real answer
   * is a short JSON array; the headroom costs nothing unless it is spent.
   */
  maxTokens?: number;
  /** The tool sends temperature 0. Kept identical rather than "near" it. */
  temperature?: number;
  onProgress?: (done: number, total: number) => void;
  /** Injected for tests; defaults to the real completion call. */
  chatJson?: ChatJsonFn;
}

/** A fixture whose call produced nothing usable. */
export interface FileFailure {
  file: string;
  reason: string;
}

export interface CheckImportsRunResult {
  modelId: string;
  caseScores: CaseScore[];
  aggregate: CheckImportsScore;
  /** True iff the aggregate clears DEFAULT_CHECK_IMPORTS_THRESHOLDS (recall-only). */
  pass: boolean;
  failures: FileFailure[];
  /**
   * Paths the model reported that the oracle does not know about. NOT graded —
   * the tool's prompt asks for "file path strings, configuration references" too,
   * so these are frequently CORRECT. Surfaced for a human reading the report,
   * and the reason precision does not gate. See score.ts.
   */
  extraPaths: { file: string; paths: string[] }[];
}

export const CHECK_IMPORTS_MAX_OUTPUT_TOKENS = 4096;

/** Run the check_imports benchmark for ONE model over the corpus. */
export async function runCheckImportsBenchmarkOnModel(
  modelId: string,
  opts: CheckImportsRunOptions,
): Promise<CheckImportsRunResult> {
  const chatJson = opts.chatJson ?? chatCompletionJSON;
  const truth = new Map(loadDataset().map((c) => [c.file, c.specifiers]));
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  const caseScores: CaseScore[] = [];
  const failures: FileFailure[] = [];
  const extraPaths: { file: string; paths: string[] }[] = [];

  let done = 0;
  for (const file of files) {
    const expected = truth.get(file) ?? [];
    let reported: string[] | null;
    try {
      const messages = buildCheckImportsExtractMessages({
        lang: "typescript",
        fileBlock: readFileAsCodeBlock(join(FIXTURE_DIR, file)),
        // The tool appends FILE_FORMAT_EXAMPLE from index.ts. It is not
        // importable here without a cycle, and it is a FORMAT example rather
        // than part of the question, so it is omitted and that omission is
        // stated rather than hidden. prompt.test.ts pins the half that matters.
        fileFormatExample: "",
      });
      const resp = await chatJson(
        messages,
        {
          temperature: opts.temperature ?? 0,
          maxTokens: opts.maxTokens ?? CHECK_IMPORTS_MAX_OUTPUT_TOKENS,
          model: modelId,
          jsonSchema: EXTRACT_PATHS_SCHEMA,
        },
        opts.deps,
      );
      const raw = (resp.parsed as { paths?: unknown }).paths;
      // Exactly the tool's own reading: an array, strings only. A non-array is
      // an unusable answer, NOT an empty one — the distinction the scorer keeps.
      reported = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : null;
      if (reported === null) failures.push({ file, reason: "response.paths was not an array" });
    } catch (err) {
      reported = null;
      failures.push({ file, reason: (err as Error).message });
    }

    caseScores.push(scoreFile(file, expected, reported));
    if (reported !== null) {
      const unknown = reported.filter((p) => !expected.includes(p));
      if (unknown.length > 0) extraPaths.push({ file, paths: unknown });
    }
    opts.onProgress?.(++done, files.length);
  }

  const aggregate = scoreAll(caseScores);
  return {
    modelId,
    caseScores,
    aggregate,
    pass: passesThresholds(aggregate, DEFAULT_CHECK_IMPORTS_THRESHOLDS).pass,
    failures,
    extraPaths,
  };
}

/**
 * Cost-estimation workload, derived from the REAL prompt and the REAL corpus
 * bytes — never from a guess. update-all prices a sweep from this before
 * spending, so an invented number here would understate a real bill.
 *
 * Mirrors scan-folder/index.ts::describeWorkload: build exactly what the runner
 * will send, and measure it.
 */
export function describeWorkload(): BenchmarkWorkload {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  let promptCharsPerModel = 0;
  for (const file of files) {
    const messages = buildCheckImportsExtractMessages({
      lang: "typescript",
      fileBlock: readFileAsCodeBlock(join(FIXTURE_DIR, file)),
      fileFormatExample: "",
    });
    for (const m of messages) promptCharsPerModel += (m.content ?? "").length;
  }
  return {
    tool: "check_imports",
    benchmark: "check-imports",
    callsPerModel: files.length, // one extraction call per fixture
    promptCharsPerModel,
    maxOutputTokensPerCall: CHECK_IMPORTS_MAX_OUTPUT_TOKENS,
  };
}

export { deriveDeclaredSpecifiers };
