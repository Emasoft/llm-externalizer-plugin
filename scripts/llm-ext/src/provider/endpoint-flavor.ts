/**
 * provider/endpoint-flavor.ts — D6b (TRDD-90DM5YHO): autodetect whether a
 * base URL speaks the llama.cpp-server native surface or plain OpenAI-compat.
 *
 * Cache mirrors provider/lmstudio.ts: a module-level Map keyed by baseUrl
 * (detection is per-ENDPOINT, not per-backend-generation; BackendConfig stays
 * immutable — see T2.7). No TTL, same as the LM Studio probe cache.
 */

import { fetchWithTimeout } from "./http.js";
import { safeReadJson } from "../safe-body.js";

export type EndpointFlavor = "llamacpp" | "openai";

interface FlavorProbeResult {
  flavor: EndpointFlavor;
  detected: boolean;
}
const _flavorCache = new Map<string, FlavorProbeResult>();
function getFlavor(baseUrl: string): FlavorProbeResult {
  return _flavorCache.get(baseUrl) ?? { flavor: "openai", detected: false };
}
function setFlavor(baseUrl: string, result: FlavorProbeResult): void {
  _flavorCache.set(baseUrl, result);
}
/** Called by the `reset` tool alongside clearLMStudioProbeCache: a settings
 *  reload may point an endpoint at a different server. */
export function clearEndpointFlavorCache(): void {
  _flavorCache.clear();
}

/** Test seam — read the cached answer without probing. */
export function getEndpointFlavorForTests(baseUrl: string): EndpointFlavor | undefined {
  const hit = _flavorCache.get(baseUrl);
  return hit?.detected ? hit.flavor : undefined;
}

/**
 * Probe order is load-bearing (live capture 2026-09-30,
 * reports/llm-ext-release-1410/20260930_2322+0200-d6b-bai-endpoint-capture.md):
 * a llama.cpp server ALSO serves OpenAI-compat /v1/*, so /v1/models answering
 * 200 does NOT prove openai flavor — /props is the only clean llamacpp marker
 * and must be asked FIRST. Anything other than a 200 JSON answer on /props
 * (403/404/timeout/non-JSON) falls through to the /v1/models arm.
 *
 * ponytail: an AUTH-ENTICATED llama.cpp server (llama-server --api-key) 401s
 * the unauthenticated /props and answers /v1/models 200, so it misclassifies
 * as openai — fail-open-to-openai is the accepted ceiling until a
 * body-level discriminator exists.
 *
 * Probes carry NO auth headers (never send a credential to a diagnostic
 * endpoint) and swallow their errors — a probe must never turn into a user-
 * visible failure. Fail open to openai, today behavior.
 */
export async function detectEndpointFlavor(
  baseUrl: string,
  isLMStudioProvider: () => boolean,
): Promise<EndpointFlavor> {
  const cached = getFlavor(baseUrl);
  if (cached.detected) return cached.flavor;

  try {
    const res = await fetchWithTimeout(`${baseUrl}/props`, {}, 5000);
    if (res.ok) {
      const body = await safeReadJson(res);
      // A bare JSON object is NOT enough: any OpenAI-compat server that
      // answers an unknown GET with its error-shape JSON (or a generic
      // handler) would look "llamacpp" on a body-only check (caught live:
      // a test fixture answered /props 200 with {choices:[...]}). A real
      // llama.cpp /props carries the model path.
      if (
        body !== null &&
        typeof body === "object" &&
        "model_path" in (body as Record<string, unknown>)
      ) {
        setFlavor(baseUrl, { flavor: "llamacpp", detected: true });
        if (!isLMStudioProvider()) {
          process.stderr.write(`[llm-externalizer] Detected llama.cpp-compatible endpoint at ${baseUrl}\n`);
        }
        return "llamacpp";
      }
    }
  } catch {
    // swallow — fall through to the /v1/models arm, then fail open
  }

  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, {}, 5000);
    setFlavor(baseUrl, { flavor: "openai", detected: true });
    if (res.ok) {
      process.stderr.write(`[llm-externalizer] Detected OpenAI-compatible endpoint at ${baseUrl}\n`);
    }
  } catch {
    setFlavor(baseUrl, { flavor: "openai", detected: true });
  }
  return "openai";
}
