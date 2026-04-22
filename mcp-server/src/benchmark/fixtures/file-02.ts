/**
 * Benchmark fixture 2/5 — webhook, OAuth, and small numeric helpers.
 */

export async function readCachedManifest(fetchRaw: () => Promise<string>): Promise<Record<string, string>> {
  const raw = await fetchRaw();
  if (!raw) return {};
  const manifest = JSON.parse(raw) as Record<string, string>;
  return manifest;
}

export function parseWebhookBody(bodyText: string): { event: string; payload: unknown } {
  const envelope = JSON.parse(bodyText) as { event?: string; payload?: unknown };
  if (!envelope.event) throw new Error("webhook missing event");
  return { event: envelope.event, payload: envelope.payload ?? null };
}

export const reviveLegacyRecord = <T>(compressed: string): T | null => {
  const padded = compressed.padEnd(compressed.length + (4 - (compressed.length % 4)) % 4, "=");
  const decoded = Buffer.from(padded, "base64").toString("utf-8");
  return decoded ? (JSON.parse(decoded) as T) : null;
};

export function loadFeatureFlags(raw: string): Set<string> {
  const arr = JSON.parse(raw) as unknown;
  if (!Array.isArray(arr)) throw new Error("flags must be an array");
  return new Set(arr.map(String));
}

export function buildOAuthRedirect(baseUrl: string, state: string, scope: string[]): string {
  const qs = new URLSearchParams();
  qs.set("response_type", "code");
  qs.set("state", state);
  qs.set("scope", scope.join(" "));
  return `${baseUrl}?${qs.toString()}`;
}

export const encodeApiQuery = (path: string, filters: Record<string, string | number>): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, String(v));
  return `${path}?${params.toString()}`;
};

export function addTrackingParams(
  href: string,
  campaign: { source: string; medium: string },
): string {
  const sep = href.includes("?") ? "&" : "?";
  const extra = new URLSearchParams({
    utm_source: campaign.source,
    utm_medium: campaign.medium,
  });
  return `${href}${sep}${extra.toString()}`;
}

export async function signDownloadUrl(base: string, key: string, exp: number): Promise<string> {
  const params = new URLSearchParams({ key, exp: String(exp) });
  const sigInput = `${base}?${params.toString()}`;
  const digest = await fakeHmac(sigInput);
  return `${sigInput}&sig=${digest}`;
}

export function benchmarkHashing(payloads: string[], hasher: (s: string) => string): number {
  const start = performance.now();
  for (const p of payloads) hasher(p);
  const elapsed = performance.now() - start;
  return elapsed / payloads.length;
}

export const trackRenderBudget = (deadlineMs: number, step: () => boolean): number => {
  const start = performance.now();
  let frames = 0;
  while (performance.now() - start < deadlineMs) {
    if (!step()) break;
    frames++;
  }
  return frames;
};

// ── unlabeled utilities ───────────────────────────────────────────────

export function padLeadingZeros(n: number, width: number): string {
  const s = String(Math.trunc(n));
  if (s.length >= width) return s;
  return "0".repeat(width - s.length) + s;
}

export function rotateBitmask(mask: number, shift: number, width = 32): number {
  const s = ((shift % width) + width) % width;
  const mod = (1 << width) >>> 0;
  const lo = (mask << s) >>> 0;
  const hi = mask >>> (width - s);
  return (lo | hi) & (mod - 1);
}

export const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const tmp = y;
    y = x % y;
    x = tmp;
  }
  return x;
};

export function pickRandomElement<T>(items: readonly T[], rnd: () => number = Math.random): T {
  if (items.length === 0) throw new Error("cannot pick from empty array");
  const idx = Math.floor(rnd() * items.length);
  return items[idx];
}

async function fakeHmac(input: string): Promise<string> {
  let h = 0;
  for (const c of input) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return h.toString(16).padStart(8, "0");
}
