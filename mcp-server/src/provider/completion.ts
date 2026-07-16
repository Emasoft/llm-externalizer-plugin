/**
 * provider/completion.ts — the non-streaming completion + retry layer
 * (B1 Phase 5b, TRDD-63314265).
 *
 * Moved out of index.ts wholesale: `chatCompletionSimple` (the OpenAI-compat
 * request every LLM call funnels through), `chatCompletionJSON` (structured
 * output), and `chatCompletionWithRetry` (the retry-on-truncation /
 * empty-response wrapper), plus the four state clusters they — and ONLY they —
 * own:
 *
 *   1. the reasoning ladder    (MODEL_REASONING_CACHE + DEFAULT_REASONING_EFFORT)
 *   2. the supported-params    (MODEL_SUPPORTED_PARAMS + FILTER_WARN_SEEN)
 *   3. the request-dump hook   (dumpRequestBody)
 *   4. the circuit breaker     (SERVICE_HEALTH)
 *
 * Those four caches were verified (P5b) to have ZERO readers or writers outside
 * these three functions, so relocating them keeps each one a SINGLE binding with
 * a single owning module — the move cannot fork the state.
 *
 * The state that could NOT move — `creditExhausted`, the auto-free engagement
 * flags, the balance cache, `FREE_MODEL_ID`, the resolved max-tokens — is read
 * or written by index.ts elsewhere (the ensemble builder, the dispatch layer,
 * `shouldUseFree`). It STAYS in index.ts and is reached through the injected
 * `CompletionDeps` seam, so there is exactly one binding of each. Mutating those
 * through `deps.setCreditExhausted()` / `deps.engageAutoFree()` writes index.ts's
 * own `let`, which is precisely the point: a local copy here would silently
 * diverge from what index.ts reads.
 *
 * This module imports ZERO from index.ts (that would be circular AND would drag
 * the whole MCP server's module-init graph into every importer).
 */

import { appendFileSync } from "node:fs";

import { applyModelOverrides } from "../request-overrides.js";
import { safeReadText, safeReadJson } from "../safe-body.js";
import { appendModelEvent } from "../model-events.js";
import { recordRequest } from "../usage-history.js";
import { HEARTBEAT_INTERVAL_MS, type ProgressFn } from "../rate-limiter.js";

import { fetchWithTimeout, fetchWithRetry429, sanitizeProviderError } from "./http.js";
import { chatCompletionNative } from "./lmstudio.js";
import { resolveConnection } from "./connection.js";
import { isFreeSuffixModelId } from "../benchmark/free-mode.js";
import {
  approvedFreePoolFromSettings,
  callWithFreeRotation,
  classifyUnavailable,
  logRotation,
} from "../free-rotation.js";
import { resolveEnsembleModelLimits } from "../ensemble-limits.js";
import {
  VALID_REASONING_EFFORTS,
  type ReasoningEffortSetting,
  type ChatMessage,
  type StreamingResult,
  type CompletionDeps,
} from "./types.js";

// ── Reasoning effort cache + configurable default ───────────────────
// OpenRouter's chat/completions accepts a `reasoning: { effort }` field. Not
// every model supports it, and some only support certain effort levels. We
// send DEFAULT_REASONING_EFFORT first, fall back to "high", then drop reasoning
// entirely. Results are cached per model ID so we only probe once per session.
//
// COST NOTE (TRDD-ec45c66f): reasoning tokens are BILLED even though we discard
// the trace (we only read message.content). A reasoning model spends its whole
// budget thinking, so "xhigh" can be ~10x the per-call cost of no reasoning.
// The default is therefore "high" (strong reasoning, ~half the xhigh spend),
// overridable via LLM_EXT_REASONING_EFFORT = xhigh|high|medium|low|off.
// Values stored in the cache: "xhigh"/"high" (confirmed-working level after a
// downgrade) or "none" (reasoning rejected or unsupported).
//
// SINGLE BINDING (P5b): this Map is written by recordReasoningRejection() and by
// chatCompletionWithRetry()'s empty-response downgrade, and read by
// reasoningLadderForModel(). All three now live in THIS module, so the cache has
// exactly one owner. Do not re-export it — a second module holding a reference
// is how a per-model downgrade silently stops being observed by the ladder.
const MODEL_REASONING_CACHE = new Map<string, "xhigh" | "high" | "none">();

// Default reasoning effort, from env (default "high"). "off" disables reasoning
// on every call. Invalid values fall back to "high". Per-call callers may still
// pass `reasoning: "off"` to opt a specific path out (e.g. cluster_synonyms).
const DEFAULT_REASONING_EFFORT: ReasoningEffortSetting = (() => {
  const raw = (process.env.LLM_EXT_REASONING_EFFORT ?? "high").toLowerCase();
  return (VALID_REASONING_EFFORTS as readonly string[]).includes(raw)
    ? (raw as ReasoningEffortSetting)
    : "high";
})();

// OpenRouter's `ChatRequestReasoning` schema (chat/completions) has
// ONLY two properties: `effort` and `summary`. There is no `exclude`,
// `enabled`, or `max_tokens` on this endpoint — those belong to the
// Responses API's ReasoningConfig. See docs/openrouter/chat-completions-api.md
// for the raw OpenAPI spec. Earlier code sent `exclude: true`, which
// OpenRouter silently dropped. The reasoning trace comes back in
// `message.reasoning` / `message.reasoning_details`, which we ignore;
// we only read `message.content`.
// `override` lets a specific call path opt out of (or down from) the global
// default — e.g. cluster_synonyms passes "off" so canonicalisation never pays
// for thinking tokens. When omitted, the env-configured DEFAULT_REASONING_EFFORT
// applies.
export function reasoningLadderForModel(
  modelId: string,
  override?: ReasoningEffortSetting,
): Array<Record<string, unknown> | null> {
  if (!modelId) return [null];
  const effort = override ?? DEFAULT_REASONING_EFFORT;
  if (effort === "off") return [null];
  const cached = MODEL_REASONING_CACHE.get(modelId);
  if (cached === "none") return [null];
  if (cached === "high") return [{ effort: "high" }, null];
  // "xhigh" is the only level above "high", so keep a high fallback for it.
  if (effort === "xhigh") return [{ effort: "xhigh" }, { effort: "high" }, null];
  // high / medium / low: send the configured level, then drop to no reasoning.
  return [{ effort }, null];
}

