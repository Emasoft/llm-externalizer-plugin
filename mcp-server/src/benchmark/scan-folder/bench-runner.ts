/**
 * scan_folder (MASS SEARCH) benchmark runner — P2c.
 *
 * NAMING: this directory ALREADY contains `runner.test.ts`, the hermetic test of
 * the scan_folder PIPELINE CORE (scan-folder/core.ts). This file is a different
 * thing — the BENCHMARK runner — so it is `bench-runner.ts` (tested by
 * `bench-runner.test.ts`), exactly as code-task/ names its own. Calling it
 * `runner.ts` would read as the subject of that pre-existing test.
 *
 * Scores ONE model over the golden corpus by driving the EXACT scan_folder
 * pipeline (scan-folder/core.ts::runScanFolder) in-process, once per query: the
 * same input validation, the same walkDir discovery, the same rate-limited
 * parallel per-file dispatch, the same mode-0 report assembly.
 *
 * THE ONLY SEAM IS THE LLM. `processFileCheck` is scan_folder's per-file LLM seam
 * (ScanFolderDeps.processFileCheck); the injected implementation below reproduces
 * index.ts::processFileCheck's message assembly from the SAME exported helpers it
 * uses — readFileAsCodeBlock + detectLang + buildPreInstructions +
 * codeTaskSystemPrompt — so there is no second copy of the prompt to drift, then
 * POSTs to OpenRouter through the injected FetchImpl (the seam
 * search-existing/runner.ts and code-task/bench-runner.ts both use). Instead of
 * writing a report to disk it tees the model's text into memory and returns a
 * `memory://` path, which in mode 0 is all the pipeline does with it.
 *
 * Scoring is DETERMINISTIC and LLM-free: score.ts reads each per-file report's
 * anchored verdict, and the truth set is derived from the corpus bytes. No judge.
 *
 * FAIL-SAFE POSTURE (same as the other three runners): a model/API failure never
 * aborts the sweep. A file whose call failed simply has no verdict — it is UNSCORED,
 * which costs coverage (and costs recall if it really was a match). The coverage
 * floor then stops a badly-degraded run from passing on the strength of the files
 * that did survive.
 */

import { resolve } from "node:path";

import { realFetch } from "../../security_scan/openrouter.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import {
  buildPreInstructions,
  detectLang,
  readFileAsCodeBlock,
  codeTaskSystemPrompt,
} from "../../scan-pipeline.js";
import {
  runScanFolder,
  type ScanFolderDeps,
  type ScanFolderFileResult,
} from "../../scan-folder/core.js";
import type { ModelPricing } from "../../mass_scouting/cost-estimate.js";

// The confusion-matrix math is IMPORTED, not re-implemented: scan_folder's output
// is the same per-file binary verdict search_existing's benchmark already scores,
// and two copies of a confusion matrix drift the day one is fixed. See the header
// of ./score.ts. The scan_folder-specific half (the anchor contract, the gate)
// lives in ./score.ts.
import { aggregateScores, scoreCase, type CaseScore, type SectionVerdict } from "../search-existing/score.js";
import { parseFileVerdict, passesThresholds, type ScanFolderScore } from "./score.js";
import {
  SCAN_FOLDER_CASES,
  buildInstructions,
  deriveMatchingFiles,
  fixtureAbsPath,
  fixtureScanRoot,
  resolveFixtureRoot,
  scannedFilesFor,
  type ScanFolderCase,
} from "./dataset.js";

/** Default OpenRouter chat/completions endpoint. */
const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ScanFolderRunOptions {
  apiKey: string;
  /** Per-million-token USD pricing; costUsd is accumulated from each call's usage. */
  pricing: ModelPricing;
  /** OpenRouter endpoint override (tests point this at a fake). */
  apiUrl?: string;
  /**
   * Max completion tokens per call. Default 4096.
   *
   * The visible answer is ONE anchored line, so the instinct is to clamp this to a
   * few hundred tokens and save money. That instinct broke the code-audit benchmark
   * (P2b) and it would break this one for the same reason: on most providers
   * `max_tokens` bounds reasoning + visible content TOGETHER, so a tight cap
   * truncates a REASONING model mid-thought, it emits no verdict line, and the
   * scorer reads that as "no parseable verdict" — i.e. the benchmark would
   * systematically fail an entire class of model for being thoughtful.
   *
   * scan_folder does not REQUIRE reasoning (registry: requireReasoning false), but
   * reasoning models are perfectly valid candidates for it, so the cap must not
   * discriminate against them. 4096 leaves room to think and costs nothing unless
   * it is actually spent — a real answer is ~30-150 tokens.
   */
  maxTokens?: number;
  /** Sampling temperature. Default 0.1 (near-deterministic — the tool's own). */
  temperature?: number;
  /** Per-call timeout. Default 300_000ms. */
  perCallTimeoutMs?: number;
  /**
   * Rate budget handed to the pipeline's REAL parallel executor. Modest by
   * default: the corpus is small, and a benchmark that trips a provider's rate
   * limiter would score the limiter, not the model.
   */
  rps?: number;
  maxInFlight?: number;
  onProgress?: (done: number, total: number) => void;
}

