/**
 * provider/types.ts — the wire-level types shared by the provider/transport
 * layer (B1 Phase 5, TRDD-63314265).
 *
 * These declarations used to live in index.ts. They are hoisted here so the
 * provider modules (http.ts, lmstudio.ts, connection.ts) can be typed without
 * importing from index.ts (which would be circular AND would drag the whole
 * MCP server's module-init graph into every importer).
 *
 * `ProviderDeps` is the injected seam object — the same pattern as
 * ScanFolderDeps / CodeTaskDeps. index.ts owns the mutable backend state
 * (`currentBackend`, `activeResolved`, `SOFT_TIMEOUT_MS` — all reassigned on a
 * settings reload), so every stateful read is exposed here as a FUNCTION, not a
 * captured value: a provider module must observe the CURRENT generation at call
 * time, never a snapshot taken at wiring time.
 */

import type { ResolvedRoute } from "../config.js";
import type { ResolvedRequestOptions } from "./request-options.js";

/** Where a managed profile's requests go (TRDD-1OOAH3LD broker): the broker endpoint plus what the job needs that the body does not carry. */
export interface BrokerConnection {
  url: string;
  token: string;
  pid: number;
  /** The engine whose server runs the request (TRDD-ZGSGGHQG): llama-server or Locals. */
  engine: "llama" | "locals";
  /** Server context for the model (-c); 0 = llama-server's default. */
  ctx: number;
  /** --queue_timeout in ms, or undefined for the broker default. */
  queueTimeoutMs?: number;
  /** P6 (review F1): find or start the current broker after this one gave a held job back. */
  reconnect: () => Promise<{ url: string; token: string; pid: number }>;
}

/** Immutable backend snapshot (see index.ts's T2.7 snapshot-and-swap note). */
export interface BackendConfig {
  readonly type: "local" | "openrouter";
  /**
   * Can a send to this backend cost money?
   *
   * NOT derivable from `type`, which answers "which request format" — a remote
   * OpenAI-compatible preset (chat-b-ai-remote) is type "local" while being a
   * real internet endpoint holding a real key. Sourced from `preset.isLocal`
   * and the provider's free-by-nature flag, both of which are properties of the
   * ENDPOINT. This is what the free_only cost guard reads; reading `type` was
   * the D1 bypass.
   */
  readonly billable: boolean;
  /**
   * Is the PRIMARY provider's preset actually a local server (mirrors
   * ResolvedProfile.isLocal — "the honest source for can a send cost money").
   * Also NOT derivable from `type` for the same D1 reason `billable` isn't: a
   * remote openai_api preset resolves type "local" while being a real internet
   * endpoint. Distinct from `billable` — a genuinely-remote FREE provider
   * (isLocal: false, billable: false) still needs the remote/cold-start retry
   * ladder even though it can't bill (item D2's split).
   */
  readonly isLocal: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly __version: number;
}

/** Resolved endpoint for a single LLM request. */
export interface ConnectionSetup {
  url: string; // Full endpoint URL
  headers: Record<string, string>; // Auth + content-type headers
  model: string; // Resolved model ID
  isNative: boolean; // true = LM Studio native /api/v1/chat
  timeout: number; // SOFT_TIMEOUT_MS
  /** true = a non-primary providers[] route (request_options never apply to it). */
  routed?: true;
  /** TRDD-1OOAH3LD: set when the request goes through the per-engine broker (submit and long-poll) instead of a direct fetch to `url`. */
  broker?: BrokerConnection;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamingResult {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
  finishReason: string;
  /** Set only on the circuit breaker's abort verdict (checkServiceHealthOrWait),
   *  never on a provider reply: lets a caller tell the verdict from a
   *  provider finish_reason=error partial reply, which also has finishReason "error". */
  serviceAbort?: boolean;
  truncated: boolean;
}

export interface ModelInfo {
  id: string;
  context_length?: number;
  max_model_len?: number;
  owned_by?: string;
  [key: string]: unknown;
}

// Reasoning-effort vocabulary. Kept as a const tuple so the type stays derived
// from the single source of truth (index.ts validates env input against it).
export const VALID_REASONING_EFFORTS = ["off", "xhigh", "high", "medium", "low"] as const;
export type ReasoningEffortSetting = (typeof VALID_REASONING_EFFORTS)[number];

/**
 * The seams the provider layer needs from the server's mutable config state.
 * Every accessor is a function so a mid-session settings reload is observed —
 * capturing `backend`/`timeout` as plain values here would pin the provider to
 * the generation that was current when index.ts built this object.
 */
export interface ProviderDeps {
  /** Current backend snapshot (index.ts `getCurrentBackend()`). */
  getBackend(): BackendConfig;
  /** Auth + attribution headers for the current backend (index.ts `apiHeaders()`). */
  apiHeaders(): Record<string, string>;
  /**
   * The provider that serves `model` under a multi-provider profile, or null
   * when the profile routes everything to its primary provider (every profile
   * that predates `providers:`).
   *
   * This is the seam that lets ONE run send model A to b.ai and model B to
   * OpenRouter. Without it, `resolveConnection` builds every URL from the single
   * active backend, so an ensemble spanning two providers is impossible however
   * the pool is assembled.
   */
  routeForModel(model: string): ResolvedRoute | null;
  /** Auth + attribution headers for ONE route (its own key, not the backend's). */
  routeHeaders(route: ResolvedRoute): Record<string, string>;
  /** Live per-request soft timeout in ms (index.ts `SOFT_TIMEOUT_MS`, a `let`). */
  getSoftTimeoutMs(): number;
  /** Active profile's `free_only` flag — gates the cost-safety assertion. */
  isFreeOnly(): boolean;
  /** Active profile's protocol is `lmstudio_api` → probe failures must fail hard. */
  isLMStudioProvider(): boolean;

