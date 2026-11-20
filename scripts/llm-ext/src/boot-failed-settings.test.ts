/**
 * TRDD-FBWXV4JF: a settings.yaml whose load THROWS at boot must refuse every request, never serve one on the generated default profile.
 *
 * Why this is a real risk: the boot IIFE catch in index.ts replaces the document with generateDefaultSettings(), and the default `free` is the
 * self-healing unpopulated placeholder that evaluateSettingsValidity exempts. Without a dedicated guard, boot (and the CLI's default
 * overrideActiveProfile call that follows it) would mark settings valid and clear settingsError, so the NOT CONFIGURED gate in dispatch would not fire.
 *
 * The throw is made real, not mocked: settings.yaml is a DIRECTORY, so ensureSettingsExist reads it and fails with EISDIR (an unparseable
 * FILE would not do: ensureSettingsExist backs it up and regenerates it). Pattern: boot-reload-validity.test.ts (fresh import per scenario).
 * Temp dirs carry the `llm-ext-` prefix so the tmpdir-leak guard covers them. The fixed code refuses before the dispatch pre-flight (pre-flight code spawns detached
 * detectors for a dispatch that gets past the gate; with the fix the gate returns first).
 * What the unfixed code did, measured: boot and the CLI default override marked settings valid, and the request was refused only by the empty `free` pool
 * ("no model of the 'free' profile ..."), not by the settings error; serving on a POPULATED default pool was not demonstrated.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getSettingsPath } from "./config.js";
import { basename, join } from "node:path";

process.env.LLM_EXT_INSTALL_RULE = "0";

// TRDD-LA1MA1EL: Windows has no /tmp (join("/tmp", ..) is C:\tmp, outside getConfigDir()'s home-or-/tmp allowlist); there the runner temp dir
// (under home) is the base. Elsewhere keep the literal /tmp the allowlist names.
const TMP_BASE = process.platform === "win32" ? tmpdir() : "/tmp";

const created: string[] = [];
let prevCfgDir: string | undefined;

async function loadFreshIndexWithThrowingSettings() {
  const cfgDir = mkdtempSync(join(TMP_BASE, "llm-ext-cfgfail-"));
  created.push(cfgDir);
  mkdirSync(join(cfgDir, "settings.yaml"));
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  const idx = await import("./index.js");
  await idx.boot();
  return { idx, cfgDir };
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  prevCfgDir = undefined;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TRDD-FBWXV4JF — a settings load that throws at boot refuses every request", () => {
  it("boot: the throwing load leaves settings NOT valid and no resolved profile", async () => {
    const { idx } = await loadFreshIndexWithThrowingSettings();
    expect(idx.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  });

  it("the CLI default overrideActiveProfile call does not turn the generated default into a valid configuration", async () => {
    const { idx } = await loadFreshIndexWithThrowingSettings();
    const result = idx.overrideActiveProfile("free", "default");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Failed to load settings");
    expect(idx.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  });

  it("dispatch: a work tool is refused with NOT CONFIGURED and the settings error, also after the CLI default override", async () => {
    const { idx, cfgDir } = await loadFreshIndexWithThrowingSettings();
    idx.overrideActiveProfile("free", "default");
    const folder = mkdtempSync(join(TMP_BASE, "llm-ext-scanfail-"));
    created.push(folder);
    writeFileSync(join(folder, "a.txt"), "hello world\n", "utf-8");
    const r = await idx.dispatchCallTool("scan_folder", { folder_path: folder, instructions: "find bugs" });
    const text = textOf(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain("NOT CONFIGURED");
    expect(text).toContain("Failed to load settings");
    // index.ts builds the message from SETTINGS_FILE = getSettingsPath() (config.ts), which resolves the config dir through realpath (/private/tmp/.. on macOS);
    // compare against that same source, not a hand-built join(cfgDir, ..). Windows behaviour (8.3 short temp name) is inferred from the code, not run here.
    expect(text).toContain(getSettingsPath());
    // Ties the message to this test's own LLM_EXT_CONFIG_DIR override (the unique mkdtemp name survives realpath/8.3 differences in the parent).
    expect(text).toContain(basename(cfgDir));
  });

  it("recovery: once settings.yaml is a readable document again, a reload accepts it and clears the failure", async () => {
    const { idx, cfgDir } = await loadFreshIndexWithThrowingSettings();
    rmSync(join(cfgDir, "settings.yaml"), { recursive: true, force: true });
    // Same valid static document boot-reload-validity.test.ts boots CONFIGURED with.
    const valid = ["active: my-custom", "profiles:", "  my-custom:", "    mode: local", "    api: generic-local", "    model: model-a", "    url: http://127.0.0.1:1", "    profile-type: local", ""].join("\n");
    writeFileSync(join(cfgDir, "settings.yaml"), valid, "utf-8");
    expect(idx.__reloadSettingsFromDiskForTests()).toEqual({ ok: true, error: "" });
    expect(idx.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });
});
