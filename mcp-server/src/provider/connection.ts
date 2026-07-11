/**
 * provider/connection.ts — the universal connection resolver (B1 Phase 5,
 * TRDD-63314265), extracted verbatim from index.ts.
 *
 * Imports ZERO from index.ts: the mutable backend/profile state it used to read
 * directly arrives through ProviderDeps. `assertFreeOnlyModel` comes straight
 * from config.ts, which is index-independent by design (config.ts's own comment
 * notes it must not import index.ts).
 */

import { assertFreeOnlyModel } from "../config.js";
import { detectLMStudio } from "./lmstudio.js";
import type { ConnectionSetup, ProviderDeps } from "./types.js";

/**
 * Universal connection resolver — single source of truth for endpoint URL,
 * auth headers, model, and API format. Called once per LLM request; the
 * result is passed down to the actual HTTP call.
 *
 * For lmstudio provider: always uses native API, fails hard on auth/connection errors.
 * For openrouter/ollama: uses OpenAI-compat /v1/chat/completions.
 */
export async function resolveConnection(
  options: { model?: string } | undefined,
  deps: ProviderDeps,
): Promise<ConnectionSetup> {
  // T2.7 — snapshot once. detectLMStudio() is awaited, so a reload could
  // race between this read and the post-detect URL build. Capturing
  // `backend` here guarantees we serve a CONSISTENT (baseUrl, type, model)
  // tuple for this single resolution.
  const backend = deps.getBackend();
  const model = options?.model || backend.model;
  // Airtight cost-safety (TRDD-97ef8b63): under a free_only profile, refuse any
  // non-':free' model BEFORE it reaches the wire. resolveConnection is the SINGLE
  // point every request's model flows through (every OpenRouter fetch sends
  // conn.model), so this one check covers every tool, ensemble slot, rotation
  // fallback, modelOverride, and the 402→free fallback. A leak fails fast — it
  // never bills.
  assertFreeOnlyModel(deps.isFreeOnly(), backend.type, model);
  const headers = deps.apiHeaders();
  const timeout = deps.getSoftTimeoutMs();

  // Detect LM Studio native API (only for local backends)
  if (backend.type === "local" && (await detectLMStudio(deps))) {
    return {
      url: `${backend.baseUrl}/api/v1/chat`,
      headers,
      model,
      isNative: true,
      timeout,
    };
  }

  return {
    url: `${backend.baseUrl}/v1/chat/completions`,
    headers,
    model,
    isNative: false,
    timeout,
  };
}
