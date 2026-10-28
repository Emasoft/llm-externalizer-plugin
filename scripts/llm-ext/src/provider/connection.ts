/**
 * provider/connection.ts — the universal connection resolver (B1 Phase 5,
 * TRDD-63314265), extracted verbatim from index.ts.
 *
 * Imports ZERO from index.ts: the mutable backend/profile state it used to read
 * directly arrives through ProviderDeps. `assertFreeOnlyModel` comes straight
 * from config.ts, which is index-independent by design (config.ts's own comment
 * notes it must not import index.ts).
 */

import { assertFreeOnlyModel, withinPriceCeiling, type ResolvedRoute } from "../config.js";
import { assertModelValidated } from "../benchmark/validated.js";
import { ctxStore } from "../usage-history.js";
import { detectLMStudio } from "./lmstudio.js";
import { detectEndpointFlavor } from "./endpoint-flavor.js";
import type { ConnectionSetup, ProviderDeps } from "./types.js";

// D3c-1 fix-up (TRDD-FDI9NYAS, adversarial review 2026-09-24): completion.ts's
// chatCompletionWithRetry must classify this refusal as deterministic (never
// retried, never counted against the circuit breaker -- see its own comment
// at the classification site). A bare regex literal duplicated in that file
// would silently drift from this message if it were ever reworded here, with
// no compiler/lint signal across the two files -- exporting the exact prefix
// keeps the two in lockstep by construction instead of by convention.
export const PRICE_CEILING_REFUSAL_PREFIX = "refusing to send auto-picked paid model ";

/**
 * Universal connection resolver — single source of truth for endpoint URL,
 * auth headers, model, and API format. Called once per LLM request; the
 * result is passed down to the actual HTTP call.
 *
 * For lmstudio provider: always uses native API, fails hard on auth/connection errors.
 * For openrouter/ollama: uses OpenAI-compat /v1/chat/completions.
 */
