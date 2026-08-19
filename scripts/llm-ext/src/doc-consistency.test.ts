// Doc-consistency gate (TRDD-828238b5 A5).
//
// Asserts the README's hand-restated COUNTS and NAME LISTS match the
// authoritative declarations in the source tree (tool arrays, commands/*.md,
// API_PRESETS, agents/*.md). This is the gate that ends the doc-drift class the
// deep audit kept fixing: add a tool/command and forget to bump a README count,
// and THIS test fails with a clear message. Runs inside `npm test`, which is
// already a publish gate — no separate CI wiring needed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  repoRoot,
  readCoreToolNames,
  readMassScoutToolNames,
  readAllToolNames,
  readApiPresetNames,
  readCommandNames,
  readAgentNames,
} from "./doc-inventory.js";

const ROOT = repoRoot();
const README = readFileSync(join(ROOT, "README.md"), "utf-8");

const core = readCoreToolNames();
const massScout = readMassScoutToolNames();
const allTools = readAllToolNames();
const presets = readApiPresetNames();
const commands = readCommandNames();
const agents = readAgentNames();

// Sub-buckets the README breaks the tool count into.
const massScoutFamily = massScout.filter((n) => n.startsWith("mass_scout"));
const modelQual = massScout.filter((n) => !n.startsWith("mass_scout"));

// Sub-buckets the README breaks the command count into.
const massScoutCmds = commands.filter((n) => n.startsWith("llm-externalizer-mass-scout"));
const securityScanCmd = commands.filter((n) => n === "llm-externalizer-security-scan");
const baseCmds = commands.filter(
  (n) => !n.startsWith("llm-externalizer-mass-scout") && n !== "llm-externalizer-security-scan",
);

describe("doc-inventory extraction (sanity)", () => {
  it("extracts the core/utility tools (includes chat, code_task, cluster_synonyms)", () => {
    expect(core).toContain("chat");
    expect(core).toContain("code_task");
    expect(core).toContain("cluster_synonyms");
    expect(core.length).toBeGreaterThanOrEqual(16);
  });

  it("extracts the mass-scout + model-qual tools (includes the A2/A4 additions)", () => {
    expect(massScout).toContain("mass_scout");
    expect(massScout).toContain("security_scan");
    expect(massScout).toContain("check_model_health");
    expect(massScout).toContain("discover_new_models");
  });

  it("extracts every slash command and agent", () => {
    expect(commands).toContain("llm-externalizer-check-model-health");
    expect(commands).toContain("llm-externalizer-discover-new-models");
    expect(commands.length).toBeGreaterThanOrEqual(20);
    expect(agents).toContain("llm-externalizer-setup-agent");
  });

  it("extracts the 6 backend presets", () => {
    expect(presets).toContain("openrouter-remote");
    expect(presets).toContain("lmstudio-local");
    expect(presets.length).toBe(6);
  });
});

describe("README count consistency", () => {
  it("every 'N CLI commands' count equals core + mass-scout total", () => {
    const total = allTools.length;
    const occurrences = [...README.matchAll(/(\d+) CLI commands/g)].map((m) => Number(m[1]));
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // features bullet + detail bullet
    for (const n of occurrences) expect(n).toBe(total);
  });

  it("the tool-count breakdown sub-counts match the source buckets", () => {
    expect(README).toContain(`${core.length} core/utility`);
    expect(README).toContain(`${massScoutFamily.length} mass-scout (`);
    expect(README).toContain(`${modelQual.length} security / model-qualification`);
  });

  it("'N plugin commands' and its base/mass-scout/security split match the files", () => {
    expect(README).toContain(`${commands.length} plugin commands`);
    expect(README).toContain(`${baseCmds.length} base`);
    // README deliberately says "1 mass-scout dispatcher (`mass-scout`" since the
    // v13.5.9 collapse of the per-action mass-scout-* slash commands (9a3e119);
    // matching the bare "N mass-scout (`" would collide with the CLI-count wording.
    expect(README).toContain(`${massScoutCmds.length} mass-scout dispatcher (\``);
    expect(securityScanCmd.length).toBe(1);
  });

  it("'N backend presets' matches API_PRESETS", () => {
    expect(README).toContain(`${presets.length} backend presets`);
  });

  it("'N internal agents' matches agents/*.md", () => {
    expect(README).toContain(`${agents.length} internal agents`);
  });
});

describe("README membership consistency", () => {
  it("names every CLI command (backtick-wrapped) somewhere in the README", () => {
    // The catalog is authored snake_case; the CLI's canonical spelling — and
    // so the README's — is kebab. Accept either, because both are real: the
    // CLI takes snake_case as a silent alias, so a README that happens to use
    // one is not wrong. What must not happen is a command appearing in
    // NEITHER spelling, which is a command users have no way to discover.
    const missing = allTools.filter(
      (t) =>
        !README.includes(`\`${t}\``) &&
        !README.includes(`\`${t.replace(/_/g, "-")}\``),
    );
    expect(missing).toEqual([]);
  });

  it("names every slash command somewhere in the README", () => {
    // Commands are referenced either by full name or by their short suffix in
    // the command-table / feature bullets; require the full name to appear.
    const missing = commands.filter((c) => !README.includes(c));
    expect(missing).toEqual([]);
  });
});
