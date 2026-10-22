// Plan §3 L0-08 / E17: an alias resolves to its target; limits and price come from the target, never the alias entry.
import { dirname, join } from "node:path";
import { getCatalog } from "../../catalog-cache.js";
import { defaultDecisionsCachePath, type DecisionsModel } from "./catalog.js";
import type { GlobalFetch } from "./transport.js";

export interface ResolvedModel {
  /** The entry the caller named (the alias itself when an alias was requested). */
  requested: DecisionsModel;
  /** The entry that serves the request: the alias target, or `requested` when it is not an alias. */
  effective: DecisionsModel;
}

/** A dated build (canonical slug) is matched too, so `typesafe/jev-1.13-20260917` resolves to its own entry. */
function find(catalog: DecisionsModel[], key: string): DecisionsModel | undefined {
  return catalog.find((m) => m.id === key) ?? catalog.find((m) => m.canonicalSlug === key);
}

export function resolveModel(id: string, catalog: DecisionsModel[]): ResolvedModel {
  const requested = find(catalog, id);
  if (!requested) throw new Error(`unknown decisions model: ${id}`);
  if (!requested.aliasTarget) return { requested, effective: requested };
  const effective = find(catalog, requested.aliasTarget);
  if (!effective) throw new Error(`alias ${id} points to ${requested.aliasTarget}, which is not in the decisions catalog`);
  // WHY: a chain would need cycle detection and the live catalog has none; fail instead of guessing.
  if (effective.aliasTarget) throw new Error(`alias ${id} points to another alias (${effective.id}); chains are not supported`);
  return { requested, effective };
}

/**
 * Usable prompt limit (state plus questions together) from a `/models/<id>/endpoints` reply body.
 * WHY: measured (P-02 + paid probe): the catalog says 64000 for jev-1.13 but the endpoint reports max_prompt_tokens 32000
 * and the real limit is about 32k, so the endpoint wins. Several endpoints: the smallest, since the router may pick any.
 * An alias reply has no endpoints (E17): the caller must pass the TARGET's reply, so an empty list is an error.
 */
export function endpointPromptLimit(replyBody: string): number {
  const endpoints = (JSON.parse(replyBody) as { data?: { endpoints?: { max_prompt_tokens?: number | null }[] } }).data?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error("endpoints reply lists no endpoint; read the alias target's endpoints");
  const limits = endpoints.map((e) => e.max_prompt_tokens);
  if (!limits.every((l): l is number => typeof l === "number" && l > 0)) throw new Error("an endpoint reports no max_prompt_tokens");
  return Math.min(...limits);
}


// WHY one exported figure: the endpoint accepts about 32k prompt tokens whatever the catalog says (P-02); a spec whose `build` is not given the model limits (catalog/audit.ts) reads this instead of repeating the literal.
export const ENDPOINT_PROMPT_TOKENS = 32_000;

// WHY 3 s: the lookup is a small JSON GET that normally answers in well under a second, and it runs before the one 60 s decisions deadline starts; a slow or down endpoint must cost seconds, not the run (owner ruling 2026-10-10: ultrafast or nothing).
export const ENDPOINT_LOOKUP_TIMEOUT_MS = 3_000;

export interface EndpointLimitOptions {
  /** The effective (alias-resolved) model id: an alias has no endpoints of its own (E17). */
  modelId: string;
  fetch: GlobalFetch;
  /** The decisions catalog cache path; the limit is cached next to it, one file per model, so a test with its own catalog path stays isolated. */
  catalogPath?: string;
  now?: number;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * Why `loadEndpointPromptLimit` refuses to look this id up, or undefined when the id is fine.
 * WHY exported: the runner's "limit unknown" warning names the reason, so a malformed catalog id is not reported as a failed lookup.
 */
export function malformedModelIdReason(modelId: string): string | undefined {
  return modelId.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ? 'the id has an empty, "." or ".." path segment' : undefined;
}

/**
 * The model's endpoint prompt limit, cached on disk with the catalog's own TTL, negative cache and atomic write (getCatalog).
 * A hit makes no network call. Returns undefined when the lookup failed (inside the negative window it is not retried): the caller
 * plans with the catalog context length and says so, and the API's own 400 stays the safety net (plan section 5 "Limits").
 */
export async function loadEndpointPromptLimit(opts: EndpointLimitOptions): Promise<number | undefined> {
  // WHY before any fetch: an empty, "." or ".." segment would be normalised away by URL resolution and ask for another path than the model's; such an id cannot name a model, so its limit is unknown.
  if (malformedModelIdReason(opts.modelId) !== undefined) return undefined;
  // A raw "%" in the id is encoded as data (%25) by encodeURIComponent below, never read as an escape.
  // WHY two ids may map to one file ("a/b" and "a_b" both become "a_b"): the row is matched by id below, so a collision degrades to "limit unknown", never to another model's limit.
  const file = join(dirname(opts.catalogPath ?? defaultDecisionsCachePath()), `decisions-endpoint-${opts.modelId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const rows = await getCatalog<{ id: string; limit: number }>(
    async () => {
      const res = await opts.fetch(`https://openrouter.ai/api/v1/models/${opts.modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`, { signal: AbortSignal.timeout(opts.timeoutMs ?? ENDPOINT_LOOKUP_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return [{ id: opts.modelId, limit: endpointPromptLimit(await res.text()) }];
    },
    opts.now ?? Date.now(),
    { path: file, ttlMs: opts.ttlMs },
  );
  return rows.find((r) => r.id === opts.modelId)?.limit;
}
