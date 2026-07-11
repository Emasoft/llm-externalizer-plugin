/**
 * provider/lmstudio.ts — LM Studio native API (/api/v1/chat), extracted
 * verbatim from index.ts (B1 Phase 5, TRDD-63314265).
 *
 * LM Studio is the only local backend with MCP support, reasoning control,
 * model load events, and prompt processing events via its native API.
 * We auto-detect LM Studio by probing /api/v1/models on first request.
 *
 * Every index.ts-scoped binding this block used to read (the current backend,
 * the active profile's protocol, apiHeaders(), DEFAULT_TEMPERATURE) is now
 * injected via ProviderDeps, so this module imports ZERO from index.ts.
 */

import { fetchWithTimeout } from "./http.js";
import { safeReadText, safeReadJson } from "../safe-body.js";
import { recordRequest } from "../usage-history.js";
import { type ProgressFn } from "../rate-limiter.js";
import type {
  ChatMessage,
  ConnectionSetup,
  ProviderDeps,
  ReasoningEffortSetting,
  StreamingResult,
} from "./types.js";

// LM Studio native API detection cache. Keyed by baseUrl because detection
// is per-endpoint (not per-backend-generation). Lives outside BackendConfig
// so backend snapshots stay immutable — see T2.7.
interface LMStudioProbeResult {
  isLMStudio: boolean;
  detected: boolean; // true once we have a definitive answer
}
const _lmStudioProbeCache = new Map<string, LMStudioProbeResult>();
function getLMStudioProbe(baseUrl: string): LMStudioProbeResult {
  return _lmStudioProbeCache.get(baseUrl) ?? { isLMStudio: false, detected: false };
}
function setLMStudioProbe(baseUrl: string, result: LMStudioProbeResult): void {
  _lmStudioProbeCache.set(baseUrl, result);
}
/** Called by the `reset` tool: a settings reload may point at a new endpoint. */
export function clearLMStudioProbeCache(): void {
  _lmStudioProbeCache.clear();
}

/**
 * Probe whether the local backend is LM Studio by hitting its native endpoint.
 * Caches the result in _lmStudioProbeCache (keyed by baseUrl) so we only
 * probe once per endpoint. T2.7: the cache lives outside BackendConfig so
 * backend snapshots stay immutable.
 */
export async function detectLMStudio(deps: ProviderDeps): Promise<boolean> {
  // SNAPSHOT once at top of scope — see T2.7. Reads below MUST use `backend`.
  const backend = deps.getBackend();
  if (backend.type !== "local") return false;
  const probed = getLMStudioProbe(backend.baseUrl);
  if (probed.detected) return probed.isLMStudio;

  const isLMStudioProvider = deps.isLMStudioProvider();

  try {
    const res = await fetchWithTimeout(
      `${backend.baseUrl}/api/v1/models`,
      { headers: deps.apiHeaders() },
    );
    // LM Studio's native /api/v1/models returns a JSON array of model objects
    if (res.ok) {
      setLMStudioProbe(backend.baseUrl, { isLMStudio: true, detected: true });
      process.stderr.write(
        "[llm-externalizer] Detected LM Studio native API\n",
      );
      return true;
    }
    // Auth failure on the native endpoint — if provider is explicitly lmstudio, fail hard
    if (res.status === 401 && isLMStudioProvider) {
      if (backend.apiKey) {
        // Token was provided but LM Studio rejected it
        throw new Error(
          "LM Studio rejected the API token (401 Unauthorized).\n" +
            "The token was resolved from the environment but is not valid for this LM Studio instance.\n" +
            "Check: LM Studio > Developer > Security — regenerate the API key and update $LM_API_TOKEN.",
        );
      } else {
        // No token at all
        throw new Error(
          "LM Studio requires authentication but no API token was found.\n" +
            "Set the LM_API_TOKEN environment variable, or add api_token to the active profile in settings.yaml.\n" +
            "In LM Studio: Developer > Security > copy the API key.",
        );
      }
    }
  } catch (err) {
    // Re-throw auth errors — those are not "not LM Studio", they are config errors
    if (
      err instanceof Error &&
      err.message.includes("LM Studio requires authentication")
    )
      throw err;
    // If provider is explicitly lmstudio, don't silently fall back to OpenAI-compat
    if (isLMStudioProvider) {
      throw new Error(
        `LM Studio native API probe failed at ${backend.baseUrl}/api/v1/models: ${err instanceof Error ? err.message : String(err)}\n` +
          "Ensure LM Studio is running and a model is loaded. The lmstudio provider requires the native API endpoint.",
        { cause: err },
      );
    }
    // Not LM Studio or endpoint not available — fall through (only for non-lmstudio providers)
  }
  setLMStudioProbe(backend.baseUrl, { isLMStudio: false, detected: true });
  return false;
}

/**
 * LM Studio native response shape from /api/v1/chat.
 */
interface LMStudioOutputEntry {
  type: "message" | "reasoning" | "tool_call" | "invalid_tool_call";
  content?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  provider_info?: Record<string, unknown>;
}

