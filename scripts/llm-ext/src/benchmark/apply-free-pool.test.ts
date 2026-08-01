// free_models pool writer (P1 zero-token model pipeline).
//
// The pool used to be hand-edited by the operator — every free-pool command ended
// with "now go edit settings.yaml". applyFreePoolToSettings is the scripted writer.
// These tests drive the REAL writer against REAL files in a tmp dir (no fs mocks):
// what we care about is exactly what a mock would hide — that the on-disk YAML is
// correct and that nothing else in it was lost.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { applyFreePoolToSettings } from "./pick.js";

const SETTINGS = [
  "active: free",
  "profiles:",
  "  free:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    free_only: true",
  "    free_models:",
  "      - old/one:free",
  "      - old/two:free",
  "    tool_models:",
  "      security_scan: keep/me:free",
  "  paid:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    model: vendor/paid",
  "",
].join("\n");

describe("applyFreePoolToSettings", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "freepool-"));
    path = join(dir, "settings.yaml");
    writeFileSync(path, SETTINGS);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function read(): Record<string, Record<string, Record<string, unknown>>> {
    return yamlParse(readFileSync(path, "utf-8"));
  }

  it("replaces the pool and reports the old one", () => {
    const r = applyFreePoolToSettings(path, "free", ["a/x:free", "b/y:free"]);
    expect(r.oldPool).toEqual(["old/one:free", "old/two:free"]);
    expect(r.newPool).toEqual(["a/x:free", "b/y:free"]);
    expect(read().profiles.free.free_models).toEqual(["a/x:free", "b/y:free"]);
  });

  it("preserves every other key on the profile AND every other profile", () => {
    applyFreePoolToSettings(path, "free", ["a/x:free"]);
    const doc = read();
    expect(doc.profiles.free.mode).toBe("remote-ensemble");
    expect(doc.profiles.free.api_key).toBe("$OPENROUTER_API_KEY");
    expect(doc.profiles.free.free_only).toBe(true);
    expect(doc.profiles.free.tool_models).toEqual({ security_scan: "keep/me:free" });
    expect(doc.profiles.paid.model).toBe("vendor/paid");
    expect(doc.active).toBe("free");
  });

  it("collapses duplicates so a re-run is idempotent", () => {
    const r = applyFreePoolToSettings(path, "free", ["a/x:free", "a/x:free", "b/y:free"]);
    expect(r.newPool).toEqual(["a/x:free", "b/y:free"]);
  });

  it("REFUSES a non-':free' id — settings.yaml validation would reject the file we wrote", () => {
    expect(() => applyFreePoolToSettings(path, "free", ["a/x:free", "openrouter/owl-alpha"])).toThrow(
      /MUST end with ':free'.*owl-alpha/s,
    );
    // The refusal must leave the file untouched.
    expect(read().profiles.free.free_models).toEqual(["old/one:free", "old/two:free"]);
  });

  it("REFUSES an empty pool — free_only with no pool is an unusable config", () => {
    expect(() => applyFreePoolToSettings(path, "free", [])).toThrow(/at least one model id/);
    expect(read().profiles.free.free_models).toEqual(["old/one:free", "old/two:free"]);
  });

  it("fails fast on an unknown profile and on a missing file", () => {
    expect(() => applyFreePoolToSettings(path, "nope", ["a/x:free"])).toThrow(/no profile named 'nope'/);
    expect(() => applyFreePoolToSettings(join(dir, "gone.yaml"), "free", ["a/x:free"])).toThrow(
      /not found/,
    );
  });

  it("leaves no .tmp file behind (the write is tmp+rename, not in-place)", () => {
    applyFreePoolToSettings(path, "free", ["a/x:free"]);
    expect(readdirSync(dir)).toEqual(["settings.yaml"]);
  });

  it("seeds free_models on a profile that has none yet", () => {
    const r = applyFreePoolToSettings(path, "paid", ["a/x:free"]);
    expect(r.oldPool).toEqual([]);
    expect(read().profiles.paid.free_models).toEqual(["a/x:free"]);
  });
});
