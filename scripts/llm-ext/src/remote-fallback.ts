// TRDD-WSPV40Y5 (increment 1d): the ONE decision of whether a remote service failure lets a general command finish on a ready
// local profile, and the fixed warning texts. Pure: no I/O, no process. The async evidence (the outage probe of
// providerOutageError, the strict probe the 1b give-up window already ran) is handed in as facts, so every call site
// (the chain walk, the free rotation, the check_imports JSON rotation) partitions the causes the same way.

import { paymentErrorCertainty } from "./benchmark/free-mode.js";
import { freeFailureCause, isNetworkIsolation } from "./free-failure-cause.js";
import { failureText } from "./provider/http.js";

/** Why the remote service is unusable for this command: an outage, no network path, a paid wallet at zero, a refused key. */
export type FallbackTrigger = "outage" | "network" | "credit" | "key";

export interface FallbackFacts {
  /** providerOutageError confirmed the outage (the cause pattern AND a failing reachability probe). */
  outageConfirmed: boolean;
  /** The 1b give-up window of this dispatch armed: a local target was ready, trigger (c) held and the STRICT probe got no genuine provider answer. */
  networkArmed: boolean;
}

const KEY_REFUSED_RE = /API error 40[13]\b/;

/**
 * The trigger these causes give, or undefined when the failure stays inside the remote profile (a request-specific 4xx, a
 * context overflow, a dead model inside a healthy service, a refusal, a free-profile 402). WHY each rule:
 *  - outage first: the existing verdict order (providerOutageError runs before failDynamicProfile).
 *  - network: EVERY cause (at least one) carries a typed network-isolation code (1a classifier) AND the 1b window armed, which
 *    is where the strict probe ran; a second 5 s probe here would only repeat it.
 *  - key: every cause is a 401, a 403 or a certain 402, and at least one is a 401 or 403 (Q3 REVISED, 2026-11-13: refused keys
 *    fall back, one rule with classify, whose NO_LOCAL_RESCUE rescues 401 and 403).
 *  - credit: only on `paid` and only when EVERY cause is a certain 402; on `free` a 402 means "no longer free" and the profile
 *    update is the fix, so it stays in-profile.
 * An empty cause list never falls back (no evidence of anything).
 */
export function fallbackVerdict(causes: readonly unknown[], profileName: string, facts: FallbackFacts): FallbackTrigger | undefined {
  if (causes.length === 0) return undefined;
  if (facts.outageConfirmed) return "outage";
  if (facts.networkArmed && isNetworkIsolation(causes.map((c) => freeFailureCause("cause", c, failureText(c))))) return "network";
  const texts = causes.map(failureText);
  const certain402 = (m: string) => paymentErrorCertainty(m) === "certain";
  if (texts.some((m) => KEY_REFUSED_RE.test(m)) && texts.every((m) => KEY_REFUSED_RE.test(m) || certain402(m))) return "key";
  if (profileName === "paid" && texts.every(certain402)) return "credit";
  return undefined;
}

/** The one stderr line printed at the switch (constraint 6, never silent). The credit and key texts are fixed by the card (section 5). */
export function fallbackWarning(trigger: FallbackTrigger, from: string, target: string, model: string): string {
  const why =
    trigger === "credit"
      ? "credit exhausted on the paid profile: top up; answered locally"
      : trigger === "key"
        ? "the API key was refused (401/403): fix it; answered locally"
        : trigger === "outage"
          ? "the remote provider appears to be down; answered locally"
          : "no network path to the remote provider; answered locally";
  return `[llm-externalizer] ${why} by profile '${target}' (model ${model}) instead of '${from}' for the rest of this command; answers are degraded\n`;
}
