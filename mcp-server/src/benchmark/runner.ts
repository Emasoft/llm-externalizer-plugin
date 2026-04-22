/**
 * Per-model OpenRouter call for the benchmark.
 *
 * Sends one chat-completion request per candidate model. The prompt
 * contains all 5 fixture files and the three keyword substrings, and
 * the response is constrained to a strict JSON schema with exactly
 * three arrays of function names. No agentic loop, no retries on bad
 * output — the point of the benchmark is to compare models as-is under
 * the same conditions.
 *
 * The runner records:
 *   - raw response body (for post-hoc inspection)
 *   - parsed arrays
 *   - input/output token counts (from the provider's `usage` block)
 *   - wall-clock latency
 *
 * Structured-output errors, 429 rate-limits, 5xx backend errors, and
 * malformed JSON are all captured as `RunError` instances rather than
 * thrown — one bad model must not abort the whole benchmark sweep.
 */

import type { Fixture } from "./ground-truth.js";
import type { QualifiedModel } from "./discover.js";

export interface RunResult {
  modelId: string;
  ok: true;
  kw1: string[];
  kw2: string[];
  kw3: string[];
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  providerFinishReason: string | null;
  rawResponse: string;
  /**
   * True when the model used the exact schema field names
   * (`kw1_functions`, `kw2_functions`, `kw3_functions`). False when we
   * had to fall back to the short-name synonyms (`kw1`, `kw2`, `kw3`) —
   * a soft schema-compliance failure that gets reported but does not
   * fail the run outright.
   */
  schemaCompliant: boolean;
}

export interface RunError {
  modelId: string;
  ok: false;
  error: string;
  httpStatus?: number;
  latencyMs: number;
  rawResponse?: string;
}

export type RunOutcome = RunResult | RunError;

export interface RunnerOptions {
  apiKey: string;
  /** Extra headers OpenRouter uses to attribute traffic for analytics. */
  httpReferer?: string;
  xTitle?: string;
  /** Per-call timeout in ms. Default 10 min — matches `bin/llm-ext`. */
  timeoutMs?: number;
  /** If set, call each model with `reasoning: { effort: <effort> }`. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Pass a specific seed for models that respect it. */
  seed?: number;
}

const SYSTEM_PROMPT =
  "You are a precise static-analysis classifier. Given several TypeScript " +
  "source files and three literal keyword substrings, return — in the required " +
  "JSON schema — the sorted list of top-level function names whose body " +
  "contains each keyword. Do not list a function more than once per array, do " +
  "not list nested helpers, and do not list functions that do not contain the " +
  "given substring. Only the literal substring counts; semantically-equivalent " +
  "code does not.";

function buildUserPrompt(keywords: readonly string[], fixtures: readonly Fixture[]): string {
  const fileSection = fixtures
    .map((f) => `\n### ${f.filename}\n\`\`\`typescript\n${f.source}\n\`\`\`\n`)
    .join("");
  const kwSection = keywords
    .map((kw, i) => `  - kw${i + 1}: ${JSON.stringify(kw)}`)
    .join("\n");
  return [
    `There are 5 TypeScript files below. For each of the following three keyword substrings, return the alphabetically-sorted array of top-level function names whose body contains that exact substring (case-sensitive, plain text match — not a regex).`,
    ``,
    `Keywords:`,
    kwSection,
    ``,
    `A function "contains" a keyword iff the literal substring appears anywhere between the opening \`{\` and closing \`}\` of its body (or between the \`=>\` and statement end for expression-bodied arrows). Matches in comments and string literals count. A function that contains none of the keywords must NOT appear in any array. Each function contains AT MOST ONE of the keywords.`,
    ``,
    `Files:`,
    fileSection,
  ].join("\n");
}

function responseSchema(keywords: readonly string[]): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "keyword_classification",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kw1_functions", "kw2_functions", "kw3_functions"],
        properties: {
          kw1_functions: {
            type: "array",
            description: `Function names whose body contains ${JSON.stringify(keywords[0])}`,
            items: { type: "string" },
          },
          kw2_functions: {
            type: "array",
            description: `Function names whose body contains ${JSON.stringify(keywords[1])}`,
            items: { type: "string" },
          },
          kw3_functions: {
            type: "array",
            description: `Function names whose body contains ${JSON.stringify(keywords[2])}`,
            items: { type: "string" },
          },
        },
      },
    },
  };
}

