/**
 * Text-tools (summarize / topics / sem_deduplicate / describe) benchmark
 * runner. Mirrors check-specs/bench-runner.ts, the closest existing analog:
 * both drive a pipeline whose ONLY LLM seam is `ensembleStreaming`, and the
 * seam never throws — every failure (network, non-2xx, malformed body, empty
 * content) degrades to an empty-content result, which the pipeline's own
 * response gate (response-gate.ts::gateLLMResponse) already understands as
 * "empty" and retries once before giving up. That is what makes the whole
 * sweep fail-safe: one bad HTTP response costs one call, never the run.
 *
 * Scores ONE model over ONE tool's golden corpus (dataset.ts) by driving the
 * REAL per-tool pipeline runner (text-tools/core.ts::runSummarize /
 * runTopics / runSemDeduplicate / runDescribe) in-process, one case per call
 * (plus text-tools/core.ts's own single corrective retry on a mechanically
 * invalid answer — cost and latency are accumulated across every call a case
 * makes, retry included).
 *
 * What gets scored, per tool (score.ts's scorers are LLM-free):
 *   - summarize / describe: the CLEANED text the pipeline actually decided to
 *     save (captured at the `saveResponse` seam — with `formatFooter`
 *     returning "" that IS the validated output, budget check included). A
 *     model that wraps a within-budget answer in a code fence still gets
 *     that fence stripped by the pipeline's own `cleanPlainText`, so scoring
 *     the saved text (not the raw wire response) is what makes the score
 *     match the tool's real contract instead of punishing formatting.
 *   - topics / sem_deduplicate: the RAW last-successful wire response,
 *     re-parsed with the SAME parsers the pipeline validated it with
 *     (parseTopicsResponse / parseSemDedupResponse) — their output is a
 *     structured payload, not prose, so there is no "cleaned text" to save;
 *     the saved text is a rendered report for humans, not the payload.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realFetch } from "../../security_scan/openrouter.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import type { ModelPricing } from "../../mass_scouting/cost-estimate.js";
import {
  literalDedup,
  parseSemDedupResponse,
  parseTopicsResponse,
  runDescribe,
  runSemDeduplicate,
  runSummarize,
  runTopics,
  type TextToolsDeps,
  type TextToolsResult,
  type TextToolsStreamingResult,
} from "../../text-tools/core.js";
import {
  DESCRIBE_CASES,
  SEM_DEDUP_CASES,
  SUMMARIZE_CASES,
  TOPICS_CASES,
  semDedupInput,
} from "./dataset.js";
import {
  aggregateTextToolScores,
  passesTextToolThresholds,
  scoreDescribeCase,
  scoreSemDedupCase,
  scoreSummarizeCase,
  scoreTopicsCase,
  type TextToolScore,
} from "./score.js";

/** The four single-call text tools this benchmark package covers. */
export type TextToolName = "summarize" | "topics" | "sem_deduplicate" | "describe";

/** Default OpenRouter chat/completions endpoint. */
const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Output bound this benchmark puts on the wire, per call. These are small,
 * single-call, non-reasoning tools — a summary/description caps at a few
 * hundred characters and topics/sem_deduplicate answer with a short JSON
 * payload — so 4096 is generous headroom, not a corpus-sized budget the way
 * code_task's 8192 is. Exported so the P4 pre-flight spend estimate reads the
 * SAME number the request carries.
 */
export const TEXT_TOOLS_MAX_OUTPUT_TOKENS = 4096;

