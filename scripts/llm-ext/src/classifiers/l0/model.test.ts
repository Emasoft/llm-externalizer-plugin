import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDecisionsCatalog } from "./catalog.js";
import { endpointPromptLimit, loadEndpointPromptLimit, resolveModel } from "./model.js";
import { replayFetch, syntheticResponse, type RecordedReply } from "./test-fetch.js";

const fx = (n: string): RecordedReply => JSON.parse(readFileSync(new URL(`../__fixtures__/p02/${n}.json`, import.meta.url), "utf-8"));
const load = () => loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: 1_800_000_000_000, path: join(mkdtempSync("/tmp/llm-ext-l0-model-"), "decisions.json") });

describe("resolveModel", () => {
  it("E17: an alias resolves to its target, whose limits and price apply", async () => {
    const r = resolveModel("~typesafe/jev-latest", await load());
    expect(r.requested.id).toBe("~typesafe/jev-latest");
    expect(r.effective.id).toBe("typesafe/jev-1.13");
    expect(r.effective.promptUsdPerM).toBeCloseTo(0.042, 9);
  });

  it("a pinned model and a dated build resolve to their own entry", async () => {
    const c = await load();
    expect(resolveModel("typesafe/jev-1.13", c).effective.id).toBe("typesafe/jev-1.13");
    expect(resolveModel("typesafe/jev-1.13-20260917", c).effective.id).toBe("typesafe/jev-1.13");
    expect(resolveModel("liquid/d1-20260930", c).effective.id).toBe("liquid/d1");
  });

  it("an unknown model is an error", async () => {
    expect(() => resolveModel("nope/none", [])).toThrow(/unknown decisions model: nope\/none/);
  });

  it("an alias whose target is missing, or is itself an alias, is an error", async () => {
    const c = await load();
    const alias = c.find((m) => m.id === "~typesafe/jev-latest")!;
    expect(() => resolveModel(alias.id, [alias])).toThrow(/not in the decisions catalog/);
    expect(() => resolveModel(alias.id, [alias, { ...alias, id: "typesafe/jev-1.13", canonicalSlug: "typesafe/jev-1.13", aliasTarget: "x/y" }])).toThrow(/another alias/);
  });
});

describe("endpointPromptLimit", () => {
  it("the target endpoint limit (32000) wins over the catalog context (64000)", async () => {
    const target = resolveModel("~typesafe/jev-latest", await load()).effective;
    expect(target.contextTokens).toBe(64000);
    expect(endpointPromptLimit(fx("target-endpoints").body)).toBe(32000);
  });

  it("the alias own endpoints reply has no endpoints: an error", () => {
    expect(() => endpointPromptLimit(fx("alias-endpoints").body)).toThrow(/no endpoint/);
  });

  it("an endpoint without max_prompt_tokens is an error", () => {
    expect(() => endpointPromptLimit(JSON.stringify({ data: { endpoints: [{}] } }))).toThrow(/max_prompt_tokens/);
  });
});

describe("loadEndpointPromptLimit (latency: one cached lookup, never on the hot path twice)", () => {
  const dir = () => join(mkdtempSync("/tmp/llm-ext-l0-endpoint-"), "decisions.json");
  it("fetches once with a short timeout, then serves the cache with zero network calls", async () => {
    const catalogPath = dir();
    const first = replayFetch([fx("target-endpoints")]);
    expect(await loadEndpointPromptLimit({ modelId: "typesafe/jev-1.13", fetch: first.fetch, catalogPath })).toBe(32000);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]!.url).toBe("https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints");
    expect(first.calls[0]!.init.signal).toBeDefined();
    const second = replayFetch([]);
    expect(await loadEndpointPromptLimit({ modelId: "typesafe/jev-1.13", fetch: second.fetch, catalogPath })).toBe(32000);
    expect(second.calls).toHaveLength(0);
  });
  it("synthetic: a failing lookup is undefined (the caller falls back) and is not retried inside the negative window", async () => {
    const catalogPath = dir();
    const down = replayFetch([syntheticResponse(503, "unavailable")]);
    expect(await loadEndpointPromptLimit({ modelId: "typesafe/jev-1.13", fetch: down.fetch, catalogPath })).toBeUndefined();
    const again = replayFetch([]);
    expect(await loadEndpointPromptLimit({ modelId: "typesafe/jev-1.13", fetch: again.fetch, catalogPath })).toBeUndefined();
    expect(again.calls).toHaveLength(0);
  });
  it("each path segment of the id is URL-encoded: a `?` or `#` cannot cut the path or add a query", async () => {
    const f = replayFetch([fx("target-endpoints")]);
    await loadEndpointPromptLimit({ modelId: "vendor/m?x=1#frag", fetch: f.fetch, catalogPath: dir() });
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/models/vendor/m%3Fx%3D1%23frag/endpoints");
  });
  it.each(["a//b", "/a", "a/", "a/./b", "a/../b", ".."])("review 7: the id %j has an empty, '.' or '..' segment: limit unknown (undefined) with NO fetch", async (modelId) => {
    const f = replayFetch([fx("target-endpoints")]);
    expect(await loadEndpointPromptLimit({ modelId, fetch: f.fetch, catalogPath: dir() })).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });
  it("review 7: a raw % in an id is encoded as data (%25), never read as an escape", async () => {
    const f = replayFetch([fx("target-endpoints")]);
    await loadEndpointPromptLimit({ modelId: "vendor/a%2Fb", fetch: f.fetch, catalogPath: dir() });
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/models/vendor/a%252Fb/endpoints");
  });
  it("the cache is per model id", async () => {
    const catalogPath = dir();
    await loadEndpointPromptLimit({ modelId: "typesafe/jev-1.13", fetch: replayFetch([fx("target-endpoints")]).fetch, catalogPath });
    const other = replayFetch([syntheticResponse(503, "x")]);
    expect(await loadEndpointPromptLimit({ modelId: "liquid/d1", fetch: other.fetch, catalogPath })).toBeUndefined();
    expect(other.calls).toHaveLength(1);
  });
});