export async function runBenchmarkOnModel(
  model: QualifiedModel,
  keywords: readonly string[],
  fixtures: readonly Fixture[],
  options: RunnerOptions,
): Promise<RunOutcome> {
  const t0 = performance.now();
  const timeoutMs = options.timeoutMs ?? 600_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("benchmark timeout"), timeoutMs);

  const requestBody: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(keywords, fixtures) },
    ],
    response_format: responseSchema(keywords),
    temperature: 0,
  };
  if (options.seed !== undefined) requestBody.seed = options.seed;
  if (options.reasoningEffort) {
    requestBody.reasoning = { effort: options.reasoningEffort };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
  };
  if (options.httpReferer) headers["HTTP-Referer"] = options.httpReferer;
  if (options.xTitle) headers["X-Title"] = options.xTitle;

  let resp: Response;
  let rawText: string;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    rawText = await resp.text();
  } catch (err) {
    clearTimeout(timer);
    return {
      modelId: model.id,
      ok: false,
      error: `network error: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: performance.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = performance.now() - t0;

  if (!resp.ok) {
    return {
      modelId: model.id,
      ok: false,
      error: `HTTP ${resp.status}: ${rawText.slice(0, 500)}`,
      httpStatus: resp.status,
      latencyMs,
      rawResponse: rawText,
    };
  }

  interface OpenRouterChatResponse {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  }

  let body: OpenRouterChatResponse;
  try {
    body = JSON.parse(rawText) as OpenRouterChatResponse;
  } catch {
    return {
      modelId: model.id,
      ok: false,
      error: "response body was not valid JSON",
      latencyMs,
      rawResponse: rawText,
    };
  }

  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return {
      modelId: model.id,
      ok: false,
      error: "response had no content",
      latencyMs,
      rawResponse: rawText,
    };
  }

  const cleaned = stripMarkdownFences(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    return {
      modelId: model.id,
      ok: false,
      error: `model output was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs,
      rawResponse: rawText,
    };
  }

  // Primary: exact schema field names. Fallback: short-name synonyms
  // — some models (qwen3.6-plus is the current offender) ignore the
  // `response_format: json_schema` strict contract and emit `kw1` /
  // `kw2` / `kw3` instead. We accept the fallback so the benchmark can
  // still score the answer, but record schemaCompliant=false so the
  // report surfaces the soft failure.
  const primary = [
    takeStringArray(parsed, "kw1_functions"),
    takeStringArray(parsed, "kw2_functions"),
    takeStringArray(parsed, "kw3_functions"),
  ];
  const fallback = [
    takeStringArray(parsed, "kw1"),
    takeStringArray(parsed, "kw2"),
    takeStringArray(parsed, "kw3"),
  ];
  let kws: Array<string[] | null>;
  let schemaCompliant: boolean;
  if (primary.every((v) => v !== null)) {
    kws = primary;
    schemaCompliant = true;
  } else if (fallback.every((v) => v !== null)) {
    kws = fallback;
    schemaCompliant = false;
  } else {
    return {
      modelId: model.id,
      ok: false,
      error:
        "model output missing required arrays under either field-name set " +
        "(kw1_functions/kw2_functions/kw3_functions or kw1/kw2/kw3)",
      latencyMs,
      rawResponse: rawText,
    };
  }

  return {
    modelId: model.id,
    ok: true,
    kw1: [...(kws[0] as string[])].sort(),
    kw2: [...(kws[1] as string[])].sort(),
    kw3: [...(kws[2] as string[])].sort(),
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    latencyMs,
    providerFinishReason: choice?.finish_reason ?? null,
    rawResponse: rawText,
    schemaCompliant,
  };
}

function stripMarkdownFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

function takeStringArray(obj: Record<string, unknown>, key: string): string[] | null {
  const v = obj[key];
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (typeof item !== "string") return null;
  }
  return v as string[];
}
