// PF-01 (TRDD-82LIQI5I): classifier-type profile schema (plan section 8), E84, and the D2 spend gate.
// Pure functions over plain objects: no disk, no network.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  CLASSIFIER_DEFAULTS,
  resolveProfile,
  shouldForceFreeMode,
  validateClassifierProfile,
  validateProfile,
  type Profile,
} from "./config.js";

const classifier = (extra: Record<string, unknown> = {}): Profile =>
  ({ "profile-type": "classifier", api: "openrouter-remote", api_key: "$OPENROUTER_API_KEY", model: "~typesafe/jev-latest", ...extra }) as unknown as Profile;

describe("classifier schema (section 8)", () => {
  it("a minimal classifier profile with no mode is valid", () => {
    expect(validateProfile("or-jev", classifier())).toEqual({ valid: true, errors: [] });
  });
  it("accepts every classifier field", () => {
    const p = classifier({ endpoint: "systemone", max_requests_per_call: 4, concurrency: 2, timeout_ms: 1000, max_attempts: 1, context_tokens: 32000, provider: { order: ["x"] }, session_id: "s", user: "u", trace: { custom: 1 } });
    expect(validateClassifierProfile("or-jev", p)).toEqual([]);
  });
  it("E84: an unknown key fails at load, naming it", () => {
    const errors = validateProfile("or-jev", classifier({ bogus: 1 })).errors;
    expect(errors.join("\n")).toMatch(/bogus is unknown to every profile type/);
  });
  it("a field of another type fails naming the type, and there is no allow_paid field (D2)", () => {
    expect(validateClassifierProfile("or-jev", classifier({ free_only: true })).join("\n")).toMatch(/free_only belongs to type free/);
    expect(validateClassifierProfile("or-jev", classifier({ allow_paid: true })).join("\n")).toMatch(/allow_paid is unknown/);
  });
  it("rejects a wrong api, bad endpoint, non-integer limits and over-long session_id", () => {
    const e = validateClassifierProfile("or-jev", classifier({ api: "openrouter", endpoint: "x", concurrency: 0, timeout_ms: 1.5, session_id: "a".repeat(257), trace: [] })).join("\n");
    expect(e).toMatch(/api: openrouter-remote/);
    expect(e).toMatch(/endpoint must be/);
    expect(e).toMatch(/concurrency must be a positive integer/);
    expect(e).toMatch(/timeout_ms must be a positive integer/);
    expect(e).toMatch(/session_id must be a string of 1 to 256/);
    expect(e).toMatch(/trace must be a mapping/);
  });
  it("PF-08: provider accepts only OpenRouter ProviderPreferences keys, naming the offender", () => {
    expect(validateClassifierProfile("or-jev", classifier({ provider: { order: ["a"], allow_fallbacks: false, data_collection: "deny" } }))).toEqual([]);
    const e = validateClassifierProfile("or-jev", classifier({ provider: { order: ["a"], allow_fallback: false } })).join("\n");
    expect(e).toMatch(/provider\.allow_fallback is not an OpenRouter provider preference/);
    expect(e).not.toMatch(/provider\.order/);
  });
  it("PF-08: session_id and user are valid at 256 characters and refused at 257", () => {
    expect(validateClassifierProfile("or-jev", classifier({ session_id: "a".repeat(256), user: "u".repeat(256) }))).toEqual([]);
    const e = validateClassifierProfile("or-jev", classifier({ user: "u".repeat(257) })).join("\n");
    expect(e).toMatch(/user must be a string of 1 to 256/);
  });
  it("PF-08: trace takes known keys as strings and any custom key", () => {
    expect(validateClassifierProfile("or-jev", classifier({ trace: { trace_id: "t", generation_name: "g", my_custom: { a: 1 } } }))).toEqual([]);
    expect(validateClassifierProfile("or-jev", classifier({ trace: { trace_id: 5 } })).join("\n")).toMatch(/trace\.trace_id must be a string/);
  });
  it("defaults are those of section 8", () => {
    expect(CLASSIFIER_DEFAULTS).toEqual({ endpoint: "decisions", max_requests_per_call: 8, concurrency: 8, timeout_ms: 60000, max_attempts: 3 });
  });
});

/** Non-test .ts files under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__fixtures__" ? [] : sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".testkit.ts") ? [p] : [];
  });
}

describe("classifier spend gate (D2)", () => {
  // PF-09. WHY a source scan: the absence of a gate is a property of every classify and browse code path, and a path added later is covered only if the test walks the directories. Comment lines may mention the switch (they say it does NOT apply).
  it("PF-09: no classify or browse code path consults allow_paid_models", () => {
    const dirs = [new URL("./classifiers", import.meta.url), new URL("./browse", import.meta.url)].map((u) => u.pathname).filter((d) => existsSync(d));
    expect(dirs.length).toBeGreaterThan(0);
    const gate = /allow_paid_models|allowPaidModels|AllowPaidModels|paid-switch|shouldForceFreeMode|isPaidGatedProfileType/;
    const offenders = dirs.flatMap(sourceFiles).filter((f) =>
      readFileSync(f, "utf-8").split("\n").some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && gate.test(l)),
    );
    expect(offenders).toEqual([]);
  });

  it("a real classifier profile (no mode) is not gated by allow_paid_models", () => {
    const resolved = resolveProfile("or-jev", classifier());
    expect(resolved.profileType).toBe("classifier");
    expect(shouldForceFreeMode(false, resolved.mode ?? null, resolved.profileType)).toBe(false);
    expect(shouldForceFreeMode(false, resolved.mode, resolved.profileType)).toBe(false);
  });
  it("a chat profile relabelled classifier fails the load and stays gated", () => {
    const relabelled = classifier({ mode: "remote" });
    expect(validateProfile("mine", relabelled).errors.join("\n")).toMatch(/mode belongs to type/);
    expect(shouldForceFreeMode(false, "remote", "classifier")).toBe(true);
    expect(shouldForceFreeMode(true, "remote", "classifier")).toBe(false);
  });
});
