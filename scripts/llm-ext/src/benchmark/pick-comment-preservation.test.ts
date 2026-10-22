// Comment-preservation regression tests for the settings.yaml writers in
// pick.ts. Before this fix every writer round-tripped settings.yaml through a
// PLAIN yamlParse -> mutate object -> yamlStringify pipeline, which silently
// dropped every `#` comment, blank line and anchor on the very first write.
// settings.yaml ships ~100 lines of operator-facing comments, so this is a
// real data-loss bug, not cosmetic. These tests drive each writer against a
// REAL settings.yaml on disk (no fs mocks) and assert every comment survives.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "../test-tmp-root.js";
import { join } from "node:path";

import {
  applyPicksToSettings,
  applyToolModelToSettings,
  applyFreePoolToSettings,
  applyEnsembleSlotToSettings,
  addProfileToSettings,
  writeDynamicProfileSection,
  GENERATED_MARKER,
  type PickedModel,
} from "./pick.js";
import type { Profile } from "../config.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const HEADER_COMMENT = "# top-of-file header comment — must survive every write";
const PROFILES_COMMENT = "# comment directly above the profiles map";

const SETTINGS = [
  HEADER_COMMENT,
  "active: prod",
  "",
  PROFILES_COMMENT,
  "profiles:",
  "  prod:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    model: vendor/one # inline trailing comment on the model key",
  "    second_model: vendor/two",
  "    third_model: vendor/three",
  "    api_key: $OPENROUTER_API_KEY",
  "    free_models:",
  "      - old/pool:free",
  "    tool_models:",
  "      security_scan: keep/me",
  "  sibling:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    model: sibling/untouched",
  "    api_key: $OPENROUTER_API_KEY",
  "",
].join("\n");

function pick(modelId: string): PickedModel {
  return {
    modelId,
    meanF1: 0.99,
    actualCost: 0.001,
    latencyMs: 500,
    inputDollarsPerMillion: 0.1,
    outputDollarsPerMillion: 0.1,
  };
}

describe("settings.yaml writers preserve comments (Document API round-trip)", () => {
  let dir = "";
  let path = "";
  let siblingBefore = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pick-comment-preservation-"));
    path = join(dir, "settings.yaml");
    writeFileSync(path, SETTINGS, "utf-8");
    siblingBefore = extractSiblingBlock(SETTINGS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function extractSiblingBlock(content: string): string {
    const lines = content.split("\n");
    const start = lines.findIndex((l) => l.trim() === "sibling:");
    // Bounded to the sibling profile's own lines (2-space indent under it) so
    // a writer that APPENDS a new top-level profile after `sibling` (e.g.
    // addProfileToSettings) doesn't get swept into "what must stay unchanged".
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].length > 0 && !lines[i].startsWith("    ")) {
        end = i;
        break;
      }
    }
    // trimEnd so a trailing blank line difference (present in the source
    // fixture, absent after a re-serialize) doesn't fail an otherwise-identical
    // comparison.
    return lines.slice(start, end).join("\n").trimEnd();
  }

  function assertCommentsAndSiblingSurvive(): void {
    const after = readFileSync(path, "utf-8");
    expect(after).toContain(HEADER_COMMENT);
    expect(after).toContain(PROFILES_COMMENT);
    expect(after).toContain("# inline trailing comment on the model key");
    expect(extractSiblingBlock(after)).toBe(siblingBefore);
  }

  it("applyPicksToSettings changes the ensemble slots and keeps every comment + the sibling profile intact", () => {
    applyPicksToSettings(path, "prod", [pick("new/one"), pick("new/two")]);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("model: new/one");
    expect(after).toContain("second_model: new/two");
    expect(after).not.toContain("third_model:");
    assertCommentsAndSiblingSurvive();
  });

  it("applyToolModelToSettings changes tool_models[tool] and keeps every comment + the sibling profile intact", () => {
    applyToolModelToSettings(path, "prod", "security_scan", "new/triage");
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("security_scan: new/triage");
    assertCommentsAndSiblingSurvive();
  });

  it("applyFreePoolToSettings replaces free_models and keeps every comment + the sibling profile intact", () => {
    applyFreePoolToSettings(path, "prod", ["fresh/one:free", "fresh/two:free"]);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("fresh/one:free");
    expect(after).toContain("fresh/two:free");
    expect(after).not.toContain("old/pool:free");
    assertCommentsAndSiblingSurvive();
  });

  it("applyEnsembleSlotToSettings sets one slot and keeps every comment + the sibling profile intact", () => {
    applyEnsembleSlotToSettings(path, "prod", "third_model", "new/three");
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("third_model: new/three");
    assertCommentsAndSiblingSurvive();
  });

  it("addProfileToSettings adds a new profile and keeps every comment + the sibling profile intact", () => {
    addProfileToSettings(path, "brand-new", { mode: "remote", api: "openrouter-remote", model: "x/y" });
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("brand-new:");
    expect(after).toContain("model: x/y");
    assertCommentsAndSiblingSurvive();
  });
});