function recordReasoningRejection(
  modelId: string,
  failedReasoning: Record<string, unknown> | null,
): void {
  if (!modelId || !failedReasoning) return;
  const effort = (failedReasoning as { effort?: string }).effort;
  if (effort === "xhigh") {
    // xhigh has a "high" fallback rung — record the partial downgrade.
    MODEL_REASONING_CACHE.set(modelId, "high");
    appendModelEvent(modelId, "reasoning_downgrade", "xhigh→high");
  } else if (effort === "high" || effort === "medium" || effort === "low") {
    // Any of these rejected → this model can't take that effort; drop reasoning
    // entirely so future calls skip the (free but wasteful) re-probe.
    MODEL_REASONING_CACHE.set(modelId, "none");
    appendModelEvent(modelId, "reasoning_downgrade", `${effort}→none`);
  }
}

function isReasoningRejectionError(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /reason|effort|xhigh|thinking/i.test(bodyText);
}

/**
 * Cost/observability audit hook. When LLM_EXT_DUMP_REQUESTS points at a file,
 * append the exact wire payload (timestamp + model + byte size + full JSON body)
 * so a request can be inspected for unexpected prompt/file inflation. Off unless
 * the env var is set. BEST-EFFORT: a write failure (bad path, full disk, etc.)
 * is logged to stderr and swallowed — it MUST NEVER break the actual LLM call.
 */
