/**
 * code_task CODE-AUDIT benchmark runner (P2b).
 *
 * NAMING: this directory ALREADY contains `runner.test.ts`, which is the
 * hermetic test of the code_task PIPELINE CORE (code-task/core.ts). This file is
 * a different thing — the BENCHMARK runner — so it is `bench-runner.ts` (tested
 * by `bench-runner.test.ts`) rather than `runner.ts`, which would read as the
 * subject of that pre-existing test file.
 *
 * Scores ONE model over the golden corpus by driving the EXACT code_task
 * pipeline (code-task/core.ts::runCodeTask) in-process, one fixture per call:
 * the same input validation, the same path resolution, the same single-file
 * route, and — critically — the same SYSTEM PROMPT the MCP server sends
 * (scan-pipeline.ts::codeTaskSystemPrompt, imported, never copied). The
 * benchmark therefore measures the model's judgment as the tool will actually
 * use it, not through an ad-hoc prompt.
 *
 * THE ONLY SEAM IS THE LLM. `processFileCheck` is the per-file LLM seam
 * (CodeTaskDeps.processFileCheck); the injected implementation below reproduces
 * index.ts::processFileCheck's message assembly using the SAME exported helpers
 * it uses — readFileAsCodeBlock + buildPreInstructions + codeTaskSystemPrompt —
 * so there is no second copy of the prompt to drift, then POSTs to OpenRouter
 * through the injected FetchImpl (the security_scan judge's seam, exactly as
 * search-existing/runner.ts does). Instead of writing a report to disk it tees
 * the model's text into memory and returns a `memory://` path, which is all the
 * pipeline does with it.
 *
 * Scoring is DETERMINISTIC and LLM-free: score.ts extracts the accused symbol
 * set from the free-text report and compares it to the fixture's AST-derived
 * ground truth. No judge anywhere.
 *
 * FAIL-SAFE POSTURE (same as the other two runners): a model/API failure never
 * aborts the sweep. A case whose pipeline returns isError is recorded as a
 * failure and scored with an EMPTY accused set (its defects become false
 * negatives), so a degraded model simply scores poorly instead of throwing. The
 * scorer's `maxFailedCases` ceiling then stops a badly-degraded run from passing
 * on the strength of the cases that did survive.
 */

import { realFetch } from "../../security_scan/openrouter.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import {
  buildPreInstructions,
  readFileAsCodeBlock,
  codeTaskSystemPrompt,
} from "../../scan-pipeline.js";
import {
  runCodeTask,
  type CodeTaskChatMessage,
  type CodeTaskDeps,
  type CodeTaskFileResult,
} from "../../code-task/core.js";
import type { ModelPricing } from "../../mass_scouting/cost-estimate.js";

import {
  CODE_AUDIT_INSTRUCTIONS,
  CODE_AUDIT_LANGUAGE,
  fixturePath,
  listTopLevelSymbols,
  loadDataset,
  readFixture,
  resolveFixtureRoot,
  type CodeAuditCase,
} from "./dataset.js";
import {
  aggregateScores,
  passesThresholds,
  scoreCase,
  type CaseScore,
  type CodeAuditScore,
} from "./score.js";