export interface TextToolRunOptions {
  apiKey: string;
  /** Per-million-token USD pricing; costUsd is accumulated from each call's usage. */
  pricing: ModelPricing;
  /** OpenRouter endpoint override (tests point this at a fake). */
  apiUrl?: string;
  maxTokens?: number;
  /** Sampling temperature. Default 0.1 (near-deterministic — the tool's own default is 0). */
  temperature?: number;
  /** Per-call timeout. Default 300_000ms. */
  perCallTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/** A case whose pipeline run FAILED outright (isError). */
export interface CaseFailure {
  caseId: string;
  reason: string;
}

/** One case's score plus a short human-readable note for the report table. */
export interface TextToolCaseResult {
  caseId: string;
  score: number;
  detail: string;
}

export interface TextToolRunResult {
  modelId: string;
  tool: TextToolName;
  perCase: TextToolCaseResult[];
  aggregate: TextToolScore;
  /** True iff the aggregate clears DEFAULT_TEXT_TOOL_THRESHOLDS. */
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

/** Mutated in place by every ensembleStreaming call across a case's attempts. */
interface Accumulator {
  costUsd: number;
  latencyMs: number;
  callCount: number;
}

/** An empty-content result — text-tools/core.ts's response gate reads this as
 *  "empty" and retries once before giving up, exactly like a real empty reply. */
function emptyResult(modelId: string): TextToolsStreamingResult {
  return { content: "", model: modelId, finishReason: "error", truncated: false };
}

interface CaseRunContext {
  apiUrl: string;
  apiKey: string;
  pricing: ModelPricing;
  temperature: number;
  maxTokens: number;
  perCallTimeoutMs: number;
  fetchImpl: FetchImpl;
  acc: Accumulator;
}

interface CaseOutcome {
  caseId: string;
  score: number;
  detail: string;
  failed: boolean;
  failureReason?: string;
}

/**
 * Run ONE case through ONE tool pipeline function. `callTool` builds the
 * args and invokes the real runner (runSummarize/runTopics/...); `scoreOutcome`
 * turns whatever was captured (the raw last-successful wire content, and the
 * exact text/payload the pipeline decided to save) into a score + a one-line
 * note. Everything HTTP-shaped lives here, once, shared by all four tools.
 */
async function runOneCase(
  caseId: string,
  modelId: string,
  ctx: CaseRunContext,
  callTool: (deps: TextToolsDeps) => Promise<TextToolsResult>,
  scoreOutcome: (rawContent: string, saveContent: string) => { score: number; detail: string },
): Promise<CaseOutcome> {
  let capturedRawContent = "";
  let capturedSaveContent = "";

  const ensembleStreaming: TextToolsDeps["ensembleStreaming"] = async (
    messages,
    options,
  ): Promise<TextToolsStreamingResult> => {
    const started = Date.now();
    let res;
    try {
      res = await ctx.fetchImpl(ctx.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: options.temperature ?? ctx.temperature,
          max_tokens: options.maxTokens ?? ctx.maxTokens,
        }),
        signal: AbortSignal.timeout(ctx.perCallTimeoutMs),
      });
    } catch {
      // Network/timeout: never throw out of the sweep — text-tools/core.ts's
      // callWithOneRetry has no try/catch around this call, so a throw here
      // would abort the whole case instead of degrading through the gate.
      return emptyResult(modelId);
    } finally {
      ctx.acc.latencyMs += Date.now() - started;
      ctx.acc.callCount++;
    }

    if (!res.ok) return emptyResult(modelId);

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch {
      // A 200 with an empty/truncated body — degrade, don't throw (same trap
      // as every other benchmark runner's seam).
      return emptyResult(modelId);
    }
    const usage = json.usage;
    if (usage) {
      ctx.acc.costUsd +=
        ((usage.prompt_tokens ?? 0) / 1_000_000) * ctx.pricing.input_per_m_usd +
        ((usage.completion_tokens ?? 0) / 1_000_000) * ctx.pricing.output_per_m_usd;
    }
    const content = json.choices?.[0]?.message?.content ?? "";
    if (content.trim().length === 0) return emptyResult(modelId);

    capturedRawContent = content;
    return {
      content,
      model: modelId,
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
          }
        : undefined,
      finishReason: "stop",
      truncated: false,
    };
  };

  const deps: TextToolsDeps = {
    // The benchmark scores ONE model at a time — the multi-model ensemble is
    // off, otherwise the score would belong to the ensemble, not the candidate.
    useEnsemble: false,
    defaultTemperature: ctx.temperature,
    ensembleStreaming,
    // No footer: the real one records usage + writes to the global ledger
    // (side effects a benchmark must not have), and an empty footer keeps the
    // saved text EXACTLY the pipeline's validated output.
    formatFooter: () => "",
    saveResponse: (_tool, content) => {
      capturedSaveContent = content;
      return `memory://case/${caseId}`;
    },
    resolveDefaultMaxTokens: () => ctx.maxTokens,
  };

  const result = await callTool(deps);

  if (result.isError) {
    const reason =
      result.content.map((p) => p.text).join(" ").split("\n")[0] || "pipeline produced no report";
    return { caseId, score: 0, detail: "FAILED", failed: true, failureReason: reason };
  }
  const { score, detail } = scoreOutcome(capturedRawContent, capturedSaveContent);
  return { caseId, score, detail, failed: false };
}

/**
 * Run the text-tool benchmark for a single model over ONE tool's corpus.
 * Drives the REAL pipeline function per case (runSummarize/runTopics/
 * runSemDeduplicate/runDescribe) — the only fake is the HTTP wire.
 */
