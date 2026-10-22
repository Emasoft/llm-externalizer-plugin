/**
 * Disk-cached, TTL'd, negative-cached fetch of a model catalog (design
 * section 2.2 + addendum D).
 *
 * WHY a disk cache: every llm-ext process is short-lived, so a per-process
 * in-memory cache (like index.ts's fetchOpenRouterModels module-level cache)
 * only helps WITHIN one command. A burst of N `llm-ext` calls in a shell
 * loop would otherwise mean N catalog fetches. Sharing the cache on disk
 * means the second call within the TTL window reads a file instead of
 * hitting the network.
 *
 * WHY negative-caching failures separately from the TTL: a fetch failure
 * (provider outage, no network) must not be retried on every single call
 * during the outage — that is a real latency cost per llm-ext invocation.
 * But it also must not poison the TTL cache as if it were a real "nothing
 * changed" result, so a fresh success afterward is picked up promptly. Hence
 * a SEPARATE, shorter negative-TTL window, tracked alongside (not instead
 * of) the last-known-good snapshot.
 *
 * The fetch function is injected — this module knows nothing about
 * OpenRouter, b.ai, or HTTP. index.ts wires the real fetcher (P6).
 * bai-catalog.ts is a thin, same-shape wrapper for the b.ai model list.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";

/** `0` means "always fetch" (never serve from the TTL cache). */
export const DEFAULT_CATALOG_TTL_MS = 600_000;
export const CATALOG_TTL_ENV = "LLM_EXT_CATALOG_TTL_MS";

/** A failed fetch is not retried within this window; the stale cache (or an
 *  empty list, if there never was one) is served instead. */
export const NEGATIVE_TTL_MS = 60_000;

/** Parse LLM_EXT_CATALOG_TTL_MS. `0` is a valid value meaning "always fetch".
 *  Missing/blank/negative/non-finite -> the default (fail-safe: a malformed
 *  env var must never make every call skip the cache AND never make it stick
 *  forever — the default TTL is the safe middle). */
export function parseCatalogTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CATALOG_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATALOG_TTL_MS;
  return n;
}

interface CatalogCacheFile<T> {
  /** Epoch ms of the last SUCCESSFUL fetch. */
  fetchedAtMs: number;
  /** Models from the last SUCCESSFUL fetch (possibly stale). */
  models: T[];
  /** Epoch ms of the last FAILED fetch attempt, if any (negative cache). */
  failedAtMs?: number;
}

export function catalogCachePath(): string {
  return join(getConfigDir(), "catalog-cache.json");
}

/**
 * ONE model's price from the on-disk catalog cache, synchronously (TRDD-FDI9NYAS
 * D3c) — the send-time price check cannot await a live network fetch on every
 * request. Reads the SAME file the periodic background detector keeps warm
 * (profile-detector.ts / dynamic-maintainer.ts both fetch through
 * catalogCachePath()), so in normal operation this is a cheap disk read
 * against data at most DEFAULT_CATALOG_TTL_MS stale, never a live HTTP call.
 *
 * Returns null when the model is absent from the cache, the cache itself is
 * missing/unreadable, or its pricing fields do not parse to finite numbers —
 * the caller MUST treat null as "no recorded price data" and fail closed
 * (refuse rather than send blind). Never throws.
 */
export function readCachedModelPrice(
  model: string,
  path: string = catalogCachePath(),
): { inputDollarsPerMillion: number; outputDollarsPerMillion: number } | null {
  const cache = readCacheFile<{ id: string; pricing?: { prompt?: string; completion?: string } }>(path);
  const entry = cache?.models.find((m) => m.id === model);
  if (!entry?.pricing) return null;
  const inputDollarsPerMillion = parseFloat(entry.pricing.prompt ?? "NaN") * 1_000_000;
  const outputDollarsPerMillion = parseFloat(entry.pricing.completion ?? "NaN") * 1_000_000;
  if (!Number.isFinite(inputDollarsPerMillion) || !Number.isFinite(outputDollarsPerMillion)) return null;
  return { inputDollarsPerMillion, outputDollarsPerMillion };
}

