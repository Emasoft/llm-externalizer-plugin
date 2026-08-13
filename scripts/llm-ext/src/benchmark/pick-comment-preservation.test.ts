// Comment-preservation regression tests for the settings.yaml writers in
// pick.ts. Before this fix every writer round-tripped settings.yaml through a
// PLAIN yamlParse -> mutate object -> yamlStringify pipeline, which silently
// dropped every `#` comment, blank line and anchor on the very first write.
// settings.yaml ships ~100 lines of operator-facing comments, so this is a
// real data-loss bug, not cosmetic. These tests drive each writer against a
// REAL settings.yaml on disk (no fs mocks) and assert every comment survives.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPicksToSettings,
  applyToolModelToSettings,
  applyFreePoolToSettings,
  applyEnsembleSlotToSettings,
  addProfileToSettings,
  type PickedModel,
} from "./pick.js";

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
