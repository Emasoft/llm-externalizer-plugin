/**
 * search_existing_implementations benchmark runner (TRDD-828238b5 A6).
 *
 * Scores ONE model over the golden fixture dataset by driving the EXACT
 * search_existing_implementations pipeline (search-existing/core.ts) in-process:
 * the same FFD bin-packed batching, the same per-file-section prompt contract,
 * the same merged-report assembly. The benchmark therefore measures the model's
 * judgment as the tool will actually use it — not an ad-hoc prompt.
 *
 * Unlike the free-form review tools, the output is a per-file binary verdict
 * (NO / YES), so it is scored MECHANICALLY against the golden dataset
 * (precision/recall/F1) with no LLM judge: the pipeline's own
 * splitPerFileSections extracts the per-file sections from the merged report,
 * score.ts classifies each section, and scoreCase pools the confusion counts.
 *
 * Like the security-triage runner, this never aborts the sweep on a model/API
 * failure: classifyError is wired to report every error as recoverable
 * (unrecoverable:false, serviceLevel:false), so a bad batch is recorded as a
 * batch error and the run continues. A pipeline-level FAILED (isError) for a
 * whole case is recorded as a case failure and scored with an empty verdict
 * map (every scanned file unscored → its expected-YES files become false
 * negatives), so a degraded model simply scores poorly rather than throwing.
 *
 * HTTP is injected via FetchImpl (the security_scan judge's seam) so the whole
 * loop is unit-testable without a network mock layer. Real callers wire it to
 * realFetch; tests inject a fake that returns canned chat-completions JSON.
 */

import { resolve } from "node:path";

import { realFetch } from "../../security_scan/openrouter.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import { splitPerFileSections } from "../../grouping.js";
import {
  runSearchExistingImplementations,
  type SeiChatMessage,
  type SeiDeps,
} from "../../search-existing/core.js";
import type { ModelPricing } from "../../mass_scouting/cost-estimate.js";

import {
  SEARCH_EXISTING_CASES,
  resolveFixtureRoot,
  listFixtureFiles,
  type SearchExistingCase,
} from "./dataset.js";
import {
  parseSectionVerdict,
  scoreCase,
  aggregateScores,
  passesThresholds,
  type CaseScore,
  type SectionVerdict,
  type SearchExistingScore,
} from "./score.js";

/** Default OpenRouter chat/completions endpoint. */
const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Output bound this benchmark puts on the wire, per call. Exported so the P4
 * pre-flight spend estimate reads the SAME number the request carries — a
 * duplicated literal could silently under-price a sweep.
 */
export const SEARCH_EXISTING_MAX_OUTPUT_TOKENS = 8192;

export interface SearchExistingRunOptions {
  apiKey: string;
  /**
   * Per-million-token USD pricing (the ModelPricing shape from
   * mass_scouting/cost-estimate). costUsd is accumulated from each call's
   * usage.{prompt_tokens, completion_tokens} against these rates.
   */
  pricing: ModelPricing;
  /** OpenRouter endpoint override (tests point this at a local fake). */
  apiUrl?: string;
  /** Max completion tokens per call. Default 8192. */
  maxTokens?: number;
  /** Sampling temperature. Default 0.1 (near-deterministic). */
  temperature?: number;
  /** Per-call timeout. Default 600_000ms. */
  perCallTimeoutMs?: number;
  /** Coarse progress callback (cases done, total). */
  onProgress?: (done: number, total: number) => void;
}

/** A whole case that the pipeline FAILED (returned isError). */
export interface CaseFailure {
  caseId: string;
  reason: string;
}

export interface SearchExistingRunResult {
  modelId: string;
  /** Per-case deterministic scores (one per dataset case). */
  caseScores: CaseScore[];
  /** Micro/macro aggregate over every case. */
  aggregate: SearchExistingScore;
  /** True iff the aggregate clears DEFAULT_SEARCH_EXISTING_THRESHOLDS. */
  pass: boolean;
  /** Total USD spent (sum of every batch call's usage × pricing). */
  costUsd: number;
  /** Mean per-call latency across every batch call (ms). 0 when no call ran. */
  meanLatencyMs: number;
  /** Cases the pipeline FAILED outright (scored as all-unscored). */
  failures: CaseFailure[];
}

/** Resolve a fixture-relative path to an absolute on-disk path. */
function abs(root: string, rel: string): string {
  return resolve(root, rel);
}

/**
 * Shape of the OpenRouter chat/completions response we consume. Only the two
 * fields the runner reads are typed; everything else is ignored.
 */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Run the benchmark for a single model over the dataset.
 *
 * For each case: build the real pipeline args (answer_mode 2 → single merged
 * report; secrets off; gitignore off), wire a SeiDeps whose callModel does a
 * raw OpenRouter POST via fetchImpl and whose saveResponse tees the merged
 * report into memory, run the pipeline, then score the captured report's
 * per-file sections against the case's expected-YES set.
 */
