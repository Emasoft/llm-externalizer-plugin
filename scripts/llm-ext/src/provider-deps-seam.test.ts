/**
 * provider-deps-seam.test.ts: TRDD-78LZFUVJ. makeProviderDeps(profile, backend) reads the profile and backend it was made
 * for, and the boot providerDeps stays the same field list over the ACTIVE profile read at call time (a profile swap by
 * overrideActiveProfile is seen). Real index.ts module booted from a real settings.yaml in an llm-ext-* temp config dir
 * (the route-headers.test.ts recipe); the other profile is a real resolveProfile result; no mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveProfile, type Profile, type ResolvedRoute } from "./config.js";
import type { BackendConfig } from "./provider/types.js";
import { writeRecord } from "./calibration/record.js";
import { recordFixture } from "./calibration/test-record.js";

let cfgDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  cfgDir = undefined;
});

const SETTINGS_YAML = `active: first
allow_paid_models: true
profiles:
  first:
    mode: remote
    api: openrouter-remote
    model: vendor/first
    api_key: first-key
    http_referer: https://first.test/referer
    app_name: FirstApp
    timeout: 111
    context_window: 11111
  second:
    mode: remote
    api: openrouter-remote
    model: vendor/second
    api_key: second-key
    http_referer: https://second.test/referer
    app_name: SecondApp
    timeout: 222
    context_window: 22222
`;

/** A profile the module never selected: a free-only LM Studio one, different from both settings.yaml profiles in every field the deps read. */
const OTHER: Profile = {
  mode: "remote",
  api: "lmstudio-local",
  model: "vendor/other",
  api_key: "other-key",
  free_only: true,
  free_models: ["vendor/other:free"],
  timeout: 333,
  context_window: 33333,
};

function backendFor(model: string, apiKey: string): BackendConfig {
  return { type: "openrouter", billable: true, isLocal: false, baseUrl: `https://${model}.test`, apiKey, model, __version: 1 };
}

const ROUTE: ResolvedRoute = {
  name: "openrouter-remote",
  api: "openrouter-remote",
  protocol: "openrouter_api",
  url: "https://openrouter.ai/api",
  authToken: "route-key",
  primary: false,
} as ResolvedRoute;

async function loadFreshIndex() {
  cfgDir = mkdtempSync(join("/tmp", "llm-ext-provider-deps-seam-"));
  writeFileSync(join(cfgDir, "settings.yaml"), SETTINGS_YAML, "utf-8");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  return import("./index.js");
}

