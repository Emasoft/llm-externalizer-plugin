// TRDD-B07E5M93: the CLI stats file gets the same directory guards as the statusline. Every case plants a real
// symlink or uses a real foreign-owned directory; nothing is mocked.
import { describe, it, expect } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeStatsJsonGuarded } from "./stats-file.js";

const posix = process.platform !== "win32";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "llm-ext-statsfile-"));
}

describe.skipIf(!posix)("writeStatsJsonGuarded", () => {
  it("writes the file atomically into a fresh 0700 directory", () => {
    const dir = join(scratch(), "claude");
    writeStatsJsonGuarded(dir, "s.json", '{"calls":1}');
    expect(readFileSync(join(dir, "s.json"), "utf-8")).toBe('{"calls":1}');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "s.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "s.json.tmp"))).toBe(false);
  });

  it("refuses a directory that is a planted symlink and writes nothing through it", () => {
    const root = scratch();
    const victim = join(root, "victim");
    mkdirSync(victim);
    const dir = join(root, "claude");
    symlinkSync(victim, dir);
    expect(() => writeStatsJsonGuarded(dir, "s.json", "{}")).toThrow(/symlink/);
    expect(readdirSync(victim)).toEqual([]);
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
  });

  it("refuses a planted symlink at the temp-file name and leaves its target untouched", () => {
    const root = scratch();
    const dir = join(root, "claude");
    mkdirSync(dir, { mode: 0o700 });
    const target = join(root, "victim.txt");
    writeFileSync(target, "original");
    symlinkSync(target, join(dir, "s.json.tmp"));
    expect(() => writeStatsJsonGuarded(dir, "s.json", "attacker-controlled-overwrite")).toThrow();
    expect(readFileSync(target, "utf-8")).toBe("original");
    expect(existsSync(join(dir, "s.json"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("refuses a directory owned by another user (/usr is root-owned)", () => {
    expect(() => writeStatsJsonGuarded("/usr", "llm-ext-stats-guard-probe.json", "{}")).toThrow(/owned by uid/);
    expect(existsSync("/usr/llm-ext-stats-guard-probe.json")).toBe(false);
    expect(existsSync("/usr/llm-ext-stats-guard-probe.json.tmp")).toBe(false);
  });
});
