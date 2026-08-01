/**
 * Benchmark fixture 4/5 — mixed payload, link, and timing helpers.
 */

export function parseEventPayload(envelope: string): { kind: string; data: unknown } {
  const outer = JSON.parse(envelope) as { kind?: string; data?: unknown };
  if (!outer.kind) throw new Error("event envelope missing kind");
  return { kind: outer.kind, data: outer.data };
}

export const loadProjectConfig = (configBlob: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = JSON.parse(configBlob) as Record<string, unknown>;
  return { ...base, ...overrides };
};

export function readManifestDump(dump: string, section: string): unknown {
  const parsed = JSON.parse(dump) as Record<string, unknown>;
  const body = parsed[section];
  if (body === undefined) throw new Error(`missing section: ${section}`);
  return body;
}

export async function decodeSessionToken(header: string | null): Promise<Record<string, string> | null> {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  const segment = token.split(".")[1] ?? "";
  const pad = segment.padEnd(segment.length + (4 - (segment.length % 4)) % 4, "=");
  const decoded = Buffer.from(pad, "base64").toString("utf-8");
  return JSON.parse(decoded) as Record<string, string>;
}

export function composeFilterUrl(
  endpoint: string,
  filters: ReadonlyArray<{ field: string; op: string; value: string }>,
): string {
  const qs = new URLSearchParams();
  for (const f of filters) qs.append(f.field, `${f.op}:${f.value}`);
  return `${endpoint}?${qs.toString()}`;
}

export const buildCheckoutLink = (productId: string, variant: string, source: string): string => {
  const params = new URLSearchParams({ product: productId, variant, src: source });
  params.set("t", Date.now().toString());
  return `/checkout?${params.toString()}`;
};

export function appendUtmTokens(href: string, src: string, medium: string, campaign: string): string {
  const [base, rest = ""] = href.split("?");
  const merged = new URLSearchParams(rest);
  merged.set("utm_source", src);
  merged.set("utm_medium", medium);
  merged.set("utm_campaign", campaign);
  return `${base}?${merged.toString()}`;
}

export function encodeCursorHandle(cursor: { offset: number; after?: string }): string {
  const qs = new URLSearchParams();
  qs.set("offset", String(cursor.offset));
  if (cursor.after) qs.set("after", cursor.after);
  return qs.toString();
}

export const trackSlowOperation = async (
  name: string,
  op: () => Promise<void>,
  thresholdMs: number,
): Promise<void> => {
  const started = performance.now();
  await op();
  const took = performance.now() - started;
  if (took > thresholdMs) {
    console.warn(`[slow] ${name} took ${took.toFixed(1)}ms (threshold ${thresholdMs}ms)`);
  }
};

export function sampleAnimationLatency(frameWork: () => void, samples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    frameWork();
    out.push(performance.now() - t);
  }
  return out;
}

// ── unlabeled utilities ───────────────────────────────────────────────

export function truncateWithEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, maxLen);
  return text.slice(0, maxLen - 1).trimEnd() + "…";
}

export function wrapLongText(input: string, width: number): string[] {
  if (width <= 0) throw new Error("width must be positive");
  const words = input.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > width) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}

export const quoteShellArg = (arg: string): string => {
  if (/^[A-Za-z0-9_\-./]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
};

export function interleaveArrays<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}
