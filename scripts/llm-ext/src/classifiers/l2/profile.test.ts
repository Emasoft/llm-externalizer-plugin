// L2-17 (TRDD-7BT0W914): classifier profile resolution. Real config.ts schema and PT-03 check, real recorded catalog, replay fetch; no network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { orJevProfile, type Profile } from "../../config.js";
import { loadDecisionsCatalog } from "../l0/catalog.js";
import { replayFetch, type RecordedReply } from "../l0/test-fetch.js";
import { resolveClassifierApiKey, resolveClassifierProfile, selectClassifierProfile, type ClassifierProfileInput } from "./profile.js";

const p = (o: Record<string, unknown>): Profile => o as unknown as Profile;
const free = p({ "profile-type": "free", mode: "remote", api: "openrouter-remote", model: "vendor/m:free", free_only: true, free_models: ["vendor/m:free"] });
const paid = p({ "profile-type": "paid", mode: "remote", api: "openrouter-remote", model: "vendor/paid" });
const scouting = p({ "profile-type": "scouting", mode: "remote", api: "openrouter-remote", model: "vendor/paid" });
const tuned = p({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$MY_KEY", endpoint: "systemone", max_requests_per_call: 3, concurrency: 2, timeout_ms: 5000, max_attempts: 1, context_tokens: 9000, provider: { order: ["x"] }, session_id: "s1", user: "u1", trace: { a: 1 } });
const profiles = { free, paid, scouting, "or-jev": orJevProfile(), tuned };
const input = (o: Partial<ClassifierProfileInput> = {}): ClassifierProfileInput => ({ settings: { active: "free", active_classifier: "or-jev", profiles }, command: "classify", ...o });

describe("resolveClassifierProfile", () => {
  it("resolves active_classifier and applies the plan defaults", () => {
    const r = resolveClassifierProfile(input());
    expect(r).toEqual({
      ok: true,
      profile: {
        name: "or-jev", source: "active_classifier", model: "~typesafe/jev-latest", endpoint: "decisions", apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 60000, maxAttempts: 3,
        limits: { max_requests_per_call: 8, concurrency: 8 }, provider: undefined, sessionId: undefined, user: undefined, trace: undefined,
      },
    });
  });

  it("--profile wins over active_classifier and every tuning field reaches the transport and planner shapes", () => {
    const r = resolveClassifierProfile(input({ profileFlag: "tuned" }));
    expect(r).toEqual({
      ok: true,
      profile: {
        name: "tuned", source: "flag", model: "typesafe/jev-1.13", endpoint: "systemone", apiKeyEnv: "MY_KEY", timeoutMs: 5000, maxAttempts: 1,
        limits: { max_requests_per_call: 3, concurrency: 2, context_tokens: 9000 }, provider: { order: ["x"] }, sessionId: "s1", user: "u1", trace: { a: 1 },
      },
    });
  });

  it("review 4: an `active:` naming a scouting profile does not stop a classifier command (it never reads `active:`)", () => {
    const r = resolveClassifierProfile(input({ settings: { active: "scouting", active_classifier: "or-jev", profiles } }));
    expect(r.ok).toBe(true);
  });

  it("review 5: a literal api_key is refused without echoing it, and no resolved profile can carry one", () => {
    const secret = "sk-or-v1-THISISALITERALSECRET";
    const literal = p({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: secret });
    const r = resolveClassifierProfile(input({ profileFlag: "lit", settings: { active: "free", profiles: { ...profiles, lit: literal } } }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.ok === false && r.error).toContain("environment variable");
    // every accepted shape yields a name, never a value
    for (const name of ["or-jev", "tuned"]) expect(JSON.stringify(resolveClassifierProfile(input({ profileFlag: name })))).not.toContain("sk-");
  });

  it.each([["free"], ["paid"], ["scouting"]])("--profile naming a %s profile is refused naming its type", (name) => {
    const r = resolveClassifierProfile(input({ profileFlag: name }));
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toContain(`does not accept profile '${name}' (type '${name}'); accepted profile types: classifier.`);
  });

  it("active_classifier naming a non-classifier profile is refused naming its type and the setting (the point left open in PF-03)", () => {
    const r = resolveClassifierProfile(input({ settings: { active: "free", active_classifier: "paid", profiles } }));
    expect(r.ok === false && r.error).toContain("does not accept profile 'paid' (type 'paid')");
    expect(r.ok === false && r.error).toContain("selected by 'active_classifier:'");
  });

  it("has no paid gate: allow_paid_models false does not matter to a classifier (D2)", () => {
    const settings = { active: "free", active_classifier: "or-jev", profiles, allow_paid_models: false };
    expect(resolveClassifierProfile(input({ settings })).ok).toBe(true);
  });

  it("asks for a profile when neither --profile nor active_classifier names one, and lists the choices for an unknown name", () => {
    const none = resolveClassifierProfile(input({ settings: { active: "free", profiles } }));
    expect(none.ok === false && none.error).toContain("--profile <name>");
    expect(none.ok === false && none.error).toContain("active_classifier");
    const unknown = resolveClassifierProfile(input({ profileFlag: "nope" }));
    expect(unknown.ok === false && unknown.error).toMatch(/unknown profile 'nope'. Available profiles: .*or-jev/);
  });

  it("a classifier profile that breaks the schema is refused with the schema's own message", () => {
    const bad = p({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", mode: "remote" });
    const r = resolveClassifierProfile(input({ profileFlag: "bad", settings: { active: "free", profiles: { ...profiles, bad } } }));
    expect(r.ok === false && r.error).toContain("Profile 'bad'");
    expect(r.ok === false && r.error).toContain("mode");
  });
});

describe("resolveClassifierApiKey (PF-11, E85)", () => {
  const withEnv = (name: string, value: string | undefined, fn: () => void): void => {
    const before = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { fn(); } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
  };
  const resolved = (flag: string) => {
    const r = resolveClassifierProfile(input({ profileFlag: flag }));
    if (!r.ok) throw new Error(r.error);
    return r.profile;
  };

  it("reads the variable named by the profile's $VAR key at call time", () => {
    withEnv("MY_KEY", "sk-test-value", () => expect(resolveClassifierApiKey(resolved("tuned"))).toBe("sk-test-value"));
  });

  it("E85: an unset variable is an error naming the variable and the profile", () => {
    withEnv("MY_KEY", undefined, () => expect(() => resolveClassifierApiKey(resolved("tuned"))).toThrow(/Profile 'tuned'.*MY_KEY/));
  });

  it.each([["empty", ""], ["spaces", "   "], ["tab and newline", "\t\n"]])("a variable set to %s is refused as not set, never sent", (_label, value) => {
    withEnv("MY_KEY", value, () => expect(() => resolveClassifierApiKey(resolved("tuned"))).toThrow(/MY_KEY.*not set/));
  });

  it("review 3: the unset error names every variable that would have been accepted", () => {
    withEnv("OPENROUTER_API_KEY", undefined, () => withEnv("CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY", undefined, () =>
      expect(() => resolveClassifierApiKey(resolved("or-jev"))).toThrow(/OPENROUTER_API_KEY.*CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY/)));
    withEnv("MY_KEY", undefined, () => expect(() => resolveClassifierApiKey(resolved("tuned"))).not.toThrow(/CLAUDE_PLUGIN_OPTION/));
  });

  it("review 3: the plugin option never supplies a key to a profile naming another variable", () => {
    withEnv("MY_KEY", undefined, () => withEnv("CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY", "sk-plugin", () =>
      expect(() => resolveClassifierApiKey(resolved("tuned"))).toThrow(/MY_KEY.*not set/)));
  });

  it("surrounding whitespace is trimmed from a set key", () => {
    withEnv("MY_KEY", "  sk-test-value\n", () => expect(resolveClassifierApiKey(resolved("tuned"))).toBe("sk-test-value"));
  });

  it("a whitespace-only plugin-option override does not shadow the real variable", () => {
    withEnv("CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY", "  ", () =>
      withEnv("OPENROUTER_API_KEY", "sk-real", () => expect(resolveClassifierApiKey(resolved("or-jev"))).toBe("sk-real")));
  });

  it("the key value appears nowhere in the resolved profile (only the variable name does)", () => {
    withEnv("MY_KEY", "sk-test-value", () => expect(JSON.stringify(resolved("tuned"))).not.toContain("sk-test-value"));
  });
});

describe("selectClassifierProfile: the classifier selection path runs the catalog checks", () => {
  const root = mkdtempSync("/tmp/llm-ext-l217-");
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const NOW = 1_800_000_000_000;
  const TTL = 1000;
  const fx = (n: string): RecordedReply => JSON.parse(readFileSync(new URL(`../__fixtures__/p02/${n}.json`, import.meta.url), "utf-8"));
  let n = 0;
  async function seeded(): Promise<string> {
    const path = join(root, `c${n++}.json`);
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path, ttlMs: TTL });
    return path;
  }

  it("the alias in the or-jev template passes from a fresh cache without a fetch", async () => {
    const idle = replayFetch([]);
    const r = await selectClassifierProfile(input(), idle.fetch, { now: NOW, path: await seeded(), ttlMs: TTL });
    expect(r.ok).toBe(true);
    expect(idle.calls).toHaveLength(0);
  });

  it("E19: a model missing from the catalog is refused naming the model", async () => {
    const gone = p({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-0.1-removed" });
    const r = await selectClassifierProfile(input({ profileFlag: "gone", settings: { active: "free", profiles: { ...profiles, gone } } }), replayFetch([]).fetch, { now: NOW, path: await seeded(), ttlMs: TTL });
    expect(r.ok === false && r.error).toContain("typesafe/jev-0.1-removed");
  });

  it("PF-07: endpoint systemone on a model that does not declare System One is refused at selection", async () => {
    const bad = p({ "profile-type": "classifier", api: "openrouter-remote", model: "cloudflare/clef", endpoint: "systemone" });
    const r = await selectClassifierProfile(input({ profileFlag: "bad", settings: { active: "free", profiles: { ...profiles, bad } } }), replayFetch([]).fetch, { now: NOW, path: await seeded(), ttlMs: TTL });
    expect(r.ok === false && r.error).toContain("cloudflare/clef");
  });

  it("a refused type never reaches the catalog: no fetch", async () => {
    const idle = replayFetch([]);
    const r = await selectClassifierProfile(input({ profileFlag: "paid" }), idle.fetch, { now: NOW, path: await seeded(), ttlMs: TTL });
    expect(r.ok).toBe(false);
    expect(idle.calls).toHaveLength(0);
  });
});
