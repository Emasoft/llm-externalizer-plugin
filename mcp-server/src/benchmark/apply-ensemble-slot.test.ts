// New-arrival adoption writer (P1 zero-token model pipeline).
//
// `--new-arrivals` used to end with "if it wins, edit ~/.llm-externalizer/settings.yaml
// by hand" — a manual step the agent narrated on every run. applyEnsembleSlotToSettings
// is the scripted half. Real writer, real files, real YAML round-trip.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { applyEnsembleSlotToSettings, ENSEMBLE_SLOTS } from "./pick.js";

const SETTINGS = [
  "active: ens",
  "profiles:",
  "  ens:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    model: old/first",
  "    second_model: old/second",
  "    api_key: $OPENROUTER_API_KEY",
  "    tool_models:",
  "      security_scan: keep/me",
  "  solo:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    model: old/solo",
  "",
].join("\n");

describe("applyEnsembleSlotToSettings", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "ensslot-"));
    path = join(dir, "settings.yaml");
    writeFileSync(path, SETTINGS);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function read(): Record<string, Record<string, Record<string, unknown>>> {
    return yamlParse(readFileSync(path, "utf-8"));
  }

  it("swaps the primary model and reports the old id", () => {
    const r = applyEnsembleSlotToSettings(path, "ens", "model", "new/arrival");
    expect(r.oldModelId).toBe("old/first");
    expect(r.newModelId).toBe("new/arrival");
    expect(read().profiles.ens.model).toBe("new/arrival");
  });

  it("touches ONLY the requested slot — the rest of a working ensemble survives", () => {
    applyEnsembleSlotToSettings(path, "ens", "model", "new/arrival");
    const doc = read();
    expect(doc.profiles.ens.second_model).toBe("old/second");
    expect(doc.profiles.ens.tool_models).toEqual({ security_scan: "keep/me" });
    expect(doc.profiles.ens.api_key).toBe("$OPENROUTER_API_KEY");
    expect(doc.profiles.solo.model).toBe("old/solo");
  });

  it("fills an unset third_model on a remote-ensemble profile", () => {
    const r = applyEnsembleSlotToSettings(path, "ens", "third_model", "new/third");
    expect(r.oldModelId).toBe("");
    expect(read().profiles.ens.third_model).toBe("new/third");
  });

  it("REFUSES second/third on a non-ensemble profile — that write would be a silent no-op", () => {
    // mode: remote ignores second_model, so "successfully" writing it would report a
    // change the runtime never reads. Fail fast instead.
    expect(() => applyEnsembleSlotToSettings(path, "solo", "second_model", "new/x")).toThrow(
      /only read under mode 'remote-ensemble'/,
    );
    expect(read().profiles.solo.second_model).toBeUndefined();
  });

  it("still allows adopting into `model` on a non-ensemble profile", () => {
    applyEnsembleSlotToSettings(path, "solo", "model", "new/x");
    expect(read().profiles.solo.model).toBe("new/x");
  });

  it("rejects an unknown slot and an empty model id", () => {
    expect(() =>
      applyEnsembleSlotToSettings(path, "ens", "fourth_model" as never, "new/x"),
    ).toThrow(/unknown slot/);
    expect(() => applyEnsembleSlotToSettings(path, "ens", "model", "")).toThrow(/non-empty string/);
  });

  it("fails fast on an unknown profile and a missing file", () => {
    expect(() => applyEnsembleSlotToSettings(path, "nope", "model", "x/y")).toThrow(
      /no profile named 'nope'/,
    );
    expect(() => applyEnsembleSlotToSettings(join(dir, "gone.yaml"), "ens", "model", "x/y")).toThrow(
      /not found/,
    );
  });

  it("leaves no .tmp file behind (tmp+rename)", () => {
    applyEnsembleSlotToSettings(path, "ens", "model", "new/x");
    expect(readdirSync(dir)).toEqual(["settings.yaml"]);
  });

  it("exports exactly the three slots the ensemble reads", () => {
    expect([...ENSEMBLE_SLOTS]).toEqual(["model", "second_model", "third_model"]);
  });
});
