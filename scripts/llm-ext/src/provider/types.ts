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

/** Immutable backend snapshot (see index.ts's T2.7 snapshot-and-swap note). */
export interface BackendConfig {
  readonly type: "local" | "openrouter";
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
  /** Live per-request soft timeout in ms (index.ts `SOFT_TIMEOUT_MS`, a `let`). */
  getSoftTimeoutMs(): number;
  /** Active profile's `free_only` flag — gates the cost-safety assertion. */
  isFreeOnly(): boolean;
  /** Active profile's protocol is `lmstudio_api` → probe failures must fail hard. */
  isLMStudioProvider(): boolean;
  /** Fallback temperature when a caller does not set one. */
  defaultTemperature: number;
}

/**
 * The extra seams the COMPLETION layer needs on top of the transport ones
 * (B1 Phase 5b). Every field here reaches state that could NOT move into
 * provider/completion.ts because index.ts reads or writes it elsewhere —
 * `creditExhausted` feeds `shouldUseFree()` and the dispatch layer,
 * `engageAutoFree` drives the ensemble builder's free pool, `FREE_MODEL_ID`
 * and the resolved max-tokens are consumed all over index.ts.
 *
 * They are exposed as FUNCTIONS for two reasons: (1) same as ProviderDeps —
 * a value captured at wiring time would pin the completion layer to a stale
 * generation; (2) `FREE_MODEL_ID` is a `const` initialised LATER in index.ts
 * than the deps object itself, so reading it eagerly here would throw on TDZ.
 *
 * The two mutators keep index.ts's `let creditExhausted` / auto-free flags as
 * the SINGLE binding — the completion layer writes THROUGH the seam instead of
 * owning a copy that would silently diverge from what index.ts reads.
 */
export interface CompletionDeps extends ProviderDeps {
  /** Max output tokens for the current model (index.ts `resolveDefaultMaxTokens()`). */
  getDefaultMaxTokens(): number;
  /** The configured free-model id used for the 402 mid-flight fallback. */
  getFreeModelId(): string;
  /** Set index.ts's `creditExhausted` flag (402 seen → session is out of credit). */
  setCreditExhausted(): void;
  /** Engage auto-free routing for every later spend site. Idempotent in index.ts. */
  engageAutoFree(reason: string): void;
  /** Drop the cached OpenRouter balance so the next check re-queries. */
  invalidateBalanceCache(): void;
}