function dumpRequestBody(body: Record<string, unknown>, model: string | undefined): void {
  const dest = process.env.LLM_EXT_DUMP_REQUESTS;
  if (!dest) return;
  try {
    const wire = JSON.stringify(body);
    appendFileSync(
      dest,
      `\n==== ${new Date().toISOString()} model=${model} bytes=${wire.length} ====\n${wire}\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[llm-externalizer] LLM_EXT_DUMP_REQUESTS write failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

// ── Dynamic per-model supported_parameters filter ────────────────────
// OpenRouter's /v1/models endpoint reports each model's
// `supported_parameters` — a concrete list of which request-body fields
// the upstream provider accepts. For example, Nemotron 3 Super :free
// supports reasoning/temperature/top_p but NOT frequency_penalty,
// presence_penalty, top_k, min_p, stop, or repetition_penalty.
//
// We cache this per model and filter the outgoing request body so that
// unsupported fields are silently dropped. This is forward-compatible:
// any new model is handled automatically without hardcoding overrides.
// OpenRouter control fields (stream, plugins, messages, model, etc.)
// are NOT in supported_parameters and must never be filtered — we only
// touch the subset in FILTERABLE_REQUEST_FIELDS below.
const MODEL_SUPPORTED_PARAMS = new Map<string, Set<string>>();
let modelSupportedParamsCacheTime = 0;
const MODEL_SUPPORTED_PARAMS_TTL_MS = 3600_000; // 1 hour

// The subset of request-body keys we compare against supported_parameters.
// OpenRouter routing/control fields (stream, model, messages, plugins,
// metadata, provider, debug, etc.) are NOT listed here — they are always
// forwarded regardless of the model.
const FILTERABLE_REQUEST_FIELDS = new Set([
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "top_a",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "reasoning",
  "include_reasoning",
  "response_format",
  "structured_outputs",
  "seed",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "logit_bias",
  "logprobs",
  "top_logprobs",
]);

async function getModelSupportedParams(
  modelId: string,
  deps: CompletionDeps,
): Promise<Set<string> | null> {
  // T2.7 — snapshot once
  const backend = deps.getBackend();
  if (!modelId || backend.type !== "openrouter") return null;
  const now = Date.now();
  if (now - modelSupportedParamsCacheTime > MODEL_SUPPORTED_PARAMS_TTL_MS) {
    MODEL_SUPPORTED_PARAMS.clear();
    modelSupportedParamsCacheTime = now;
  }
  const cached = MODEL_SUPPORTED_PARAMS.get(modelId);
  if (cached !== undefined) return cached;

  try {
    // Query the per-model endpoint with the EXACT model id.
    // /v1/models/{id}/endpoints returns { data: { endpoints: [...] } }
    // where each endpoint carries its own supported_parameters list.
    // We take the UNION across endpoints — if any provider for this
    // model accepts a field, sending it is safe (the provider that
    // doesn't accept will either ignore it or return a 400, which the
    // reasoning ladder and retry loop already handle).
    const res = await fetchWithTimeout(
      `${backend.baseUrl}/v1/models/${modelId}/endpoints`,
      { headers: deps.apiHeaders() },
    );
    if (!res.ok) return null;
    const body = await safeReadJson<{
      data?: {
        endpoints?: Array<{ supported_parameters?: string[] }>;
      };
    }>(res);
    const endpoints = body.data?.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
    const merged = new Set<string>();
    for (const ep of endpoints) {
      if (Array.isArray(ep.supported_parameters)) {
        for (const p of ep.supported_parameters) merged.add(p);
      }
    }
    if (merged.size === 0) return null;
    MODEL_SUPPORTED_PARAMS.set(modelId, merged);
    process.stderr.write(
      `[llm-externalizer] Model ${modelId} supports: ${Array.from(merged).sort().join(", ")}\n`,
    );
    return merged;
  } catch {
    // Non-fatal — unknown support, proceed without filtering
    return null;
  }
}

// One-shot "we dropped <field> for <model>" log: per (model, field) pair,
// emit a single stderr line the first time we filter that combo. This
// addresses the v9.10.0 audit finding T2.16 — without it, a user whose
// `temperature: 0.7` override silently goes nowhere had no way to tell.
const FILTER_WARN_SEEN = new Set<string>();

function filterBodyForSupportedParams(
  body: Record<string, unknown>,
  supported: Set<string> | null,
  modelId?: string,
): Record<string, unknown> {
  if (!supported) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (FILTERABLE_REQUEST_FIELDS.has(key) && !supported.has(key)) {
      // Known filterable field, not supported by this model — drop it
      if (modelId) {
        const seenKey = `${modelId}|${key}`;
        if (!FILTER_WARN_SEEN.has(seenKey)) {
          FILTER_WARN_SEEN.add(seenKey);
          process.stderr.write(
            `[llm-externalizer] Dropping unsupported field '${key}' for model '${modelId}' (per OpenRouter supported_parameters). Override your profile if this was intentional.\n`,
          );
          // Persist the mitigation as a durable per-model health event (A1),
          // once per model+field (gated by the same FILTER_WARN_SEEN set).
          appendModelEvent(modelId, "param_drop", `dropped '${key}'`);
        }
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

// High-quality-scan prompt cache (TRDD-DBUSM55E): wrap the system message's text
// in OpenRouter's array-of-parts form with a cache_control:{type:"ephemeral"}
// breakpoint, so the stable per-file scan system prefix is cached across the many
// per-file requests of a folder scan. Only the system message is wrapped (the
// per-file code block lives in the user message and is NOT cacheable). Non-system
// or non-string messages pass through untouched. OpenRouter normalizes/strips the
// annotation for providers that don't support it.
export function withSystemCacheBreakpoint(messages: ChatMessage[]): unknown[] {
  return messages.map((m) =>
    m.role === "system" && typeof m.content === "string"
      ? {
          role: "system",
          content: [
            {
              type: "text",
              text: m.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        }
      : m,
  );
}

/** Options accepted by the plain (non-JSON) completion path. */
export interface SimpleCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  onProgress?: ProgressFn;
  /** Per-call reasoning override. "off" disables reasoning for this call
   *  regardless of the global default (e.g. cluster_synonyms). */
  reasoning?: ReasoningEffortSetting;
  /** High-quality-scan OpenRouter provider-routing block (TRDD-DBUSM55E). A
   *  control field outside FILTERABLE_REQUEST_FIELDS, so it survives the
   *  supported-params filter to the wire. Undefined → no provider routing. */
  provider?: Record<string, unknown>;
  /** High-quality-scan prompt cache (TRDD-DBUSM55E). When true, the system
   *  prompt gets a cache_control breakpoint. Undefined/false → no cache. */
  cache?: boolean;
}

// ── Non-streaming text completion ────────────────────────────────────
// All LLM requests use this. stream=false, single JSON response.
// Batch-level heartbeat in rateLimitedParallel keeps MCP connection alive.

export async function chatCompletionSimple(
  messages: ChatMessage[],
  options: SimpleCompletionOptions,
  deps: CompletionDeps,
): Promise<StreamingResult> {
  // T2.7 — snapshot once at top of this LLM call. resolveConnection() also
  // snapshots internally to make the URL+model+timeout tuple coherent; here
  // we use the same generation for reasoning-ladder gating and error-msg
  // backend-type labels. A mid-call reload that changes `currentBackend`
  // cannot interleave fields between conn building and the request body.
  const backend = deps.getBackend();
  const conn = await resolveConnection(options, deps);

  // LM Studio native API — delegate to native handler (different request format)
  if (conn.isNative) {
    return chatCompletionNative(conn, messages, options, deps);
  }

  const baseBody: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? deps.defaultTemperature,
    max_tokens: options.maxTokens ?? deps.getDefaultMaxTokens(),
    stream: false,
  };
  if (conn.model) baseBody.model = conn.model;

  // High-quality-scan routing (TRDD-DBUSM55E). Both only apply for OpenRouter and
  // only when the high_quality_scan caller opts in; every other call leaves the
  // body byte-for-byte unchanged (the options default to undefined).
  if (backend.type === "openrouter") {
    // `provider` is a CONTROL field (not in FILTERABLE_REQUEST_FIELDS) so it
    // survives filterBodyForSupportedParams to the wire untouched.
    if (options.provider) baseBody.provider = options.provider;
    // Prompt cache: a cache_control breakpoint on the (stable) system prompt so
    // the repeated per-file scan prefix is cached across the folder's files.
    if (options.cache) baseBody.messages = withSystemCacheBreakpoint(messages);
  }

  // Reasoning ladder: OpenRouter backend uses the configured effort (default
  // "high"), unless this call passes a per-call override (e.g. "off").
  // Other backends (ollama/vllm/llamacpp OpenAI-compat) get [null] — no reasoning field.
  const reasoningLadder =
    backend.type === "openrouter"
      ? reasoningLadderForModel(conn.model || "", options.reasoning)
      : [null];

  // Dynamically look up which request-body fields this model accepts.
  // The result is a Set<string> or null (unknown — don't filter). Queried
  // from /v1/models/{id}/endpoints and cached per model for 1 hour. This
  // is forward-compatible: any new model's unsupported fields are dropped
  // automatically instead of causing 400 errors.
  const supportedParams = await getModelSupportedParams(conn.model || "", deps);

  const startTime = Date.now();

  // Heartbeat: send progress every 30s while waiting for the response.
  // Prevents MCP inactivity timeout on long-running requests (reasoning models).
  const heartbeat = options.onProgress
    ? setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        options.onProgress!(50, 100, `Processing… ${elapsed}s elapsed`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  try {
    let lastError: Error | null = null;
    // A1/A7 model-health: emit each degradation kind AT MOST ONCE per logical
    // call (this whole chatCompletionSimple invocation), even across reasoning
    // ladder rungs. Set-and-guard booleans keep the ledger at "this model X'd on
    // this call", mirroring the existing 429-flood collapse. Logging-only.
    let emitted429 = false;

    for (const reasoning of reasoningLadder) {
      let body: Record<string, unknown> = { ...baseBody };
      if (reasoning) body.reasoning = reasoning;
      // Apply per-model overrides before filtering so the filter has
      // the full picture of what we intend to send.
      body = applyModelOverrides(body, conn.model);
      // Filter to only fields this model supports. Does nothing for
      // non-OpenRouter backends and for models with unknown metadata.
      body = filterBodyForSupportedParams(body, supportedParams, conn.model);

      // Cost/observability audit: when LLM_EXT_DUMP_REQUESTS points at a file,
      // append the exact wire payload (model + byte size + body) so a request can
      // be inspected for unexpected prompt/file inflation. Off unless set.
      // Best-effort: a dump-write failure (bad path, full disk) must NEVER break
      // the actual LLM call.
      dumpRequestBody(body, conn.model);

      const rl429 = { saw429: false };
      const res = await fetchWithRetry429(
        conn.url,
        {
          method: "POST",
          headers: conn.headers,
          body: JSON.stringify(body),
        },
        conn.timeout,
        startTime,
        rl429,
      );

      // A1/A7: one durable rate_limit_429 per call that hit ≥1 429 (the retry
      // helper collapses the per-attempt flood; the final-attempt 429 that
      // exhausted retries is caught via res.status here). Logging-only.
      if ((rl429.saw429 || res.status === 429) && !emitted429) {
        emitted429 = true;
        appendModelEvent(conn.model || "unknown", "rate_limit_429", "429 during call");
      }

      if (!res.ok) {
        const text = await safeReadText(res).catch(() => "");
        if (reasoning && isReasoningRejectionError(res.status, text)) {
          const effort = (reasoning as { effort?: string }).effort;
          process.stderr.write(
            `[llm-externalizer] Model ${conn.model} rejected reasoning.effort=${effort} — downgrading\n`,
          );
          recordReasoningRejection(conn.model || "", reasoning);
          lastError = new Error(
            `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
          );
          continue;
        }
        // A1/A7: a 4xx (non-429) is an unrecoverable model-side failure
        // (bad request, model gone, forbidden). Record it before throwing so
        // the throw path is unchanged. 429 is recorded above, not here.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          appendModelEvent(conn.model || "unknown", "non_retryable_failure", `HTTP ${res.status}`);
        }
        throw new Error(
          `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
        );
      }

      const data = await safeReadJson<{
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        model?: string;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cost?: number;
        };
      }>(res);

      const content = data.choices?.[0]?.message?.content ?? "";
      const model = data.model ?? options.model ?? "unknown";
      const finishReason = data.choices?.[0]?.finish_reason ?? "";
      const usage = data.usage;

      // One completed LLM web request → one usage-history line (this call's own
      // cost, not a running sum). Native delegation above is recorded inside
      // chatCompletionNative, so this records ONLY the OpenAI-compat path.
      recordRequest({ ok: true, durationMs: Date.now() - startTime, costUsd: usage?.cost ?? 0 });
      return { content, model, usage, finishReason, truncated: false };
    }

    throw lastError ?? new Error("Reasoning ladder exhausted with no response");
  } catch (e) {
    // Failed web request — record a FAIL line (cost 0, since no billed
    // completion came back) then rethrow so the caller's retry/error logic is
    // unchanged. Logging never alters control flow.
    recordRequest({ ok: false, durationMs: Date.now() - startTime, costUsd: 0 });
    throw e;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

// ── Non-streaming JSON completion ────────────────────────────────────
// Used when we need structured output (e.g. check_imports path extraction).
// Non-streaming allows response_format + response-healing plugin.

export interface JSONCompletionResult {
  parsed: Record<string, unknown>;
  model: string;
  usage?: StreamingResult["usage"];
  finishReason: string;
}

// JSON schema for check_imports — extracts file paths from source code
export const EXTRACT_PATHS_SCHEMA = {
  name: "extract_paths_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "All file paths, imports, and module references found in the source.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
} as const;

/**
 * Non-streaming chat completion with JSON structured output.
 * Uses response_format + response-healing plugin (OpenRouter only).
 * Falls back to plain text for local backends.
 */
export async function chatCompletionJSON(
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    jsonSchema?: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
    onProgress?: ProgressFn;
  },
  deps: CompletionDeps,
): Promise<JSONCompletionResult> {
  // T2.7 — snapshot once for consistent (type, model) across all branches
  const backend = deps.getBackend();
  const conn = await resolveConnection(options, deps);

  // Route through LM Studio native API (no json_schema support,
  // but the prompt-based JSON extraction works well with local models).
  if (conn.isNative) {
    const nativeResult = await chatCompletionNative(conn, messages, options, deps);
    const rawContent = nativeResult.content;
    const nativeModel = nativeResult.model || conn.model || "unknown";
    if (!rawContent.trim()) {
      // A1/A7: blank structured-output body on the native path. Record then throw.
      appendModelEvent(nativeModel, "empty_response", "blank JSON body (native)");
      throw new Error(
        "LLM returned empty response (expected JSON). Model may not support structured output.",
      );
    }
    let parsed: Record<string, unknown>;
    try {
      // Strip markdown fences if present
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
      // A1/A7: a heal fired only if fence/junk stripping changed the content.
      if (cleaned !== rawContent.trim()) {
        appendModelEvent(nativeModel, "schema_heal", "fence-stripped JSON (native)");
      }
    } catch {
      throw new Error(
        `LLM returned non-JSON response: ${rawContent.substring(0, 200)}`,
      );
    }
    return {
      parsed,
      model: nativeResult.model,
      usage: nativeResult.usage,
      finishReason: nativeResult.finishReason,
    };
  }

  const baseBody: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? deps.defaultTemperature,
    max_tokens: options.maxTokens ?? deps.getDefaultMaxTokens(),
    stream: false, // Non-streaming for structured output
  };

  if (conn.model) baseBody.model = conn.model;

  // Structured output: json_schema + response-healing (OpenRouter only)
  if (options.jsonSchema && backend.type === "openrouter") {
    baseBody.response_format = {
      type: "json_schema",
      json_schema: options.jsonSchema,
    };
    // Response-healing plugin auto-fixes malformed JSON from weaker models
    baseBody.plugins = [{ id: "response-healing" }];
  }

  // Reasoning ladder (OpenRouter only): xhigh → high → none.
  // Reasoning is enforced for structured-output calls too. The ladder
  // sends only schema-valid fields (effort + summary). Providers that
  // reject reasoning + json_schema return 400 and the ladder downgrades
  // automatically.
  const reasoningLadder =
    backend.type === "openrouter"
      ? reasoningLadderForModel(conn.model || "")
      : [null];

  // Dynamic per-model parameter filter — drops request-body fields the
  // model doesn't list in its supported_parameters. Cached per model.
  const supportedParams = await getModelSupportedParams(conn.model || "", deps);

  // Periodic progress keepalive while waiting for non-streaming response
  const jsonStartTime = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (options.onProgress) {
    const pg = options.onProgress;
    pg(5, 100, "Sending request to LLM…");
    progressTimer = setInterval(() => {
      const pct = Math.min(
        90,
        Math.round(((Date.now() - jsonStartTime) / conn.timeout) * 100),
      );
      pg(pct, 100, "Waiting for LLM response…");
    }, 10_000);
  }

  try {
    let lastLadderError: Error | null = null;
    let rawContent = "";
    let model = "";
    let usage: StreamingResult["usage"] | undefined;
    let finishReason = "";
    let gotResponse = false;
    // A1/A7 model-health: emit rate_limit_429 at most once per logical call
    // (across ladder rungs). Same set-and-guard pattern as chatCompletionSimple.
    let emitted429 = false;

    for (const reasoning of reasoningLadder) {
      let body: Record<string, unknown> = { ...baseBody };
      if (reasoning) body.reasoning = reasoning;
      // Apply per-model overrides last so they win over baseBody defaults.
      body = applyModelOverrides(body, conn.model);
      // Filter to only fields this model supports (Nemotron drops
      // frequency_penalty etc., other models may drop reasoning).
      body = filterBodyForSupportedParams(body, supportedParams, conn.model);

      // Cost/observability audit (see chatCompletionSimple) — structured-output path.
      dumpRequestBody(body, conn.model);

      const rl429 = { saw429: false };
      const res = await fetchWithRetry429(
        conn.url,
        {
          method: "POST",
          headers: conn.headers,
          body: JSON.stringify(body),
        },
        conn.timeout,
        jsonStartTime,
        rl429,
      );

      // A1/A7: one durable rate_limit_429 per call that hit ≥1 429. Logging-only.
      if ((rl429.saw429 || res.status === 429) && !emitted429) {
        emitted429 = true;
        appendModelEvent(conn.model || "unknown", "rate_limit_429", "429 during call (JSON mode)");
      }

      if (!res.ok) {
        const text = await safeReadText(res).catch(() => "");
        if (reasoning && isReasoningRejectionError(res.status, text)) {
          const effort = (reasoning as { effort?: string }).effort;
          process.stderr.write(
            `[llm-externalizer] Model ${conn.model} rejected reasoning.effort=${effort} (JSON mode) — downgrading\n`,
          );
          recordReasoningRejection(conn.model || "", reasoning);
          lastLadderError = new Error(
            `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
          );
          continue;
        }
        // A1/A7: a 4xx (non-429) is an unrecoverable model-side failure.
        // Record before throwing — the throw path is unchanged.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          appendModelEvent(conn.model || "unknown", "non_retryable_failure", `HTTP ${res.status} (JSON mode)`);
        }
        throw new Error(
          `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
        );
      }

      const data = await safeReadJson<{
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        model?: string;
        usage?: StreamingResult["usage"];
      }>(res);

      rawContent = data.choices?.[0]?.message?.content ?? "";
      model = data.model ?? conn.model ?? "";
      usage = data.usage;
      finishReason = data.choices?.[0]?.finish_reason ?? "";
      gotResponse = true;
      break;
    }

    if (!gotResponse) {
      throw lastLadderError ?? new Error("Reasoning ladder exhausted with no response");
    }

    // Parse the JSON response — guard against empty/whitespace-only content
    if (!rawContent.trim()) {
      // A1/A7: the model returned a structured-output reply with no body — a
      // degradation signal (record before throwing; throw path unchanged).
      appendModelEvent(model || conn.model || "unknown", "empty_response", "blank JSON body");
      throw new Error(
        "LLM returned empty response (expected JSON). Model may not support structured output.",
      );
    }
    let parsed: Record<string, unknown>;
    try {
      // Strip markdown fences if present (matches chatCompletionNative branch above).
      // Even with response_format: json_schema some providers/models wrap JSON in
      // ```json ... ``` fences, which makes JSON.parse throw.
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
      // A1/A7: if the raw reply was NOT already clean JSON but the fence/junk
      // strip made it parse, we just HEALED a non-conforming structured-output
      // reply. Recording only the heals that actually fired (cleaned ≠ raw)
      // keeps this a true degradation signal, not noise on every call.
      if (cleaned !== rawContent.trim()) {
        appendModelEvent(model || conn.model || "unknown", "schema_heal", "fence-stripped JSON");
      }
    } catch (e) {
      // LLM may wrap JSON in code fences, include trailing text, or produce malformed JSON
      throw new Error(
        `LLM returned malformed JSON: ${e instanceof Error ? e.message : String(e)}. Raw (first 200 chars): ${rawContent.slice(0, 200)}`,
        { cause: e },
      );
    }

    // One completed LLM web request → one usage-history line. The native
    // branch above is recorded inside chatCompletionNative, so this records
    // ONLY the OpenAI-compat structured-output path.
    recordRequest({ ok: true, durationMs: Date.now() - jsonStartTime, costUsd: usage?.cost ?? 0 });
    return { parsed, model, usage, finishReason };
  } catch (e) {
    recordRequest({ ok: false, durationMs: Date.now() - jsonStartTime, costUsd: 0 });
    throw e;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

// ── Global service health tracker ────────────────────────────────────
// Tracks consecutive failures across ALL requests to detect systemic issues
// (offline servers, broken connections, traffic overload). When the failure
// rate exceeds the threshold, pauses with exponential backoff before retrying.
// If all backoff attempts fail, aborts with a clear server-side error message.
//
// SINGLE BINDING (P5b): SERVICE_HEALTH is read/written ONLY by the three
// functions below and by chatCompletionWithRetry — all in this module. It is
// deliberately NOT exported: a second module holding its own counter would make
// the circuit breaker trip on a subset of the failures it is supposed to see.

const SERVICE_HEALTH = {
  consecutiveFailures: 0,
  lastSuccessAt: Date.now(),
  // Threshold: 5 consecutive failures across any requests → likely systemic
  failureThreshold: 5,
  // Backoff delays in ms: 60s, 120s, 350s, then give up
  backoffDelays: [60_000, 120_000, 350_000],
  backoffAttempt: 0,
  // If true, service is in backoff/cooldown mode
  inCooldown: false,
};

function recordServiceSuccess(): void {
  SERVICE_HEALTH.consecutiveFailures = 0;
  SERVICE_HEALTH.lastSuccessAt = Date.now();
  SERVICE_HEALTH.backoffAttempt = 0;
  SERVICE_HEALTH.inCooldown = false;
}

function recordServiceFailure(): void {
  SERVICE_HEALTH.consecutiveFailures++;
}

/** Returns true if we should abort (server-side issue confirmed). */
async function checkServiceHealthOrWait(): Promise<string | null> {
  if (SERVICE_HEALTH.consecutiveFailures < SERVICE_HEALTH.failureThreshold) {
    return null; // Not enough failures to trigger cooldown
  }

  const { backoffDelays, backoffAttempt } = SERVICE_HEALTH;
  if (backoffAttempt >= backoffDelays.length) {
    // Exhausted all backoff attempts — abort
    return (
      `SERVER ISSUE DETECTED: ${SERVICE_HEALTH.consecutiveFailures} consecutive failures. ` +
      `Last success was ${Math.round((Date.now() - SERVICE_HEALTH.lastSuccessAt) / 1000)}s ago. ` +
      `Tried waiting ${backoffDelays.map((d) => `${d / 1000}s`).join(", ")}. ` +
      `The issue appears to be server-side (offline, overloaded, or connection broken). ` +
      `Please retry later.`
    );
  }

  // Pause with backoff
  const delay = backoffDelays[backoffAttempt];
  SERVICE_HEALTH.inCooldown = true;
  process.stderr.write(
    `[circuit-breaker] ${SERVICE_HEALTH.consecutiveFailures} consecutive failures detected — ` +
    `waiting ${delay / 1000}s before retrying (backoff ${backoffAttempt + 1}/${backoffDelays.length})\n`,
  );
  await new Promise((r) => setTimeout(r, delay));
  SERVICE_HEALTH.backoffAttempt++;
  SERVICE_HEALTH.inCooldown = false;
  return null;
}

// ── Retry-on-truncation wrapper ──────────────────────────────────────
// Retries LLM calls when the response is truncated (finishReason !== "stop")
// or when a timeout caused partial output. Up to 3 retries for generic
// failures; up to 15 retries for silent empty responses on OpenRouter
// (the documented "no content generated" case — cold-start / scaling).
// Integrates with SERVICE_HEALTH to detect systemic server issues.
const MAX_TRUNCATION_RETRIES = 3;
const MAX_EMPTY_RESPONSE_RETRIES = 15;
// Fixed wait between empty-response retries. Empty responses aren't a
// rate-limit signal — they're documented cold-start / scaling behavior,
// so exponential backoff would be the wrong primitive (it would make us
// wait longer the more the provider needs a warm request). A small,
// constant delay just gives the provider a moment to finish whatever
// scaling it was doing before we try again.
const EMPTY_RESPONSE_RETRY_DELAY_MS = 2000;

/**
 * Complete one call on the APPROVED free pool, ROTATING across it — the paid→free
 * fallback body shared by the 402 (credit-exhausted) and the terminal
 * (paid-model-unavailable) paths.
 *
 * Strictly ONE-DIRECTIONAL. Every caller has already established that the current
 * model is a PAID model, so this only ever moves paid→free; it can never move a
 * free_only profile to paid (that profile's model is ':free', and
 * assertFreeOnlyModel forbids paid regardless). The pool is the reconciled /
 * persisted approved pool, minus the model we just failed on; it degrades to the
 * single validated freeModelId only when settings are unreadable. Rotation means
 * a daily-capped first free model doesn't kill the command — the whole point of
 * the user's "every command must complete" rule.
 */
async function completeOnFreePool(
  messages: ChatMessage[],
  options: SimpleCompletionOptions,
  deps: CompletionDeps,
  freeModelId: string,
): Promise<StreamingResult> {
  const pool = approvedFreePoolFromSettings().filter((id) => id !== options.model);
  const ids = pool.length > 0 ? pool : [freeModelId];
  // Per-model output ceilings, and CLAMP the request to them. The failing call
  // was sized for a PAID model (maxTokens can be 65K); many free models cap
  // completions far lower, and a max_tokens above the cap is a 400 — a
  // NON-availability error, so rotation would rethrow it and the command would
  // die with an approved pool sitting right there. Clamp DOWN only (Math.min),
  // never up, so the caller's own budget still bounds every fallback.
  const candidates = ids.map((id) => ({
    id,
    maxOutput: resolveEnsembleModelLimits(id, undefined).maxOutput,
  }));
  return callWithFreeRotation<StreamingResult>(
    candidates[0],
    candidates.slice(1),
    (model, maxOutput) =>
      chatCompletionSimple(
        messages,
        {
          ...options,
          model,
          maxTokens: Math.min(options.maxTokens ?? maxOutput, maxOutput),
        },
        deps,
      ),
    {
      resultFailureDetail: (r) => (r.finishReason === "error" ? r.content : null),
      onRotate: (from, to, detail) => logRotation(from, to, detail),
    },
  );
}

export async function chatCompletionWithRetry(
  messages: ChatMessage[],
  options: SimpleCompletionOptions,
  deps: CompletionDeps,
): Promise<StreamingResult> {
  // T2.7 — snapshot ONCE per retry-loop invocation. The fallback-model
  // path and the early-abort path BOTH read backend.model; if a reload
  // raced between those reads we could attribute a model to the wrong
  // backend label in error messages. One snapshot, used everywhere.
  const backend = deps.getBackend();
  // FREE_MODEL_ID is a `const` in index.ts initialised AFTER the deps object is
  // built, so it MUST be read through a function (never captured as a value at
  // wiring time) — a value capture would hit the TDZ at module init.
  const freeModelId = deps.getFreeModelId();
  // Check global service health before attempting
  const healthAbort = await checkServiceHealthOrWait();
  if (healthAbort) {
    return {
      content: healthAbort,
      model: options.model || backend.model,
      finishReason: "error",
      truncated: true,
    };
  }

  // Separate counters for generic failures and empty-response failures.
  // Empty responses get a much higher budget (with exponential backoff)
  // because OpenRouter's docs say this is the expected cold-start behavior
  // and a retry is the documented workaround.
  let genericAttempts = 0;
  let emptyAttempts = 0;
  // A1/A7 model-health: emit ONE truncation_retry per logical call the first
  // time an incomplete/truncated response forces a continuation retry — not one
  // per retry attempt. Logging-only; never alters the retry/backoff loop.
  let emittedTruncationRetry = false;

  while (true) {
    let resp: StreamingResult;
    try {
      // Non-streaming: single JSON response, no SSE parsing.
      // Batch-level heartbeat in rateLimitedParallel keeps MCP alive.
      resp = await chatCompletionSimple(messages, options, deps);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 402 Payment Required — credit exhausted mid-flight. Flag the session
      // and immediately retry this call with the free model, no cooldown.
      // This is the promised "never fail, switch to free" behavior.
      if (
        /API error 402\b/.test(errMsg) &&
        backend.type === "openrouter" &&
        options.model !== freeModelId
      ) {
        // These three MUTATE index.ts's own module state through the seam —
        // `creditExhausted` (read later by shouldUseFree + the dispatch layer),
        // the auto-free engagement flags (read by getEnsembleModels), and the
        // balance cache. They must NOT be mirrored here: a local copy would
        // diverge from the single binding index.ts actually reads.
        // Credit is gone for the SESSION, so engage sticky auto-free: later calls
        // route through the free pool too, not just this one.
        deps.setCreditExhausted();
        deps.invalidateBalanceCache();
        deps.engageAutoFree("402 mid-flight");
        process.stderr.write(
          `[llm-externalizer] Credit exhausted (402) — completing this call on the free pool (rotating on rate-limit).\n`,
        );
        try {
          return await completeOnFreePool(messages, options, deps, freeModelId);
        } catch (freeErr) {
          const freeMsg =
            freeErr instanceof Error ? freeErr.message : String(freeErr);
          process.stderr.write(
            `[llm-externalizer] Free-mode fallback exhausted the approved pool: ${freeMsg}\n`,
          );
          throw err;
        }
      }

      // Network/connection error — count as generic failure
      recordServiceFailure();
      genericAttempts++;
      if (genericAttempts <= MAX_TRUNCATION_RETRIES) {
        // Issue 2: tag the model/truncation retry layer + include the model id.
        const retryModel = options.model || backend.model;
        process.stderr.write(
          `[model-retry] ${retryModel}: request error: ${errMsg} — retrying (${genericAttempts}/${MAX_TRUNCATION_RETRIES})\n`,
        );
        const abort = await checkServiceHealthOrWait();
        if (abort) {
          return {
            content: abort,
            model: options.model || backend.model,
            finishReason: "error",
            truncated: true,
          };
        }
        continue;
      }
      // Last resort (the user's directional rule): a PAID model that has
      // exhausted its retries on a genuine AVAILABILITY failure (429/404/no
      // endpoints/503 — never a 400/bad-key, which classifyUnavailable rejects)
      // completes on the free pool instead of failing the command. Non-sticky:
      // we do NOT engage session-wide auto-free here, because the wallet may be
      // fine and only this model/moment was bad — the next call retries paid. The
      // guard `!isFreeSuffixModelId(options.model)` makes this STRICTLY one-way
      // (paid→free): a free_only profile's model is already ':free', so it never
      // reaches here, and free-rotation already covers a failing free model.
      if (
        backend.type === "openrouter" &&
        options.model !== undefined &&
        !isFreeSuffixModelId(options.model) &&
        options.model !== freeModelId &&
        classifyUnavailable(errMsg) !== null
      ) {
        process.stderr.write(
          `[llm-externalizer] Paid model '${options.model}' is unavailable and out of retries — completing this call on the free pool.\n`,
        );
        try {
          return await completeOnFreePool(messages, options, deps, freeModelId);
        } catch {
          throw err; // free pool also exhausted — surface the ORIGINAL paid error
        }
      }
      throw err; // Exhausted retries
    }

    // "stop" with non-empty content means normal completion — return immediately.
    // Note: some providers return finishReason="stop" with empty content for
    // problematic prompts. We treat that as an empty response (retryable).
    if (resp.finishReason === "stop" && !resp.truncated && resp.content.trim().length > 0) {
      recordServiceSuccess();
      return resp;
    }

    // "length" — output hit max_tokens limit, real truncation. Don't retry.
    if (resp.finishReason === "length") {
      recordServiceSuccess();
      resp.truncated = true;
      resp.content +=
        "\n\n---\n**TRUNCATED**: Response hit the output-token limit (finish_reason=length). The analysis above is cut off mid-generation.";
      process.stderr.write(
        `[llm-externalizer] finish_reason=length — output token limit hit\n`,
      );
      return resp;
    }

    // "content_filter" — provider blocked the response. Deterministic, don't retry.
    if (resp.finishReason === "content_filter") {
      recordServiceSuccess();
      resp.truncated = true;
      resp.content +=
        "\n\n---\n**BLOCKED**: The provider's content filter blocked this response (finish_reason=content_filter). No retry — the block is deterministic for this prompt.";
      process.stderr.write(
        `[llm-externalizer] finish_reason=content_filter — content filter blocked response\n`,
      );
      return resp;
    }

    // Everything else: empty content, finishReason="" (malformed/glitch),
    // finishReason="error", or unknown values.
    recordServiceFailure();
    const isEmpty = resp.content.trim().length === 0;
    const reasonLabel = resp.finishReason || "empty";

    // Pick the right retry budget based on failure type.
    //
    // Empty responses on OpenRouter are the documented "no content generated"
    // case (cold-start, scaling) — the recommended workaround is to retry.
    // We use MAX_EMPTY_RESPONSE_RETRIES (15) with exponential backoff so the
    // provider has time to warm up between attempts. Non-empty failures
    // (finishReason=error, unknown values) keep the stricter MAX_TRUNCATION_RETRIES
    // budget since they're less likely to be transient.
    const useEmptyBudget = isEmpty && backend.type === "openrouter";
    if (useEmptyBudget) {
      emptyAttempts++;
    } else {
      genericAttempts++;
    }
    const limit = useEmptyBudget ? MAX_EMPTY_RESPONSE_RETRIES : MAX_TRUNCATION_RETRIES;
    const currentAttempt = useEmptyBudget ? emptyAttempts : genericAttempts;

    // Empty-response escalation: downgrade the reasoning cache so the next
    // attempt runs with less (or no) reasoning. xhigh -> high -> none.
    if (useEmptyBudget && options.model && currentAttempt <= limit) {
      const current = MODEL_REASONING_CACHE.get(options.model);
      if (current === undefined || current === "xhigh") {
        MODEL_REASONING_CACHE.set(options.model, "high");
        process.stderr.write(
          `[llm-externalizer] Empty response on ${options.model} — downgrading reasoning cache to high\n`,
        );
      } else if (current === "high") {
        MODEL_REASONING_CACHE.set(options.model, "none");
        process.stderr.write(
          `[llm-externalizer] Empty response on ${options.model} — disabling reasoning\n`,
        );
      }
    }

    if (currentAttempt <= limit) {
      // A1/A7: one durable truncation_retry per call — the first time an
      // incomplete/truncated/empty response forces a continuation retry on this
      // model. Set-and-guard so the ledger gets "this model needed a
      // truncation retry on this call", not one line per attempt.
      if (!emittedTruncationRetry) {
        emittedTruncationRetry = true;
        appendModelEvent(
          options.model || backend.model || "unknown",
          "truncation_retry",
          `finish_reason=${reasonLabel}`,
        );
      }
      process.stderr.write(
        `[llm-externalizer] ${useEmptyBudget ? "Empty" : "Invalid"} response (finish_reason=${reasonLabel}) — retrying (${currentAttempt}/${limit})\n`,
      );
      // Check systemic failure threshold (may block/abort)
      const abort = await checkServiceHealthOrWait();
      if (abort) {
        return {
          content: abort,
          model: resp.model,
          finishReason: "error",
          truncated: true,
        };
      }
      // Fixed short wait between empty-response retries. Empty responses
      // are cold-start / scaling signals, not rate-limit signals, so a
      // constant interval is the right shape (see EMPTY_RESPONSE_RETRY_DELAY_MS
      // comment above). Non-empty retries go through the service-health
      // cooldown and don't need an extra delay here.
      if (useEmptyBudget) {
        process.stderr.write(
          `[llm-externalizer] Waiting ${Math.round(EMPTY_RESPONSE_RETRY_DELAY_MS / 1000)}s before retry ${currentAttempt + 1}\n`,
        );
        await new Promise((r) => setTimeout(r, EMPTY_RESPONSE_RETRY_DELAY_MS));
      }
      continue;
    }

    // Exhausted retries — label by cause so the report makes sense.
    if (isEmpty && (resp.finishReason === "" || resp.finishReason === "stop")) {
      resp.content = `**EMPTY RESPONSE**: The provider returned no content after ${limit} retries (finish_reason=${reasonLabel}). This usually means a transient provider glitch or the model failed on this specific prompt. No partial output available.`;
    } else if (resp.finishReason === "error") {
      resp.content += `\n\n---\n**UPSTREAM ERROR**: The provider reported an error (finish_reason=error) after ${limit} retries. The partial output above may be incomplete.`;
    } else {
      resp.content += `\n\n---\n**INCOMPLETE**: Response did not finish cleanly after ${limit} retries (finish_reason=${reasonLabel}). The output above may be incomplete.`;
    }
    resp.truncated = true;
    process.stderr.write(
      `[llm-externalizer] Exhausted ${limit} retries (finish_reason=${reasonLabel}, empty=${isEmpty}) — returning with label\n`,
    );
    return resp;
  }
}
