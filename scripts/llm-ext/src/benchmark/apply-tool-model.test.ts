// Unit tests for applyToolModelToSettings (TRDD-828238b5 A7-P2) — the per-tool
// model writer in pick.ts. No network, no external state: every case operates on
// a temp settings.yaml. Mirrors pick.test.ts's applyPicksToSettings tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { applyToolModelToSettings } from "./pick.js";

describe("applyToolModelToSettings", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "apply-tool-model-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSettings(content: string): string {
    const path = join(tmp, "settings.yaml");
    writeFileSync(path, content);
    return path;
  }

  it("sets tool_models[tool] when no tool_models map exists, preserving every other key", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  other:
    mode: local
    api: lmstudio-local
    model: local-stub
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
    api_key: $OPENROUTER_API_KEY
    timeout: 120
`,
    );
    const result = applyToolModelToSettings(settingsPath, "prod", "security_scan", "triage/model");
    expect(result).toEqual({
      profileName: "prod",
      tool: "security_scan",
      oldModelId: "",
      newModelId: "triage/model",
    });
    const doc = yamlParse(readFileSync(settingsPath, "utf-8")) as {
      active: string;
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(doc.active).toBe("prod");
    // Other profile untouched.
    expect(doc.profiles.other.model).toBe("local-stub");
    // Every other key on the target profile preserved.
    const prod = doc.profiles.prod;
    expect(prod.mode).toBe("remote");
    expect(prod.api).toBe("openrouter-remote");
    expect(prod.model).toBe("main/model");
    expect(prod.api_key).toBe("$OPENROUTER_API_KEY");
    expect(prod.timeout).toBe(120);
    // The new tool_models map created.
    expect(prod.tool_models).toEqual({ security_scan: "triage/model" });
  });

  it("preserves OTHER tool_models entries and returns the previous model id", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
    tool_models:
      security_scan: old/triage
      search_existing_implementations: keep/me
`,
    );
    const result = applyToolModelToSettings(settingsPath, "prod", "security_scan", "new/triage");
    expect(result.oldModelId).toBe("old/triage");
    expect(result.newModelId).toBe("new/triage");
    const doc = yamlParse(readFileSync(settingsPath, "utf-8")) as {
      profiles: Record<string, { tool_models: Record<string, string> }>;
    };
    expect(doc.profiles.prod.tool_models).toEqual({
      security_scan: "new/triage",
      // The OTHER tool entry must survive untouched.
      search_existing_implementations: "keep/me",
    });
  });

  it("writes atomically — no .tmp file is left behind", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
`,
    );
    applyToolModelToSettings(settingsPath, "prod", "search_existing_implementations", "se/model");
    const leftovers = readdirSync(tmp).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
    const doc = yamlParse(readFileSync(settingsPath, "utf-8")) as {
      profiles: Record<string, { tool_models: Record<string, string> }>;
    };
    expect(doc.profiles.prod.tool_models).toEqual({ search_existing_implementations: "se/model" });
  });

  it("throws on an unknown tool name and lists registered tools", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
`,
    );
    expect(() =>
      applyToolModelToSettings(settingsPath, "prod", "not_a_real_tool", "x/y"),
    ).toThrow(/unknown tool 'not_a_real_tool'/);
  });

  it("throws on a missing profile and lists existing profiles", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
`,
    );
    expect(() =>
      applyToolModelToSettings(settingsPath, "nonexistent", "security_scan", "x/y"),
    ).toThrow(/no profile named 'nonexistent'/);
  });

  it("throws on an empty modelId", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
`,
    );
    expect(() =>
      applyToolModelToSettings(settingsPath, "prod", "security_scan", ""),
    ).toThrow(/non-empty string/);
  });

  it("throws when the settings file is missing", () => {
    const missing = join(tmp, "does-not-exist.yaml");
    expect(() =>
      applyToolModelToSettings(missing, "prod", "security_scan", "x/y"),
    ).toThrow(/not found/);
  });

  it("treats a malformed tool_models value (a scalar) as empty rather than crashing", () => {
    const settingsPath = writeSettings(
      `active: prod
profiles:
  prod:
    mode: remote
    api: openrouter-remote
    model: main/model
    tool_models: not-a-map
`,
    );
    const result = applyToolModelToSettings(settingsPath, "prod", "security_scan", "fresh/model");
    expect(result.oldModelId).toBe("");
    const doc = yamlParse(readFileSync(settingsPath, "utf-8")) as {
      profiles: Record<string, { tool_models: Record<string, string> }>;
    };
    expect(doc.profiles.prod.tool_models).toEqual({ security_scan: "fresh/model" });
  });
});