export async function runTextToolBenchmarkOnModel(
  tool: TextToolName,
  modelId: string,
  opts: TextToolRunOptions = {
    apiKey: "",
    pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: 0 },
  },
  fetchImpl: FetchImpl = realFetch,
): Promise<TextToolRunResult> {
  const ctx: CaseRunContext = {
    apiUrl: opts.apiUrl ?? DEFAULT_API_URL,
    apiKey: opts.apiKey,
    pricing: opts.pricing,
    temperature: opts.temperature ?? 0.1,
    maxTokens: opts.maxTokens ?? TEXT_TOOLS_MAX_OUTPUT_TOKENS,
    perCallTimeoutMs: opts.perCallTimeoutMs ?? 300_000,
    fetchImpl,
    acc: { costUsd: 0, latencyMs: 0, callCount: 0 },
  };

  const perCase: TextToolCaseResult[] = [];
  const failures: CaseFailure[] = [];
  let total: number;

  const record = (o: CaseOutcome): void => {
    perCase.push({ caseId: o.caseId, score: o.score, detail: o.detail });
    if (o.failed) failures.push({ caseId: o.caseId, reason: o.failureReason ?? "unknown failure" });
  };

  if (tool === "summarize") {
    total = SUMMARIZE_CASES.length;
    for (let i = 0; i < SUMMARIZE_CASES.length; i++) {
      const c = SUMMARIZE_CASES[i];
      record(
        await runOneCase(
          c.id,
          modelId,
          ctx,
          (deps) => runSummarize({ input_content: c.text, max_chars: c.maxChars }, deps),
          (_raw, save) => {
            const s = scoreSummarizeCase(c, save);
            return { score: s.score, detail: `budget=${s.withinBudget} recall=${s.conceptRecall.toFixed(2)}` };
          },
        ),
      );
      opts.onProgress?.(i + 1, total);
    }
  } else if (tool === "topics") {
    total = TOPICS_CASES.length;
    for (let i = 0; i < TOPICS_CASES.length; i++) {
      const c = TOPICS_CASES[i];
      record(
        await runOneCase(
          c.id,
          modelId,
          ctx,
          (deps) => runTopics({ input_content: c.text }, deps),
          (raw) => {
            const payload = parseTopicsResponse(raw);
            if (!payload) return { score: 0, detail: "unparsable topics JSON" };
            const s = scoreTopicsCase(c, payload);
            return {
              score: s.score,
              detail: `lang=${s.languageMatch} recall=${s.conceptRecall.toFixed(2)} prec=${s.termPrecision.toFixed(2)}`,
            };
          },
        ),
      );
      opts.onProgress?.(i + 1, total);
    }
  } else if (tool === "sem_deduplicate") {
    total = SEM_DEDUP_CASES.length;
    for (let i = 0; i < SEM_DEDUP_CASES.length; i++) {
      const c = SEM_DEDUP_CASES[i];
      const input = semDedupInput(c).join("\n");
      record(
        await runOneCase(
          c.id,
          modelId,
          ctx,
          (deps) => runSemDeduplicate({ input_content: input }, deps),
          (raw) => {
            const literal = literalDedup(semDedupInput(c)).survivors;
            const parsed = parseSemDedupResponse(raw, literal);
            const survivors = parsed.survivors ?? [];
            const s = scoreSemDedupCase(c, survivors);
            return { score: s.score, detail: `exact=${s.exactClusters}/${s.totalClusters} strays=${s.strays}` };
          },
        ),
      );
      opts.onProgress?.(i + 1, total);
    }
  } else {
    total = DESCRIBE_CASES.length;
    for (let i = 0; i < DESCRIBE_CASES.length; i++) {
      const c = DESCRIBE_CASES[i];
      record(
        await runOneCase(
          c.id,
          modelId,
          ctx,
          async (deps) => {
            // describe requires input_file — the dataset carries inline
            // content, so it is written to a throwaway tmp file per case and
            // removed in `finally`, whatever the pipeline call does.
            const dir = mkdtempSync(join(tmpdir(), "llm-ext-describe-bench-"));
            try {
              const filePath = join(dir, c.fileName);
              writeFileSync(filePath, c.content, "utf-8");
              return await runDescribe({ input_file: filePath, max_chars: c.maxChars }, deps);
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          },
          (_raw, save) => {
            const s = scoreDescribeCase(c, save);
            return { score: s.score, detail: `budget=${s.withinBudget} recall=${s.conceptRecall.toFixed(2)}` };
          },
        ),
      );
      opts.onProgress?.(i + 1, total);
    }
  }

  const scores = perCase.map((p) => p.score);
  const aggregate = aggregateTextToolScores(scores, failures.length, total);
  return {
    modelId,
    tool,
    perCase,
    aggregate,
    pass: passesTextToolThresholds(aggregate).pass,
    costUsd: ctx.acc.costUsd,
    meanLatencyMs: ctx.acc.callCount === 0 ? 0 : ctx.acc.latencyMs / ctx.acc.callCount,
    failures,
  };
}
