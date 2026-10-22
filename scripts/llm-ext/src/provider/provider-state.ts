/**
 * Provider state for a give-up message (TRDD-YG72CYY7, increment 4).
 *
 * getModelSupportedParams already fetches /v1/models/{id}/endpoints; this file
 * slims that array, decides which endpoints are degraded, and renders one line.
 * Pure functions, no I/O, no state.
 */
import type { ModelEndpoint } from "../or-model-info.js";

export interface ProviderEndpointState {
  provider: string;
  status?: number;
  uptime30m?: number;
}

export interface ProviderStateEntry {
  fetchedAt: number;
  endpoints: ProviderEndpointState[];
}

// Pending owner question Q3: 90 or 95. 90 is the "poor" bound of uptimeLevel in or-model-info.ts.
export const PROVIDER_DEGRADED_UPTIME_PCT = 90;

const MAX_LISTED = 3;
const MAX_NAME_CHARS = 40;

/** Provider names are remote data that reach user-visible text: strip anything that could break the line or leak a key. */
export function cleanProviderName(raw: unknown): string {
  if (typeof raw !== "string") return "unnamed";
  const cleaned = raw
    .replace(/[\p{Cc}|]/gu, " ")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return cleaned || "unnamed";
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Total: any remote shape yields a (possibly empty) array, never a throw. */
export function slimEndpoints(endpoints: unknown): ProviderEndpointState[] {
  if (!Array.isArray(endpoints)) return [];
  const out: ProviderEndpointState[] = [];
  for (const ep of endpoints as unknown[]) {
    if (typeof ep !== "object" || ep === null) continue;
    const e = ep as ModelEndpoint;
    const slim: ProviderEndpointState = { provider: cleanProviderName(e.provider_name) };
    if (isFiniteNumber(e.status)) slim.status = e.status;
    // Percent on a 0..100 scale; anything else is unknown, not degraded.
    if (isFiniteNumber(e.uptime_last_30m) && e.uptime_last_30m >= 0 && e.uptime_last_30m <= 100) {
      slim.uptime30m = e.uptime_last_30m;
    }
    out.push(slim);
  }
  return out;
}

export function isDegraded(ep: ProviderEndpointState): boolean {
  return (
    (ep.status !== undefined && ep.status !== 0) ||
    (ep.uptime30m !== undefined && ep.uptime30m < PROVIDER_DEGRADED_UPTIME_PCT)
  );
}

/** Floor, not round: a degraded 99.96 must not print 100.0%. The epsilon absorbs x*10 float error. */
const pct = (v: number): string => `${(Math.floor(v * 10 + 1e-9) / 10).toFixed(1)}%`;

function describe(ep: ProviderEndpointState): string {
  const parts: string[] = [];
  if (ep.status !== undefined && ep.status !== 0) parts.push(`status ${ep.status}`);
  if (ep.uptime30m !== undefined) parts.push(`uptime ${pct(ep.uptime30m)}`);
  return `${ep.provider} (${parts.join(", ")})`;
}

/** The one-line provider state, or undefined when no provider is degraded. */
export function formatProviderState(
  modelId: string,
  entry: ProviderStateEntry,
  now: number,
): string | undefined {
  const degraded = entry.endpoints.filter(isDegraded);
  if (degraded.length === 0) return undefined;
  degraded.sort(
    (a, b) =>
      (a.uptime30m ?? Infinity) - (b.uptime30m ?? Infinity) ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
  );
  const listed = degraded.slice(0, MAX_LISTED).map(describe);
  const more = degraded.length - MAX_LISTED;
  if (more > 0) listed.push(`and ${more} more`);
  const clock = `${new Date(entry.fetchedAt).toISOString().slice(11, 19)}Z`;
  const mins = Math.floor((now - entry.fetchedAt) / 60_000);
  const age = mins >= 1 ? `cached ${mins} min ago` : "cached under 1 min ago";
  return `provider state for ${modelId} as of ${clock} (${age}): ${degraded.length} of ${entry.endpoints.length} providers degraded: ${listed.join(", ")}`;
}
