// Real-filesystem test (no mocks) for TRDD-GRCE2QUQ: a backup must never replace an existing one.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "./test-tmp-root.js";
import { backupSettingsFile } from "./benchmark/pick.js";
import { writeBackupExclusive } from "./config.js";

describe("backups never overwrite", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-ext-backup-"));
    saved = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("two different settings backed up in the same second keep both files", () => {
    const settings = join(dir, "settings.yaml");
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    writeFileSync(settings, "first: 1\n");
    const a = backupSettingsFile(settings, "settings-before-regenerate", "free", { nowMs: now });
    writeFileSync(settings, "second: 2\n");
    const b = backupSettingsFile(settings, "settings-before-regenerate", "free", { nowMs: now });
    expect(b).not.toBe(a);
    expect(readFileSync(a, "utf-8")).toBe("first: 1\n");
    expect(readFileSync(b, "utf-8")).toBe("second: 2\n");
    expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
  });

  it("identical content in the same second reuses the existing backup", () => {
    const settings = join(dir, "settings.yaml");
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    writeFileSync(settings, "same: 1\n");
    const a = backupSettingsFile(settings, "p", "n", { nowMs: now });
    expect(backupSettingsFile(settings, "p", "n", { nowMs: now })).toBe(a);
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
  });

  it("writeBackupExclusive keeps an existing different file and uses the next free name", () => {
    const stem = join(dir, "settings.yaml.corrupt-X");
    const a = writeBackupExclusive(stem, "", Buffer.from("one"));
    const b = writeBackupExclusive(stem, "", Buffer.from("two"));
    expect(readFileSync(a, "utf-8")).toBe("one");
    expect(readFileSync(b, "utf-8")).toBe("two");
    expect(b).toBe(`${stem}-1`);
  });

  it("writeBackupExclusive propagates a non-collision error instead of hiding it", () => {
    expect(() => writeBackupExclusive(join(dir, "missing-dir", "x"), ".yaml", Buffer.from("c"))).toThrow(/ENOENT/);
  });

  it("two different invalid-UTF-8 files are not called identical and keep their exact bytes", () => {
    const stem = join(dir, "bytes");
    // Both decode to the same string of U+FFFD, so a utf-8 compare would call them equal.
    const first = Buffer.from([0xff, 0xfe, 0x41]);
    const second = Buffer.from([0xfe, 0xff, 0x41]);
    const a = writeBackupExclusive(stem, ".bin", first);
    const b = writeBackupExclusive(stem, ".bin", second);
    expect(b).not.toBe(a);
    expect(readFileSync(a).equals(first)).toBe(true);
    expect(readFileSync(b).equals(second)).toBe(true);
    expect(writeBackupExclusive(stem, ".bin", first)).toBe(a);
  });

  it("writes the backup contents and restricts POSIX permissions to mode 0600", () => {
    const p = writeBackupExclusive(join(dir, "mode"), ".yaml", Buffer.from("k: v\n"));
    expect(readFileSync(p, "utf-8")).toBe("k: v\n");
    // Windows file access uses ACLs; stat mode bits do not describe them.
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("dedupe finds a -N backup written earlier in the same second", () => {
    const settings = join(dir, "settings.yaml");
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    writeFileSync(settings, "first: 1\n");
    backupSettingsFile(settings, "p", "n", { nowMs: now });
    writeFileSync(settings, "second: 2\n");
    const b = backupSettingsFile(settings, "p", "n", { nowMs: now });
    expect(b).toMatch(/-1\.yaml$/);
    expect(backupSettingsFile(settings, "p", "n", { nowMs: now + 5000, dedupe: true })).toBe(b);
    expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
  });
});
