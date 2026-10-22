/**
 * Pure builders for the `local` dynamic profile section (TRDD-C9SXX7HO, D1).
 *
 * `local` is the third built-in dynamic profile (alongside `free`/`paid`):
 * instead of an OpenRouter catalog, its content comes straight from
 * `local_discovery/scan.ts`'s probe of well-known local LLM server ports
 * (llama.cpp / LM Studio / vLLM / Ollama / generic OpenAI-compatible). This
 * module does NO I/O and runs NO probe — it only turns an already-probed
 * `DiscoveredService[]` (or its absence) into a `Profile` shape and a
 * change-detection fingerprint. The actual scan, the write, and the wiring
 * into DYNAMIC_PROFILE_NAMES/dynamic-maintainer.ts are D2 (phase C2 + D2),
 * deliberately out of scope here so this file can land in parallel with C2.
 */

import { createHash } from "node:crypto";
import { PLACEHOLDER_MODEL_ID, type Profile, type ProviderBinding } from "./config.js";
import { PROBE_TARGETS, type DiscoveredService } from "./local_discovery/scan.js";

/**
 * Build the `local` dynamic profile section from a scan result.
 *
 * Coordinator decisions on the card's open design points (TRDD-C9SXX7HO):
 *  1. `model`/`api` come from the FIRST endpoint, in PROBE_TARGETS order,
 *     that served at least one model — its first listed model, and the
 *     matching `*-local` preset (the same picks `buildProfileForService`
 *     already makes for the STATIC `--pick` flow, applied here to build the
 *     DYNAMIC section instead).
 *  2. `detected_providers` (D6a rename, TRDD-90DM5YHO: was `providers` before
 *     14.1.0 — the user's own groups now own that key on `local` too, and the
 *     generated probe output must not share it) carries every (endpoint,
 *     model) pair detected, ALSO in PROBE_TARGETS order — this is the
 *     walkable fallback chain (chainModelIds / resolveModelChain) once a
 *     model goes away. No rating exists for local endpoints (no price, no
 *     benchmark), so probe order IS the preference order; there is nothing
 *     else to rank them by. Each entry carries an explicit `name` (the
 *     endpoint's preset, `-2` suffixed on repeats — D6a names every group).
 *  Unpopulated (no endpoint reachable, or none served a model): the section
 *  is still written, marked, with `model: PLACEHOLDER_MODEL_ID` and an empty
 *  `detected_providers`/`free_models` list — never the sentinel id surfaced
 *  to the user, never "not benchmarked" (this profile is scanned, not
 *  benchmarked; see the card's Open design points / fix-queue 83 review).
 *
 * D1 review follow-up (TRDD-C9SXX7HO): `profileChain` (profile-fallback.ts)
 * and `chainModelIds`/`resolveModelChain` (config.ts) walk
 * `model`/`second_model`/`third_model`/`free_models`/`tool_models` — never
 * `detected_providers`/`providers[]`, which is only the routing table
 * `resolveGroups` builds from it (a model id's URL, not a fallback-order
 * signal). A routes-only section is therefore invisible to every one of
 * those three walkers, so this builder emits BOTH: `free_models` carries the
 * walkable chain (every detected id, in PROBE_TARGETS probe order, flattened
 * across endpoints), `detected_providers` carries each id's route. This is
 * the same two-field shape default-profiles.ts writes for a routed b.ai
 * entry (the id in `free_models`, its route in `providers`) — reused here
 * rather than inventing a third shape the walkers would need to learn.
 */