function readCacheFile<T>(path: string): CatalogCacheFile<T> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CatalogCacheFile<T>>;
    if (typeof parsed.fetchedAtMs !== "number" || !Array.isArray(parsed.models)) return null;
    return {
      fetchedAtMs: parsed.fetchedAtMs,
      models: parsed.models,
      failedAtMs: typeof parsed.failedAtMs === "number" ? parsed.failedAtMs : undefined,
    };
  } catch {
    // Corrupt/unreadable cache is not an error condition — treat as absent,
    // same fail-open contract as every other sidecar state file in this repo.
    return null;
  }
}

function writeCacheFile<T>(path: string, data: CatalogCacheFile<T>): void {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    try { chmodSync(tmp, 0o600); } catch { /* Windows may not support chmod */ }
    renameSync(tmp, path);
  } catch {
    // The cache is an optimisation, not a correctness requirement — a failed
    // write just means the next call re-fetches. Best-effort cleanup only.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing further to do */ }
  }
}

export interface GetCatalogOptions {
  ttlMs?: number;
  /** Override the cache file path — tests use an isolated one. */
  path?: string;
  /**
   * Called with the thrown error when the FETCH itself failed (P6b-fix S2).
   * WHY it exists: this module fails open by design, so a catalog fetch that
   * fails leaves the caller with an empty list and NO signal at all — the
   * dynamic maintainer then computed an empty pool and the dispatch gate
   * reported "no usable free model right now (0 available)", a diagnosis that
   * was both wrong and unactionable. Optional and best-effort: a throwing
   * reporter must never turn a fail-open path into a throw.
   */
  onError?: (err: unknown) => void;
}

/**
 * Get the catalog, serving from the disk cache when fresh, negative-caching
 * a failed fetch for NEGATIVE_TTL_MS, and falling back to the stale cache (or
 * []) on failure. `now` is injected so tests need no wall-clock dependency.
 */
export async function getCatalog<T>(
  fetcher: () => Promise<T[]>,
  now: number = Date.now(),
  opts: GetCatalogOptions = {},
): Promise<T[]> {
  const path = opts.path ?? catalogCachePath();
  const ttlMs = opts.ttlMs ?? parseCatalogTtlMs(process.env[CATALOG_TTL_ENV]);
  const cache = readCacheFile<T>(path);

  if (cache && ttlMs > 0 && now - cache.fetchedAtMs < ttlMs) {
    return cache.models;
  }

  // A recent failure short-circuits the network call entirely — this is what
  // makes "two calls within 60s after a failure" cost exactly one fetch
  // attempt, not two.
  if (cache?.failedAtMs !== undefined && now - cache.failedAtMs < NEGATIVE_TTL_MS) {
    return cache.models;
  }

  try {
    const models = await fetcher();
    writeCacheFile(path, { fetchedAtMs: now, models });
    return models;
  } catch (err) {
    // Fail-open: serve whatever we last had (possibly nothing), and record
    // the failure so the NEXT call within NEGATIVE_TTL_MS also skips the
    // network instead of paying the same timeout again.
    //
    // P6b-fix S2: fail-open must not mean fail-SILENT. The reporter is
    // wrapped because this path's whole contract is "never throws" — a
    // reporter that throws would defeat the very fail-open it is describing.
    try {
      opts.onError?.(err);
    } catch {
      /* a reporter must never be able to break the fail-open path */
    }
    writeCacheFile(path, {
      fetchedAtMs: cache?.fetchedAtMs ?? 0,
      models: cache?.models ?? [],
      failedAtMs: now,
    });
    return cache?.models ?? [];
  }
}

/**
 * True iff the LAST recorded fetch for this cache file failed and that failure
 * is still inside the negative-cache window (P6b-fix S2).
 *
 * WHY a separate, synchronous read: the dispatch gate runs after the
 * maintainer and has no access to what the maintainer's async fetch did, so
 * without this it attributed an empty pool to "the benchmark hasn't finished
 * yet" even when the real cause was an unreachable provider. The negative-TTL
 * window is deliberately the same one that suppresses the refetch: inside it,
 * the emptiness genuinely IS the failure's consequence.
 */
export function catalogFetchRecentlyFailed(
  nowMs: number = Date.now(),
  path: string = catalogCachePath(),
): boolean {
  const cache = readCacheFile<unknown>(path);
  if (!cache || cache.failedAtMs === undefined) return false;
  return nowMs - cache.failedAtMs < NEGATIVE_TTL_MS;
}