describe("makeProviderDeps over a profile other than the active one", () => {
  it("reads THAT profile and backend for every field that can be checked without a send", async () => {
    const index = await loadFreshIndex();
    const other = resolveProfile("other", OTHER);
    const backend = backendFor("other", "other-key");
    const deps = index.makeProviderDeps(other, backend);
    const boot = index.__providerDepsForTests();

    expect(deps.getBackend()).toBe(backend);
    expect(deps.getSoftTimeoutMs()).toBe(333_000);
    expect(boot.getSoftTimeoutMs()).toBe(111_000);
    expect(deps.isFreeOnly()).toBe(true);
    expect(boot.isFreeOnly()).toBe(false);
    expect(deps.isLMStudioProvider()).toBe(true);
    expect(boot.isLMStudioProvider()).toBe(false);
    expect(deps.getActiveProtocol()).toBe("lmstudio_api");
    expect(boot.getActiveProtocol()).toBe("openrouter_api");
    expect(deps.getDefaultMaxTokens()).toBe(33_333);
    expect(boot.getDefaultMaxTokens()).toBe(11_111);
    expect(deps.routeForModel("vendor/other")).toEqual(other.routeForModel("vendor/other"));
    expect(deps.routeForModel("vendor/first")).toEqual(other.routeForModel("vendor/first"));
    expect(deps.isManualModel("vendor/other")).toBe(false);
    expect(deps.getRequestOptions("chat")).toBeNull();
// The thinking switch is one field of the one list: both objects carry it, and a remote route gets nothing (TRDD-1OOAH3LD gap C1-7).
    expect(typeof boot.getLocalThinking).toBe("function");
expect(typeof deps.getLocalThinking).toBe("function");
    expect(deps.getLocalThinking?.("chat", "vendor/other", other.routeForModel("vendor/other"))).toBeUndefined();
  });

it("a per-walk object over a calibrated local profile carries the per-model thinking switch (the local fallback uses it, TRDD-1OOAH3LD gap C1-7)", async () => {
    const index = await loadFreshIndex();
    // The fallback target is resolveProfile of a local profile (index.ts localFallbackTarget): its head route is its primary group, so resolveConnection never takes the routed branch.
    const local = resolveProfile("loc", { mode: "local", api: "llamacpp-local", url: "http://127.0.0.1:9", model: "m-loc" } as Profile);
    writeRecord(cfgDir as string, { ...recordFixture("llama", "m-loc"), thinking_works: { off: true, on: true } });
    const deps = index.makeProviderDeps(local, backendFor("m-loc", ""), { noHold: true });
    const route = local.routeForModel("m-loc");
    expect(route?.primary).toBe(true);
    expect(deps.getLocalThinking?.("chat", "m-loc", route)).toBe(false);
    expect(deps.getLocalThinking?.("code_task", "m-loc", route)).toBe(true);
    expect(deps.getLocalThinking?.("code_task", "m-unrecorded", route)).toBeUndefined();
  });
  it("builds its headers from that profile's attribution and that backend's key, not the active ones", async () => {
    const index = await loadFreshIndex();
    const withAttribution = resolveProfile("attributed", { ...OTHER, api: "openrouter-remote", free_only: false, http_referer: "https://other.test/referer", app_name: "OtherApp" });
    const deps = index.makeProviderDeps(withAttribution, backendFor("other", "other-key"));
    const boot = index.__providerDepsForTests();

    expect(deps.apiHeaders()).toEqual({ "Content-Type": "application/json", Authorization: "Bearer other-key", "HTTP-Referer": "https://other.test/referer", "X-Title": "OtherApp" });
    expect(deps.routeHeaders(ROUTE)).toEqual({ "Content-Type": "application/json", Authorization: "Bearer route-key", "HTTP-Referer": "https://other.test/referer", "X-Title": "OtherApp" });
    expect(boot.routeHeaders(ROUTE)["HTTP-Referer"]).toBe("https://first.test/referer");
  });

  it("localBroker answers null for a profile that starts no server and for a route that is not its primary one", async () => {
    const index = await loadFreshIndex();
    const deps = index.makeProviderDeps(resolveProfile("other", OTHER), backendFor("other", "other-key"));
    expect(await deps.localBroker?.({ model: "vendor/other", route: null })).toBeNull();
    expect(await deps.localBroker?.({ model: "vendor/other", route: ROUTE })).toBeNull();
  });

  it("a null profile gets the same defaults the boot object has with no active profile", async () => {
    const index = await loadFreshIndex();
    const deps = index.makeProviderDeps(null, backendFor("none", ""));
    expect(deps.getSoftTimeoutMs()).toBe(300_000);
    expect(deps.isFreeOnly()).toBe(false);
    expect(deps.getActiveProtocol()).toBe("openai_api");
    expect(deps.routeForModel("vendor/x")).toBeNull();
    expect(deps.getDefaultMaxTokens()).toBe(100_000);
  });
});

describe("the boot providerDeps", () => {
  it("equals makeProviderDeps over the active profile, and keeps equalling it after overrideActiveProfile swaps the profile", async () => {
    const index = await loadFreshIndex();
    const boot = index.__providerDepsForTests();
    const settings = () => index.getActiveSettings().profiles;
    const compare = (name: string, expectedTimeoutMs: number, expectedCtx: number, referer: string) => {
      const same = index.makeProviderDeps(resolveProfile(name, settings()[name]), boot.getBackend());
      expect(boot.getSoftTimeoutMs()).toBe(expectedTimeoutMs);
      expect(boot.getSoftTimeoutMs()).toBe(same.getSoftTimeoutMs());
      expect(boot.getDefaultMaxTokens()).toBe(expectedCtx);
      expect(boot.getDefaultMaxTokens()).toBe(same.getDefaultMaxTokens());
      expect(boot.apiHeaders()).toEqual(same.apiHeaders());
      expect(boot.apiHeaders()["HTTP-Referer"]).toBe(referer);
      expect(boot.routeHeaders(ROUTE)).toEqual(same.routeHeaders(ROUTE));
      expect(boot.getActiveProtocol()).toBe(same.getActiveProtocol());
      expect(boot.isFreeOnly()).toBe(same.isFreeOnly());
      expect(boot.isLMStudioProvider()).toBe(same.isLMStudioProvider());
      expect(boot.getBackend().apiKey).toBe(`${name}-key`);
    };
    compare("first", 111_000, 11_111, "https://first.test/referer");
    const firstBackend = boot.getBackend();

    expect(index.overrideActiveProfile("second", "flag")).toEqual({ ok: true });
    // The object built at module init sees the swap: every field reads the module state at call time.
    expect(boot.getBackend()).not.toBe(firstBackend);
    compare("second", 222_000, 22_222, "https://second.test/referer");
  });
});
