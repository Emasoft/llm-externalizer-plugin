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
 * The state that could NOT move — `creditExhausted`, `FREE_MODEL_ID`, the
 * resolved max-tokens — is read or written by index.ts elsewhere (the
 * dispatch layer, `resolveModelOverride`). It STAYS in index.ts and is
 * reached, where still needed, through the injected `CompletionDeps` seam.
 *
 * `deps.getFreeModelId()` / `deps.engageAutoFree()` and the two mutators
 * that preceded them on this interface (a credit-exhausted-session setter
 * and a balance-cache invalidator) are ALL GONE, not just uncalled: they
 * existed only to drive the paid->free / 402->free cross-profile borrow,
 * which TRDD-OE27RD7I addendum 4 (USER, no exceptions) deletes outright —
 * see chatCompletionWithRetry's deterministic-failure path below. The two
 * mutators went first (phase 14.1-C1); the free-model-id getter and the
 * engage function followed once index.ts's OWN callers (resolveModelOverride,
 * classifyError) stopped engaging anything either (phase 14.1-C2c-ENV) —
 * this file never called any of the four. This module's retry loop reaching
 * for a resolved profile's OWN chain instead (profile-fallback.ts) is phase
 * 14.1-C2, wired at index.ts's
 * chatCompletionWithProfileFallback.
 *
 * This module imports ZERO from index.ts (that would be circular AND would drag
 * the whole MCP server's module-init graph into every importer).
 */

import { appendFileSync } from "node:fs";

import { applyModelOverrides } from "../request-overrides.js";
import { safeReadText, safeReadJson } from "../safe-body.js";
import { appendModelEvent } from "../model-events.js";
import { ctxStore, recordOutputTokensSample, recordRequest } from "../usage-history.js";
import { HEARTBEAT_INTERVAL_MS, type ProgressFn } from "../rate-limiter.js";

import {
  fetchWithTimeout,
  fetchWithRetry429,
  sanitizeProviderError,
  attachFailure,
  failureOf,
  httpFailureFields,
  RETRYABLE_STATUS,
  type FailureFields,
  RetryDeadlineError,
  failureText,
  RETRY_DEADLINE_MS,
  retryWindowClosed,
  startRetryClock,
  waitFitsClock,
  type RetryClock,
} from "./http.js";
import { chatCompletionNative } from "./lmstudio.js";
import {
  OutputLimitError,
  applyRequestOptions,
  effectiveMaxTokens,
  warnNoToolContextOnce,
  withStopInstruction,
  type ResolvedRequestOptions,
} from "./request-options.js";
import { resolveConnection, PRICE_CEILING_REFUSAL_PREFIX } from "./connection.js";
import { IRON_RULE_REFUSAL_PREFIX } from "../benchmark/validated.js";
import { isFreeSuffixModelId, paymentErrorCertainty } from "../benchmark/free-mode.js";
import { billableForRoute, type ResolvedRoute } from "../config.js";
import {
  classifyUnavailable,
  clearNoContentStrikes,
  credentialSucceededOnOtherModel,
  markCredentialSucceeded,
  markRunUnusable,
  noteGeneric403Model,
  noteOwnModelEvent,
  recordNoContentStrike,
} from "../free-rotation.js";
// resolveEnsembleModelLimits and the free-rotation pool helpers
// (approvedFreePoolFromSettings/callWithFreeRotation/logRotation/
// isRunUnusable) were used only by the paid->free rotation body, the
// cross-profile borrow deleted below (TRDD-OE27RD7I addendum 4) — no
// remaining caller in this file.
import {
  VALID_REASONING_EFFORTS,
  type ReasoningEffortSetting,
  type ChatMessage,
  type StreamingResult,
  type CompletionDeps,
  type ConnectionSetup,
} from "./types.js";

import { formatProviderState, slimEndpoints, type ProviderStateEntry } from "./provider-state.js";

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


// Slim endpoint state per exact model id, filled by the same /endpoints fetch
// (no extra request) and cleared with the Set map above on the same TTL.
const MODEL_PROVIDER_STATE = new Map<string, ProviderStateEntry>();

/** Synchronous, no fetch: the provider-state line of a model whose /endpoints reply was already cached, else undefined. */
export function providerStateLine(modelId: string, now: number = Date.now()): string | undefined {
  const entry = MODEL_PROVIDER_STATE.get(modelId);
  return entry ? formatProviderState(modelId, entry, now) : undefined;
}

/** httpFailureFields plus, for a provider-side status on the primary OpenRouter host, the cached provider-state line (never fetches). */
function httpFailureWithState(
  res: Response,
  text: string,
  conn: { url: string; model?: string },
  backend: { baseUrl: string },
): FailureFields {
  const fields = httpFailureFields(res, text);
  // Host gate on the full URL host (hostname AND port); an unparseable URL on either side gives no line.
  // WHY: a call routed to another vendor under an OpenRouter primary must never print OpenRouter's providers.
  if (
    conn.model &&
    res.status !== 429 &&
    RETRYABLE_STATUS.has(res.status) &&
    URL.canParse(conn.url) &&
    URL.canParse(backend.baseUrl) &&
    new URL(conn.url).host === new URL(backend.baseUrl).host
  ) {
    const line = providerStateLine(conn.model);
    if (line !== undefined) fields.providerState = line;
  }
  return fields;
}

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
    MODEL_PROVIDER_STATE.clear();
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
    // Stored BEFORE the size-0 return: a model with supported_parameters [] (the
    // recorded Jev reply) still has provider state worth keeping. slimEndpoints
    // is total, so it can never change the Set result below.
    MODEL_PROVIDER_STATE.set(modelId, { fetchedAt: Date.now(), endpoints: slimEndpoints(endpoints) });
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
  /** Tighter-than-global per-call deadline in ms, covering the body read as
   *  well as the headers. Omitted => the global soft timeout. session_summary
   *  sets this so one straggling chunk cannot drag a whole concurrent run out
   *  to the global 300s while every sibling has long since finished. */
  timeoutMs?: number;
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
  /** D6a (TRDD-90DM5YHO): the SPECIFIC serving group a chain walk targets.
   *  The profile-fallback walker passes the entry's own route so a model
   *  served by two groups reaches the group being tried; every other caller
   *  leaves it undefined and resolveConnection falls back to
   *  deps.routeForModel(model) — the first serving group, pre-D6a behaviour. */
  route?: ResolvedRoute;
  /** Absolute epoch-ms end of the retry window (TRDD-YG72CYY7). Omitted =>
   *  chatCompletionWithRetry starts a RETRY_DEADLINE_MS window at the call's
   *  FIRST failure. It gates only the start of new attempts/waits; a request
   *  already in flight is never aborted by it. */
  deadlineAt?: number;
  /** A retry clock shared by every call of one dispatcher scope (one file through
   *  one dispatcher), so "retry up to 5 minutes" holds per logical call and not
   *  per model tried. Absent => the call owns a private clock as before. When
   *  both this and `deadlineAt` are given, `retryClock` wins (its own deadline
   *  applies). Control field: never part of the request body. */
  retryClock?: RetryClock;
}

/**
 * The request options for THIS call: the tool name comes from the per-invocation
 * usage context (the same store provider/connection.ts reads), so no call site
 * has to pass it. A call without a tool context gets the default block, and the
 * process says so once.
 */
function requestOptionsForCall(deps: CompletionDeps): ResolvedRequestOptions | null {
  const tool = ctxStore.getStore()?.tool;
  const ro = deps.getRequestOptions(tool);
  if (ro !== null && tool === undefined) warnNoToolContextOnce();
  return ro;
}

/**
 * B1: the connection and request options for one call. When request options apply
 * the request MUST go to the OpenAI-compatible /v1/chat/completions path, never the
 * native /api/v1/chat one. WHY: llama-server's OpenAI endpoint is the one that honours
 * max_tokens, top_k, repeat_penalty and chat_template_kwargs and reports
 * finish_reason "length" (verified live 2026-10-28), while the native path sends no
 * cap and hard-codes finishReason "stop" (a runaway reply could never be detected).
 * O7: a non-primary providers[] route gets no options at all (they are profile-wide
 * settings for the primary local server and must not leak to another vendor/server).
 * If the OpenAI URL cannot be derived, throw: options are never dropped silently.
 */