// ── writeDynamicProfileSection (design §2.6, P5) ─────────────────────────────
//
// The generated-section writer for the dynamic `free`/`paid` profiles: marker
// placement, migration-safety backup of a pre-existing unmarked section, the
// no-write-when-identical fast path, and the settings.write.lock it takes.

describe("writeDynamicProfileSection", () => {
  let cfg = "";
  let dynPath = "";
  let prevCfgDir: string | undefined;

  const DYN_HEADER = "# header comment above everything";
  const OTHER_PROFILE_COMMENT = "# comment on the untouched sibling profile";
  const DYN_SETTINGS = [
    DYN_HEADER,
    "active: sibling",
    "profiles:",
    OTHER_PROFILE_COMMENT,
    "  sibling:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    model: sibling/untouched",
    "    api_key: $OPENROUTER_API_KEY",
    "  free:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    model: hand/authored",
    "    api_key: $OPENROUTER_API_KEY",
    "    free_only: true",
    "",
  ].join("\n");

  // P6b-fix2 S-9: the writer takes the caller's decision as
  // `(currentSection) => nextSection` and applies it UNDER its own lock, so a
  // caller can no longer write a document it parsed before waiting for that
  // lock. These cases replace the section wholesale, so they ignore the
  // argument — exactly what the benchmark child does.
  const nextProfile: Profile = {
    mode: "remote-ensemble",
    api: "openrouter-remote",
    api_key: "$OPENROUTER_API_KEY",
    free_only: true,
    model: "v/alpha:free",
    free_models: ["v/alpha:free"],
    tool_models: {},
  };

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "write-dynamic-profile-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    dynPath = join(cfg, "settings.yaml");
    writeFileSync(dynPath, DYN_SETTINGS, "utf-8");
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("marks the section with GENERATED_MARKER and leaves every other section/comment byte-identical", () => {
    const notify = vi.fn();
    const result = writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify });
    expect(result.changed).toBe(true);
    const after = readFileSync(dynPath, "utf-8");
    expect(after).toContain(GENERATED_MARKER);
    expect(after).toContain(DYN_HEADER);
    expect(after).toContain(OTHER_PROFILE_COMMENT);
    expect(after).toContain("sibling/untouched");
    expect(after).toContain("model: v/alpha:free");
  });

  it("a BRAND NEW key (no prior 'free:'/'paid:' section at all) gets the marker comment directly above it (P6b item 0, TRDD-90DM5YHO)", () => {
    // Reproduces the real first-run shape: a settings.yaml with only static
    // profiles, no `free:`/`paid:` section whatsoever — the case
    // overrideActiveProfile hits on every fresh install. Every other test in
    // this file pre-seeds an EXISTING (unmarked) 'free:' section, which
    // exercises a different code path in the yaml library (setIn on an
    // EXISTING key keeps it as a Scalar node) — a brand new key is stored as
    // a raw JS string by setIn, which is exactly the case that silently lost
    // the marker before the fix in writeDynamicProfileSection.
    const noSectionYaml = [
      "active: sibling",
      "profiles:",
      "  sibling:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    model: sibling/untouched",
      "    api_key: $OPENROUTER_API_KEY",
      "",
    ].join("\n");
    writeFileSync(dynPath, noSectionYaml, "utf-8");

    for (const name of ["free", "paid", "local"] as const) {
      const result = writeDynamicProfileSection(dynPath, name, () => nextProfile, { notify: vi.fn() });
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBeNull(); // nothing existed to back up
    }
    const after = readFileSync(dynPath, "utf-8");
    const lines = after.split("\n");
    for (const name of ["free", "paid", "local"]) {
      const keyLineIdx = lines.findIndex((l) => l.trim() === `${name}:`);
      expect(keyLineIdx).toBeGreaterThan(-1);
      // The EXACT rendered comment line immediately precedes the key —
      // "contains GENERATED_MARKER somewhere in the file" is not enough
      // (P6a's own gap: that weaker assertion passed while the real CLI
      // output carried no comment at all).
      expect(lines[keyLineIdx - 1].trim()).toBe(`# ${GENERATED_MARKER}`);
    }
  });

  it("backs up the whole settings file before overwriting an existing UNMARKED section, and notifies", () => {
    const notify = vi.fn();
    const result = writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify });
    expect(result.backupPath).not.toBeNull();
    const backedUp = readFileSync(result.backupPath as string, "utf-8");
    // The backup is the settings file AS IT WAS before this write — it must
    // still carry the hand-authored model, not the new one.
    expect(backedUp).toContain("model: hand/authored");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/is now generated by llm-ext/);
  });

  it("a failed backup aborts the write — the section is left untouched", () => {
    // Put a plain FILE where `backups/` must be a directory: writeDynamicProfileSection's
    // own `mkdirSync(backupsDir, { recursive: true })` then throws ENOTDIR, so the
    // backup — and therefore the whole write — never happens.
    const backupsPath = join(cfg, "backups");
    writeFileSync(backupsPath, "not a directory", "utf-8");
    const before = readFileSync(dynPath, "utf-8");
    expect(() => writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify: vi.fn() })).toThrow(
      /backing it up first failed/,
    );
    expect(readFileSync(dynPath, "utf-8")).toBe(before);
  });

  it("re-running with the SAME profile after a hand edit inside a marked section regenerates it (no merge)", () => {
    writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify: vi.fn() });
    // Hand-edit the now-marked section directly on disk.
    const handEdited = readFileSync(dynPath, "utf-8").replace("v/alpha:free", "v/HAND-EDITED:free");
    writeFileSync(dynPath, handEdited, "utf-8");
    expect(readFileSync(dynPath, "utf-8")).toContain("v/HAND-EDITED:free");

    const result = writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify: vi.fn() });
    expect(result.changed).toBe(true);
    const after = readFileSync(dynPath, "utf-8");
    expect(after).toContain("model: v/alpha:free");
    expect(after).not.toContain("v/HAND-EDITED:free");
  });

  it("an identical write is a no-op — file mtime is unchanged and nothing is backed up", () => {
    writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify: vi.fn() });
    const mtimeBefore = statSync(dynPath).mtimeMs;
    const result = writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify: vi.fn() });
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(statSync(dynPath).mtimeMs).toBe(mtimeBefore);
  });

  it("a STALE settings.write.lock (older than the 30s TTL) is cleared and the write proceeds — never wedges forever", () => {
    const lockDir = join(cfg, "settings.write.lock");
    mkdirSync(lockDir);
    // Back-date the lock past the staleness TTL so withSettingsWriteLock's
    // mkdir spin-lock clears it on its very first retry instead of spinning
    // for the full wait window (pick.ts's SETTINGS_WRITE_LOCK_STALE_MS).
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const result = writeDynamicProfileSection(dynPath, "free", () => nextProfile, { notify: vi.fn() });
    expect(result.changed).toBe(true);
  });

  it("writing 'free' three times, each write re-parsing settings.yaml from disk, when 'free' is the FIRST key under profiles: leaves exactly one marker line (row 69, TRDD-90DM5YHO)", () => {
    // Real settings.yaml always has `free` first under `profiles:` — unlike
    // every other case in this file, where `sibling`/`prod` comes first. The
    // yaml library attaches a leading comment on the FIRST map key to the MAP
    // node, not to the key (that's why profileSectionMarkerState has a
    // map-level fallback for index 0). writeDynamicProfileSection stamps the
    // marker on the KEY without clearing a stale copy left on the MAP by the
    // previous write's own round trip through disk, so each write adds one
    // more marker line instead of replacing the one that's already there.
    const freeFirstYaml = [
      "active: free",
      "profiles:",
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    model: hand/authored",
      "    api_key: $OPENROUTER_API_KEY",
      "  sibling:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    model: sibling/untouched",
      "    api_key: $OPENROUTER_API_KEY",
      "",
    ].join("\n");
    writeFileSync(dynPath, freeFirstYaml, "utf-8");

    for (let i = 0; i < 3; i++) {
      const round: Profile = { ...nextProfile, model: `v/round-${i}:free`, free_models: [`v/round-${i}:free`] };
      const result = writeDynamicProfileSection(dynPath, "free", () => round, { notify: vi.fn() });
      expect(result.changed).toBe(true);
    }
    const after = readFileSync(dynPath, "utf-8");
    const markerLines = after.split("\n").filter((l) => l.trim() === `# ${GENERATED_MARKER}`);
    expect(markerLines).toHaveLength(1);
    expect(after).toContain("v/round-2:free");
  });
});

