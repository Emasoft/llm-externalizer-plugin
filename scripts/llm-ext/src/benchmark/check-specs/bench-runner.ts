/**
 * check_against_specs (SPEC ADHERENCE) benchmark runner — P2d.
 *
 * NAMING: this directory ALREADY contains `runner.test.ts`, the hermetic test of the
 * check_against_specs PIPELINE CORE (check-specs/core.ts, extracted in P2a). This file
 * is a different thing — the BENCHMARK runner — so it is `bench-runner.ts` (tested by
 * `bench-runner.test.ts`), exactly as code-task/ and scan-folder/ name theirs.
 *
 * Scores ONE model over the golden corpus by driving the EXACT check_against_specs
 * pipeline (check-specs/core.ts::runCheckAgainstSpecs) in-process: the same argument
 * validation, the same `specs-`-tagged spec block, the same real system prompt, the same
 * mode-0 one-call-per-file loop, the same per-file report assembly.
 *
 * THE ONLY SEAM IS THE LLM. `ensembleStreaming` is check_against_specs's single LLM call
 * site (CheckSpecsDeps.ensembleStreaming); the implementation injected below POSTs the
 * messages the pipeline built — untouched — to OpenRouter through the injected FetchImpl
 * (the same seam the other three benchmark runners use). Nothing about the prompt is
 * re-created here, so there is no second copy of it to drift: the benchmark sends what
 * the server sends.
 *
 * Scoring is DETERMINISTIC and LLM-free: score.ts reads each per-file report's anchored
 * verdict, and the truth is the label the real fix commit established. No judge.
 *
 * FAIL-SAFE POSTURE (same as the other three runners, and here it is load-bearing): the
 * core's mode-0 loop does NOT wrap the LLM call in a try/catch, so a seam that THREW
 * would abort the whole sweep and turn one flaky HTTP call into a zero for the model.
 * The seam therefore never throws for a network/API failure — it records the reason and
 * returns empty content, which the core already handles as a per-file
 * "FAILED: <path> — LLM returned empty response" line and moves on. That file simply has
 * no verdict: it is UNSCORED, which costs coverage (and costs recall if it really was a
 * violation), and the coverage floor stops a badly-degraded run from passing on the
 * strength of the files that did survive.
 */

import { realFetch } from "../../security_scan/openrouter.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import {
  runCheckAgainstSpecs,
  type CheckSpecsDeps,
  type CheckSpecsStreamingResult,
} from "../../check-specs/core.js";
import type { ModelPricing } from "../../mass_scouting/cost-estimate.js";

// The confusion-matrix math is IMPORTED, not re-implemented: this tool's output is the
// same per-file binary verdict search_existing's benchmark already scores, and two copies
// of a confusion matrix drift the day one is fixed. See the header of ./score.ts.
import {
  aggregateScores,
  scoreCase,
  type CaseScore,
  type SectionVerdict,
} from "../search-existing/score.js";
import {
  accuracyOf,
  parseSpecVerdict,
  passesThresholds,
  type CheckSpecsScore,
} from "./score.js";
import {
  CHECK_SPECS_FIXTURES,
  CHECK_SPECS_INSTRUCTIONS,
  expectedViolations,
  fixtureFilePaths,
  resolveFixtureRoot,
  specPath,
  type SpecFixture,
} from "./dataset.js";

/** Default OpenRouter chat/completions endpoint. */
const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Output bound this benchmark puts on the wire, per call. Exported so the P4 pre-flight
 * spend estimate reads the SAME number the request carries — a duplicated literal could
 * silently under-price a sweep.
 */
export const CHECK_SPECS_MAX_OUTPUT_TOKENS = 4096;

/**
 * The single case id. check_against_specs's corpus is ONE spec audited over N files
 * (unlike scan_folder's N queries), so the shared per-case math is fed exactly one case.
 * Named rather than inlined so the report, the cache and the tests all say the same word.
 */
export const CHECK_SPECS_CASE_ID = "testing-md-cost-safety";