function requestOptionsConnection(
  conn: ConnectionSetup,
  deps: CompletionDeps,
): { conn: ConnectionSetup; ro: ResolvedRequestOptions | null } {
  if (conn.routed) return { conn, ro: null };
  const ro = requestOptionsForCall(deps);
  if (ro === null || !conn.isNative) return { conn, ro };
  const nativeSuffix = "/api/v1/chat";
  if (!conn.url.endsWith(nativeSuffix)) {
    throw new Error(
      `request_options: cannot derive the OpenAI-compatible endpoint from '${conn.url}'; refusing to send without the options`,
    );
  }
  return {
    conn: { ...conn, url: `${conn.url.slice(0, -nativeSuffix.length)}/v1/chat/completions`, isNative: false },
    ro,
  };
}
// ── Non-streaming text completion ────────────────────────────────────
// All LLM requests use this. stream=false, single JSON response.
// Batch-level heartbeat in rateLimitedParallel keeps MCP connection alive.

export async function chatCompletionSimple(
  messages: ChatMessage[],
  options: SimpleCompletionOptions,
  deps: CompletionDeps,
  // Retry clock owned by chatCompletionWithRetry; absent for direct callers,
  // so a one-shot call never starts a retry window or mutates its options.
  clock?: RetryClock,
  // Call-local state of chatCompletionWithRetry: receives `refusedRetryAt` when
  // a Retry-After beyond the window ended this call's retrying (never the clock).
  call?: { refusedRetryAt?: number; requestOptions?: ResolvedRequestOptions | null },
): Promise<StreamingResult> {
  // T2.7 — snapshot once at top of this LLM call. resolveConnection() also
  // snapshots internally to make the URL+model+timeout tuple coherent; here
  // we use the same generation for reasoning-ladder gating and error-msg
  // backend-type labels. A mid-call reload that changes `currentBackend`
  // cannot interleave fields between conn building and the request body.
  const backend = deps.getBackend();
  const { conn, ro } = requestOptionsConnection(await resolveConnection(options, deps), deps);
  // O5: remember the options THIS request used so the length check in chatCompletionWithRetry does not re-resolve them.
  if (call) call.requestOptions = ro;

  // LM Studio / llama.cpp native API — delegate to native handler (different request format). requestOptionsConnection never leaves a native conn when ro !== null.
  if (conn.isNative) {
    return chatCompletionNative(conn, messages, options, deps);
  }
  const baseBody: Record<string, unknown> = {
    // WHY a copy with the stop sentence: see withStopInstruction (first system message only).
    messages: ro !== null ? withStopInstruction(messages, effectiveMaxTokens(ro, options.maxTokens)) : messages,
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
      // TRDD-1OOAH3LD: profile request_options win over the static model table.
      if (ro !== null) body = applyRequestOptions(body, ro, options.maxTokens);
      // Filter to only fields this model supports. Does nothing for
      // non-OpenRouter backends and for models with unknown metadata.
      body = filterBodyForSupportedParams(body, supportedParams, conn.model);

      // Cost/observability audit: when LLM_EXT_DUMP_REQUESTS points at a file,
      // append the exact wire payload (model + byte size + body) so a request can
      // be inspected for unexpected prompt/file inflation. Off unless set.
      // Best-effort: a dump-write failure (bad path, full disk) must NEVER break
      // the actual LLM call.
      dumpRequestBody(body, conn.model);

      const rl429: { saw429: boolean; refusedRetryAt?: number } = { saw429: false };
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
        clock,
      );
      if (call && rl429.refusedRetryAt !== undefined) call.refusedRetryAt = rl429.refusedRetryAt;

      // A1/A7: one durable rate_limit_429 per call that hit ≥1 429 (the retry
      // helper collapses the per-attempt flood; the final-attempt 429 that
      // exhausted retries is caught via res.status here). Logging-only.
      if ((rl429.saw429 || res.status === 429) && !emitted429) {
        emitted429 = true;
        // Names the provider the 429 came from; the ledger reader parses only "HTTP NNN", so the extra words are inert.
        appendModelEvent(conn.model || "unknown", "rate_limit_429", `429 during call${clock?.lastProvider ? ` from ${clock.lastProvider}` : ""}`);
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
          attachFailure(lastError, httpFailureWithState(res, text, conn, backend));
          continue;
        }
        // A1/A7: a 4xx (non-429) is an unrecoverable model-side failure
        // (bad request, model gone, forbidden). Record it before throwing so
        // the throw path is unchanged. 429 is recorded above, not here.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // The body (sanitized, never a key, capped to 120 chars) is what
          // lets §5's persistence verdict AND a human reading the ledger tell
          // a model-specific 403 ("only available on agentic harnesses") from
          // a bad-key 403 ("No auth credentials found") — the bare status
          // alone can't (both are "HTTP 403").
          const ev = appendModelEvent(
            conn.model || "unknown",
            "non_retryable_failure",
            `HTTP ${res.status}: ${sanitizeProviderError(text, 120)}`,
          );
          // Keep §5's lazy recent-events cache current for THIS process
          // without a re-read (P2 amendment item 3).
          if (ev) noteOwnModelEvent(ev);
        }
        const httpErr = new Error(
          `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
        );
        attachFailure(httpErr, httpFailureWithState(res, text, conn, backend));
        throw httpErr;
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
      // Task #188: fold completion_tokens into the per-tool×model output EWMA
      // so --estimate's EXPECTED line calibrates itself from real runs.
      if (typeof usage?.completion_tokens === "number") {
        recordOutputTokensSample(model, usage.completion_tokens);
      }
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
    /** Retry clock shared by every call of one dispatcher scope (see
     *  SimpleCompletionOptions.retryClock). Absent => no retry window. */
    retryClock?: RetryClock;
  },
  deps: CompletionDeps,
): Promise<JSONCompletionResult> {
  // T2.7 — snapshot once for consistent (type, model) across all branches
  const backend = deps.getBackend();
  // "shared" is a property of the error (TRDD-YG72CYY7 round C0a item 1): this
  // function only runs under a caller-supplied clock (its rotation wrapper in
  // index.ts scopes one), so the throw sites below pass it straight through.
  const shared = options.retryClock !== undefined;
  // A call that starts under a shared clock another call already closed makes no
  // request: the dispatch has no retry time left. Cause = the clock's newest error.
  if (options.retryClock && retryWindowClosed(options.retryClock)) {
    throw retryDeadlineError(options.retryClock, options.retryClock.lastError, backend.type, {
      shared,
      // foreignCause only when a cause actually rides along: with none the
      // label must stay the default, per retryDeadlineError's contract.
      foreignCause: options.retryClock.lastError !== undefined,
    });
  }
  const { conn, ro } = requestOptionsConnection(await resolveConnection(options, deps), deps);

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

  // TRDD-1OOAH3LD: null unless the active profile sets request_options (ro and conn come from requestOptionsConnection above).
  const baseBody: Record<string, unknown> = {
    // WHY a copy with the stop sentence: see withStopInstruction (first system message only).
    messages: ro !== null ? withStopInstruction(messages, effectiveMaxTokens(ro, options.maxTokens)) : messages,
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
      // TRDD-1OOAH3LD: profile request_options win over the static model table.
      if (ro !== null) body = applyRequestOptions(body, ro, options.maxTokens);
      // Filter to only fields this model supports (Nemotron drops
      // frequency_penalty etc., other models may drop reasoning).
      body = filterBodyForSupportedParams(body, supportedParams, conn.model);

      // Cost/observability audit (see chatCompletionSimple) — structured-output path.
      dumpRequestBody(body, conn.model);

      const rl429: { saw429: boolean; refusedRetryAt?: number } = { saw429: false };
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
        options.retryClock,
      );

      // A1/A7: one durable rate_limit_429 per call that hit ≥1 429. Logging-only.
      if ((rl429.saw429 || res.status === 429) && !emitted429) {
        emitted429 = true;
        appendModelEvent(conn.model || "unknown", "rate_limit_429", `429 during call (JSON mode)${options.retryClock?.lastProvider ? ` from ${options.retryClock.lastProvider}` : ""}`);
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
          attachFailure(lastLadderError, httpFailureWithState(res, text, conn, backend));
          continue;
        }
        // A1/A7: a 4xx (non-429) is an unrecoverable model-side failure.
        // Record before throwing — the throw path is unchanged.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const ev = appendModelEvent(
            conn.model || "unknown",
            "non_retryable_failure",
            `HTTP ${res.status} (JSON mode): ${sanitizeProviderError(text, 120)}`,
          );
          if (ev) noteOwnModelEvent(ev);
        }
        const httpErr = new Error(
          `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
        );
        attachFailure(httpErr, httpFailureWithState(res, text, conn, backend));
        // chatCompletionJSON has no retry wrapper, so it records the newest error
        // on the shared clock itself (chatCompletionWithRetry does that for the
        // plain path); a later call under a closed clock uses it as its cause.
        if (options.retryClock) options.retryClock.lastError = httpErr;
        // A Retry-After beyond the window ends THIS call only (the shared clock
        // stays open for the next model); no wrapper exists here to convert it.
        if (rl429.refusedRetryAt !== undefined) {
          throw retryDeadlineError(options.retryClock ?? {}, httpErr, backend.type, {
            shared,
            refusedRetryAt: rl429.refusedRetryAt,
            // No catch-snapshot exists on this path (chatCompletionJSON has no
            // retry wrapper), but the clock fields ARE current: http.ts set them
            // from THIS refusal body just before the throw. Pass them through
            // explicitly so the provider never degrades to a regex or the
            // backend type (round C0b item 1, B4).
            lastStatus: options.retryClock?.lastStatus,
            lastProvider: options.retryClock?.lastProvider,
          });
        }
        throw httpErr;
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
      // TRDD-1OOAH3LD: on a request_options profile a reply cut off by the
      // length limit (partial or empty) is an error, never a half answer.
      if (ro !== null && finishReason === "length") {
        // O3: the request completed and was billed; record it like the plain path does before throwing.
        recordRequest({ ok: true, durationMs: Date.now() - jsonStartTime, costUsd: usage?.cost ?? 0 });
        if (typeof usage?.completion_tokens === "number" && model) {
          recordOutputTokensSample(model, usage.completion_tokens);
        }
        throw new OutputLimitError({
          tool: ctxStore.getStore()?.tool,
          model: model || conn.model || "unknown",
          maxTokens: effectiveMaxTokens(ro, options.maxTokens),
          callerCap: ro.maxOutputTokens > (options.maxTokens ?? Infinity),
          completionTokens: usage?.completion_tokens,
          partial: rawContent,
        });
      }
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
    // Task #188: same EWMA fold as the plain-completion path above.
    if (typeof usage?.completion_tokens === "number" && model) {
      recordOutputTokensSample(model, usage.completion_tokens);
    }
    return { parsed, model, usage, finishReason };
  } catch (e) {
    // An OutputLimitError already recorded its own ok line (the HTTP request completed); a second fail line would double-count it.
    if (!(e instanceof OutputLimitError)) {
      recordRequest({ ok: false, durationMs: Date.now() - jsonStartTime, costUsd: 0 });
    }
    throw e;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

// ── Global service health tracker ────────────────────────────────────
// Tracks consecutive TRANSPORT failures across ALL requests to detect systemic
// issues (offline servers, broken connections, traffic overload). When the
// failure rate exceeds the threshold, pauses with exponential backoff before
// retrying. If all backoff attempts fail, aborts with a clear server-side error
// message.
//
// TRANSPORT-ONLY (2026-08-04 livelock post-mortem): only thrown request errors
// (network / timeout / non-2xx) feed this breaker — except a payment error
// (D1, paymentErrorCertainty), which is a refusal of one model or key, not an
// outage, and neither counts nor resets the streak. An HTTP 200 whose body is
// empty or all-reasoning (finish_reason=length) is a MODEL-shape failure with
// its own dedicated cures (the reasoning downgrade ladder + the length+empty
// cost stop below) and MUST NOT count here: during a parallel scan over
// reasoning-heavy free models, counting those raced this GLOBAL counter past
// the threshold while the provider was measurably healthy (a live probe
// returned 200 in <2s), and the resulting false "SERVER ISSUE" verdict fed the
// rotation layer a poisoned error that livelocked the whole free pool.
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
  // Round C item 1 (TRDD-YG72CYY7): epoch of the breaker state — bumped ONLY
  // by the reset branch. A sleeper waking to a changed epoch was reset under
  // it and must not proceed as a fresh attempt (the half-open "one real
  // attempt" contract); a recordServiceSuccess heal does NOT bump it, so a
  // healed sleeping claim proceeding is correct. sleepers counts callers
  // currently inside a rung wait, for abort-message accuracy.
  epoch: 0,
  // Epoch at which the last success healed the breaker (-1 = none); a stale sleeper proceeds when this equals the current epoch (review M1).
  successEpoch: -1,
  sleepers: 0,
  // If true, service is in backoff/cooldown mode
  inCooldown: false,
};