interface LMStudioChatResponse {
  model_instance_id: string;
  output: LMStudioOutputEntry[];
  stats?: {
    input_tokens?: number;
    total_output_tokens?: number;
    reasoning_output_tokens?: number;
    tokens_per_second?: number;
    time_to_first_token_seconds?: number;
  };
  response_id?: string;
}

/**
 * Chat completion using LM Studio's native /api/v1/chat endpoint (non-streaming).
 * Provides MCP integration, reasoning control, and avoids streaming timeout issues
 * with reasoning models that have high time-to-first-token.
 */
export async function chatCompletionNative(
  conn: ConnectionSetup,
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    // Accepts the canonical ReasoningEffortSetting plus LM Studio's "on".
    // In practice only "off" (cluster_synonyms) is ever passed here.
    reasoning?: ReasoningEffortSetting | "on";
    integrations?: Array<Record<string, unknown>>;
    onProgress?: ProgressFn;
  },
  deps: ProviderDeps,
): Promise<StreamingResult> {
  // Convert ChatMessage[] to LM Studio input format:
  // system_prompt is extracted from system messages, input is the user message(s)
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // Build multi-turn input as array of content parts
  const inputParts: Array<{ type: string; content: string }> = [];
  for (const msg of nonSystemMessages) {
    inputParts.push({
      type: msg.role === "user" ? "text" : msg.role,
      content: msg.content,
    });
  }

  const body: Record<string, unknown> = {
    model: conn.model,
    // If single user message, pass as string; otherwise pass as array
    input:
      nonSystemMessages.length === 1
        ? nonSystemMessages[0].content
        : inputParts,
    temperature: options.temperature ?? deps.defaultTemperature,
    stream: false,
    store: false, // We don't need stateful chat
  };

  // Never send max_output_tokens — LM Studio defaults to model maximum.
  // Reasoning models use the budget for both thinking AND response, so setting
  // a limit often causes truncated or empty responses.

  if (systemMessages.length > 0) {
    body.system_prompt = systemMessages.map((m) => m.content).join("\n\n");
  }

  // Only send reasoning if explicitly set — not all models support it.
  // Models that don't will return error "does not support reasoning configuration".
  if (options.reasoning) {
    body.reasoning = options.reasoning;
  }

  if (options.integrations && options.integrations.length > 0) {
    body.integrations = options.integrations;
  }

  // Send initial progress
  if (options.onProgress) {
    options.onProgress(5, 100, "Sending request to LM Studio…");
  }

  // Periodic progress while waiting for response
  const startTime = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (options.onProgress) {
    const pg = options.onProgress;
    progressTimer = setInterval(() => {
      const pct = Math.min(
        90,
        Math.round(((Date.now() - startTime) / conn.timeout) * 100),
      );
      pg(pct, 100, "Waiting for LM Studio response…");
    }, 10_000);
  }

  try {
    let res = await fetchWithTimeout(
      conn.url,
      { method: "POST", headers: conn.headers, body: JSON.stringify(body) },
      conn.timeout,
    );

    // If the reasoning parameter is rejected, retry without it
    if (!res.ok && body.reasoning) {
      const errText = await safeReadText(res).catch(() => "");
      if (errText.includes("does not support reasoning")) {
        process.stderr.write(
          "[llm-externalizer] Model does not support reasoning parameter, retrying without it\n",
        );
        delete body.reasoning;
        res = await fetchWithTimeout(
          conn.url,
          { method: "POST", headers: conn.headers, body: JSON.stringify(body) },
          conn.timeout,
        );
      } else {
        throw new Error(`LM Studio API error ${res.status}: ${errText}`);
      }
    }

    if (!res.ok) {
      const text = await safeReadText(res).catch(() => "");
      throw new Error(`LM Studio API error ${res.status}: ${text}`);
    }

    const data = await safeReadJson<LMStudioChatResponse>(res);

    // Extract message content from output array
    const messageContent = data.output
      .filter((o) => o.type === "message" && o.content)
      .map((o) => o.content!)
      .join("");

    // Map LM Studio stats to our StreamingResult usage format
    const usage = data.stats
      ? {
          prompt_tokens: data.stats.input_tokens ?? 0,
          completion_tokens: data.stats.total_output_tokens ?? 0,
          total_tokens:
            (data.stats.input_tokens ?? 0) +
            (data.stats.total_output_tokens ?? 0),
        }
      : undefined;

    // One completed LLM web request → one usage-history line. Local LM Studio
    // returns no `cost` in usage, so this is $0.000000 (correct for local).
    recordRequest({ ok: true, durationMs: Date.now() - startTime, costUsd: (usage as { cost?: number } | undefined)?.cost ?? 0 });
    return {
      content: messageContent,
      model: data.model_instance_id || conn.model,
      usage,
      finishReason: "stop",
      truncated: false,
    };
  } catch (e) {
    recordRequest({ ok: false, durationMs: Date.now() - startTime, costUsd: 0 });
    throw e;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}