export async function resolveConnection(
  options: { model?: string; timeoutMs?: number; route?: ResolvedRoute } | undefined,
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
  // MULTI-PROVIDER: does this MODEL belong to a provider other than the primary?
  // Resolved before the cost guard, because which endpoint a model goes to
  // decides whether that endpoint can bill.
  // D6a: an explicit `options.route` (the chain walk's own entry) WINS — a
  // model served by two groups must reach the group being tried, not
  // routeForModel's first match. Undefined → the first serving group, the
  // pre-D6a behaviour.
  const route = options?.route ?? deps.routeForModel(model);

  // `backend.billable`, NOT `backend.type` — see BackendConfig.billable. Passing
  // the type here was D1: a remote openai_api preset resolves to type "local",
  // so this guard waved through every model on an endpoint that could bill.
  //
  // On a routed model the guard asks about the ROUTE's endpoint, not the
  // primary's: sending a b.ai model must not be judged by OpenRouter's billing,
  // nor the reverse. `isFreeProvider` on the route was already voided at resolve
  // time if its url redirected the host or scheme (overridesEndpoint).
  // Deliberately the SAME expression as BackendConfig.billable
  // (`!isLocal && !isFreeProvider`), just sourced from the route. Writing it
  // differently here is what produced the regression: `!route.isFreeProvider`
  // alone marked a routed LOCAL model billable, so free_only refused an ollama
  // model that cannot cost anything. One rule, two call sites, no drift.
  const billable = route
    ? !route.isLocal && !route.isFreeProvider
    : backend.billable;
  assertFreeOnlyModel(
    deps.isFreeOnly(),
    billable,
    model,
    route ? route.isFreeProvider : false,
  );
  // IRON RULE (TRDD-8b6b3646): a PAID OpenRouter model may only be SENT by a tool
  // it has passed the benchmark for (or a harder one). Fires ONLY when a tool
  // usage-context is present — i.e. a real tool invocation (set once at the
  // dispatch chokepoint). A context-less call (a unit test, or the benchmark
  // runner, which is EXEMPT and bypasses resolveConnection anyway) is not gated.
  // No-op for local / ':free' (handled inside assertModelValidated). Refuses
  // BEFORE the wire — $0 spent.
  //
  // TRDD-FDI9NYAS D3b: a MANUAL model (the user hand-listed it in the active
  // profile — `isManualModel`) is NEVER refused by this gate. The IRON RULE
  // exists to stop an AUTO-PICKED id from being sent with no proof it works;
  // a hand-listed id is the user's own choice, "all manual, no benchmarks or
  // updates" (USER spec 3.1), so no benchmark ledger applies to it.
  const toolCtx = ctxStore.getStore()?.tool;
  if (toolCtx && !deps.isManualModel(model)) assertModelValidated(model, toolCtx, billable);
  // D3c send-time price check (TRDD-FDI9NYAS): an AUTO-PICKED PAID model must
  // still be priced under the ceiling at THE MOMENT OF SEND — a provider can
  // raise its price after a model was admitted to the pool, and the
  // benchmark/pick-stage price check (D3a) is a snapshot at admission time,
  // not a standing guarantee. Same `!isManualModel` exemption as the
  // benchmark gate above: the user's own hand-listed model is manual, "no
  // price gate on hand-listed models" (USER "No, manual is manual").
  //
  // Deliberately NOT gated behind `toolCtx` (unlike assertModelValidated
  // above): cost-safety must hold on EVERY send, tool context or not — a
  // context-less sender (a benchmark bench-runner calling chatCompletion*
  // directly, outside dispatchCallTool's withUsageContext wrapper) must not
  // become a way around this gate just by never setting one.
  //
  // A cold/absent price cache FAILS CLOSED: `getModelPricePerMillion`
  // returns null when there is no recorded price, and `null` refuses here —
  // refusing costs nothing, sending blind can cost real money.
  if (billable && !deps.isManualModel(model)) {
    const price = deps.getModelPricePerMillion(model);
    const ceiling = deps.getEnsemblePriceCeilingUsd();
    if (!price || !withinPriceCeiling(price, ceiling)) {
      throw new Error(
        price
          ? `${PRICE_CEILING_REFUSAL_PREFIX}'${model}': price ` +
            `($${price.inputDollarsPerMillion}/M in, $${price.outputDollarsPerMillion}/M out) ` +
            `exceeds the $${ceiling}/M ceiling. No API call was made, $0 spent.`
          : `${PRICE_CEILING_REFUSAL_PREFIX}'${model}': no recorded price data ` +
            `for it (cold/absent price cache). No API call was made, $0 spent.`,
      );
    }
  }
  // A routed model uses ITS provider's key, never the primary's. Sending b.ai a
  // model with the OpenRouter key (or vice versa) is both a hard auth failure and
  // a credential leak to the wrong vendor.
  const headers = route ? deps.routeHeaders(route) : deps.apiHeaders();
  // A caller may impose a TIGHTER per-call deadline than the global soft
  // timeout — session_summary does, because its wall-clock is set by the SLOWEST
  // chunk, so a straggler allowed to run the full global 300s drags the whole
  // run past its target even though every other chunk finished long before.
  // Only meaningful since the deadline started covering the body read
  // (TRDD-0H5N1V9W); before that it bounded time-to-first-byte and a stalled
  // generation ignored it entirely.
  const timeout = options?.timeoutMs ?? deps.getSoftTimeoutMs();

  // D6a: a NON-primary group (a providers[]/detected_providers[] binding)
  // takes the routed path — the group's own URL, straight OpenAI-compat. D6b
  // KEEPS this: a routed group never reaches the flavor probe below, because
  // the probe is a question about a LOCAL backend, and detectEndpointFlavor
  // caches per baseUrl — asking it of the route would answer for the wrong
  // host (the probe reads backend.baseUrl, not route.url).
  if (route && !route.primary) {
    return {
      url: `${route.url}/v1/chat/completions`,
      headers,
      model,
      isNative: false,
      timeout,
      // TRDD-1OOAH3LD O7: request_options belong to the primary local server only.
      routed: true,
    };
  }

  // D6b (TRDD-90DM5YHO): the API-flavor decision comes from the GROUP PRESET
  // PROTOCOL, never backend.type — b.ai is backend.type "local" AND protocol
  // openai_api, and only the protocol tells the two apart. From here on the
  // path is primary-only, so the protocol is the active profile's, read
  // through ProviderDeps.
  //
  // lmstudio_api keeps the ORIGINAL detectLMStudio native-API probe verbatim
  // (unchanged behaviour). openai_api runs detectEndpointFlavor: a plain
  // OpenAI-compat server keeps ${base}/v1/chat/completions, while a
  // llama.cpp server behind the same preset flips to its native
  // /api/v1/chat — the win this item exists for (b.ai's wasted LM Studio
  // probe disappears). Probes carry NO auth headers and fail open.
  // openrouter_api is remote by construction: straight OpenAI-compat, no probe.
  const protocol = route && !route.primary ? route.protocol : deps.getActiveProtocol();

  if (protocol === "lmstudio_api" && (await detectLMStudio(deps))) {
    return {
      url: `${backend.baseUrl}/api/v1/chat`,
      headers,
      model,
      isNative: true,
      timeout,
    };
  }

  if (protocol === "openai_api") {
    const flavor = await detectEndpointFlavor(backend.baseUrl, deps.isLMStudioProvider);
    if (flavor === "llamacpp") {
      return {
        url: `${backend.baseUrl}/api/v1/chat`,
        headers,
        model,
        isNative: true,
        timeout,
      };
    }
  }

  return {
    url: `${backend.baseUrl}/v1/chat/completions`,
    headers,
    model,
    isNative: false,
    timeout,
  };
}