/** Test hook: zero the circuit breaker so one test's failures don't trip
 *  escalating backoff (60s/120s/350s) on a LATER, unrelated test — module
 *  state persists across tests in the same vitest file (isolate is per FILE,
 *  not per test), same reason free-rotation.ts exports resetRunUnusableForTests. */
export function resetServiceHealthForTests(): void {
  SERVICE_HEALTH.consecutiveFailures = 0;
  SERVICE_HEALTH.lastSuccessAt = Date.now();
  SERVICE_HEALTH.backoffAttempt = 0;
  SERVICE_HEALTH.inCooldown = false;
  // Zeroed too: a stale epoch/sleepers/successEpoch from one test would leak into the next (round C review L2).
  SERVICE_HEALTH.sleepers = 0;
  SERVICE_HEALTH.epoch = 0;
  SERVICE_HEALTH.successEpoch = -1;
}


/** Test hook (round C item 1): checkServiceHealthOrWait is module-private; the
 *  epoch/stale-sleeper contract is only reachable through this export. */
export function checkServiceHealthForTests(clock?: RetryClock): Promise<string | null> {
  return checkServiceHealthOrWait(clock);
}

/** Test hook: put the breaker exactly at its failure threshold. */
export function tripServiceHealthForTests(): void {
  // Direct set, not recordServiceFailure(): free-rotation-coverage pins that symbol to exactly one call site.
  SERVICE_HEALTH.consecutiveFailures = SERVICE_HEALTH.failureThreshold;
}


/** Test hook: set the failure streak to an exact count (boundary tests at threshold-1 / threshold).
 *  Direct set, not recordServiceFailure(): free-rotation-coverage pins that symbol to exactly one call site. */
export function setServiceFailuresForTests(count: number): void {
  SERVICE_HEALTH.consecutiveFailures = count;
}

/** Test hook: the breaker's current consecutive-failure count (read-only). */
export function serviceFailureCountForTests(): number {
  return SERVICE_HEALTH.consecutiveFailures;
}
/** Test hook: callers currently inside a backoff rung wait. */
export function serviceHealthSleepersForTests(): number {
  return SERVICE_HEALTH.sleepers;
}

/** Test hook: a real success (heals the breaker and stamps successEpoch) without an HTTP round trip. */
export function recordServiceSuccessForTests(): void {
  recordServiceSuccess();
}
function recordServiceSuccess(): void {
  SERVICE_HEALTH.consecutiveFailures = 0;
  SERVICE_HEALTH.lastSuccessAt = Date.now();
  SERVICE_HEALTH.backoffAttempt = 0;
  SERVICE_HEALTH.inCooldown = false;
  // Remember the epoch a success healed: sleepers reset-under earlier must not abort a healthy service (review M1).
  SERVICE_HEALTH.successEpoch = SERVICE_HEALTH.epoch;
}

function recordServiceFailure(): void {
  SERVICE_HEALTH.consecutiveFailures++;
}