/** Default OpenRouter chat/completions endpoint. */
const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface CodeAuditRunOptions {
  apiKey: string;
  /**
   * Per-million-token USD pricing (mass_scouting's ModelPricing shape). costUsd
   * is accumulated from each call's usage.{prompt_tokens, completion_tokens}
   * against these rates.
   */
  pricing: ModelPricing;
  /** OpenRouter endpoint override (tests point this at a fake). */
  apiUrl?: string;
  /**
   * Max completion tokens per call. Default 8192.
   *
   * This number is a real tradeoff and the obvious cheap answer is WRONG. The
   * output side is the expensive axis, and a reasoning model does NOT self-limit
   * — it spends whatever budget it is given on billed thinking tokens (that is
   * literally the defect this corpus's ensemble-limits.ts case is about). So the
   * instinct is to clamp this hard, e.g. 2048.
   *
   * But code_task REQUIRES a reasoning model (registry.ts: requireReasoning), and
   * on most providers `max_tokens` bounds reasoning + visible content TOGETHER. A
   * tight cap therefore truncates a reasoning model mid-thought and it returns
   * little or no visible text — which the scorer reads as "found nothing" and the
   * benchmark reports as incompetence. That is not a cheap benchmark, it is a
   * BROKEN one that systematically fails exactly the class of model the tool
   * needs. 8192 leaves room to think and still write the handful of DEFECT: lines
   * a single-file audit warrants, and bounds the worst case to a few cents per
   * model over the whole corpus.
   */
  maxTokens?: number;
  /** Sampling temperature. Default 0.1 (near-deterministic — the tool's own). */
  temperature?: number;
  /** Per-call timeout. Default 300_000ms. */
  perCallTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/** A case the pipeline FAILED (returned isError, or the seam threw). */
export interface CaseFailure {
  caseId: string;
  reason: string;
}

export interface CodeAuditRunResult {
  modelId: string;
  caseScores: CaseScore[];
  aggregate: CodeAuditScore;
  /** True iff the aggregate clears DEFAULT_CODE_AUDIT_THRESHOLDS. */
  pass: boolean;
  costUsd: number;
  meanLatencyMs: number;
  failures: CaseFailure[];
}

/** The slice of the OpenRouter chat/completions response we consume. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Run the code-audit benchmark for a single model over the corpus.
 *
 * One fixture per runCodeTask call (`input_files_paths: [one file]`), which is
 * the pipeline's SINGLE-FILE route → deps.processFileCheck. Per-file calls (not
 * one batched call over the whole corpus) because the tool's real code-audit
 * usage is per-file, and because a batched prompt would let a model that found
 * nothing in file 3 hide behind its answer for file 1.
 */
export async function runCodeAuditBenchmarkOnModel(
  modelId: string,
  cases: readonly CodeAuditCase[] = loadDataset(),
  opts: CodeAuditRunOptions = {
    apiKey: "",
    pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: 0 },
  },
  fetchImpl: FetchImpl = realFetch,
): Promise<CodeAuditRunResult> {
  const fixtureRoot = resolveFixtureRoot();
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const maxTokens = opts.maxTokens ?? 8192;
  const temperature = opts.temperature ?? 0.1;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 300_000;

  let costUsd = 0;
  let latencyTotalMs = 0;
  let callCount = 0;
  const caseScores: CaseScore[] = [];
  const failures: CaseFailure[] = [];

  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    const abs = fixturePath(c, fixtureRoot);
    // Ground truth is derived from the fixture ON DISK at run time (the fixture
    // is the single source of truth — it cannot drift from the expected answer).
    const universe = listTopLevelSymbols(readFixture(c, fixtureRoot), c.file);

    let capturedReport = "";

    /**
     * The ONE seam. Reproduces index.ts::processFileCheck's message assembly
     * from the SAME shared helpers it uses (so the prompt cannot drift), calls
     * OpenRouter, and tees the model's text into memory instead of writing a
     * report file.
     */
    const processFileCheck: CodeTaskDeps["processFileCheck"] = async (
      filePath,
      task,
      options,
    ): Promise<CodeTaskFileResult> => {
      const codeBlock = readFileAsCodeBlock(
        filePath,
        options.language,
        options.redact,
        options.maxBytes,
        options.regexRedact,
      );
      const lang = options.language || CODE_AUDIT_LANGUAGE;
      const messages: CodeTaskChatMessage[] = [
        { role: "system", content: codeTaskSystemPrompt(lang) },
        {
          role: "user",
          content: `${buildPreInstructions(true, "read")}Task: ${task}\n\n${codeBlock}`,
        },
      ];

      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(perCallTimeoutMs),
        });
      } catch (err) {
        // Network/timeout: report it as a FileProcessResult failure (the shape
        // the pipeline understands) rather than throwing out of the sweep.
        return { filePath, success: false, error: `request failed: ${(err as Error).message}` };
      } finally {
        latencyTotalMs += Date.now() - started;
        callCount++;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        return {
          filePath,
          success: false,
          error: `API error ${res.status}: ${bodyText.slice(0, 300)}`,
        };
      }

      const json = (await res.json()) as ChatCompletionResponse;
      const usage = json.usage;
      if (usage) {
        costUsd +=
          ((usage.prompt_tokens ?? 0) / 1_000_000) * opts.pricing.input_per_m_usd +
          ((usage.completion_tokens ?? 0) / 1_000_000) * opts.pricing.output_per_m_usd;
      }
      const content = json.choices?.[0]?.message?.content ?? "";
      if (content.trim().length === 0) {
        return { filePath, success: false, error: "LLM returned empty response" };
      }
      capturedReport = content;
      return { filePath, success: true, reportPath: `memory://case/${c.id}` };
    };

    const deps: CodeTaskDeps = {
      // The benchmark scores ONE model at a time, so the multi-model ensemble is
      // off — otherwise the score would belong to the ensemble, not the candidate.
      useEnsemble: false,
      defaultTemperature: temperature,
      normalizePaths: (raw) => {
        if (!raw) return [];
        const arr = Array.isArray(raw) ? raw : [raw];
        return arr.filter((p): p is string => typeof p === "string" && p.length > 0);
      },
      // The benchmark always passes explicit input_files_paths; folder_path is
      // never used, and a silent empty result would be worse than a clear error.
      resolveFolderPath: () => ({ files: [], error: "folder_path is not used by the code-audit benchmark" }),
      processFileCheck,
      // Unreachable on the single-file route. Throw rather than return a stub:
      // if the pipeline ever changed shape and started batching here, a silent
      // stub would produce a plausible-looking but meaningless score.
      ensembleStreaming: async () => {
        throw new Error(
          "code-audit benchmark: ensembleStreaming was called, but every case is a SINGLE input file and must route through processFileCheck. The pipeline's single-file route changed — fix the runner rather than scoring a different code path.",
        );
      },
      formatFooter: () => "",
      saveResponse: () => `memory://case/${c.id}`,
      robustPerFileProcess: async () => {
        throw new Error(
          "code-audit benchmark: robustPerFileProcess was called, but the benchmark never sets max_retries > 1.",
        );
      },
      // The REAL system prompt — imported, not copied (scan-pipeline.ts).
      codeTaskSystemPrompt,
      ensembleModelLabel: () => modelId,
      resolveDefaultMaxTokens: () => maxTokens,
    };

    const args: Record<string, unknown> = {
      instructions: CODE_AUDIT_INSTRUCTIONS,
      input_files_paths: [abs],
      language: CODE_AUDIT_LANGUAGE,
      answer_mode: 0,
      scan_secrets: false,
      redact_secrets: false,
    };

    const result = await runCodeTask(args, deps);

    if (result.isError || capturedReport === "") {
      const reason =
        result.content.map((p) => p.text).join("\n").split("\n")[0] || "pipeline produced no report";
      failures.push({ caseId: c.id, reason });
      // Scored with an EMPTY accused set: the case's defects become false
      // negatives, so the model is PENALISED for the failure rather than the
      // case being silently dropped from the denominator.
      caseScores.push(scoreCase(c, universe, "", /* failed */ true));
    } else {
      caseScores.push(scoreCase(c, universe, capturedReport));
    }

    if (opts.onProgress) opts.onProgress(ci + 1, cases.length);
  }

  const aggregate = aggregateScores(caseScores);
  return {
    modelId,
    caseScores,
    aggregate,
    pass: passesThresholds(aggregate).pass,
    costUsd,
    meanLatencyMs: callCount === 0 ? 0 : latencyTotalMs / callCount,
    failures,
  };
}
