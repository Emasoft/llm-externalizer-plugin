/**
 * Guards the hermetic-suite fix in test-hermetic-config.ts: during the
 * suite, getConfigDir() must never resolve to the real
 * ~/.llm-externalizer, and must resolve under /tmp (realpath'd, matching
 * config.ts's own M8 allowlist — NOT os.tmpdir(), which differs from /tmp
 * on macOS).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { join, sep } from "node:path";
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


// TRDD-LA1MA1EL: getConfigDir() compares realpathSync.native results (the long Windows form; plain
// realpathSync keeps 8.3 short names such as RUNNER~1 and made the home-prefix check reject a temp dir
// under home). macOS cannot produce an 8.3 name, so the short-name case itself is only provable on the
// Windows CI run; these tests pin what is checkable here: symlinked parents are resolved before the
// comparison, and the rejection text still names both allowed roots in their native form.
describe("getConfigDir() canonical resolution (TRDD-LA1MA1EL)", () => {
  function withConfigDir<T>(value: string, body: () => T): T {
    const saved = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = value;
    try {
      return body();
    } finally {
      if (saved === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = saved;
    }
  }

  it("accepts a not-yet-existing config folder reached through a symlinked parent and returns its native real path", () => {
    // TRDD-LA1MA1EL: Windows has no /tmp (realpathSync.native("/tmp") throws ENOENT and join("/tmp", ..) is C:\tmp, outside the allowlist); there the
    // runner temp dir (8.3 short form under home, e.g. RUNNER~1) is the base, which makes this the real short-name regression check.
    const base = mkdtempSync(join(process.platform === "win32" ? osTmpdir() : realpathSync.native("/tmp"), "llm-ext-la1-"));
    try {
      const target = join(base, "real");
      mkdirSync(target);
      const link = join(base, "link");
      symlinkSync(target, link, "junction");
      const dir = withConfigDir(join(link, "cfg", "nested"), () => getConfigDir());
      expect(dir).toBe(join(realpathSync.native(target), "cfg", "nested"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("names both allowed roots, in their native real form, when it rejects a folder", () => {
    const message = withConfigDir("/etc/llm-ext-la1-guard-test", () => {
      try {
        getConfigDir();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("getConfigDir() did not throw");
    });
    expect(message).toMatch(/outside allowed paths/);
    // Same fallbacks as config.ts: on Windows /tmp does not resolve and the literal "/tmp" is kept (TRDD-LA1MA1EL).
    const home = (() => { try { return realpathSync.native(homedir()); } catch { return homedir(); } })();
    const tmpCanonical = (() => { try { return realpathSync.native("/tmp"); } catch { return "/tmp"; } })();
    expect(message).toContain(`(${home} or ${tmpCanonical})`);
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
  // TRDD-LA1MA1EL: native, like config.ts, so a Windows 8.3 temp name (RUNNER~1) is compared in its long form.
  const osTmpReal = realpathSync.native(osTmpdir());
  // sep, not "/": on Windows the roots use backslashes, and a "/" test would never see os.tmpdir() under home (TRDD-LA1MA1EL).
  const under = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);
  const osTmpAllowed = under(osTmpReal, realpathSync.native("/tmp")) || under(osTmpReal, realpathSync.native(homedir()));
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