export interface CheckSpecsRunOptions {
  apiKey: string;
  /** Per-million-token USD pricing; costUsd is accumulated from each call's usage. */
  pricing: ModelPricing;
  /** OpenRouter endpoint override (tests point this at a fake). */
  apiUrl?: string;
  /**
   * Max completion tokens per call. Default 4096.
   *
   * The visible answer is one anchored line plus a short justification, so the instinct
   * is to clamp this to a few hundred tokens and save money. That instinct broke the
   * code-audit benchmark (P2b) and would break this one identically: on most providers
   * `max_tokens` bounds reasoning + visible content TOGETHER, so a tight cap truncates a
   * REASONING model mid-thought, it emits no verdict line, and the scorer reads that as
   * "no parseable verdict" — the benchmark would systematically fail an entire class of
   * model for being thoughtful. check_against_specs does not REQUIRE reasoning (registry:
   * requireReasoning false) but reasoning models are perfectly valid candidates, so the
   * cap must not discriminate against them. 4096 costs nothing unless actually spent.
   */
  maxTokens?: number;
  /** Per-call timeout. Default 300_000ms. */
  perCallTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/** A file whose LLM call never produced a report. */
export interface FileFailure {
  file: string;
  reason: string;
}

export interface CheckSpecsRunResult {
  modelId: string;
  caseScores: CaseScore[];
  aggregate: CheckSpecsScore;
  /** Reported, never gated — see score.ts::accuracyOf. */
  accuracy: number;
  /** True iff the aggregate clears DEFAULT_CHECK_SPECS_THRESHOLDS. */
  pass: boolean;
  costUsd: number;
  meanLatencyMs: number;
  failures: FileFailure[];
  /** The rule each VIOLATION line named, for a human reading the report. NOT graded. */
  citedRules: { file: string; citedRule: string }[];
}

/** The slice of the OpenRouter chat/completions response we consume. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * The SOURCE file's path, out of the user message the pipeline built.
 *
 * readFileAsCodeBlock wraps a source file as `<filename>\n<path>\n</filename>` and the
 * SPEC as `<specs-filename>…</specs-filename>` (scan-pipeline.ts:306) — two distinct
 * tags, on purpose, so the model can tell the rules from the code. `<specs-filename>`
 * does not contain the substring `<filename>`, so this pattern reads the source file and
 * only the source file.
 *
 * It reads the USER message, never the system prompt: the system prompt carries
 * FILE_FORMAT_EXAMPLE, which contains a `<filename>` PLACEHOLDER. P2c's runner scraped the
 * wrong block for exactly this reason, matched the placeholder, and silently benchmarked
 * nothing while its tests went green. Hence: read the user message, and make the caller
 * verify the path it got is a real fixture (below) rather than trusting it.
 */
function sourcePathFromUserMessage(userContent: string): string | null {
  const m = /<filename>\n([^\n]+)\n<\/filename>/.exec(userContent);
  return m ? m[1] : null;
}

/**
 * Run the spec-adherence benchmark for a single model over the corpus.
 *
 * ONE runCheckAgainstSpecs call for the whole corpus (not one per file): the pipeline
 * itself loops to one LLM call per input file in mode 0, which is the thing under test.
 * Driving the real pipeline — rather than looping over files ourselves — is what makes
 * this a benchmark of check_against_specs and not of an ad-hoc prompt that resembles it.
 */
export async function runCheckSpecsBenchmarkOnModel(
  modelId: string,
  fixtures: readonly SpecFixture[] = CHECK_SPECS_FIXTURES,
  opts: CheckSpecsRunOptions = {
    apiKey: "",
    pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: 0 },
  },
  fetchImpl: FetchImpl = realFetch,
): Promise<CheckSpecsRunResult> {
  const fixtureRoot = resolveFixtureRoot();
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const maxTokens = opts.maxTokens ?? CHECK_SPECS_MAX_OUTPUT_TOKENS;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 300_000;

  const files = fixtureFilePaths(fixtures, fixtureRoot);
  const expected = expectedViolations(fixtures, fixtureRoot);
  const known = new Set(files);

  let costUsd = 0;
  let latencyTotalMs = 0;
  let callCount = 0;
  let filesDone = 0;

  /** resolved file path → the model's raw per-file report. */
  const reports = new Map<string, string>();
  /**
   * resolved file path → why its call produced no report.
   *
   * Recorded HERE, at the seam, because the pipeline does not hand the reason back: a
   * failed per-file call in mode 0 is rendered into the returned TEXT as
   * "FAILED: <path> — LLM returned empty response" and the structured error is lost.
   * A benchmark must not scrape a human-readable summary to learn why a call failed —
   * "API error 429: rate limited" and "the model returned nothing" are completely
   * different facts about a run, and a report that flattened both would hide a
   * rate-limited (i.e. invalid) sweep behind a plausible-looking score.
   */
  const errors = new Map<string, string>();

  const ensembleStreaming: CheckSpecsDeps["ensembleStreaming"] = async (
    messages,
  ): Promise<CheckSpecsStreamingResult> => {
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";
    const filePath = sourcePathFromUserMessage(userContent);
    // A path we cannot place is a bug in THIS runner (a changed tag format, a scraped
    // placeholder, a path-form drift), not evidence about a model. Fail loudly instead
    // of scoring a phantom: an unattributable report would silently become an unscored
    // file for every model, which reads as "the model answered nothing".
    if (filePath === null || !known.has(filePath)) {
      throw new Error(
        `check-specs benchmark: could not attribute an LLM call to a corpus file.\n` +
          `  parsed <filename>: ${filePath ?? "(none found in the user message)"}\n` +
          `  corpus expects e.g.: ${files[0]}\n` +
          `The prompt's file-tag format or the fixture path form has drifted. Fix the runner — do not score this run.`,
      );
    }

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
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(perCallTimeoutMs),
      });
    } catch (err) {
      // Network/timeout. Return empty content rather than throwing: the core's mode-0
      // loop has no try/catch around this call, so a throw would abort the entire sweep.
      // Empty content is a shape it already understands (a per-file FAILED line).
      const reason = `request failed: ${(err as Error).message}`;
      errors.set(filePath, reason);
      return emptyResult(modelId);
    } finally {
      latencyTotalMs += Date.now() - started;
      callCount++;
      filesDone++;
      if (opts.onProgress) opts.onProgress(filesDone, files.length);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const reason = `API error ${res.status}: ${bodyText.slice(0, 300)}`;
      errors.set(filePath, reason);
      return emptyResult(modelId);
    }

    // Same trap as code-task/bench-runner.ts: a 200 with an empty/truncated body
    // throws out of the sweep and costs every OTHER model its run. Degrade to the
    // per-file failure shape the non-2xx branch above already uses.
    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      errors.set(
        filePath,
        `malformed response body (HTTP ${res.status}): ${(err as Error).message}`,
      );
      return emptyResult(modelId);
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
    if (content.trim().length === 0) {
      errors.set(filePath, "LLM returned empty response");
      return emptyResult(modelId);
    }
    reports.set(filePath, content);
    return {
      content,
      model: modelId,
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens:
              (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
          }
        : undefined,
      finishReason: "stop",
      truncated: false,
    };
  };

  const deps: CheckSpecsDeps = {
    // The benchmark scores ONE model at a time, so the multi-model ensemble is off —
    // otherwise the score would belong to the ensemble, not to the candidate.
    useEnsemble: false,
    normalizePaths: (raw) => {
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
    },
    // No folder_path is passed (the corpus is an explicit, ordered file list — a folder
    // walk would also sweep up the fixture README and audit it as a fourteenth "file").
    // Unreachable; a clear error rather than a silent empty list if that ever changes.
    resolveFolderPath: () => ({
      files: [],
      error:
        "check-specs benchmark passes input_files_paths, never folder_path",
    }),
    ensembleStreaming,
    // No footer. The real one records usage + writes to the global ledger (index.ts side
    // effects a benchmark must not have); usage is accumulated at the seam above instead,
    // from the same response body. An empty footer also keeps the scored text EXACTLY the
    // model's own output, with nothing appended that a verdict regex could trip over.
    formatFooter: () => "",
    // Mode 0 calls saveResponse once per file. The report is already captured at the seam
    // (keyed by the file the call was FOR, which is stronger than trusting loop order), so
    // this returns a marker rather than writing anything: a benchmark must not litter the
    // user's report directory with 13 files per model per run.
    saveResponse: (_tool, _content, meta) =>
      `memory://${meta.inputFile ?? "unknown"}`,
    ensembleModelLabel: () => modelId,
    resolveDefaultMaxTokens: () => maxTokens,
  };

  const args: Record<string, unknown> = {
    spec_file_path: specPath(fixtureRoot),
    input_files_paths: files,
    instructions: CHECK_SPECS_INSTRUCTIONS,
    scan_secrets: false,
    redact_secrets: false,
    // Mode 0 — one LLM call and one report per file. Mode 1/2 would batch several files
    // into a single call and merge the findings into one document, destroying the per-file
    // boundary this benchmark scores on.
    answer_mode: 0,
  };

  const result = await runCheckAgainstSpecs(args, deps);

  // A validation failure (bad spec path, empty file list) returns isError with NO calls
  // made. That is a broken run, not a zero-scoring model, and scoring it would quietly
  // report every candidate as hopeless.
  if (result.isError && reports.size === 0 && errors.size === 0) {
    throw new Error(
      `check-specs benchmark: the pipeline refused the run before any LLM call — ` +
        `${result.content.map((p) => p.text).join(" ")}`,
    );
  }

  const verdicts = new Map<string, SectionVerdict>();
  const failures: FileFailure[] = [];
  const citedRules: { file: string; citedRule: string }[] = [];

  for (const file of files) {
    const report = reports.get(file);
    if (report === undefined) {
      // No report: the call failed, or the pipeline never reached the file. Either way
      // there is no verdict, so the file is UNSCORED — it costs coverage, and recall too
      // if it was a violation. It is never dropped from the denominator.
      failures.push({ file, reason: errors.get(file) ?? "no report produced" });
      continue;
    }
    const parsed = parseSpecVerdict(report);
    verdicts.set(file, parsed.verdict);
    if (parsed.verdict === "yes" && parsed.citedRule) {
      citedRules.push({ file, citedRule: parsed.citedRule });
    }
  }

  const caseScores = [
    scoreCase(CHECK_SPECS_CASE_ID, files, expected, verdicts),
  ];
  const aggregate = aggregateScores(caseScores);

  return {
    modelId,
    caseScores,
    aggregate,
    accuracy: accuracyOf(aggregate),
    pass: passesThresholds(aggregate).pass,
    costUsd,
    meanLatencyMs: callCount === 0 ? 0 : latencyTotalMs / callCount,
    failures,
    citedRules,
  };
}

/** An empty-content result — the shape the core reads as "this file produced nothing". */
function emptyResult(modelId: string): CheckSpecsStreamingResult {
  return {
    content: "",
    model: modelId,
    finishReason: "error",
    truncated: false,
  };
}
