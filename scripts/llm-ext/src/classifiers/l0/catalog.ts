// Plan §3/§4: the decisions model catalog is the single source of model limits; this loader only fetches, caches and maps it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_TTL_ENV, getCatalog, NEGATIVE_TTL_MS, parseCatalogTtlMs } from "../../catalog-cache.js";
import { getConfigDir } from "../../config.js";
import { withMkdirLock } from "../../mkdir-lock.js";
import type { GlobalFetch } from "./transport.js";

export const DECISIONS_CATALOG_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
const FETCH_TIMEOUT_MS = 30_000;

export interface DecisionsModel {
  id: string;
  canonicalSlug: string;
  /** Slug of the model an alias (e.g. `~typesafe/jev-latest`) redirects to; limits must be read from that target. */
  aliasTarget?: string;
  /** Catalog `context_length`; null when the catalog reports 0 or nothing (plan §4: the profile override applies then). */
  contextTokens: number | null;
  promptUsdPerM: number | null;
  outputModalities: string[];
  systemOne: boolean;
}

interface RawModel {
  id: string;
  canonical_slug?: string;
  description?: string;
  context_length?: number | null;
  alias_target?: { slug?: string } | null;
  pricing?: { prompt?: string };
  architecture?: { output_modalities?: string[] };
}

/** WHY a separate file: the shared catalog cache holds the plain OpenRouter list; mixing the two shapes would corrupt both. */
export function defaultDecisionsCachePath(): string {
  return join(getConfigDir(), "decisions-catalog-cache.json");
}

/**
 * The cached catalog at ANY age, never refreshed; null when the file is missing or damaged.
 * WHY null on damage: chat-profile selection must not break because a classifier-only cache is corrupt;
 * the strict path (loadDecisionsCatalog) refetches over a bad cache instead.
 */
export function readCachedDecisionsCatalog(path: string = defaultDecisionsCachePath()): DecisionsModel[] | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { models?: unknown };
    return Array.isArray(parsed.models) ? (parsed.models as DecisionsModel[]) : null;
  } catch {
    return null;
  }
}

function toModel(m: RawModel): DecisionsModel {
  const perToken = Number.parseFloat(m.pricing?.prompt ?? "");
  return {
    id: m.id,
    canonicalSlug: m.canonical_slug ?? m.id,
    ...(m.alias_target?.slug ? { aliasTarget: m.alias_target.slug } : {}),
    contextTokens: m.context_length ? m.context_length : null,
    // toPrecision: 0.000000042 * 1e6 would otherwise carry binary noise into every cost figure.
    promptUsdPerM: Number.isFinite(perToken) ? Number((perToken * 1e6).toPrecision(12)) : null,
    outputModalities: m.architecture?.output_modalities ?? [],
    // shortcut: the catalog has no System One field (measured, P-02); description text or a typesafe id is the only signal. Upgrade when the catalog adds one.
    systemOne: /system\s*one/i.test(m.description ?? "") || /^~?typesafe\//.test(m.id),
  };
}

async function fetchModels(fetchImpl: GlobalFetch): Promise<DecisionsModel[]> {
  const res = await fetchImpl(DECISIONS_CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: RawModel[] };
  if (!Array.isArray(body.data)) throw new Error("reply has no data array");
  return body.data.map(toModel);
}

export interface LoadDecisionsCatalogOptions {
  fetch: GlobalFetch;
  now?: number;
  path?: string;
  ttlMs?: number;
}

export async function loadDecisionsCatalog(opts: LoadDecisionsCatalogOptions): Promise<DecisionsModel[]> {
  const path = opts.path ?? defaultDecisionsCachePath();
  let cause: unknown;
  let failedRecently = false;
  const now = opts.now ?? Date.now();
  // shortcut: withMkdirLock is synchronous, so it is released when the promise is returned, not when the fetch ends; it only covers the cache read/TTL prologue. Upgrade when an async lock exists.
  const models = await withMkdirLock(`${path}.lock`, () => {
    // WHY one peek before getCatalog: getCatalog reads the file and catalogFetchRecentlyFailed read it again, so every load cost two reads. One read answers both questions; getCatalog (which reads again) runs only when a fetch is due, and its failure arrives through `cause`.
    const cache = peekCache(path);
    if (cache?.failedAtMs !== undefined && now - cache.failedAtMs < NEGATIVE_TTL_MS) {
      failedRecently = true;
      return cache.models;
    }
    const ttlMs = opts.ttlMs ?? parseCatalogTtlMs(process.env[CATALOG_TTL_ENV]);
    if (cache && ttlMs > 0 && now - cache.fetchedAtMs < ttlMs) return cache.models;
    return getCatalog(() => fetchModels(opts.fetch), now, { path, ttlMs: opts.ttlMs, onError: (e) => { cause = e; } });
  });
  // WHY: getCatalog fails open (serves stale data or []); plan §8 and E16 demand an error instead.
  if (cause !== undefined || failedRecently) {
    const why = cause === undefined ? "a refresh failed within the last 60 s" : cause instanceof Error ? cause.message : String(cause);
    throw new Error(`decisions catalog unavailable and cache expired: ${DECISIONS_CATALOG_URL} (${why})`);
  }
  return models;
}

/** The cache file with its failure stamp, read once; null when missing or damaged (same fail-open reading as catalog-cache.ts readCacheFile, which is not exported). */
function peekCache(path: string): { fetchedAtMs: number; failedAtMs?: number; models: DecisionsModel[] } | null {
  try {
    if (!existsSync(path)) return null;
    const p = JSON.parse(readFileSync(path, "utf-8")) as { fetchedAtMs?: unknown; failedAtMs?: unknown; models?: unknown };
    if (typeof p.fetchedAtMs !== "number" || !Array.isArray(p.models)) return null;
    return { fetchedAtMs: p.fetchedAtMs, models: p.models as DecisionsModel[], ...(typeof p.failedAtMs === "number" ? { failedAtMs: p.failedAtMs } : {}) };
  } catch {
    return null;
  }
}