export async function runSearchExistingBenchmarkOnModel(
  modelId: string,
  cases: readonly SearchExistingCase[] = SEARCH_EXISTING_CASES,
  opts: SearchExistingRunOptions = {
    apiKey: "",
    pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: 0 },
  },
  fetchImpl: FetchImpl = realFetch,
): Promise<SearchExistingRunResult> {
  const fixtureRoot = resolveFixtureRoot();
  const allFixtureRel = listFixtureFiles(fixtureRoot);
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const maxTokens = opts.maxTokens ?? SEARCH_EXISTING_MAX_OUTPUT_TOKENS;
  const temperature = opts.temperature ?? 0.1;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 600_000;

  let costUsd = 0;
  let latencyTotalMs = 0;
  let callCount = 0;
  const caseScores: CaseScore[] = [];
  const failures: CaseFailure[] = [];

  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];

    // Files the pipeline will scan for THIS case: every fixture file whose
    // extension the case scans, minus its reference source_files (the pipeline
    // excludes those). Absolute paths — scoreCase + splitPerFileSections both
    // key on the same absolute form the pipeline emits in its `## File:` lines.
    const sourceRel = new Set(c.sourceFiles ?? []);
    const scannedAbs = allFixtureRel
      .filter((rel) => c.extensions.some((ext) => rel.endsWith(ext)))
      .filter((rel) => !sourceRel.has(rel))
      .map((rel) => abs(fixtureRoot, rel));
    const expectedYesAbs = new Set(
      c.expectedYes.map((rel) => abs(fixtureRoot, rel)),
    );

    // In-memory tee: the pipeline calls saveResponse exactly once in mode 2
    // with the full merged report (per-file `## File:` sections embedded inside
    // per-batch wrappers). We capture that text and return a pseudo path.
    let capturedMergedReport = "";
    const saveResponse: SeiDeps["saveResponse"] = (_tool, content) => {
      capturedMergedReport = content;
      return `memory://case/${c.id}`;
    };

    const callModel: SeiDeps["callModel"] = async (
      messages: SeiChatMessage[],
    ) => {
      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(perCallTimeoutMs),
        });
      } finally {
        latencyTotalMs += Date.now() - started;
        callCount++;
      }
      if (!res.ok) {
        // Snapshot a bounded slice of the error body for the batch record. The
        // pipeline records this as a batch error (classifyError → recoverable),
        // so the sweep is never aborted by a single bad batch.
        const bodyText = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${bodyText.slice(0, 500)}`);
      }
      // Same trap as code-task/bench-runner.ts, but this runner signals failure by
      // THROWING — the caller classifies it as a recoverable batch error, so the
      // sweep survives. A bare res.json() throws a bare SyntaxError instead, which
      // reads as "Unexpected end of JSON input" with no HTTP context. Rethrow it in
      // the same shape as the non-2xx branch above so the batch record is legible.
      let json: ChatCompletionResponse;
      try {
        json = (await res.json()) as ChatCompletionResponse;
      } catch (err) {
        throw new Error(
          `malformed response body (HTTP ${res.status}): ${(err as Error).message}`,
          {
            cause: err,
          },
        );
      }
      const usage = json.usage;
      if (usage) {
        costUsd +=
          ((usage.prompt_tokens ?? 0) / 1_000_000) *
            opts.pricing.input_per_m_usd +
          ((usage.completion_tokens ?? 0) / 1_000_000) *
            opts.pricing.output_per_m_usd;
      }
      const content = json.choices?.[0]?.message?.content ?? "";
      return { content, model: modelId };
    };

    const deps: SeiDeps = {
      useEnsemble: false,
      backendModel: modelId,
      callModel,
      // Never abort the sweep: every error is recoverable + non-service-level,
      // so the pipeline records it as a per-batch error and continues. A whole
      // case that produces zero usable output still returns isError (handled
      // below), but a single bad batch within a multi-batch case does not stop.
      classifyError: () => ({
        reason: "benchmark batch error",
        unrecoverable: false,
        serviceLevel: false,
      }),
      saveResponse,
      ensembleModelLabel: () => modelId,
      // No onProgress / outputDir for the in-memory benchmark.
    };

    const args: Record<string, unknown> = {
      feature_description: c.featureDescription,
      folder_path: fixtureRoot,
      extensions: c.extensions,
      answer_mode: 2,
      use_gitignore: false,
      scan_secrets: false,
      redact_secrets: false,
    };
    if (c.sourceFiles && c.sourceFiles.length > 0) {
      args.source_files = c.sourceFiles.map((rel) => abs(fixtureRoot, rel));
    }

    const result = await runSearchExistingImplementations(args, deps);

    if (result.isError) {
      // Pipeline-level FAILED: no usable merged report. Record the failure and
      // score the case with an EMPTY verdict map — every scanned file is
      // unscored, turning each expected-YES into a false negative. The model is
      // penalized for the failure rather than the case being silently dropped.
      const reason =
        result.content
          .map((p) => p.text)
          .join("\n")
          .split("\n")[0] ?? "pipeline FAILED";
      failures.push({ caseId: c.id, reason });
      caseScores.push(
        scoreCase(
          c.id,
          scannedAbs,
          expectedYesAbs,
          new Map<string, SectionVerdict>(),
        ),
      );
      if (opts.onProgress) opts.onProgress(ci + 1, cases.length);
      continue;
    }

    // Extract per-file sections from the captured merged report and classify
    // each. splitPerFileSections finds the `## File: <abs>` markers inside the
    // per-batch wrappers; parseSectionVerdict maps each body to yes/no/unparseable.
    const sections = splitPerFileSections(capturedMergedReport, scannedAbs);
    const verdicts = new Map<string, SectionVerdict>();
    for (const [path, body] of sections) {
      verdicts.set(path, parseSectionVerdict(body));
    }

    caseScores.push(scoreCase(c.id, scannedAbs, expectedYesAbs, verdicts));
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