/** Returns true if we should abort (server-side issue confirmed). */
async function checkServiceHealthOrWait(clock?: RetryClock): Promise<string | null> {
  if (SERVICE_HEALTH.consecutiveFailures < SERVICE_HEALTH.failureThreshold) {
    return null; // Not enough failures to trigger cooldown
  }

  const { backoffDelays, backoffAttempt } = SERVICE_HEALTH;
  // The ladder is exhausted when every rung was waited OR the next rung is
  // longer than the retry window (TRDD-YG72CYY7). A rung longer than
  // RETRY_DEADLINE_MS can never fit any call's window, so it is skipped and the
  // abort verdict is returned at once. Merely refusing it inside a clocked call
  // (the first design) left the ladder armed at that rung, and the NEXT call —
  // any chain entry, retry or file, with no clock started yet — claimed the
  // slot and slept the whole 350 s: the refusal relocated the stall instead of
  // removing it.
  if (backoffAttempt >= backoffDelays.length || backoffDelays[backoffAttempt] > RETRY_DEADLINE_MS) {
    // Exhausted all backoff attempts — abort THIS call, then HALF-OPEN the
    // breaker. Without the reset, the tripped state was permanent: the only
    // reset was recordServiceSuccess(), which needs a completed request, but a
    // tripped breaker aborts every call BEFORE any request goes out — so no
    // success could ever occur again and every later call in the process was
    // stillborn (the 2026-08-04 livelock: rotation cycled a whole pool of
    // instant aborts forever). Resetting here means the NEXT call gets one
    // real attempt; if the outage is real, failures re-trip the breaker and
    // the ladder runs again.
    // The sentence must say why the ladder stopped: when the NEXT rung is
    // longer than the retry window it was refused, not tried, and a caller that
    // waited nothing must not be told "Tried waiting 60s, 120s.".
    const waitedRungs = backoffDelays.slice(0, backoffAttempt).map((d) => `${d / 1000}s`).join(", ");
    const ladderSentence =
      backoffAttempt < backoffDelays.length
        ? `Backoff waits already used in this process: ${waitedRungs || "none"}; ` +
          `the next wait (${backoffDelays[backoffAttempt] / 1000}s) is longer than the retry window so it was not attempted. `
        : `Tried waiting ${waitedRungs}. `;
    // Round C item 1 (TRDD-YG72CYY7): the waits in ladderSentence were made by
    // OTHER callers of this process — say so when sleepers exist, so THIS
    // caller is not told it waited when it did not.
    const sleeperSentence =
      SERVICE_HEALTH.sleepers > 0
        ? `Other calls of this process are still waiting out earlier rungs; they will not make fresh attempts after this reset. `
        : "";
    const message =
      `SERVER ISSUE DETECTED: ${SERVICE_HEALTH.consecutiveFailures} consecutive failures. ` +
      `Last success was ${Math.round((Date.now() - SERVICE_HEALTH.lastSuccessAt) / 1000)}s ago. ` +
      ladderSentence +
      sleeperSentence +
      `The issue appears to be server-side (offline, overloaded, or connection broken). ` +
      `Please retry later.`;
    SERVICE_HEALTH.consecutiveFailures = 0;
    SERVICE_HEALTH.backoffAttempt = 0;
    SERVICE_HEALTH.inCooldown = false;
    // Round C item 1 (TRDD-YG72CYY7): bump the epoch ONLY here — a sleeper
    // waking to a changed epoch was reset under and returns the abort verdict
    // instead of a fresh attempt. A heal (recordServiceSuccess) must not bump
    // it: a healed sleeping claim proceeding is correct.
    SERVICE_HEALTH.epoch++;
    return message;
  }

  // Pause with backoff. The attempt slot is claimed BEFORE the await —
  // synchronously, so it is atomic in single-threaded JS. Incrementing after
  // waking was a concurrency bug (ultracode F3, 2026-08-05): while one call
  // slept, the exhausted-branch reset (or recordServiceSuccess) could zero
  // backoffAttempt, and the waking sleeper's stale `++` then advanced the
  // FRESH ladder — enough waking sleepers pushed it past backoffDelays.length
  // with consecutiveFailures=0, so the NEXT failure streak aborted on its
  // first health check while the message still claimed the full ladder ran.
  const delay = backoffDelays[backoffAttempt];
  // Retry clock (TRDD-YG72CYY7): never wait past it, and never claim a ladder
  // slot when there is no time left to use it. Checked BEFORE the slot claim
  // below so a refused wait leaves the shared ladder untouched for other
  // calls. Returning null with the clock marked expired makes the caller stop
  // at its next loop check (RetryDeadlineError) instead of sleeping.
  if (!waitFitsClock(clock, delay)) return null;
  // Round C item 1 (TRDD-YG72CYY7): capture the epoch BEFORE sleeping and
  // count this caller as a sleeper; after waking, a changed epoch means the
  // breaker was reset under this caller — return the abort verdict instead of
  // proceeding as a fresh attempt (the half-open contract). NEVER null here:
  // null sends the caller to a fresh request, resurrecting the bug.
  const myEpoch = SERVICE_HEALTH.epoch;
  SERVICE_HEALTH.sleepers++;
  SERVICE_HEALTH.backoffAttempt++;
  SERVICE_HEALTH.inCooldown = true;
  // try/finally: a throwing stderr write must not leak the sleeper count (review L1).
  try {
    process.stderr.write(
      `[circuit-breaker] ${SERVICE_HEALTH.consecutiveFailures} consecutive failures detected — ` +
      `waiting ${delay / 1000}s before retrying (backoff ${backoffAttempt + 1}/${backoffDelays.length})\n`,
    );
    await new Promise((r) => setTimeout(r, delay));
  } finally {
    SERVICE_HEALTH.sleepers--;
  }
  // Round C item 1 (TRDD-YG72CYY7): stale sleeper — the breaker was reset
  // under this caller while it waited. Return the abort verdict (the
  // serviceAbort shape) instead of null, so the caller does not make a fresh
  // attempt on a breaker that just reset (the half-open contract).
  // Abort only if reset under us AND no success healed the new epoch; a healed service deserves a real attempt (review M1).
  // successEpoch is a high-water mark, so a breaker re-tripped after the heal in the same epoch must still abort (review M-B).
  if (
    myEpoch !== SERVICE_HEALTH.epoch &&
    (SERVICE_HEALTH.successEpoch !== SERVICE_HEALTH.epoch || SERVICE_HEALTH.consecutiveFailures >= SERVICE_HEALTH.failureThreshold)
  ) {
    // A re-trip after a heal is not a concurrent reset: say what actually happened.
    if (SERVICE_HEALTH.successEpoch === SERVICE_HEALTH.epoch) {
      return `SERVER ISSUE DETECTED: the service recovered while this call waited out its backoff rung but failed again (${SERVICE_HEALTH.consecutiveFailures} consecutive failures); this call aborts instead of making a fresh attempt.`;
    }
    return `SERVER ISSUE DETECTED: the circuit breaker was reset by a concurrent caller while this call waited out its backoff rung; this call aborts instead of making a fresh attempt.`;
  }
  SERVICE_HEALTH.inCooldown = false;
  return null;
}

// Retries LLM calls when the response is truncated (finishReason !== "stop")
// or when a timeout caused partial output. Up to 3 retries for generic
// failures; up to 15 retries for silent empty responses on OpenRouter
// (the documented "no content generated" case — cold-start / scaling).
// Integrates with SERVICE_HEALTH to detect systemic server issues.
const MAX_TRUNCATION_RETRIES = 3;
const MAX_EMPTY_RESPONSE_RETRIES = 15;

// ── Run-level PAID empty-response spend guard (ultracode F4, 2026-08-05) ──
// Every empty/glitch retry on a PAID model re-bills the full prompt: input
// tokens are charged even when zero content comes back. The per-call budget
// (MAX_EMPTY_RESPONSE_RETRIES) caps ONE call at 15 billed attempts, but a scan
// makes hundreds of calls. Before the transport-only breaker change the GLOBAL
// breaker accidentally bounded that spend (empty responses fed it and tripped
// a stall); making the breaker transport-only deleted the only run-level stop.
// This restores a DELIBERATE one: once a paid model has burned this many
// empty-response retries process-wide, later calls on it stop retrying
// immediately (label + return) instead of re-paying up to 15 attempts per file
// for a model that is demonstrably not answering. Free models are exempt —
// their retries cost $0 and the no-content strike store already demotes them.
const RUN_PAID_EMPTY_RETRY_BUDGET = 30;
const runPaidEmptyRetriesByModel = new Map<string, number>();
// Fixed wait between empty-response retries. Empty responses aren't a
// rate-limit signal — they're documented cold-start / scaling behavior,
// so exponential backoff would be the wrong primitive (it would make us
// wait longer the more the provider needs a warm request). A small,
// constant delay just gives the provider a moment to finish whatever
// scaling it was doing before we try again.
const EMPTY_RESPONSE_RETRY_DELAY_MS = 2000;


/** Build the final error when the retry window closed (TRDD-YG72CYY7). The
 *  last underlying error rides in `.cause`; status and provider are read from
 *  that cause (see the body), the backend type is the provider fallback.
 *  `opts.shared` — a property of the ERROR, not the caller (round C0a item 1):
 *  true only when the call runs under a caller-supplied (dispatch-scope) clock.
 *  `dispatchClosed` is then true only for a shared window that is REALLY closed;
 *  a call with a private clock owns its window (the next model gets a fresh one)
 *  and throws dispatchClosed false, so rotation and the chain walk treat it as
 *  an ordinary failure of that one model. `opts.foreignCause` labels `.cause`
 *  as another call's error and must be passed ONLY when the cause is not this
 *  call's own failure — with no cause at all it stays false. `opts.lastStatus`
 *  and `opts.lastProvider` carry the call's OWN snapshot of the clock fields
 *  (round C0b item 1, B4): another concurrent slot can overwrite the shared
 *  clock fields before this call builds its error, so the values must be read
 *  at the moment THIS call failed. The sites outside chatCompletionWithRetry's
 *  catch that reach the fallbacks: the chatCompletionJSON entry-check throw
 *  (no snapshot exists — the window closed before this call attempted
 *  anything) and its Retry-After refusal throw, which passes the clock fields
 *  explicitly because they ARE current for that call (http.ts sets them from
 *  the refusal body just before the throw). */
