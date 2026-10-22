// free_models pool writer (P1 zero-token model pipeline).
//
// The pool used to be hand-edited by the operator — every free-pool command ended
// with "now go edit settings.yaml". applyFreePoolToSettings is the scripted writer.
// These tests drive the REAL writer against REAL files in a tmp dir (no fs mocks):
// what we care about is exactly what a mock would hide — that the on-disk YAML is
// correct and that nothing else in it was lost.
//
// P6b-fix B2: the fixture profiles are deliberately NOT named `free`/`paid` any
// more. Those two names are GENERATED sections owned by writeDynamicProfileSection
// (settings write lock + generated marker + backup-before-overwrite), and this
// writer now refuses them outright — see the last test in this file, which is the
// one that pins that refusal.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { applyFreePoolToSettings } from "./pick.js";

const SETTINGS = [
  "active: poolprof",
  "profiles:",
  "  poolprof:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    free_only: true",
  "    free_models:",
  "      - old/one:free",
  "      - old/two:free",
  "    tool_models:",
  "      security_scan: keep/me:free",
  "  otherprof:",
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
    const r = applyFreePoolToSettings(path, "poolprof", ["a/x:free", "b/y:free"]);
    expect(r.oldPool).toEqual(["old/one:free", "old/two:free"]);
    expect(r.newPool).toEqual(["a/x:free", "b/y:free"]);
    expect(read().profiles.poolprof.free_models).toEqual(["a/x:free", "b/y:free"]);
  });

  it("preserves every other key on the profile AND every other profile", () => {
    applyFreePoolToSettings(path, "poolprof", ["a/x:free"]);
    const doc = read();
    expect(doc.profiles.poolprof.mode).toBe("remote-ensemble");
    expect(doc.profiles.poolprof.api_key).toBe("$OPENROUTER_API_KEY");
    expect(doc.profiles.poolprof.free_only).toBe(true);
    expect(doc.profiles.poolprof.tool_models).toEqual({ security_scan: "keep/me:free" });
    expect(doc.profiles.otherprof.model).toBe("vendor/paid");
    expect(doc.active).toBe("poolprof");
  });

  it("collapses duplicates so a re-run is idempotent", () => {
    const r = applyFreePoolToSettings(path, "poolprof", ["a/x:free", "a/x:free", "b/y:free"]);
    expect(r.newPool).toEqual(["a/x:free", "b/y:free"]);
  });

  it("REFUSES a non-':free' id — settings.yaml validation would reject the file we wrote", () => {
    expect(() => applyFreePoolToSettings(path, "poolprof", ["a/x:free", "openrouter/owl-alpha"])).toThrow(
      /MUST end with ':free'.*owl-alpha/s,
    );
    // The refusal must leave the file untouched.
    expect(read().profiles.poolprof.free_models).toEqual(["old/one:free", "old/two:free"]);
  });

  it("REFUSES an empty pool — free_only with no pool is an unusable config", () => {
    expect(() => applyFreePoolToSettings(path, "poolprof", [])).toThrow(/at least one model id/);
    expect(read().profiles.poolprof.free_models).toEqual(["old/one:free", "old/two:free"]);
  });

  it("fails fast on an unknown profile and on a missing file", () => {
    expect(() => applyFreePoolToSettings(path, "nope", ["a/x:free"])).toThrow(/no profile named 'nope'/);
    expect(() => applyFreePoolToSettings(join(dir, "gone.yaml"), "poolprof", ["a/x:free"])).toThrow(
      /not found/,
    );
  });

  it("leaves no .tmp file behind (the write is tmp+rename, not in-place)", () => {
    applyFreePoolToSettings(path, "poolprof", ["a/x:free"]);
    expect(readdirSync(dir)).toEqual(["settings.yaml"]);
  });

  it("seeds free_models on a profile that has none yet", () => {
    const r = applyFreePoolToSettings(path, "otherprof", ["a/x:free"]);
    expect(r.oldPool).toEqual([]);
    expect(read().profiles.otherprof.free_models).toEqual(["a/x:free"]);
  });

  it("P6b-fix B2: REFUSES a DYNAMIC profile name and leaves the file byte-identical — profiles.free/paid have exactly one writer", () => {
    // Both dynamic names, because a guard that covered only `free` would leave
    // the identical hole open on `paid`.
    const DYNAMIC_SETTINGS = [
      "active: free",
      "profiles:",
      "  free:",
      "    mode: remote-ensemble",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models:",
      "      - old/one:free",
      "  paid:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    model: vendor/paid",
      "",
    ].join("\n");
    writeFileSync(path, DYNAMIC_SETTINGS);
    // The refusal is by NAME, before any settings.yaml lookup — 'local' has
    // no section in this fixture, and still refuses (TRDD-C9SXX7HO, D2).
    for (const name of ["free", "paid", "local"]) {
      expect(() => applyFreePoolToSettings(path, name, ["a/x:free"])).toThrow(
        /GENERATED dynamic profile/,
      );
      // Byte-identical, not merely "still parses": the whole point is that no
      // second, lockless engine touched the generated section.
      expect(readFileSync(path, "utf-8")).toBe(DYNAMIC_SETTINGS);
    }
    // The refusal names the command that IS the right tool, so it is not a
    // dead end.
    expect(() => applyFreePoolToSettings(path, "free", ["a/x:free"])).toThrow(
      /--populate-default-profile free/,
    );
  });
});
