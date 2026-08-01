/**
 * Benchmark fixture 3/5 — event streams, pagination, and small algorithms.
 */

interface Snapshot {
  revision: number;
  entries: unknown[];
}

export async function deserializeEvent(line: string): Promise<unknown> {
  if (!line.startsWith("data:")) return null;
  const body = line.slice(5).trim();
  return JSON.parse(body);
}

export function restoreLocalStorage(key: string, defaultValue: unknown): unknown {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (raw == null) return defaultValue;
  try {
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export const parseBatchResponse = (chunks: string[]): unknown[] => {
  const merged: unknown[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    merged.push(JSON.parse(chunk));
  }
  return merged;
};

export function materializeSnapshot(text: string): Snapshot {
  const blob = JSON.parse(text) as Partial<Snapshot>;
  return {
    revision: typeof blob.revision === "number" ? blob.revision : 0,
    entries: Array.isArray(blob.entries) ? blob.entries : [],
  };
}

export function composePaginationUrl(base: string, cursor: string, pageSize: number): string {
  const query = new URLSearchParams();
  query.set("cursor", cursor);
  query.set("page_size", String(pageSize));
  return `${base}?${query.toString()}`;
}

export function buildPayloadSignature(secret: string, claims: Record<string, string>): string {
  const params = new URLSearchParams(claims);
  params.sort();
  const canonical = params.toString();
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) h = (h ^ canonical.charCodeAt(i)) * 16777619;
  return `${secret}:${(h >>> 0).toString(16)}`;
}

export const encodeRedirectTarget = (dest: string, ref: string): string => {
  const qs = new URLSearchParams({ dest, ref });
  return `/redirect?${qs.toString()}`;
};

export function decorateAnalyticsUrl(
  href: string,
  events: ReadonlyArray<[string, string | number]>,
): string {
  const [pathname, existing = ""] = href.split("?");
  const merged = new URLSearchParams(existing);
  for (const [k, v] of events) merged.append(k, String(v));
  return `${pathname}?${merged.toString()}`;
}

export function assertTimingBudget(run: () => void, maxMs: number): void {
  const start = performance.now();
  run();
  const elapsed = performance.now() - start;
  if (elapsed > maxMs) {
    throw new Error(`timing budget exceeded: ${elapsed.toFixed(2)}ms > ${maxMs}ms`);
  }
}

export const capturePerformanceTrace = async <T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ label: string; value: T; durationMs: number }> => {
  const t0 = performance.now();
  const value = await fn();
  return { label, value, durationMs: performance.now() - t0 };
};

// ── unlabeled utilities ───────────────────────────────────────────────

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function dedupeBy<T, K>(items: readonly T[], keyOf: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export const isProbablyPrime = (n: number): boolean => {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let i = 3; i * i <= n; i += 2) {
    if (n % i === 0) return false;
  }
  return true;
};

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  return `${(s / 60).toFixed(2)}min`;
}