/** A file whose per-file LLM call never produced a report. */
export interface FileFailure {
  caseId: string;
  file: string;
  reason: string;
}

export interface ScanFolderRunResult {
  modelId: string;
  caseScores: CaseScore[];
  aggregate: ScanFolderScore;
  /** True iff the aggregate clears DEFAULT_SCAN_FOLDER_THRESHOLDS. */
  pass: boolean;
  costUsd: number;
  meanLatencyMs: number;
  failures: FileFailure[];
  /** MATCH-line citations, per case, for a human reading the report. NOT graded. */
  evidence: { caseId: string; file: string; evidence: string }[];
}

/** The slice of the OpenRouter chat/completions response we consume. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Run the mass-search benchmark for a single model over the corpus.
 *
 * ONE runScanFolder call per QUERY (not per file): the pipeline itself fans out to
 * one LLM call per file, which is the thing under test. Driving the real pipeline
 * — rather than looping over files ourselves — is what makes this a benchmark of
 * scan_folder and not of an ad-hoc prompt that resembles it.
 */
export async function runScanFolderBenchmarkOnModel(
  modelId: string,
  cases: readonly ScanFolderCase[] = SCAN_FOLDER_CASES,
  opts: ScanFolderRunOptions = {
    apiKey: "",
    pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: 0 },
  },
  fetchImpl: FetchImpl = realFetch,
): Promise<ScanFolderRunResult> {
  const fixtureRoot = resolveFixtureRoot();
  const scanRoot = fixtureScanRoot(fixtureRoot);
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.1;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 300_000;

  let costUsd = 0;
  let latencyTotalMs = 0;
  let callCount = 0;
  const caseScores: CaseScore[] = [];
  const failures: FileFailure[] = [];
  const evidence: { caseId: string; file: string; evidence: string }[] = [];

  let filesDone = 0;
  const totalFiles = cases.reduce((n, c) => n + scannedFilesFor(c, fixtureRoot).length, 0);

  for (const c of cases) {
    // Truth is recomputed from the fixture bytes on every run — the corpus is the
    // single source of the expected answer (dataset.ts::deriveMatchingFiles).
    // Both sides are resolve()d so the pipeline's walkDir paths and ours are the
    // same string; a rel-vs-abs mismatch would silently score every file as
    // unscored, so it is checked for explicitly below rather than trusted.
    const scanned = scannedFilesFor(c, fixtureRoot).map((rel) =>
      resolve(fixtureAbsPath(rel, fixtureRoot)),
    );
    const expectedMatch = new Set(
      deriveMatchingFiles(c, fixtureRoot).map((rel) => resolve(fixtureAbsPath(rel, fixtureRoot))),
    );

    /** filePath (resolved) → the model's raw per-file report. */
    const reports = new Map<string, string>();
    /**
     * filePath (resolved) → why its call produced no report.
     *
     * Recorded HERE, at the seam, because the pipeline does not hand the reason
     * back: a per-file failure in mode 0 is rendered into the summary TEXT
     * ("FAILED:\n  <path>: <error>") and the structured error is not returned. The
     * benchmark must not scrape a human-readable summary to learn why a call
     * failed — "API error 429: rate limited" and "LLM returned empty response" are
     * completely different facts about a model, and a report that flattened both
     * to "no report produced" would hide a rate-limited (i.e. invalid) run.
     */
    const errors = new Map<string, string>();

    const processFileCheck: ScanFolderDeps["processFileCheck"] = async (
      filePath,
      task,
      options,
    ): Promise<ScanFolderFileResult> => {
      // Byte-for-byte index.ts::processFileCheck's message assembly, built from the
      // SAME shared helpers it imports — so the benchmark sends the prompt the
      // server really sends, and there is no copy to drift.
      const codeBlock = readFileAsCodeBlock(
        filePath,
        undefined,
        options.redact,
        options.maxBytes,
        options.regexRedact,
      );
      const messages = [
        { role: "system", content: codeTaskSystemPrompt(detectLang(filePath)) },
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
        // Network/timeout: report it as a per-file failure (the shape the pipeline
        // understands) instead of throwing out of the sweep. Throwing would enter
        // the core's 3-attempt retry ladder and, after three consecutive failures,
        // ABORT the whole batch — turning one flaky call into a zero for the model.
        const reason = `request failed: ${(err as Error).message}`;
        errors.set(resolve(filePath), reason);
        return { filePath, success: false, error: reason };
      } finally {
        latencyTotalMs += Date.now() - started;
        callCount++;
        filesDone++;
        if (opts.onProgress) opts.onProgress(filesDone, totalFiles);
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const reason = `API error ${res.status}: ${bodyText.slice(0, 300)}`;
        errors.set(resolve(filePath), reason);
        return { filePath, success: false, error: reason };
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
        const reason = "LLM returned empty response";
        errors.set(resolve(filePath), reason);
        return { filePath, success: false, error: reason };
      }
      reports.set(resolve(filePath), content);
      return { filePath, success: true, reportPath: `memory://${c.id}/${filePath}` };
    };

    const deps: ScanFolderDeps = {
      // The benchmark scores ONE model at a time, so the multi-model ensemble is
      // off — otherwise the score would belong to the ensemble, not the candidate.
      useEnsemble: false,
      backendModel: modelId,
      processFileCheck,
      // The seam above never throws (every failure is returned as a
      // FileProcessResult), so this is only reachable if the pipeline itself throws.
      // It is deliberately NOT service-level: a service-level verdict ABORTS the
      // whole batch and would let one unexpected error erase a model's remaining
      // files. `unrecoverable` skips the retry ladder — a benchmark must not spend
      // three attempts (plus backoff) on a bug in its own runner.
      classifyError: (err) => ({
        reason: err instanceof Error ? err.message : String(err),
        unrecoverable: true,
        serviceLevel: false,
      }),
      // Mode 0 never calls saveResponse (it only lists the per-file report paths),
      // so this is unreachable. Return a marker rather than writing anything: a
      // benchmark must not litter the user's report directory.
      saveResponse: () => `memory://${c.id}`,
      getRateLimitConfig: async () => ({
        rps: opts.rps ?? 2,
        maxInFlight: opts.maxInFlight ?? 3,
      }),
      resolveDefaultMaxTokens: () => maxTokens,
    };

    const args: Record<string, unknown> = {
      folder_path: scanRoot,
      instructions: buildInstructions(c.criterion),
      extensions: c.extensions,
      // The fixture dir is inside a git repo, and `git ls-files` would honour the
      // repo's ignore rules; the manual walk is what makes the corpus the corpus.
      use_gitignore: false,
      scan_secrets: false,
      redact_secrets: false,
      // Mode 0 — one report per file. Mode 2 would merge them into one document and
      // throw away the per-file boundary this benchmark scores on.
      answer_mode: 0,
    };

    const result = await runScanFolder(args, deps);

    // A path-form drift (rel vs abs, symlinked root) would silently produce an
    // all-unscored case that reads as "the model answered nothing". That is a bug
    // in THIS runner, not evidence about a model, so it fails loudly.
    if (reports.size > 0 && !scanned.some((f) => reports.has(f))) {
      throw new Error(
        `scan-folder benchmark: the pipeline reported on ${reports.size} file(s), none of which match the dataset's paths. ` +
          `Dataset sees e.g. ${scanned[0]}; the pipeline produced e.g. ${[...reports.keys()][0]}. ` +
          `The fixture path form has drifted — fix the runner rather than scoring a phantom result.`,
      );
    }

    const verdicts = new Map<string, SectionVerdict>();
    for (const file of scanned) {
      const report = reports.get(file);
      if (report === undefined) {
        // No report: the per-file call failed, or the pipeline never reached the
        // file (batch abort / validation error). Either way there is no verdict, so
        // the file is UNSCORED — it costs coverage, and recall too if it was a
        // match. It is never dropped from the denominator.
        //
        // The seam's own reason wins; the pipeline's summary line is the fallback
        // for a file it never dispatched at all (e.g. a validation error, where no
        // call was ever made and so no per-file reason exists).
        const reason =
          errors.get(file) ??
          (result.isError
            ? result.content.map((p) => p.text).join("\n").split("\n")[0]
            : "no report produced");
        failures.push({ caseId: c.id, file, reason });
        continue;
      }
      const parsed = parseFileVerdict(report);
      verdicts.set(file, parsed.verdict);
      if (parsed.verdict === "yes" && parsed.evidence) {
        evidence.push({ caseId: c.id, file, evidence: parsed.evidence });
      }
    }

    caseScores.push(scoreCase(c.id, scanned, expectedMatch, verdicts));
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
    evidence,
  };
}
