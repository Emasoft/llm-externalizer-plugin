/**
 * D1 (TRDD-C9SXX7HO): pure builders for the `local` dynamic profile section.
 * No I/O, no network — `local-profile.ts` never probes, so these tests build
 * `DiscoveredService[]` fixtures directly instead of stubbing `fetch`.
 */

import { describe, expect, test } from "vitest";
import { buildLocalProfileSection, localEndpointFingerprint } from "./local-profile.js";
import {
  PLACEHOLDER_MODEL_ID,
  resolveProfile,
  validateProfile,
  unpopulatedLocalProfile,
  type ProviderBinding,
} from "./config.js";
import { profileChain, ProfileExhaustedError } from "./profile-fallback.js";
import { PROBE_TARGETS, type DiscoveredService } from "./local_discovery/scan.js";

/** Minimal reachable service fixture, positioned at PROBE_TARGETS[at]. */
function reachableService(at: number, modelIds: readonly string[]): DiscoveredService {
  const target = PROBE_TARGETS[at];
  return {
    index: at + 1,
    kind: target.kind,
    baseUrl: target.baseUrl,
    presetName: target.presetName,
    reachable: true,
    models: modelIds.map((id) => ({ id })),
  };
}

function unreachableService(at: number): DiscoveredService {
  const target = PROBE_TARGETS[at];
  return {
    index: at + 1,
    kind: target.kind,
    baseUrl: target.baseUrl,
    presetName: target.presetName,
    reachable: false,
    models: [],
    error: "connection refused",
  };
}

describe("buildLocalProfileSection", () => {
  test("two endpoints detected: model/api come from the first in probe order, providers lists every pair in probe order, free_models is the walkable chain profileChain/resolveModelChain actually read", () => {
    // PROBE_TARGETS[0] = lmstudio-local, PROBE_TARGETS[6] = ollama-local —
    // deliberately non-adjacent indices so "first in probe order" is not
    // confused with "first in the input array" (both fixtures are already
    // passed in probe order here, as discoverLocalLlmServices always returns).
    const services = [
      reachableService(0, ["llama-3-8b"]),
      reachableService(6, ["qwen2.5:7b", "mistral:7b"]),
    ];

    const profile = buildLocalProfileSection(services);

    expect(profile.mode).toBe("local");
    expect(profile.api).toBe(PROBE_TARGETS[0].presetName);
    expect(profile.model).toBe("llama-3-8b");

    // profileChain (profile-fallback.ts) and chainModelIds/resolveModelChain
    // (config.ts) walk `free_models`, never `providers[]` — so THIS is the
    // field that actually decides the fallback chain a real call walks.
    expect(profile.free_models).toEqual(["llama-3-8b", "qwen2.5:7b", "mistral:7b"]);

    // D6a rename: the generated probe routes live under `detected_providers`;
    // `providers` is now the USER's own groups key on local.
    const providers = profile.detected_providers as ProviderBinding[];
    // PROBE_TARGETS[0] is lmstudio-local: validateProfile refuses that preset
    // as a routing-table entry (its native API is only reachable as the
    // profile-level `api`) — buildLocalProfileSection routes it through
    // 'generic-local' instead here (same baseUrl), never lmstudio-local.
    // D6a: each generated group carries an explicit name.
    expect(providers).toEqual([
      { name: "generic-local", api: "generic-local", url: PROBE_TARGETS[0].baseUrl, models: ["llama-3-8b"] },
      {
        name: PROBE_TARGETS[6].presetName,
        api: PROBE_TARGETS[6].presetName,
        url: PROBE_TARGETS[6].baseUrl,
        models: ["qwen2.5:7b", "mistral:7b"],
      },
    ]);
  });

  test("nothing detected: unpopulated placeholder shape, empty free_models and providers lists", () => {
    // Every well-known port unreachable — the overwhelmingly common case
    // (no local runner started at all).
    const services = PROBE_TARGETS.map((_, i) => unreachableService(i));

    const profile = buildLocalProfileSection(services);

    expect(profile.mode).toBe("local");
    expect(profile.model).toBe(PLACEHOLDER_MODEL_ID);
    expect(profile.free_models).toEqual([]);
    // D0 fix-up (TRDD-AL8GIZYA), D6a rename: the empty generated routes list
    // IS carried on the unpopulated placeholder, now under
    // `detected_providers` (`providers` is the user's own groups key on
    // local). See unpopulatedLocalProfile's docblock, which this MUST stay
    // byte-identical to.
    expect(profile.detected_providers).toEqual([]);
  });

  test("a reachable endpoint with no model loaded counts as undetected, same as unreachable", () => {
    const services = [
      { ...reachableService(0, []), models: [] },
      unreachableService(1),
    ];

    const profile = buildLocalProfileSection(services);

    expect(profile.model).toBe(PLACEHOLDER_MODEL_ID);
    expect(profile.free_models).toEqual([]);
    expect(profile.detected_providers).toEqual([]);
  });
});

