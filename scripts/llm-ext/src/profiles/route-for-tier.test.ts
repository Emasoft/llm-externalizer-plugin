// TRDD-SZ7TO9FW plan step W3: routeForTier names the profile whose routes and deps send each chain entry (spec 4.2, 4.5).
// The fixture routesFor answers an unlisted id with the catch-all groups, as config.ts resolveGroups does, so a test
// that expects a throw proves the seam never falls back to the active profile endpoint.
import { describe, expect, it } from "vitest";

import type { ResolvedRoute } from "../config.js";
import type { ChainEntry } from "./resolve-chain.js";
import { routeForTier, type TierProfile, type TierRouteContext } from "./route-for-tier.js";

interface Fixture extends TierProfile {
  groups: ResolvedRoute[];
}

function route(name: string, models: string[], primary: boolean): ResolvedRoute {
  return { name, api: name, protocol: "openai_api", url: `https://${name}.test/v1`, authToken: `key-${name}`, keyRef: `$${name.toUpperCase()}_KEY`, primary, isLocal: false, isFreeProvider: false, models };
}

function profile(name: string, groups: ResolvedRoute[], over: Partial<TierProfile> = {}): Fixture {
  return { name, model: "", secondModel: "", thirdModel: "", freeModels: [], server: null, groups, ...over };
}

/** config.ts semantics: every group listing the id, else the catch-all groups (no `models:`). */
function routesFor(p: Fixture, modelId: string): ResolvedRoute[] {
  const listing = p.groups.filter((g) => g.models.includes(modelId));
  return listing.length > 0 ? listing : p.groups.filter((g) => g.models.length === 0);
}

const paidActive = profile("my-paid", [route("openrouter", [], true)], { model: "anthropic/x" });
const freeProfile = profile("free", [route("openrouter-free", [], true)]);
const paidProfile = profile("paid", [route("openrouter-paid", [], true)]);
const llama = profile("local_llama", [route("llamacpp-local", [], true)], { model: "org/m-GGUF:Q6_K", server: "llama" });
const mlx = profile("locals-mlx", [route("locals-local", [], true), route("ollama", ["mlx/shared"], false)], { model: "mlx/m-4bit", secondModel: "mlx/shared", server: "locals" });

function ctx(over: Partial<TierRouteContext<Fixture>> = {}): TierRouteContext<Fixture> {
  return { active: paidActive, activeCategory: "paid", free: freeProfile, paid: paidProfile, locals: [llama, mlx], routesFor, ...over };
}

const entry = (modelId: string, tier: ChainEntry["tier"]): ChainEntry => ({ modelId, tier });

describe("routeForTier", () => {
  it("sends a pinned entry through the active profile", () => {
    const r = routeForTier(entry("anthropic/x", "pinned"), ctx());
    expect(r.depsProfile).toBe(paidActive);
    expect(r.routes.map((g) => g.name)).toEqual(["openrouter"]);
  });

  it("sends an own-pool entry (tier == active category) through the active profile", () => {
    expect(routeForTier(entry("vendor/p", "paid"), ctx()).depsProfile).toBe(paidActive);
    const freeActive = profile("my-free", [route("b-ai", [], true)]);
    expect(routeForTier(entry("vendor/f:free", "free"), ctx({ active: freeActive, activeCategory: "free" })).depsProfile).toBe(freeActive);
  });

  it("sends a free-tier entry of a paid profile through the free profile, with its routes", () => {
    const r = routeForTier(entry("vendor/f:free", "free"), ctx());
    expect(r.depsProfile).toBe(freeProfile);
    expect(r.routes.map((g) => g.name)).toEqual(["openrouter-free"]);
  });

  it("sends a paid-tier entry of a free profile through the paid profile", () => {
    const freeActive = profile("my-free", [route("b-ai", [], true)]);
    const r = routeForTier(entry("vendor/p", "paid"), ctx({ active: freeActive, activeCategory: "free" }));
    expect(r.depsProfile).toBe(paidProfile);
    expect(r.routes.map((g) => g.name)).toEqual(["openrouter-paid"]);
  });

  it("returns every serving group in group order", () => {
    const twoAccounts = profile("free", [route("acct-1", ["vendor/f:free"], true), route("acct-2", ["vendor/f:free"], false)]);
    const r = routeForTier(entry("vendor/f:free", "free"), ctx({ free: twoAccounts }));
    expect(r.routes.map((g) => g.name)).toEqual(["acct-1", "acct-2"]);
  });

  it("throws, naming tier and model, when the free profile is missing, though the active profile would route it", () => {
    expect(routesFor(paidActive, "vendor/f:free")).toHaveLength(1);
    expect(() => routeForTier(entry("vendor/f:free", "free"), ctx({ free: null }))).toThrow(/free-tier model 'vendor\/f:free'.*no resolved 'free' profile/);
  });

  it("throws, naming tier and model, when the paid profile is missing", () => {
    const freeActive = profile("my-free", [route("b-ai", [], true)]);
    expect(() => routeForTier(entry("vendor/p", "paid"), ctx({ active: freeActive, activeCategory: "free", paid: null }))).toThrow(/paid-tier model 'vendor\/p'.*no resolved 'paid' profile/);
  });

  it("throws when the tier profile serves no route for the model", () => {
    const named = profile("free", [route("acct-1", ["other:free"], true)]);
    expect(() => routeForTier(entry("vendor/f:free", "free"), ctx({ free: named }))).toThrow(/free-tier model 'vendor\/f:free'.*profile 'free' has no route serving it/);
  });

  it("sends a local entry through the managed local profile that lists it, via its broker route", () => {
    const r = routeForTier(entry("org/m-GGUF:Q6_K", "local"), ctx());
    expect(r.depsProfile).toBe(llama);
    expect(r.routes.map((g) => g.name)).toEqual(["llamacpp-local"]);
  });

  it("sends a locals-mlx model to the Locals broker even when local_llama is the active profile", () => {
    const r = routeForTier(entry("mlx/m-4bit", "local"), ctx({ active: llama, activeCategory: "local" }));
    expect(r.depsProfile).toBe(mlx);
    expect(r.routes.map((g) => g.name)).toEqual(["locals-local"]);
  });

  it("prefers the active local profile when it lists the model", () => {
    const llamaToo = profile("my-local", [route("llamacpp-local", [], true)], { freeModels: ["org/m-GGUF:Q6_K"], server: "llama" });
    expect(routeForTier(entry("org/m-GGUF:Q6_K", "local"), ctx({ active: llamaToo, activeCategory: "local" })).depsProfile).toBe(llamaToo);
  });

  it("throws, naming tier and model, when no local profile lists the model", () => {
    expect(() => routeForTier(entry("nobody/lists-this", "local"), ctx())).toThrow(/local-tier model 'nobody\/lists-this'.*no local profile lists it \(checked: my-paid, local_llama, locals-mlx\)/);
  });

  it("throws when the only profile listing a local model is not managed", () => {
    const unmanaged = profile("my-ollama", [route("ollama", [], true)], { model: "qwen:4b" });
    expect(() => routeForTier(entry("qwen:4b", "local"), ctx({ locals: [unmanaged] }))).toThrow(/local-tier model 'qwen:4b'.*'my-ollama' lists it but is not managed/);
  });

  it("throws when the listing profile reaches the model only through a non-broker group", () => {
    expect(() => routeForTier(entry("mlx/shared", "local"), ctx())).toThrow(/local-tier model 'mlx\/shared'.*'locals-mlx' has no broker \(primary\) route/);
  });
});
