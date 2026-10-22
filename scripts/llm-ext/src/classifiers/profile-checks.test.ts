import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Profile } from "../config.js";
import { validateProfile } from "../config.js";
import { ANY_PROFILE_TYPE } from "../profile-accept.js";
import { loadDecisionsCatalog } from "./l0/catalog.js";
import type { DecisionsEndpoint } from "./l0/transport.js";
import { replayFetch, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import { selectedChatProfileErrors, selectionCatalogErrors, settingsCatalogErrors } from "./profile-checks.js";

const fx = (n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/p02/${n}.json`, import.meta.url), "utf-8"));
const root = mkdtempSync("/tmp/llm-ext-pf02-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = 1_800_000_000_000;
const TTL = 1000;
let n = 0;
/** A cache path seeded from the real recorded catalog (no cache when `seed` is false). */
async function cachePath(seed = true): Promise<string> {
  const path = join(root, `c${n++}.json`);
  if (seed) await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path, ttlMs: TTL });
  return path;
}
const idle = () => replayFetch([]);

describe("decisions guard (free, paid, scouting)", () => {
  it.each(["free", "paid", "scouting"] as const)("%s profile on a cached decisions model fails, whichever vendor", async (type) => {
    const path = await cachePath();
    for (const model of ["typesafe/jev-1.13", "inception/mercury-decide:free", "perplexity/pplx-decider-v1.1-27b"]) {
      const r = idle();
      const errs = await selectionCatalogErrors({ name: "p", type, model, fetch: r.fetch, now: NOW + 10 * TTL, path, ttlMs: TTL });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain(model);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("an expired cache is read as is and never refreshed", async () => {
    const path = await cachePath();
    const r = idle();
    const errs = await selectionCatalogErrors({ name: "p", type: "paid", model: "typesafe/jev-1.13", fetch: r.fetch, now: NOW + 1e9, path, ttlMs: TTL });
    expect(errs).toHaveLength(1);
    expect(r.calls).toHaveLength(0);
  });

  it("a chat model passes, and a local profile is skipped even with a decisions model", async () => {
    const path = await cachePath();
    const r = idle();
    expect(await selectionCatalogErrors({ name: "p", type: "free", model: "openai/gpt-4o:free", fetch: r.fetch, path })).toEqual([]);
    expect(await selectionCatalogErrors({ name: "p", type: "local", model: "typesafe/jev-1.13", fetch: r.fetch, path })).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it("no cache: the guard is skipped and nothing is fetched", async () => {
    const path = await cachePath(false);
    const r = idle();
    expect(await selectionCatalogErrors({ name: "p", type: "paid", model: "typesafe/jev-1.13", fetch: r.fetch, path })).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });
});

describe("review fixes", () => {
  it.each(["not json", '{"fetchedAtMs":1}', '{"fetchedAtMs":1,"models":"x"}'])("chat profile: a corrupt cache (%s) is skipped like a missing one", async (content) => {
    const path = join(root, `bad${n++}.json`);
    writeFileSync(path, content);
    const r = idle();
    expect(await selectionCatalogErrors({ name: "p", type: "free", model: "typesafe/jev-1.13", fetch: r.fetch, path })).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it("an alias whose target is missing surfaces its own message, not 'not in the decisions catalog (removed)'", async () => {
    const path = join(root, `alias${n++}.json`);
    const alias = { id: "~a/x", canonicalSlug: "~a/x", aliasTarget: "a/gone", contextTokens: null, promptUsdPerM: null, outputModalities: [], systemOne: false };
    writeFileSync(path, JSON.stringify({ fetchedAtMs: NOW, models: [alias] }));
    const errs = await selectionCatalogErrors({ name: "c", type: "classifier", model: "~a/x", fetch: idle().fetch, now: NOW, path, ttlMs: TTL });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("points to a/gone");
    expect(errs[0]).not.toContain("may have been removed");
  });
});

describe("classifier model exists", () => {
  it("the alias resolves through alias_target and passes", async () => {
    const path = await cachePath();
    const r = idle();
    expect(await selectionCatalogErrors({ name: "or-jev", type: "classifier", model: "~typesafe/jev-latest", fetch: r.fetch, now: NOW, path, ttlMs: TTL })).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it("E19: a model removed from the catalog fails naming the model and the model-info Jev filter", async () => {
    const path = await cachePath();
    const errs = await selectionCatalogErrors({ name: "or-jev", type: "classifier", model: "typesafe/jev-0.1-removed", fetch: idle().fetch, now: NOW, path, ttlMs: TTL });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("typesafe/jev-0.1-removed");
    expect(errs[0]).toContain("model-info");
    expect(errs[0]).toContain("Jev filter");
  });

  it("a fresh fetch is used when no cache exists", async () => {
    const path = await cachePath(false);
    const r = replayFetch([fx("models-decisions")]);
    expect(await selectionCatalogErrors({ name: "c", type: "classifier", model: "typesafe/jev-1.13", fetch: r.fetch, now: NOW, path, ttlMs: TTL })).toEqual([]);
    expect(r.calls).toHaveLength(1);
  });

  it("synthetic: expired cache plus a failed refresh is an error, not a silent use of stale data", async () => {
    const path = await cachePath();
    const bad = replayFetch([syntheticResponse(503, "down")]);
    await expect(selectionCatalogErrors({ name: "c", type: "classifier", model: "typesafe/jev-1.13", fetch: bad.fetch, now: NOW + 5 * TTL, path, ttlMs: TTL })).rejects.toThrow(/decisions catalog unavailable/);
  });
});


describe("PF-07: endpoint systemone rule", () => {
  const run = async (model: string, endpoint: DecisionsEndpoint | undefined) => selectionCatalogErrors({ name: "c", type: "classifier", model, endpoint, fetch: idle().fetch, now: NOW, path: await cachePath(), ttlMs: TTL });

  it("a model whose catalog entry declares System One passes", async () => {
    expect(await run("inception/mercury-decide", "systemone")).toEqual([]);
  });

  it("a typesafe/* model passes", async () => {
    expect(await run("typesafe/jev-1.13", "systemone")).toEqual([]);
  });

  it("review 4: the alias ~typesafe/jev-latest is accepted on systemone (judged by its target)", async () => {
    expect(await run("~typesafe/jev-latest", "systemone")).toEqual([]);
  });

  it("review 5: a mistyped endpoint is reported by the schema check settings validate runs, and adds no catalog error", async () => {
    const bad = { "profile-type": "classifier", api: "openrouter-remote", model: "cloudflare/clef", endpoint: "system-one" } as unknown as Profile;
    expect(validateProfile("c", bad).errors.join("\n")).toContain("endpoint must be 'decisions' or 'systemone'");
    expect(await settingsCatalogErrors({ profiles: { c: bad } }, idle().fetch, { now: NOW, path: await cachePath(), ttlMs: TTL })).toEqual([]);
  });

  it("a model that does not declare System One is refused naming the model and the endpoint", async () => {
    const errs = await run("cloudflare/clef", "systemone");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("cloudflare/clef");
    expect(errs[0]).toContain("systemone");
  });

  it("the same model on the default or explicit decisions endpoint passes", async () => {
    expect(await run("cloudflare/clef", undefined)).toEqual([]);
    expect(await run("cloudflare/clef", "decisions")).toEqual([]);
  });


  // WHY a raw catalog served through loadDecisionsCatalog: the System One flag is computed by l0/catalog.ts (toModel), so the cache file cannot be written by hand and the recorded fixture cannot isolate the id rule.
  const rawModel = (id: string, description: string, aliasTarget?: string) => ({ id, canonical_slug: id, description, pricing: { prompt: "0" }, architecture: { output_modalities: ["decisions"] }, ...(aliasTarget ? { alias_target: { slug: aliasTarget } } : {}) });
  const runRaw = async (models: object[], model: string) => {
    const path = join(root, `raw${n++}.json`);
    await loadDecisionsCatalog({ fetch: replayFetch([syntheticResponse(200, JSON.stringify({ data: models }))]).fetch, now: NOW, path, ttlMs: TTL });
    return selectionCatalogErrors({ name: "c", type: "classifier", model, endpoint: "systemone", fetch: idle().fetch, now: NOW, path, ttlMs: TTL });
  };

  it("synthetic: a typesafe/* id is accepted on systemone even when its description never says System One", async () => {
    expect(await runRaw([rawModel("typesafe/plain-x", "A decision model.")], "typesafe/plain-x")).toEqual([]);
    expect(await runRaw([rawModel("other/plain-x", "A decision model.")], "other/plain-x")).toHaveLength(1);
  });

  it("synthetic: an alias is judged by its target, not by its own entry", async () => {
    // The alias entry alone would qualify (description names System One); its resolved target does not.
    const errs = await runRaw([rawModel("vendor/alias", "Served through System One.", "vendor/plain"), rawModel("vendor/plain", "A decision model.")], "vendor/alias");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("vendor/alias");
    // The reverse: a non-qualifying alias entry passes when its target qualifies.
    expect(await runRaw([rawModel("vendor/alias", "A decision model.", "vendor/s1"), rawModel("vendor/s1", "Served through System One.")], "vendor/alias")).toEqual([]);
  });

  it("settings validate reaches the rule through the profile's endpoint field", async () => {
    const profiles = { c: { "profile-type": "classifier", api: "openrouter-remote", model: "cloudflare/clef", endpoint: "systemone" } as unknown as Profile };
    const errs = await settingsCatalogErrors({ profiles }, idle().fetch, { now: NOW, path: await cachePath(), ttlMs: TTL });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("systemone");
  });
});

// PF-04 wiring of PF-02: where the checks run. Real recorded catalog, replay fetch, no network.
describe("wiring: selection and settings validate", () => {
  const chat = (model: string, extra: object = {}): Profile => ({ "profile-type": "free", mode: "remote", api: "openrouter-remote", model, ...extra }) as unknown as Profile;
  const classifier = (model: string): Profile => ({ "profile-type": "classifier", api: "openrouter-remote", model }) as unknown as Profile;
  const TEXT = ["local", "free", "paid"] as const;

  it("selecting a free profile whose model is a cached decisions model is refused, with zero fetches", async () => {
    const path = await cachePath();
    const r = idle();
    const errs = await selectedChatProfileErrors({ profiles: { f: chat("typesafe/jev-1.13") } }, "f", TEXT, r.fetch, { now: NOW, path, ttlMs: TTL });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("typesafe/jev-1.13");
    expect(r.calls).toHaveLength(0);
  });

  it("is skipped for a command that accepts every type, for a type the command does not accept, and for a classifier profile", async () => {
    const path = await cachePath();
    const r = idle();
    const settings = { profiles: { f: chat("typesafe/jev-1.13"), c: classifier("typesafe/jev-0.1-removed") } };
    expect(await selectedChatProfileErrors(settings, "f", ANY_PROFILE_TYPE, r.fetch, { now: NOW, path, ttlMs: TTL })).toEqual([]);
    expect(await selectedChatProfileErrors(settings, "f", ["classifier"], r.fetch, { now: NOW, path, ttlMs: TTL })).toEqual([]);
    // a classifier profile is the classifier resolver's business: the selection guard never fetches for it
    expect(await selectedChatProfileErrors(settings, "c", ["classifier", ...TEXT], r.fetch, { now: NOW, path, ttlMs: TTL })).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it("a chat model passes and a missing cache is skipped, both without a fetch", async () => {
    const r = idle();
    expect(await selectedChatProfileErrors({ profiles: { f: chat("openai/gpt-4o:free") } }, "f", TEXT, r.fetch, { path: await cachePath() })).toEqual([]);
    expect(await selectedChatProfileErrors({ profiles: { f: chat("typesafe/jev-1.13") } }, "f", TEXT, r.fetch, { path: await cachePath(false) })).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it("settings validate: every profile is checked, chat guard and classifier model alike, from a fresh cache without a fetch", async () => {
    const path = await cachePath();
    const r = idle();
    const settings = { profiles: { f: chat("typesafe/jev-1.13"), ok: chat("openai/gpt-4o:free"), gone: classifier("typesafe/jev-0.1-removed"), "or-jev": classifier("~typesafe/jev-latest") } };
    const errs = await settingsCatalogErrors(settings, r.fetch, { now: NOW, path, ttlMs: TTL });
    expect(errs).toHaveLength(2);
    expect(errs.join("\n")).toContain("Profile 'f' (free)");
    expect(errs.join("\n")).toContain("Profile 'gone'");
    expect(r.calls).toHaveLength(0);
  });

  it("settings validate on an expired cache with a failed refresh fails for a classifier profile (E16) instead of using stale data", async () => {
    const path = await cachePath();
    const bad = replayFetch([syntheticResponse(503, "down")]);
    await expect(settingsCatalogErrors({ profiles: { c: classifier("typesafe/jev-1.13") } }, bad.fetch, { now: NOW + 5 * TTL, path, ttlMs: TTL })).rejects.toThrow(/decisions catalog unavailable/);
  });

  it("loading settings never reaches the checks: config.ts does not import them", () => {
    const config = readFileSync(new URL("../config.ts", import.meta.url), "utf-8");
    expect(config).not.toMatch(/profile-checks/);
  });
});