function retryDeadlineError(
  clock: RetryClock,
  cause: unknown,
  backendType: string,
  opts: { shared: boolean; refusedRetryAt?: number; foreignCause?: boolean; lastStatus?: number; lastProvider?: string },
): RetryDeadlineError {
  // Status and provider come from the call's own snapshot first (set in
  // chatCompletionWithRetry's catch the instant its attempt failed), then the
  // cause text's "API error NNN" status, then — only when the cause is
  // FOREIGN or absent — the clock's newest fields (they ARE the dispatch's
  // newest, and that is what "foreign" means). The provider is NEVER regexed
  // out of the finished text (round C0b item 1, B4): a message like
  // "Provider returned error at [0]" made the old bracket regex report the
  // provider as "0"; the trail names the provider only from the body parse
  // (providerNameFromBody, via the clock/snapshot) or falls back to the
  // backend type.
  const text = cause === undefined ? undefined : failureText(cause);
  // Unified fallback chain (round C0b item 1, B4): snapshot (the call own
  // values, taken at its own failure) ?? "API error NNN" parse of the cause
  // text ?? the clock fields (the dispatch newest — right for a FOREIGN cause
  // and for a no-snapshot own cause). Provider: snapshot ?? clock ?? backend.
  const status = opts.lastStatus ?? (Number(/API error (\d{3})\b/.exec(text ?? "")?.[1]) || clock.lastStatus);
  const provider = opts.lastProvider ?? clock.lastProvider ?? backendType;
  return new RetryDeadlineError(
    {
      attempts: clock.attempts ?? 0,
      elapsedMs: Date.now() - (clock.startedAt ?? Date.now()),
      lastStatus: status,
      lastProvider: provider,
    },
    cause,
    // retryAt only from THIS call's own refusal, never from the dispatch.
    opts.refusedRetryAt,
    // dispatchClosed is true only for a SHARED window that is really closed.
    // WHY it is a property of the error: the rotation and the walk cannot tell
    // a shared clock from a private one. A call with a private clock owns its
    // window (the next model gets a fresh one), and a Retry-After refusal beyond
    // an open window ends this call only.
    opts.shared && (opts.refusedRetryAt === undefined || retryWindowClosed(clock)),
    opts.foreignCause === true,
  );
}

