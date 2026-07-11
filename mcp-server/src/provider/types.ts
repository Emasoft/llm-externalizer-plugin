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
