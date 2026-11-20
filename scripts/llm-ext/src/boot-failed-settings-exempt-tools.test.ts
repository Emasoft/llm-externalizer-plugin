/**
 * TRDD-LFWV2DKG: after a boot whose settings load THROWS, the four gate-exempt tools (list_profiles, get_settings, profile, discover) stay errors even
 * when settings.yaml is readable again, and never present the generated default profiles (or the file's own, never loaded) as the user's.
 *
 * Why this is a real risk: list_profiles/get_settings/discover read the disk or activeSettings themselves. After a failed boot activeSettings is the
 * generated default document, and a file that became readable again (transient lock/read error) would be listed as if the boot had loaded it.
 * The throw is real, not mocked: settings.yaml is a directory (EISDIR) or an unreadable file (chmod 000, EACCES), then made readable with valid
 * content naming a profile that is NOT in the defaults. Pattern: boot-default-settings-writers.test.ts. Temp dirs carry the `llm-ext-` prefix. No network.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LLM_EXT_INSTALL_RULE = "0";

// Windows has no /tmp (see boot-failed-settings.test.ts); elsewhere keep the literal /tmp the config-dir allowlist names.
const TMP_BASE = process.platform === "win32" ? tmpdir() : "/tmp";
const CANNOT_MAKE_UNREADABLE = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);

const USER_PROFILE = "myprof";
const VALID_SETTINGS = [`active: ${USER_PROFILE}`, "profiles:", `  ${USER_PROFILE}:`, "    mode: local", "    api: generic-local", "    model: model-a", "    url: http://127.0.0.1:1", "    profile-type: local", ""].join("\n");

const created: string[] = [];
let prevCfgDir: string | undefined;

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  prevCfgDir = undefined;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

/** Boot on an unreadable settings.yaml, then make it a readable valid document; returns the module and the failure text the boot recorded. */
async function bootThenMakeReadable(prepare: (settingsPath: string) => void, makeReadable: (settingsPath: string) => void) {
  const cfgDir = mkdtempSync(join(TMP_BASE, "llm-ext-lfwv2dkg-"));
  created.push(cfgDir);
  const settingsPath = join(cfgDir, "settings.yaml");
  prepare(settingsPath);
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  const idx = await import("./index.js");
  await idx.boot();
  expect(idx.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  const { generateDefaultSettings } = await import("./config.js");
  const failure = idx.overrideActiveProfile("free", "default");
  expect(failure.ok).toBe(false);
  makeReadable(settingsPath);
  return { idx, failureText: failure.ok ? "" : failure.error, defaultNames: Object.keys(generateDefaultSettings().profiles) };
}

async function expectExemptToolsStayErrors(scenario: Awaited<ReturnType<typeof bootThenMakeReadable>>): Promise<void> {
  const { idx, failureText, defaultNames } = scenario;
  expect(failureText).toContain("Failed to load settings");
  expect(defaultNames.length).toBeGreaterThan(0);
  for (const tool of ["list_profiles", "get_settings", "profile"] as const) {
    const r = await idx.dispatchCallTool(tool, {});
    const text = textOf(r);
    expect(r.isError, `${tool}: ${text}`).toBe(true);
    // The failure the boot recorded, verbatim: not a listing of the defaults and not of the file that boot never loaded.
    expect(text, tool).toBe(failureText);
    expect(text, tool).not.toContain(USER_PROFILE);
  }
  const shown = await idx.dispatchCallTool("profile", { show: defaultNames[0] });
  expect(shown.isError, textOf(shown)).toBe(true);
  expect(textOf(shown)).toBe(failureText);
  const d = await idx.dispatchCallTool("discover", {});
  const dText = textOf(d);
  expect(d.isError, dText).toBe(true);
  expect(dText).toContain("NOT CONFIGURED");
  expect(dText).toContain(failureText);
  expect(dText).not.toContain(USER_PROFILE);
  // "Available profiles: ..." would name the generated defaults as the user's; the API presets line legitimately holds words like "local", so test the label.
  expect(dText).not.toContain("Available profiles");
  expect(dText).not.toContain("Profiles:");
}

describe("TRDD-LFWV2DKG — exempt tools after a failed boot load stay errors when settings.yaml is readable again", () => {
  it("settings.yaml was a directory at boot and is now a valid file", async () => {
    const scenario = await bootThenMakeReadable(
      (p) => mkdirSync(p),
      (p) => {
        rmSync(p, { recursive: true, force: true });
        writeFileSync(p, VALID_SETTINGS, "utf-8");
      },
    );
    await expectExemptToolsStayErrors(scenario);
  });

  it.skipIf(CANNOT_MAKE_UNREADABLE)("settings.yaml was unreadable (chmod 000) at boot and is now a valid readable file", async () => {
    const scenario = await bootThenMakeReadable(
      (p) => {
        writeFileSync(p, VALID_SETTINGS, "utf-8");
        chmodSync(p, 0o000);
      },
      (p) => chmodSync(p, 0o600),
    );
    await expectExemptToolsStayErrors(scenario);
  });
});
describe("TRDD-LFWV2DKG — the two settings formatters flag every failure branch as an error (a text with exit 0 was the bug)", () => {
  /** Point config.ts at a throwaway dir holding `yaml` and run `fn` with the freshly imported formatters. */
  async function withSettings<T>(yaml: string, fn: (m: typeof import("./config.js")) => T): Promise<T> {
    const dir = mkdtempSync(join(TMP_BASE, "llm-ext-lfwv2dkg-fmt-"));
    created.push(dir);
    writeFileSync(join(dir, "settings.yaml"), yaml, "utf-8");
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    vi.resetModules();
    return fn(await import("./config.js"));
  }

  it("a settings.yaml that cannot be parsed: both formatters report it as an error", async () => {
    await withSettings("profiles: [unclosed\n", (m) => {
      expect(m.formatProfilesList()).toMatchObject({ isError: true });
      expect(m.formatActiveProfileSummary()).toMatchObject({ isError: true });
    });
  });

  // Proves an empty profiles map makes the listing an error that says No profiles defined.
  it("an empty profiles map: the listing is an error that says no profiles are defined", async () => {
    await withSettings("profiles: {}\n", (m) => {
      const listing = m.formatProfilesList();
      expect(listing.isError).toBe(true);
      expect(listing.text).toContain("No profiles defined");
    });
  });

  it("an effective profile that is not in the file: the summary is an error, the listing is not", async () => {
    await withSettings(VALID_SETTINGS, (m) => {
      const summary = m.formatActiveProfileSummary("nosuch");
      expect(summary.isError).toBe(true);
      expect(summary.text).toContain("not found");
      expect(m.formatProfilesList("nosuch").isError).toBe(false);
    });
  });
});