// The paid->free rotation body shared by the mid-flight 402 handler and the
// terminal paid-unavailable handler is DELETED here, not reworked:
// TRDD-OE27RD7I addendum 4 (USER, no exceptions) forbids every
// cross-profile borrow, including 402->free and paid->free — the exact two
// things this function existed to do. The completion path now iterates only
// the resolved profile's own chain (see profile-fallback.ts); a model
// outside that profile is never reached from here again.

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
  // Check global service health before attempting. The shared clock (when
  // given) is passed so a call entering under an already-started clock never
  // sleeps a breaker rung that does not fit (N8).
  const healthAbort = await checkServiceHealthOrWait(options.retryClock);
  if (healthAbort) {
    return {
      content: healthAbort,
      serviceAbort: true,
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
  // D1: an UNCERTAIN payment error gets exactly one same-model retry per call.
  let paymentRetried = false;
  // A1/A7 model-health: emit ONE truncation_retry per logical call the first
  // time an incomplete/truncated response forces a continuation retry — not one
  // per retry attempt. Logging-only; never alters the retry/backoff loop.
  let emittedTruncationRetry = false;
  // Retry clock for THIS logical call (TRDD-YG72CYY7): the dispatcher scope's
  // shared clock when given (it wins over `deadlineAt`), else an own object so
  // the caller's options are never mutated; starts at the first failure.
  // "shared" is a property of the error (TRDD-YG72CYY7 round C0a item 1): a
  // private clock owns its window (the next model gets a fresh one), so only
  // a call under a caller-supplied clock can throw dispatchClosed true.
  const shared = options.retryClock !== undefined;
  const clock: RetryClock = options.retryClock ?? { deadlineAt: options.deadlineAt };
  let lastErr: unknown;
  // Call-local: set when a Retry-After beyond the window ended THIS call's
  // retrying. Not on the shared clock, so other models of the dispatch go on.
  const call: { refusedRetryAt?: number; requestOptions?: ResolvedRequestOptions | null } = {};
  const stopped = (): boolean => retryWindowClosed(clock) || call.refusedRetryAt !== undefined;

  // Call-local snapshot of the clock status/provider, refreshed in the catch
  // below at the moment THIS call failed (round C0b item 1, B4): the loop-top
  // throw can fire before any attempt of this call, in which case there is no
  // snapshot and the undefined values let retryDeadlineError fall back to the
  // clock fields.
  let callStatus: number | undefined;
  let callProvider: string | undefined;

  while (true) {
    // A refused wait or a passed deadline ends the retrying here, before a new
    // attempt is started. Under a shared clock this CAN be reached before this
    // call has failed at all (another call closed the window), so the cause
    // falls back to the clock's newest error; without it the error would carry
    // no cause.
    if (stopped()) {
      throw retryDeadlineError(clock, lastErr ?? clock.lastError, backend.type, {
        shared,
        refusedRetryAt: call.refusedRetryAt,
        // "Foreign" only when a cause actually rides along: lastErr undefined
        // AND clock.lastError undefined leaves the error cause-less, and a
        // cause-less error must keep the default label.
        foreignCause: lastErr === undefined && clock.lastError !== undefined,

        // The call-own snapshot (round C0b item 1, B4): read at the moment
        // THIS call failed, before another slot could overwrite the fields.
        lastStatus: callStatus,
        lastProvider: callProvider,
      });
    }
    let resp: StreamingResult;
    try {
      // Non-streaming: single JSON response, no SSE parsing.
      // Batch-level heartbeat in rateLimitedParallel keeps MCP alive.
      resp = await chatCompletionSimple(messages, options, deps, clock, call);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      startRetryClock(clock);
      lastErr = err;
      // Snapshot the clock's status/provider NOW (round C0b item 1, B4):
      // another concurrent slot can overwrite the shared clock fields before
      // this call builds its error, so the values must be read at the moment
      // THIS call failed. retryDeadlineError prefers these over both the
      // cause-text parse and the (possibly newer) clock fields.
      callStatus = clock.lastStatus;
      callProvider = clock.lastProvider;

      // A mid-flight 402 (credit exhausted) used to retry THIS call against
      // the hard-coded FREE_MODEL_ID here — the "402 -> free" cross-profile
      // borrow TRDD-OE27RD7I addendum 4 forbids (USER, no exceptions: "no
      // switching to free models ... must exist anymore"). Deleted, not
      // reworked: 402 now falls straight into the generic deterministic-4xx
      // classification below (fix-queue row 15 — 402 joins 403/404/410 there,
      // never retried on the same model), and this call simply throws so the
      // profile's own chain (profile-fallback.ts) can advance, once a caller
      // wires it in (phase 14.1-C2).

      // D1: a payment error (paymentErrorCertainty, free-rotation.ts) is the
      // server correctly refusing THIS model or key, not a systemic outage —
      // and the breaker exists for outages (e0688b6: "when the server is
      // down"). Counting it made a chain whose every entry 402s sleep 60s
      // mid-walk before a guaranteed 402 (the Row 27 paid test measured
      // 60.1s). Neutral: it neither counts nor resets the streak. Everything
      // else — network, timeout, 5xx, 429, any other non-2xx — still counts,
      // unchanged (aa87c5d's transport-only rule).
      const payment = paymentErrorCertainty(errMsg);
      // D3c-1 fix-up (TRDD-FDI9NYAS, regression found in
      // profile-chain-402.test.ts): connection.ts's send-time price-ceiling
      // refusal ("refusing to send auto-picked paid model ...") is a
      // closed-form, $0, deterministic refusal — never a transport/server
      // problem, and never retryable by asking the same model again (the
      // price/cache state that produced it can't change mid-call). Without
      // this exclusion it fell into the generic "transient" branch below:
      // retried the SAME model up to MAX_TRUNCATION_RETRIES times for
      // nothing, and fed recordServiceFailure() into the GLOBAL circuit
      // breaker, which trips after 5 consecutive failures and sleeps 60s+ —
      // turning an instant, free refusal into a 60s+ stall once a chain had
      // enough refused entries (the test's 30s timeout). Treat it like a
      // deterministic 4xx: no breaker count, no same-model retry, immediate
      // throw so the caller's chain (walkProfileChainOnce) advances at once.
      const isPriceCeilingRefusal = errMsg.startsWith(PRICE_CEILING_REFUSAL_PREFIX);
      // TRDD-VAORGKVF: the IRON RULE refusal (assertModelValidated) is thrown before anything is sent: $0, deterministic, and no wait or retry can change the ledger. It used to feed recordServiceFailure and get 3 same-model retries per entry (measure r1 item 2). Only that function produces the prefix; every HTTP error starts with "API error" (measure r2 item 6).
      const isIronRuleRefusal = errMsg.startsWith(IRON_RULE_REFUSAL_PREFIX);
      // GitHub-15 finding 2 (D4): the breaker exists for OUTAGES (429, 5xx,
      // 408, transport). A deterministic 4xx (402/403/404/410 — the same gate
      // that stops the same-model retry below) cannot succeed by asking
      // again, so counting it only parked the walk in 60/120/350 s sleeps
      // before a guaranteed refusal (issue 15: 530 of 941 s were breaker
      // sleeps triggered solely by permanent 403s). Never breaker food.
      const deterministic4xx = /\bAPI error (402|403|404|410)\b/.test(errMsg);
      // YG72CYY7 D4: a stop verdict (TLS) cannot heal by waiting, so it is not breaker food; refused connections and DNS budgets still are.
      // Request/auth refusals are not outages; their existing retry policy stays separate.
      const requestOrAuth4xx = callStatus === 400 || callStatus === 401;
      if (payment === null && !isPriceCeilingRefusal && !isIronRuleRefusal && !deterministic4xx && !requestOrAuth4xx && failureOf(err)?.final !== "stop")
        recordServiceFailure();
      // Bumped unconditionally even for a deterministic4xx/price-ceiling
      // refusal that throws below without ever reading it again this call —
      // same pre-existing shape the deterministic4xx branch already has.
      // Harmless (nothing downstream reads a stale count across models), so
      // left as-is rather than adding a second conditional to a counter nothing depends on.
      genericAttempts++;
      // A deterministic 4xx (402/403/404/410 — never 429, that's transient) can
      // never succeed by asking the SAME model again (TRDD-W9XLU1HD): without
      // this the retry loop burns MAX_TRUNCATION_RETRIES extra round-trips
      // before the caller ever gets a chance to rotate. This gate is on the
      // RAW STATUS, not classifyUnavailable's verdict — a bad/revoked API key
      // also returns 403, and that case must still stop retrying THIS model
      // (there's nothing to gain from asking again) even though it must NOT
      // be treated as "this model is gone" (see classifyUnavailable's 403
      // gate in free-rotation.ts, P2 amendment 2026-09-16). 402 is included
      // (TRDD-90DM5YHO item 3): out of credit is deterministic for the same
      // model and key, same reasoning as 403/404/410 — and D1's payment gate
      // below never retries a 402 either (it is always "certain").
      // (declared above, next to the breaker gate — GitHub-15 moved it up so
      // both gates share one regex)
      // Separately: is THIS verdict model-specific enough to mark the model
      // run-unusable? classifyUnavailable only returns "gone"/"daily-quota"
      // for a 403 when the body names the model, not just the key — so a
      // bad-key 403 correctly marks nothing, and the ORIGINAL auth error
      // surfaces to the caller via the `throw err` below. UNLESS this
      // credential has already proven itself good on a DIFFERENT model this
      // run (TRDD-90DM5YHO item 1) — then a bare 403 on THIS model can only be
      // about this model, not the key, so it is safe to classify "gone" too.
      const currentModelId = options.model || backend.model || "unknown";
      // TRDD-W9XLU1HD coordinator mitigation: every bare 403 notes its model
      // BEFORE classification, so the model that COMPLETES the 2-distinct
      // quorum is itself treated as gone (2+ distinct models refusing with
      // generic 403s in one run = pool-level rejection, not a transient
      // model state). Noting before classifying is harmless for a
      // model-specific 403 (that already classifies "gone" on its own).
      if (/\bAPI error 403\b/.test(errMsg)) {
        noteGeneric403Model(currentModelId);
      }
      const unavailableKind = classifyUnavailable(errMsg, {
        credentialProvenGoodElsewhere: credentialSucceededOnOtherModel(
          backend.type,
          backend.baseUrl,
          backend.apiKey,
          currentModelId,
        ),
      });
      if (unavailableKind === "gone" || unavailableKind === "daily-quota") {
        // Pass the REAL verdict, not a hardcoded "gone" (TRDD-W9XLU1HD
        // review) — a caller reading it back via runUnusableKind() must see
        // "daily-quota" as daily-quota, or applyUnavailable's registry
        // fallback would misclassify it as a 1h "gone" reprobe instead of
        // the correct wait-until-midnight.
        markRunUnusable(currentModelId, unavailableKind);
      }
      // Retry window closed (or a Retry-After beyond it): a retryable failure
      // ends with the neutral RetryDeadlineError instead of another attempt,
      // while a failure with its own verdict (payment, deterministic 4xx,
      // price-ceiling refusal, model gone, daily quota) keeps its own error.
      // The retry branches below run only while the window is open and the
      // closed case is thrown after them. A guard placed BEFORE them let the
      // uncertain-payment and non-4xx "gone" `continue`s hand the call to the
      // loop-top check, which replaced their own error with RetryDeadlineError.
      // Owner ruling 2026-10-23 (TRDD-YG72CYY7 Q1): a rejected key cannot succeed by asking the same model again, so the generic same-model retry is skipped on callStatus 401. isAuth4xx only keeps the raw error for the caller's auth classification.
      const isAuth4xx = /\bAPI error 401\b/.test(errMsg);
      const keepsOwnError =
        payment !== null ||
        isAuth4xx ||
        deterministic4xx ||
        isPriceCeilingRefusal ||
        isIronRuleRefusal || // TRDD-VAORGKVF: keeps its own error (the "Validate it" remedy)
        unavailableKind === "gone" ||
        unavailableKind === "daily-quota";
      const closedWindowError = (): unknown =>
        keepsOwnError
          ? err
          : retryDeadlineError(clock, err, backend.type, {
              shared,
              refusedRetryAt: call.refusedRetryAt,
              // The call-own snapshot (round C0b item 1, B4).
              lastStatus: callStatus,
              lastProvider: callProvider,
            });
      // D1 (USER 2026-09-18: "it should retry once, but if the payment
      // required or credits exhausted error is certain, it should of course
      // skip to the next provider"). CERTAIN: never retried here — the throw
      // below lets the caller's chain advance at once. UNCERTAIN: exactly one
      // same-model retry, with no breaker wait before it (a payment error
      // must never trigger the 60s pause), unless this very error just proved
      // the model run-unusable: asking a model that is gone or spent for
      // today again cannot help. A second failure is thrown to the caller.
      if (
        payment === "uncertain" &&
        !paymentRetried &&
        !stopped() &&
        unavailableKind !== "gone" &&
        unavailableKind !== "daily-quota"
      ) {
        paymentRetried = true;
        process.stderr.write(
          `[model-retry] ${options.model || backend.model}: possible payment error: ${errMsg} — retrying once\n`,
        );
        continue;
      }
      if (
        payment === null &&
        genericAttempts <= MAX_TRUNCATION_RETRIES &&
        // YG72CYY7: a verdict stamped at the first failure (TLS, spent ECONNREFUSED/504 budget) is read, never re-derived; retrying here is the multiplier it ends.
        failureOf(err)?.final === undefined &&
        !stopped() &&
        !deterministic4xx &&
        callStatus !== 401 &&
        !isPriceCeilingRefusal &&
        !isIronRuleRefusal && // TRDD-VAORGKVF: same model, same refusal
        unavailableKind !== "daily-quota"
      ) {
        // Issue 2: tag the model/truncation retry layer + include the model id.
        const retryModel = options.model || backend.model;
        process.stderr.write(
          `[model-retry] ${retryModel}: request error: ${errMsg} — retrying (${genericAttempts}/${MAX_TRUNCATION_RETRIES})\n`,
        );
        const abort = await checkServiceHealthOrWait(clock);
        if (abort) {
          return {
            content: abort,
            model: options.model || backend.model,
            finishReason: "error",
            truncated: true,
            serviceAbort: true,
          };
        }
        // A refused breaker wait marked the clock expired: stop here with the
        // right error rather than looping to the top-of-loop check.
        if (stopped()) {
          clock.lastError = err;
          throw closedWindowError();
        }
        continue;
      }
      if (stopped()) {
        clock.lastError = err;
        throw closedWindowError();
      }
      // A PAID model that exhausted its retries on a genuine availability
      // failure used to complete on the free pool here instead of failing the
      // command — the "paid -> free" cross-profile borrow TRDD-OE27RD7I
      // addendum 4 forbids. Deleted: the honest error now always surfaces, so
      // a caller can advance to the profile's OWN next chain entry instead
      // (profile-fallback.ts; wired in phase 14.1-C2).
      // round C0a item 3 (B3): the exhausted-retries throw also ends the call
      // with this error, so the clock records it here (and only here).
      clock.lastError = err;
      throw err; // Exhausted retries
    }

    // "stop" with non-empty content means normal completion — return immediately.
    // Note: some providers return finishReason="stop" with empty content for
    // problematic prompts. We treat that as an empty response (retryable).
    if (resp.finishReason === "stop" && !resp.truncated && resp.content.trim().length > 0) {
      recordServiceSuccess();
      // Task #189c: a content-bearing success HEALS any no-content demotion —
      // the strike store is read-first, so this is a no-op unless strikes exist.
      clearNoContentStrikes(options.model || backend.model || "");
      // TRDD-90DM5YHO item 1: the single point where a successful completion
      // returns — note that THIS credential just proved itself good on THIS
      // model, so a later generic 403 on a DIFFERENT model can be told apart
      // from a bad-key 403 (see classifyUnavailable's credentialProvenGoodElsewhere).
      markCredentialSucceeded(
        backend.type,
        backend.baseUrl,
        backend.apiKey,
        options.model || backend.model || "unknown",
      );
      return resp;
    }

    // TRDD-1OOAH3LD: on a request_options profile "length" (partial OR empty) is
    // an error, raised HERE and not inside chatCompletionSimple on purpose: this
    // point is outside the try/catch above, so the generic retry, the circuit
    // breaker (recordServiceFailure) and the window logic are never entered. An
    // HTTP 200 reply is a working transport; retrying would re-bill the same
    // budget and hit the same limit. Profiles without request_options fall
    // through to the branches below, unchanged.
    if (resp.finishReason === "length") {
      // O5: the options ACTUALLY used for the request (recorded by chatCompletionSimple), not a second resolution that a settings reload could change.
      const ro = call.requestOptions ?? null;
      if (ro !== null) {
        recordServiceSuccess();
        throw new OutputLimitError({
          tool: ctxStore.getStore()?.tool,
          model: resp.model || options.model || backend.model || "unknown",
          maxTokens: effectiveMaxTokens(ro, options.maxTokens),
          callerCap: ro.maxOutputTokens > (options.maxTokens ?? Infinity),
          completionTokens: resp.usage?.completion_tokens,
          partial: resp.content,
        });
      }
    }
    // "length" WITH CONTENT — the model wrote an answer and ran out of room.
    // Real truncation: the partial output is useful and a retry would just
    // truncate again at the same place. Don't retry.
    //
    // "length" with EMPTY content is a DIFFERENT failure and must NOT land here
    // (TRDD-8b6b3646). It means the model burned its ENTIRE max_tokens budget on
    // REASONING tokens and emitted zero content — a reasoning model does not
    // self-limit (see the COST NOTE at the top of this file). Treating that as
    // "truncation, don't retry" was a money bug with three compounding costs:
    //   1. It billed a full reasoning budget and returned NOTHING to the user.
    //   2. It marked the call recordServiceSuccess() — a call that produced zero
    //      content was counted as healthy, so nothing anywhere flagged it.
    //   3. Worst: it returned BEFORE the empty-response path below, whose
    //      reasoning-downgrade ladder (xhigh→high→none, ~40 lines down) exists
    //      to fix EXACTLY this. The cure was already written and this guard
    //      clause made it unreachable. Every subsequent call re-paid the same
    //      full-reasoning burn because the ladder never got to cache a downgrade.
    // Falling through routes it to that ladder: retry with less reasoning until
    // real content comes back.
    if (resp.finishReason === "length" && resp.content.trim().length > 0) {
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
    //
    // Deliberately NOT recordServiceFailure(): these arrived over a WORKING
    // transport (the HTTP round-trip succeeded) and are model-shape failures —
    // cold-start blanks, reasoning burn, glitched finish reasons — each with
    // its own retry budget and cure below. Feeding them to the GLOBAL breaker
    // is how a parallel scan over reasoning-heavy free models manufactured a
    // false "SERVER ISSUE" verdict against a provider that a live probe showed
    // healthy (see the breaker's TRANSPORT-ONLY note above).
    //
    // And under transport-ONLY semantics the same 200 is a transport SUCCESS,
    // so it must RESET the consecutive-failure counter too (ultracode F2,
    // 2026-08-05). Leaving the counter frozen here meant "consecutive" was a
    // lie: on a run where every response is model-shaped (so the content
    // branches above never fire), five sporadic timeouts spread over hours of
    // healthy 200s still summed to the threshold and produced the exact false
    // SERVER ISSUE verdict the transport-only change was written to eliminate.
    recordServiceSuccess();
    const isEmpty = resp.content.trim().length === 0;
    const reasonLabel = resp.finishReason || "empty";

    // The model this call actually hit. `options.model` is OPTIONAL — when the
    // caller relies on the profile's configured model it is undefined, and keying
    // the ladder (and the cost stop below) off it alone silently disabled BOTH for
    // exactly the calls that spend the most. The exhausted-retries message already
    // resolves it this way; do it once, here, and use it everywhere. Moved ABOVE
    // the retry-budget split (item D2) because both halves of that split now need it.
    const ladderModel = options.model || backend.model;
    // The route this call actually hit, if `ladderModel` is routed to another
    // provider under a `providers:` profile — needed by BOTH halves of the D2
    // split below, same as resolveConnection's own route lookup.
    const calledRoute = deps.routeForModel(ladderModel);

    // Pick the right retry budget based on failure type.
    //
    // Empty responses on a REMOTE endpoint are the documented "no content
    // generated" case (cold-start, scaling) — the recommended workaround is to
    // retry. We use MAX_EMPTY_RESPONSE_RETRIES (15) with exponential backoff so
    // the provider has time to warm up between attempts. Non-empty failures
    // (finishReason=error, unknown values) keep the stricter MAX_TRUNCATION_RETRIES
    // budget since they're less likely to be transient.
    //
    // D2 split: this used to read `backend.type === "openrouter"`, a TRANSPORT
    // label, not a "is this endpoint remote" signal — a remote openai_api preset
    // (b.ai) resolves type "local" (D1 shape), so it got the stricter truncation
    // budget with no cold-start-tuned backoff even though it is exactly as remote
    // as OpenRouter. isRemoteBackend answers the TRANSPORT question (retry/backoff
    // strategy); billableForSpendStop below answers the separate COST question —
    // the two used to share one flag and that was the bug.
    const isRemoteBackend = calledRoute ? !calledRoute.isLocal : !backend.isLocal;
    const useEmptyBudget = isEmpty && isRemoteBackend;
    if (useEmptyBudget) {
      emptyAttempts++;
    } else {
      genericAttempts++;
    }
    const limit = useEmptyBudget ? MAX_EMPTY_RESPONSE_RETRIES : MAX_TRUNCATION_RETRIES;
    const currentAttempt = useEmptyBudget ? emptyAttempts : genericAttempts;

    // Run-level spend stop (RUN_PAID_EMPTY_RETRY_BUDGET above): a PAID model
    // past its process-wide empty-retry budget gets no more billed retries
    // this run — label and return before the ladder/retry machinery below.
    // Route-aware billable (item 1/D2): backend.billable alone is wrong for a
    // ROUTED model — same derivation as resolveConnection/assertModelValidated
    // (config.ts's billableForRoute, no duplicated logic).
    const billableForSpendStop = billableForRoute(calledRoute, backend.billable);
    if (isEmpty && billableForSpendStop && ladderModel && !isFreeSuffixModelId(ladderModel)) {
      const used = (runPaidEmptyRetriesByModel.get(ladderModel) ?? 0) + 1;
      runPaidEmptyRetriesByModel.set(ladderModel, used);
      if (used > RUN_PAID_EMPTY_RETRY_BUDGET) {
        resp.truncated = true;
        resp.content =
          `**EMPTY RESPONSE (run budget)**: ${ladderModel} has returned ${used} billable empty responses across this run ` +
          `(finish_reason=${reasonLabel}). Each retry re-bills the full prompt for nothing, so this call stops retrying immediately. ` +
          `The model appears unable to answer in current conditions — consider a different model for this slot.`;
        process.stderr.write(
          `[llm-externalizer] ${ladderModel}: run-level empty-response budget (${RUN_PAID_EMPTY_RETRY_BUDGET}) exhausted — refusing further billed retries on this paid model.\n`,
        );
        return resp;
      }
    }

    // Empty-response escalation: downgrade the reasoning cache so the next
    // attempt runs with less (or no) reasoning. xhigh -> high -> none.
    // The retry clock starts at the first failure that forces a retry. WHY the
    // window verdict is taken HERE, before the downgrade (N3): a reply that
    // closes the window (deadline passed, or the 2 s empty-reply wait no longer
    // fits) is followed by no retry, so recording a reasoning downgrade for it
    // would change the next CALL for this model with nothing gained.
    if (currentAttempt <= limit) startRetryClock(clock);
    let closedByWindow =
      currentAttempt <= limit &&
      (retryWindowClosed(clock) || (useEmptyBudget && !waitFitsClock(clock, EMPTY_RESPONSE_RETRY_DELAY_MS)));

    if (useEmptyBudget && ladderModel && currentAttempt <= limit && !closedByWindow) {
      const current = MODEL_REASONING_CACHE.get(ladderModel);
      if (current === undefined || current === "xhigh") {
        MODEL_REASONING_CACHE.set(ladderModel, "high");
        process.stderr.write(
          `[llm-externalizer] Empty response on ${ladderModel} — downgrading reasoning cache to high\n`,
        );
      } else if (current === "high") {
        MODEL_REASONING_CACHE.set(ladderModel, "none");
        process.stderr.write(
          `[llm-externalizer] Empty response on ${ladderModel} — disabling reasoning\n`,
        );
      }
    }

    // COST STOP for the length+empty case. The reasoning ladder needs at most two
    // downgrades to reach "none"; if the model STILL returns length+empty with
    // reasoning off, it cannot produce content in this budget for this prompt and
    // every further attempt bills a full max_tokens burn for a guaranteed nothing.
    // The generic empty budget is 15 retries — appropriate for a cold-start blank
    // (those are cheap: no tokens generated), but ruinous here, where each attempt
    // is a MAXED-OUT completion. Stop as soon as the cure has demonstrably failed.
    //
    // `currentAttempt > 1` is required, not cosmetic: MODEL_REASONING_CACHE is a
    // process-global that is ALSO set to "none" when a model simply does not
    // SUPPORT reasoning (see reasoningLadderForModel). For such a model the cache
    // reads "none" from the very first failure, so without this guard the first
    // length+empty aborted with zero retries — turning a possibly transient
    // provider hiccup into a hard error. One retry, then stop.
    if (
      useEmptyBudget &&
      resp.finishReason === "length" &&
      currentAttempt > 1 &&
      ladderModel &&
      MODEL_REASONING_CACHE.get(ladderModel) === "none"
    ) {
      // No recordServiceFailure() here either: length+empty with reasoning off
      // is a model/budget mismatch, not transport health (see above).
      // It IS a per-model quality strike (task #189c): three of these demote
      // the model out of the preferred ensemble until a content success heals it.
      recordNoContentStrike(ladderModel);
      resp.truncated = true;
      resp.content =
        `**NO CONTENT**: ${ladderModel} consumed its entire ${options.maxTokens ?? "output"}-token budget without emitting any content, ` +
        `even with reasoning disabled (finish_reason=length). The model produced only reasoning tokens. ` +
        `Retrying would bill another full budget for the same empty result, so this call stops here. ` +
        `Consider a smaller input, a larger max_tokens, or a different model for this slot.`;
      process.stderr.write(
        `[llm-externalizer] ${ladderModel}: length+empty with reasoning already off — refusing to burn another full budget on a retry that cannot help.\n`,
      );
      return resp;
    }

    // An empty/invalid reply that forces a retry is a failure for the retry
    // clock too (the first one starts it). When the window is already closed
    // the call is NOT thrown away: it falls through to the labelled reply
    // below (EMPTY RESPONSE / NO CONTENT / UPSTREAM ERROR / INCOMPLETE, with
    // any partial content), exactly as when the retry budget runs out. Turning
    // it into a RetryDeadlineError discarded the partial content and, with no
    // request having thrown, left the error without any cause.
    if (currentAttempt <= limit && !closedByWindow) {
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
      const abort = await checkServiceHealthOrWait(clock);
      // Round C item 2 (N4): a breaker wait that returned null can still have
      // marked the clock expired (waitFitsClock's refusal side effect); and
      // any wait here can straddle deadlineAt. When the window closed during
      // THIS wait, fall through to the labelled reply instead of continuing.
      if (retryWindowClosed(clock) && !abort) {
        closedByWindow = true;
      } else if (abort) {
        return {
          content: abort,
          model: resp.model,
          finishReason: "error",
          truncated: true,
          serviceAbort: true,
        };
      }
      // Fixed short wait between empty-response retries. Empty responses
      // are cold-start / scaling signals, not rate-limit signals, so a
      // constant interval is the right shape (see EMPTY_RESPONSE_RETRY_DELAY_MS
      // comment above). Non-empty retries go through the service-health
      // cooldown and don't need an extra delay here.
      // Never sleep past the retry clock. A refused breaker wait (clock marked
      // expired) or an empty-reply wait that does not fit the window ends the
      // retrying: fall out of this block to the labelled reply below.
      if (!retryWindowClosed(clock) && (!useEmptyBudget || waitFitsClock(clock, EMPTY_RESPONSE_RETRY_DELAY_MS))) {
        if (useEmptyBudget) {
          process.stderr.write(
            `[llm-externalizer] Waiting ${Math.round(EMPTY_RESPONSE_RETRY_DELAY_MS / 1000)}s before retry ${currentAttempt + 1}\n`,
          );
          await new Promise((r) => setTimeout(r, EMPTY_RESPONSE_RETRY_DELAY_MS));
        }
        // Round C item 2 (N4, TRDD-YG72CYY7): POST-wait re-check — the gate
        // above evaluated BEFORE the sleep, so a wait that straddled
        // deadlineAt must not `continue` into the loop-top throw, which would
        // discard the labelled reply below. Fall through to it instead.
        if (retryWindowClosed(clock)) {
          closedByWindow = true;
        } else {
          continue;
        }
      }
    }
    // Exhausted retries (or the retry window closed) — label by cause so the report makes sense.
    // Reaching here with attempts left means the block above did not `continue`:
    // the window closed (a breaker wait or the empty-reply wait was refused).
    closedByWindow = currentAttempt <= limit;
    // WHY `closedByWindow` changes this block (N3): when the clock stopped the
    // retrying, the model answered only `attempts` times. Quoting the retry
    // LIMIT ("after 15 retries") then misstates what happened, and a quality
    // strike for a model that answered once is unearned — three strikes demote
    // it from the ensemble. Window closure is a time-budget outcome, not
    // evidence about the model.
    const attempts = clock.attempts ?? currentAttempt;
    const after = (word: string) =>
      closedByWindow ? `because the retry window closed after ${attempts} attempt(s)` : `after ${limit} ${word}`;
    if (isEmpty && resp.finishReason === "length") {
      // Same quality strike as the cost-stop above (task #189c): the model
      // generated only reasoning for the entire retry budget.
      if (!closedByWindow) recordNoContentStrike(options.model || backend.model || "");
      // Distinct from a blank/glitch empty: the model DID generate — all of it
      // reasoning, none of it content. Say that, so the report doesn't blame a
      // "provider glitch" for a model/budget mismatch the user can actually act on.
      resp.content = `**NO CONTENT**: ${options.model || backend.model} spent its whole output budget on reasoning tokens and returned no content ${after("attempts")} (finish_reason=length). Not a provider glitch — the model generated only reasoning. Try a larger max_tokens, a smaller input, or a different model for this slot.`;
    } else if (isEmpty && (resp.finishReason === "" || resp.finishReason === "stop")) {
      resp.content = `**EMPTY RESPONSE**: The provider returned no content ${after("retries")} (finish_reason=${reasonLabel}). This usually means a transient provider glitch or the model failed on this specific prompt. No partial output available.`;
    } else if (resp.finishReason === "error") {
      resp.content += `\n\n---\n**UPSTREAM ERROR**: The provider reported an error (finish_reason=error) ${after("retries")}. The partial output above may be incomplete.`;
    } else {
      resp.content += `\n\n---\n**INCOMPLETE**: Response did not finish cleanly ${after("retries")} (finish_reason=${reasonLabel}). The output above may be incomplete.`;
    }
    resp.truncated = true;
    process.stderr.write(
      `[llm-externalizer] Exhausted ${closedByWindow ? `retry window after ${attempts} attempt(s)` : `${limit} retries`} (finish_reason=${reasonLabel}, empty=${isEmpty}) — returning with label\n`,
    );
    return resp;
  }
}
