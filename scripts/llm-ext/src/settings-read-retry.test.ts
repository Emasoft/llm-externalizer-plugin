// TRDD-Y7G1ZRBG: readSettingsFileRetrying retries only the transient Windows sharing-violation codes, boundedly, and lets every other error (and the last transient one) propagate unchanged. The read function and the sleep are injected, so no real clock and no real lock is needed.

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { tmpdir } from "./test-tmp-root.js";
import { SETTINGS_READ_RETRY_DELAYS_MS, ensureSettingsExist, loadSettings, readSettingsFileRetrying, settingsReadSeam } from "./config.js";

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  err.code = code;
  return err;
}

/** A read that throws `code` for its first `failures` calls, then returns "ok". */
function flakyRead(code: string, failures: number): { read: (p: string) => string; calls: () => number } {
  let n = 0;
  return {
    read: () => {
      n++;
      if (n <= failures) throw errno(code);
      return "ok";
    },
    calls: () => n,
  };
}

describe("readSettingsFileRetrying (TRDD-Y7G1ZRBG)", () => {
  it("returns the content on the first attempt without sleeping", () => {
    const f = flakyRead("EPERM", 0);
    const sleeps: number[] = [];
    expect(readSettingsFileRetrying("/x", f.read, (ms) => sleeps.push(ms), true)).toBe("ok");
    expect(f.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    it(`retries ${code} until the read succeeds`, () => {
      const f = flakyRead(code, 3);
      const sleeps: number[] = [];
      expect(readSettingsFileRetrying("/x", f.read, (ms) => sleeps.push(ms), true)).toBe("ok");
      expect(f.calls()).toBe(4);
      expect(sleeps).toEqual(SETTINGS_READ_RETRY_DELAYS_MS.slice(0, 3));
    });
  }

  it("bounds the retry: a persistent EPERM propagates the same error object after every delay, total wait at most 200 ms", () => {
    const thrown = errno("EPERM");
    let calls = 0;
    const sleeps: number[] = [];
    let caught: unknown;
    try {
      readSettingsFileRetrying("/x", () => { calls++; throw thrown; }, (ms) => sleeps.push(ms), true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(thrown);
    expect(calls).toBe(SETTINGS_READ_RETRY_DELAYS_MS.length + 1);
    expect(sleeps).toEqual([...SETTINGS_READ_RETRY_DELAYS_MS]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
  });

  for (const code of ["EISDIR", "ENOENT"]) {
    it(`does not retry ${code}: one attempt, no sleep, same error`, () => {
      const thrown = errno(code);
      let calls = 0;
      const sleeps: number[] = [];
      expect(() => readSettingsFileRetrying("/x", () => { calls++; throw thrown; }, (ms) => sleeps.push(ms), true)).toThrow(thrown);
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    });
  }

  it("does not retry a transient code when retrying is off (the POSIX default): one attempt, no sleep", () => {
    const thrown = errno("EACCES");
    let calls = 0;
    const sleeps: number[] = [];
    expect(() => readSettingsFileRetrying("/x", () => { calls++; throw thrown; }, (ms) => sleeps.push(ms), false)).toThrow(thrown);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
  describe("through loadSettings / ensureSettingsExist (real files in a temp llm-ext-* config dir)", () => {
    let dir: string;
    let prevCfg: string | undefined;
    beforeEach(() => {
      // /tmp on POSIX so the chmod case lives on a plain local path; the shared tmpdir() helper elsewhere.
      dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "llm-ext-readretry-"));
      prevCfg = process.env.LLM_EXT_CONFIG_DIR;
      process.env.LLM_EXT_CONFIG_DIR = dir;
    });
    afterEach(() => {
      delete settingsReadSeam.read;
      delete settingsReadSeam.sleep;
      delete settingsReadSeam.retryTransient;
      if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR; else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
      rmSync(dir, { recursive: true, force: true });
    });
    const file = (): string => join(dir, "settings.yaml");
    const backups = (): string[] => readdirSync(dir).filter((n) => n.includes(".corrupt-"));

    it("a missing settings.yaml is null (ENOENT from the read, no existsSync pre-check) and a real file loads", () => {
      expect(loadSettings()).toBeNull();
      writeFileSync(file(), "active: free\nprofiles: {}\n");
      expect(loadSettings()?.active).toBe("free");
    });

    it("loadSettings rides out two EPERM reads (retry flag forced on) and returns the settings", () => {
      writeFileSync(file(), "active: free\nprofiles: {}\n");
      let n = 0;
      const sleeps: number[] = [];
      settingsReadSeam.retryTransient = true;
      settingsReadSeam.sleep = (ms) => { sleeps.push(ms); };
      settingsReadSeam.read = (p) => { if (++n <= 2) throw errno("EPERM"); return readFileSync(p, "utf-8"); };
      expect(loadSettings()?.active).toBe("free");
      expect(n).toBe(3);
      expect(sleeps).toEqual(SETTINGS_READ_RETRY_DELAYS_MS.slice(0, 2));
    });

    it("ensureSettingsExist on a persistently unreadable file throws the read error and leaves the file byte-identical, no backup, no regeneration", () => {
      const before = "active: free\nprofiles: {}\n# user comment\n";
      writeFileSync(file(), before);
      settingsReadSeam.retryTransient = true;
      settingsReadSeam.sleep = () => undefined;
      settingsReadSeam.read = () => { throw errno("EPERM"); };
      expect(() => ensureSettingsExist()).toThrow(/EPERM/);
      delete settingsReadSeam.read;
      expect(readFileSync(file(), "utf-8")).toBe(before);
      expect(backups()).toEqual([]);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("ensureSettingsExist on a chmod 000 settings.yaml throws and leaves it byte-identical, no backup", () => {
      const before = "active: free\nprofiles: {}\n";
      writeFileSync(file(), before);
      chmodSync(file(), 0o000);
      try {
        expect(() => ensureSettingsExist()).toThrow(/EACCES/);
      } finally {
        chmodSync(file(), 0o600);
      }
      expect(readFileSync(file(), "utf-8")).toBe(before);
      expect(backups()).toEqual([]);
    });

    it("ensureSettingsExist on a file that was read but does not parse still backs it up before regenerating", () => {
      const bad = "a: [unclosed\n";
      writeFileSync(file(), bad);
      ensureSettingsExist();
      const found = backups();
      expect(found).toHaveLength(1);
      expect(readFileSync(join(dir, found[0]), "utf-8")).toBe(bad);
      expect(loadSettings()).not.toBeNull();
    });
  });
  it("does not retry an error without a code", () => {
    const thrown = new Error("no code");
    let calls = 0;
    expect(() => readSettingsFileRetrying("/x", () => { calls++; throw thrown; }, () => undefined, true)).toThrow(thrown);
    expect(calls).toBe(1);
  });

  it("the default read really reads a file and really throws EISDIR on a directory", () => {
    expect(readSettingsFileRetrying(import.meta.filename)).toContain("TRDD-Y7G1ZRBG");
    expect(() => readSettingsFileRetrying(import.meta.dirname)).toThrow(/EISDIR/);
  });
});
