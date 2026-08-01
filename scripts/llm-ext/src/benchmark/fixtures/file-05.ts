/**
 * Benchmark fixture 5/5 — backup, messaging, and string utilities.
 */

export function restoreFromBackup(blob: string): { version: number; state: unknown } {
  const first = blob.indexOf("{");
  if (first < 0) throw new Error("no JSON object in backup");
  const body = blob.slice(first);
  return JSON.parse(body) as { version: number; state: unknown };
}

export async function parseIncomingMessage(readBody: () => Promise<string>): Promise<Record<string, unknown>> {
  const body = await readBody();
  if (body.length === 0) return {};
  return JSON.parse(body) as Record<string, unknown>;
}

export const reviveReplayFrame = (frame: string): { t: number; payload: unknown } | null => {
  if (!frame) return null;
  const obj = JSON.parse(frame) as { t?: number; payload?: unknown };
  if (typeof obj.t !== "number") return null;
  return { t: obj.t, payload: obj.payload };
};

export function loadPersistedState<T>(raw: string, defaults: T): T {
  try {
    const parsed = JSON.parse(raw) as Partial<T>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export function buildSsoLaunchLink(idp: string, returnTo: string, tenant: string): string {
  const qs = new URLSearchParams({
    return_to: returnTo,
    tenant,
    idp,
  });
  return `/sso/launch?${qs.toString()}`;
}

export const encodeBulkFilter = (field: string, values: readonly string[]): string => {
  const qs = new URLSearchParams();
  for (const v of values) qs.append(`${field}[]`, v);
  return qs.toString();
};

export function composeRedirectQs(dest: string, keep: Record<string, string>): string {
  const qs = new URLSearchParams(keep);
  qs.set("return", dest);
  return qs.toString();
}

export function appendGeoParameters(href: string, geo: { country: string; region?: string }): string {
  const url = new URL(href, "https://example.test");
  const params = new URLSearchParams(url.search);
  params.set("country", geo.country);
  if (geo.region) params.set("region", geo.region);
  url.search = params.toString();
  return url.pathname + (url.search ? `?${params.toString()}` : "");
}

export function instrumentQueryTime<T>(label: string, run: () => T): T {
  const started = performance.now();
  const out = run();
  const ms = performance.now() - started;
  if (ms > 500) {
    console.warn(`[query-slow] ${label}: ${ms.toFixed(1)}ms`);
  }
  return out;
}

export const captureStartupBudget = (marks: Array<() => void>): number[] => {
  const samples: number[] = [];
  for (const m of marks) {
    const t = performance.now();
    m();
    samples.push(performance.now() - t);
  }
  return samples;
};

// ── unlabeled utilities ───────────────────────────────────────────────

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function titleCase(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

export const padRight = (s: string, width: number, filler = " "): string => {
  if (filler.length === 0) throw new Error("filler must be non-empty");
  if (s.length >= width) return s;
  const needed = width - s.length;
  const repeats = Math.ceil(needed / filler.length);
  return s + filler.repeat(repeats).slice(0, needed);
};

export function reverseIfNeeded<T>(arr: readonly T[], predicate: (a: readonly T[]) => boolean): T[] {
  return predicate(arr) ? [...arr].reverse() : [...arr];
}