  /** The ACTIVE profile's protocol (config.ts ApiProtocol) — D6b: the connection
   *  layer decides which detector to run from the GROUP PRESET PROTOCOL, never
   *  backend.type (b.ai is backend.type local AND protocol openai_api). */
  getActiveProtocol(): string;

  /**
   * True iff `model` is in the active profile's `manualModels` provenance set
   * (TRDD-FDI9NYAS D3b) — the user hand-listed it. Replaces the earlier
   * planned `isDynamic` flag: exemption from the benchmark-verdict and price
   * gates follows where a model CAME FROM, not the profile's type, so a
   * reserved/manual id inside a DYNAMIC profile is exempt too (D5).
   */
  isManualModel(model: string): boolean;

  /**
   * TRDD-1OOAH3LD: the per-engine broker this request must go through, or
   * null to send directly. Non-null only when the active profile sets
   * `server: managed` and the request goes to the profile's own (primary)
   * group; the hook makes sure the broker runs. `route` is null for the
   * primary group when no route was resolved. Throws BrokerUnavailableError
   * (marked final "stop") when the broker cannot be started. Optional so
   * callers without a broker are unchanged.
   */
  localBroker?(target: { model: string; route: ResolvedRoute | null }): Promise<BrokerConnection | null>;
  /**
   * ONE model's recorded price (USD / million tokens, input + output), or
   * null when there is no recorded price data (cold/absent cache) —
   * TRDD-FDI9NYAS D3c's send-time price check. The chokepoint MUST fail
   * closed on null, never treat "unknown" as "cheap enough".
   */
  getModelPricePerMillion(
    model: string,
  ): { inputDollarsPerMillion: number; outputDollarsPerMillion: number } | null;
  /** The active ensemble price ceiling (USD / million), read fresh on every
   *  call (config.ts `getEnsemblePriceCeiling`) — same reload-safety reason
   *  as every other function field here. */
  getEnsemblePriceCeilingUsd(): number;
  /** Fallback temperature when a caller does not set one. */
  defaultTemperature: number;
}

/**
 * The extra seams the COMPLETION layer needs on top of the transport ones
 * (B1 Phase 5b). The resolved max-tokens is consumed all over index.ts and
 * could not move into provider/completion.ts either.
 *
 * Exposed as a FUNCTION for the same reason as ProviderDeps — a value
 * captured at wiring time would pin the completion layer to a stale
 * generation.
 *
 * TRDD-OE27RD7I 14.1-C2c-ENV: `getFreeModelId()` and `engageAutoFree()` were
 * deleted here -- provider/completion.ts (this interface's only real
 * consumer) never called either (see that file's own module comment), and
 * their sole remaining caller was index.ts's own `resolveModelOverride` /
 * `classifyError`, which now reach `FREE_MODEL_ID` directly and no longer
 * engage anything (addendum 4 deleted engageAutoFree itself). Same fate as
 * the credit-exhausted-session setter and the balance-cache invalidator
 * that preceded them on this interface. Grep gate: all four are 0 hits in
 * src outside a comment or a test asserting absence.
 */
export interface CompletionDeps extends ProviderDeps {
  /** Max output tokens for the current model (index.ts `resolveDefaultMaxTokens()`). */
  getDefaultMaxTokens(): number;
  /**
   * TRDD-1OOAH3LD: the active profile's request_options merged for `tool`, or
   * null when the profile sets none. REQUIRED (not optional) so a lost wiring
   * fails to compile instead of silently dropping the options; callers that
   * never use request_options (benchmark runners, fixtures) return null.
   */
  getRequestOptions(tool: string | undefined): ResolvedRequestOptions | null;
}
