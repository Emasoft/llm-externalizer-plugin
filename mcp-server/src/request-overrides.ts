// Per-model request body overrides (extracted from index.ts — B1 Phase 1,
// TRDD-63314265). PURE: depends only on its arguments + the static table below,
// so it imports without pulling index.ts's main()-on-import side effect.
//
// Some models need sampling parameters that differ from our defaults. This
// registry keeps the model-specific knobs out of the main code paths — every
// entry is optional and unset fields fall back to the caller's defaults.
//
// IMPORTANT — what OpenRouter can and can't forward:
//   There is NO generic pass-through for vendor-specific parameters in either
//   /chat/completions or /responses. Both `provider` objects have fixed schemas.
//   OpenRouter only forwards known vendor fields (safe_prompt for Mistral,
//   raw_mode for Hyperbolic, etc.) that are explicitly mapped in its routing
//   layer. Sending unknown top-level fields like vLLM's `chat_template_kwargs`
//   results in them being silently dropped. See docs/openrouter/chat-completions-api.md
//   and docs/openrouter/responses-api.md for the raw OpenAPI specs.
//
//   For models that need thinking enabled, the only supported path is
//   `reasoning.effort` — OpenRouter's internal routing translates this into
//   whatever provider-specific flag the backend expects, based on the model's
//   `supports_reasoning` metadata. Our ladder sends this automatically.

export interface ModelRequestOverrides {
  temperature?: number;
  top_p?: number;
}

const MODEL_REQUEST_OVERRIDES: Record<string, ModelRequestOverrides> = {
  // NVIDIA Nemotron 3 Super 120B (free tier). NVIDIA's documented sampling
  // recommendation: temperature=1.0, top_p=0.95. The earlier empty-response
  // failures were caused by our ensemble default of temperature=0.1, which is
  // far below what this model tolerates — the sampling floor collapsed the
  // output distribution to empty on large inputs. OpenRouter reports
  // supports_reasoning=true for this model, so the reasoning.effort field from
  // the ladder is still sent and translated to the vLLM enable_thinking flag
  // internally.
  "nvidia/nemotron-3-super-120b-a12b:free": {
    temperature: 1.0,
    top_p: 0.95,
  },
};

/** Apply any per-model sampling override to a request body. Returns the body
 *  unchanged (same reference) when there is no model id or no override for it;
 *  otherwise returns a shallow copy with the overridden fields set. Pure. */
export function applyModelOverrides(
  body: Record<string, unknown>,
  modelId: string | undefined,
): Record<string, unknown> {
  if (!modelId) return body;
  const override = MODEL_REQUEST_OVERRIDES[modelId];
  if (!override) return body;
  const out = { ...body };
  if (override.temperature !== undefined) out.temperature = override.temperature;
  if (override.top_p !== undefined) out.top_p = override.top_p;
  return out;
}
