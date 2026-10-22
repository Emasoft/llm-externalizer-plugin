// PT-06 (TRDD-W57VQ346, D33, E81e): a field of another type, or unknown to every type, fails the load naming the field and its type.
// Pure functions over plain objects: nothing here touches disk or the network.

import { describe, it, expect } from "vitest";

import { settingsLevelErrors, validateProfile, validateSettings, type Profile, type Settings } from "./config.js";

const paid = (extra: Record<string, unknown> = {}): Profile =>
  ({ "profile-type": "paid", mode: "remote", api: "openrouter-remote", model: "vendor/some-model", api_key: "test-key", ...extra }) as unknown as Profile;

const settingsOf = (active: string, profiles: Record<string, Profile>): Settings => ({ active, profiles }) as unknown as Settings;

describe("PT-06 strict per-type fields", () => {
  it("E81e: free_only in a paid profile fails, naming the field and the type it belongs to", () => {
    const r = validateProfile("mine", paid({ free_only: true }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/Profile 'mine': profiles\.mine\.free_only belongs to type free, not 'paid'/);
  });

  it("a field unknown to every type fails, naming the field", () => {
    const r = validateProfile("mine", paid({ turbo_mode: 1 }));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/profiles\.mine\.turbo_mode is unknown to every profile type/);
  });

  it("a clean typed profile, including the app_name/http_referer attribution fields, still loads", () => {
    const r = validateProfile("mine", paid({ app_name: "x", http_referer: "https://example.com", timeout: 30 }));
    expect(r.errors).toEqual([]);
  });

  it("a profile without profile-type is not checked yet (pre-PT-02 files still load)", () => {
    const { "profile-type": _t, ...untyped } = paid({ turbo_mode: 1 }) as unknown as Record<string, unknown>;
    expect(validateProfile("mine", untyped as unknown as Profile).errors).toEqual([]);
  });

  it("an unselected profile with a foreign field fails the settings load too", () => {
    const s = settingsOf("good", { good: paid(), bad: paid({ free_only: true }) });
    expect(validateSettings(s).errors.join("\n")).toMatch(/Profile 'bad': profiles\.bad\.free_only belongs to type free, not 'paid'/);
    expect(settingsLevelErrors(s).join("\n")).toMatch(/profiles\.bad\.free_only belongs to type free/);
  });

  it("a classifier profile with a chat-only field fails once, naming the field", () => {
    const c = { "profile-type": "classifier", api: "openrouter-remote", model: "~typesafe/jev-latest", api_key: "k", selection: {} } as unknown as Profile;
    const r = validateProfile("c1", c);
    expect(r.errors.filter((e) => e.includes("c1.selection"))).toHaveLength(1);
  });
});