export function buildLocalProfileSection(services: readonly DiscoveredService[]): Profile {
  // Only a reachable endpoint that actually served a model counts — an
  // unreachable port or a server with nothing loaded contributes no pair,
  // same filter buildProfileForService applies for the static `--pick` flow.
  const withModels = services.filter((s) => s.reachable && s.models.length > 0);

  if (withModels.length === 0) {
    return {
      mode: "local",
      // No endpoint detected yet. PROBE_TARGETS[0]'s own preset names a
      // *-local api (required by validateProfile's mode<->preset check) even
      // though it carries no meaning until a real endpoint is found — it is
      // never read, since there are no detected providers and nothing can
      // serve. D0 fix-up (TRDD-AL8GIZYA), D6a rename: the empty generated
      // routes list IS carried, now under `detected_providers` — see
      // unpopulatedLocalProfile's docblock (config.ts), which this MUST stay
      // byte-identical to.
      api: PROBE_TARGETS[0].presetName,
      model: PLACEHOLDER_MODEL_ID,
      free_models: [],
      detected_providers: [],
    };
  }

  const primary = withModels[0];
  // D6a: each generated group carries an EXPLICIT name — the endpoint's own
  // preset, `-2`-suffixed when two endpoints share a preset (two Ollama
  // servers are `ollama-local` and `ollama-local-2`). Explicit names here
  // keep group identity stable across re-probes even when the user's own
  // `providers` groups derive names from the same presets.
  const usedNames = new Set<string>();
  const namedProviders: ProviderBinding[] = withModels.map((s) => {
    const base = s.presetName === "lmstudio-local" ? "generic-local" : s.presetName;
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}-${n++}`;
    usedNames.add(name);
    return {
      // D2 review (fq88's own validateProfile rule, not this card's design):
      // `lmstudio-local` is refused as a routing-table entry — its "native"
      // API is only reachable as the profile-level `api`, per the rule's own
      // remedy text ("Use 'generic-local' with an explicit url"). This fires
      // even for the PRIMARY endpoint's own entry (buildLocalProfileSection
      // deliberately duplicates it into the first generated group), so every
      // LM Studio binding here goes through the generic OpenAI-compatible
      // route instead — LM Studio serves that surface too, at the same
      // baseUrl, and the profile-level `api` below is unaffected (no such
      // restriction there).
      name,
      api: base,
      url: s.baseUrl,
      models: s.models.map((m) => m.id),
    };
  });
  // profileChain (profile-fallback.ts) and chainModelIds/resolveModelChain
  // (config.ts) walk `free_models`/`paid_models` — never the routing table,
  // which resolveGroups uses to find each id's URL. So the walkable fallback
  // chain has to live in `free_models` too, in the same PROBE_TARGETS probe
  // order as `detected_providers`, flattened across every endpoint (this
  // mirrors the shape default-profiles.ts writes for a routed b.ai entry:
  // the id goes in `free_models`, its route in the routes list).
  const free_models = namedProviders.flatMap((p) => p.models ?? []);

  return {
    mode: "local",
    api: primary.presetName,
    model: primary.models[0].id,
    free_models,
    detected_providers: namedProviders,
  };
}

/**
 * Stable fingerprint of the detected (endpoint, model) set, same shape as
 * dynamic-maintainer.ts's `poolFingerprint` (config.ts's borrowed pattern,
 * originally default-profiles.ts): sort the canonical per-pair strings
 * (order-independent — two re-probes that found the same set in a different
 * response order must fingerprint identically, or the maintainer would
 * regenerate the section on every call for no real change), join, sha256,
 * truncate to 16 hex chars. Unreachable services (or ones with no model
 * loaded) contribute nothing, matching `buildLocalProfileSection`'s filter.
 */
export function localEndpointFingerprint(services: readonly DiscoveredService[]): string {
  const pairs: string[] = [];
  for (const s of services) {
    if (!s.reachable) continue;
    for (const m of s.models) {
      pairs.push(`${s.baseUrl} ${m.id}`);
    }
  }
  // `.sort()` makes this stable across a re-probe that returns the SAME set
  // in a different response order — but it deliberately does NOT encode
  // PROBE_TARGETS' own order. That is safe only because PROBE_TARGETS is a
  // fixed, hardcoded array (local_discovery/scan.ts) today: reordering its
  // entries changes probe order but not the fingerprint, which is correct
  // for THIS builder (buildLocalProfileSection re-derives model/api/providers
  // from PROBE_TARGETS order fresh every call, so the fingerprint only needs
  // to say "detected set changed", not "arrangement changed"). If
  // PROBE_TARGETS ever becomes user-configurable, its order must be folded
  // into the hash too — a user-driven reorder would then be a real config
  // change the detector has to notice, not noise to suppress.
  const canonical = pairs.sort().join("");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