describe("D2 integration: validateProfile and profileChain on a built local section", () => {
  // TRDD-C9SXX7HO, D2's own directive: "the FIRST test of D2" — a built local
  // section, never exercised end-to-end before this phase, must actually
  // validate and actually walk as a fallback chain, not merely look right in
  // isolated unit assertions.
  test("a two-endpoint local section passes validateProfile and profileChain yields every pair", () => {
    const services = [
      reachableService(0, ["llama-3-8b"]),
      reachableService(6, ["qwen2.5:7b", "mistral:7b"]),
    ];
    const profile = buildLocalProfileSection(services);

    const validation = validateProfile("local", profile);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    const resolved = resolveProfile("local", profile);
    expect(resolved.dynamic).toBe(true); // isDynamicProfileName("local") once wired

    const ids: string[] = [];
    const gen = profileChain(resolved);
    let step = gen.next();
    while (!step.done) {
      ids.push(step.value.modelId);
      try {
        step = gen.next({ kind: "model" }); // force advance to the next entry
      } catch (err) {
        expect(err).toBeInstanceOf(ProfileExhaustedError);
        step = { done: true, value: undefined };
      }
    }
    expect(ids).toEqual(["llama-3-8b", "qwen2.5:7b", "mistral:7b"]);
  });

  // Fix-queue row 95c: the test above never fed a `{ kind: "endpoint" }`
  // failure, so it never proved addendum 2's "the second is skipped without
  // a request" or the final `throw ProfileExhaustedError` — a caller that
  // only checks `.done` would not notice profileChain silently returning
  // instead of throwing once every entry is gone. PROBE_TARGETS[6] serves
  // TWO ids (qwen2.5:7b, mistral:7b) behind the SAME baseUrl, so marking
  // that endpoint dead after the first of the two must skip the second
  // entirely and then exhaust the (dynamic) profile.
  test("marking PROBE_TARGETS[6]'s endpoint dead skips its remaining model and throws a dynamic ProfileExhaustedError", () => {
    const services = [
      reachableService(0, ["llama-3-8b"]),
      reachableService(6, ["qwen2.5:7b", "mistral:7b"]),
    ];
    const profile = buildLocalProfileSection(services);
    const resolved = resolveProfile("local", profile);

    const gen = profileChain(resolved);
    const first = gen.next();
    expect(first.done).toBe(false);
    expect(first.value?.modelId).toBe("llama-3-8b");
    // Row 96(3): pin the endpoint the first entry came from too — the
    // modelId alone does not prove profileChain walked PROBE_TARGETS in
    // order rather than by coincidence of the fixture data.
    expect(first.value?.baseUrl).toBe(PROBE_TARGETS[0].baseUrl);

    const second = gen.next({ kind: "model" });
    expect(second.done).toBe(false);
    expect(second.value?.modelId).toBe("qwen2.5:7b");
    expect(second.value?.baseUrl).toBe(PROBE_TARGETS[6].baseUrl);

    // ChainFailure carries no URL (only `kind`, plus an optional `error`
    // cause) — profileChain marks the CURRENT yielded entry's own baseUrl
    // dead (the loop's own `baseUrl` local, not anything read off the failure
    // object), so `{ kind: "endpoint" }` alone is a valid shape to report back
    // through `.next()`.
    //
    // No try/catch here that could swallow a missing throw: if profileChain
    // stopped throwing (e.g. a broken skip that just returned done:true
    // instead), this assertion itself fails rather than passing silently.
    let thrown: unknown;
    try {
      gen.next({ kind: "endpoint" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileExhaustedError);
    expect((thrown as ProfileExhaustedError).kind).toBe("dynamic");
  });

  // Migration's SHIPPED_PLACEHOLDER_SHAPES (benchmark/pick.ts) adopts an
  // unmarked section by matching it BYTE-FOR-BYTE against config.ts's
  // unpopulatedLocalProfile() — config.ts cannot import this module (it
  // would cycle back), so the two hand-written/generated shapes are pinned
  // equal here instead, the same round-trip guarantee unpopulatedFreeProfile/
  // unpopulatedPaidProfile already have with their own writers.
  test("unpopulatedLocalProfile() (config.ts) matches buildLocalProfileSection([]) exactly", () => {
    expect(unpopulatedLocalProfile()).toEqual(buildLocalProfileSection([]));
  });
});

describe("localEndpointFingerprint", () => {
  test("changes when a model appears", () => {
    const before = [reachableService(0, ["llama-3-8b"])];
    const after = [reachableService(0, ["llama-3-8b", "llama-3-70b"])];
    expect(localEndpointFingerprint(before)).not.toBe(localEndpointFingerprint(after));
  });

  test("changes when a model disappears", () => {
    const before = [reachableService(0, ["llama-3-8b", "llama-3-70b"])];
    const after = [reachableService(0, ["llama-3-8b"])];
    expect(localEndpointFingerprint(before)).not.toBe(localEndpointFingerprint(after));
  });

  test("stable across a re-probe that only reorders an unchanged set", () => {
    const first = [
      reachableService(0, ["llama-3-8b", "llama-3-70b"]),
      reachableService(6, ["qwen2.5:7b"]),
    ];
    // Same (endpoint, model) pairs, endpoints AND each endpoint's own model
    // list both reordered — a re-probe response array order is not a promise.
    const reprobed = [
      reachableService(6, ["qwen2.5:7b"]),
      reachableService(0, ["llama-3-70b", "llama-3-8b"]),
    ];
    expect(localEndpointFingerprint(first)).toBe(localEndpointFingerprint(reprobed));
  });
});
