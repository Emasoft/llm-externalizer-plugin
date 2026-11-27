import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, chmodSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDefaultOutputDirCache } from "../../project-root.js";
import { prepareReportDir, writeAtomic, writeReport } from "./report.js";

// Real directories under /tmp; the default dir is steered with the real LLM_EXT_OUTPUT_DIR variable.
let root: string;
const savedEnv = process.env.LLM_EXT_OUTPUT_DIR;
beforeEach(() => {
  root = resolve(mkdtempSync("/tmp/llmext-report-")); // resolve: on Windows mkdtemp returns \tmp\... without the drive (TRDD-PX0X1JRD)
  _resetDefaultOutputDirCache();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.LLM_EXT_OUTPUT_DIR;
  else process.env.LLM_EXT_OUTPUT_DIR = savedEnv;
  _resetDefaultOutputDirCache();
});

describe("prepareReportDir", () => {
  it("creates and returns the -o directory", () => {
    const d = join(root, "a", "b");
    expect(prepareReportDir(d)).toBe(d);
    expect(existsSync(d)).toBe(true);
  });
  it("uses defaultOutputDir() when -o is omitted", () => {
    process.env.LLM_EXT_OUTPUT_DIR = join(root, "default");
    expect(prepareReportDir(undefined)).toBe(resolve(join(root, "default")));
    expect(existsSync(join(root, "default"))).toBe(true);
  });
  it("E52: a directory that cannot be created fails with a clear error", () => {
    const f = join(root, "afile");
    writeFileSync(f, "x");
    expect(() => prepareReportDir(join(f, "sub"))).toThrow(/cannot write report directory/);
  });
  it("E52: an existing read-only directory fails before any write", () => {
    // WHY (TRDD-1Y9UK5MK): Windows does not enforce read-only directory modes, so chmod 0o500 refuses nothing there; the test proves the POSIX refusal.
    if (process.getuid?.() === 0 || process.platform === "win32") return; // root ignores permission bits
    const d = join(root, "ro");
    mkdirSync(d);
    chmodSync(d, 0o500);
    expect(() => prepareReportDir(d)).toThrow(/cannot write report directory/);
    chmodSync(d, 0o700);
  });
});

describe("writeReport", () => {
  it("writes exactly the given text to a timestamped .json file and leaves no temp file", () => {
    const text = JSON.stringify({ schema: 1 }, null, 2) + "\n";
    const p = writeReport(root, "filter", text);
    expect(p.startsWith(resolve(root))).toBe(true);
    // WHY (TRDD-1Y9UK5MK): writeReport joins with the native separator, "\" on Windows.
    expect(p).toMatch(/[\\/]\d{8}_\d{6}[+-]\d{4}-filter-[0-9a-f]{6}\.json$/);
    expect(readFileSync(p, "utf-8")).toBe(text);
    expect(readdirSync(root)).toEqual([basename(p)]);
  });
  it("refuses a decision that is not lowercase kebab-case (it becomes part of the file name)", () => {
    for (const bad of ["a/b", "..", "Filter", "", "a b"]) expect(() => writeReport(root, bad, "x")).toThrow(/decision/);
    expect(readdirSync(root)).toEqual([]);
  });
  it("writeAtomic removes its temp file when the rename fails (destination is an existing directory)", () => {
    const dest = join(root, "target.json");
    mkdirSync(dest);
    expect(() => writeAtomic(dest, "x")).toThrow();
    expect(readdirSync(root)).toEqual(["target.json"]);
  });
  it("two writes in the same second never collide", () => {
    const a = writeReport(root, "filter", "1\n");
    const b = writeReport(root, "filter", "2\n");
    expect(a).not.toBe(b);
    expect(readdirSync(root)).toHaveLength(2);
  });
});
