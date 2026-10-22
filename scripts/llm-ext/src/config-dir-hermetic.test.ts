/**
 * Guards the hermetic-suite fix in test-hermetic-config.ts: during the
 * suite, getConfigDir() must never resolve to the real
 * ~/.llm-externalizer, and must resolve under /tmp (realpath'd, matching
 * config.ts's own M8 allowlist — NOT os.tmpdir(), which differs from /tmp
 * on macOS).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigDir } from "./config.js";

describe("hermetic suite: getConfigDir() isolation", () => {
  it("does not resolve to the real ~/.llm-externalizer during the suite", () => {
    const realDefault = join(homedir(), ".llm-externalizer");
    expect(getConfigDir()).not.toBe(realDefault);
  });

  it("resolves under /tmp (config.ts's own allowlist root) during the suite", () => {
    const tmpCanonical = (() => {
      try {
        return realpathSync("/tmp");
      } catch {
        return "/tmp";
      }
    })();
    const dir = getConfigDir();
    expect(dir === tmpCanonical || dir.startsWith(tmpCanonical + "/")).toBe(true);
  });
});


describe("getConfigDir() path guard (TRDD-YUML4ISF)", () => {
  it("still rejects a config folder outside the home folder and /tmp", () => {
    const saved = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = "/etc/llm-ext-guard-test";
    try {
      expect(() => getConfigDir()).toThrow(/outside allowed paths/);
    } finally {
      if (saved === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = saved;
    }
  });


  // Real os.tmpdir() (follows TMPDIR, /var/folders/... on a default macOS terminal) must
  // stay rejected: widening config.ts's guard to it would let the caller-controlled
  // TMPDIR choose the config folder. Skipped where os.tmpdir() is legitimately allowed.
  const osTmpReal = realpathSync(osTmpdir());
  const under = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");
  const osTmpAllowed = under(osTmpReal, realpathSync("/tmp")) || under(osTmpReal, realpathSync(homedir()));
  it.skipIf(osTmpAllowed)(
    "rejects a config folder under the real os.tmpdir() (skipped when os.tmpdir() is under /tmp or $HOME, e.g. Linux CI)",
    () => {
      const saved = process.env.LLM_EXT_CONFIG_DIR;
      const dir = mkdtempSync(join(osTmpReal, "llm-ext-guard-"));
      process.env.LLM_EXT_CONFIG_DIR = dir;
      try {
        expect(() => getConfigDir()).toThrow(/outside allowed paths/);
      } finally {
        if (saved === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
        else process.env.LLM_EXT_CONFIG_DIR = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

});