// ── D0 (TRDD-AL8GIZYA): the ownership boundary's per-key GENERATED merge ────
//
// writeDynamicProfileSection now writes/deletes GENERATED keys ONE AT A TIME
// instead of replacing the whole section — a user's `selection` node (byte
// for byte: comments, key order) must survive both calling shapes design
// section 3.2 rule 2 names: the benchmark child's full-replacement `() =>
// next`, and a maintainer-style patch that spreads `currentSection` (and so
// technically carries the user key along in its return value too — the
// writer must still ignore it, since only GENERATED keys are ever read out).

describe("D0: writeDynamicProfileSection preserves a user-owned `selection` block byte for byte", () => {
  let cfg = "";
  let dynPath = "";
  let prevCfgDir: string | undefined;

  const USER_COMMENT = "# my custom ceiling — llm-ext must never touch this node";
  const SEEDED = [
    "active: paid",
    "profiles:",
    `  # ${GENERATED_MARKER}`,
    "  paid:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    model: vendor/old",
    "    api_key: $OPENROUTER_API_KEY",
    USER_COMMENT,
    "    selection:",
    "      price_ceiling_usd_per_million: 0.75",
    "",
  ].join("\n");

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "write-dynamic-user-keys-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    dynPath = join(cfg, "settings.yaml");
    writeFileSync(dynPath, SEEDED, "utf-8");
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("the benchmark child's full-replacement () => next (design section 3.2 rule 2) never touches the user's selection block or its comment", () => {
    const childNext: Profile = {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/new",
      api_key: "$OPENROUTER_API_KEY",
    };
    const result = writeDynamicProfileSection(dynPath, "paid", () => childNext, { notify: vi.fn() });
    expect(result.changed).toBe(true);
    const after = readFileSync(dynPath, "utf-8");
    expect(after).toContain("model: vendor/new");
    expect(after).toContain(USER_COMMENT);
    expect(after).toContain("    selection:");
    expect(after).toContain("      price_ceiling_usd_per_million: 0.75");
  });

  it("a maintainer-style merge patch that spreads currentSection (so its return value carries `selection` too) still leaves the user's node untouched — the writer reads only GENERATED keys out of it", () => {
    const result = writeDynamicProfileSection(
      dynPath,
      "paid",
      (current) => ({ ...(current as Profile), model: "vendor/merged" }),
      { notify: vi.fn() },
    );
    expect(result.changed).toBe(true);
    const after = readFileSync(dynPath, "utf-8");
    expect(after).toContain("model: vendor/merged");
    expect(after).toContain(USER_COMMENT);
    expect(after).toContain("      price_ceiling_usd_per_million: 0.75");
  });

  it("a GENERATED key the patch drops is deleted individually — the user's selection block stays exactly where it was", () => {
    // second_model was never set on this fixture; add it first so there is
    // something to observe being removed again.
    writeDynamicProfileSection(
      dynPath,
      "paid",
      (current) => ({ ...(current as Profile), second_model: "vendor/second" }),
      { notify: vi.fn() },
    );
    expect(readFileSync(dynPath, "utf-8")).toContain("second_model: vendor/second");

    const result = writeDynamicProfileSection(
      dynPath,
      "paid",
      (current) => {
        const { second_model: _drop, ...rest } = current as Profile;
        return rest;
      },
      { notify: vi.fn() },
    );
    expect(result.changed).toBe(true);
    const after = readFileSync(dynPath, "utf-8");
    expect(after).not.toContain("second_model:");
    expect(after).toContain(USER_COMMENT);
    expect(after).toContain("      price_ceiling_usd_per_million: 0.75");
  });
});
