/**
 * Unit tests for the grouping helpers used by answer_mode=1.
 *
 * These tests import directly from `./grouping.ts`, which is pure and has
 * no side effects, so they can run without booting the MCP server. They
 * cover:
 *
 *   • parseFileGroups          — with and without ---GROUP:id--- markers
 *   • hasNamedGroups           — detects named vs unnamed groups
 *   • autoGroupByHeuristic     — clusters real files on disk by subfolder
 *                                and extension, splits oversized buckets,
 *                                handles marker filtering and edge cases
 *   • splitPerFileSections     — exact, suffix, and basename matching;
 *                                \r\n line endings; missing sections
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  parseFileGroups,
  hasNamedGroups,
  autoGroupByHeuristic,
  splitPerFileSections,
} from "./grouping";

// ── parseFileGroups ────────────────────────────────────────────────────

describe("parseFileGroups", () => {
  it("returns empty array for empty input", () => {
    /** Empty input produces no groups — caller decides how to handle */
    expect(parseFileGroups([])).toEqual([]);
  });

  it("wraps unmarked paths in a single unnamed group", () => {
    /** Backward compat: no markers means one unnamed group with everything */
    const groups = parseFileGroups([
      "/path/a.ts",
      "/path/b.ts",
      "/path/c.ts",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("");
    expect(groups[0].files).toEqual(["/path/a.ts", "/path/b.ts", "/path/c.ts"]);
  });

  it("parses a single named group between matching markers", () => {
    const groups = parseFileGroups([
      "---GROUP:auth---",
      "/path/auth.ts",
      "/path/auth.test.ts",
      "---/GROUP:auth---",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("auth");
    expect(groups[0].files).toEqual(["/path/auth.ts", "/path/auth.test.ts"]);
  });

  it("parses multiple named groups in order", () => {
    const groups = parseFileGroups([
      "---GROUP:auth---",
      "/path/auth.ts",
      "---/GROUP:auth---",
      "---GROUP:api---",
      "/path/api.ts",
      "/path/routes.ts",
      "---/GROUP:api---",
    ]);
    expect(groups.map((g) => g.id)).toEqual(["auth", "api"]);
    expect(groups[0].files).toEqual(["/path/auth.ts"]);
    expect(groups[1].files).toEqual(["/path/api.ts", "/path/routes.ts"]);
  });

  it("closes an open group at the next header without an explicit footer", () => {
    /** Footers are optional — the next header closes the previous group */
    const groups = parseFileGroups([
      "---GROUP:auth---",
      "/path/auth.ts",
      "---GROUP:api---",
      "/path/api.ts",
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].id).toBe("auth");
    expect(groups[0].files).toEqual(["/path/auth.ts"]);
    expect(groups[1].id).toBe("api");
    expect(groups[1].files).toEqual(["/path/api.ts"]);
  });

  it("collects files outside any markers into an unnamed group", () => {
    /** Files before the first header or between groups go into id="" */
    const groups = parseFileGroups([
      "/path/readme.md",
      "---GROUP:auth---",
      "/path/auth.ts",
      "---/GROUP:auth---",
      "/path/stray.ts",
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.id === "")?.files).toEqual(["/path/readme.md"]);
    expect(groups.find((g) => g.id === "auth")?.files).toEqual(["/path/auth.ts"]);
    const trailingUnnamed = groups[groups.length - 1];
    expect(trailingUnnamed.id).toBe("");
    expect(trailingUnnamed.files).toContain("/path/stray.ts");
  });

  it("drops empty named groups (header immediately followed by footer)", () => {
    const groups = parseFileGroups([
      "---GROUP:empty---",
      "---/GROUP:empty---",
      "/path/a.ts",
    ]);
    expect(groups.map((g) => g.id)).toEqual([""]);
    expect(groups[0].files).toEqual(["/path/a.ts"]);
  });
});

// ── hasNamedGroups ─────────────────────────────────────────────────────

describe("hasNamedGroups", () => {
  it("returns false when all groups have empty id", () => {
    expect(hasNamedGroups([{ id: "", files: ["/a.ts"] }])).toBe(false);
  });

  it("returns true when at least one group is named", () => {
    expect(
      hasNamedGroups([
        { id: "", files: ["/a.ts"] },
        { id: "auth", files: ["/b.ts"] },
      ]),
    ).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(hasNamedGroups([])).toBe(false);
  });
});

// ── autoGroupByHeuristic ───────────────────────────────────────────────
// autoGroupByHeuristic calls statSync() on every path, so these tests
// create a real temp directory tree and clean up afterwards.

describe("autoGroupByHeuristic", () => {
  const tmpRoot = "/tmp/__llm_ext_grouping_test";
  const srcDir = join(tmpRoot, "src");
  const scriptsDir = join(tmpRoot, "scripts");
  const nestedDir = join(tmpRoot, "src", "nested");

  const srcAuth = join(srcDir, "auth.ts");
  const srcAuthTest = join(srcDir, "auth.test.ts");
  const srcDb = join(srcDir, "db.ts");
  const srcReadme = join(srcDir, "README.md");
  const scriptsFoo = join(scriptsDir, "foo.py");
  const scriptsBar = join(scriptsDir, "bar.py");
  const nestedIndex = join(nestedDir, "index.ts");

  beforeAll(() => {
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(srcAuth, "export const x = 1;\n", "utf-8");
    writeFileSync(srcAuthTest, "import { x } from './auth';\n", "utf-8");
    writeFileSync(srcDb, "export function db() {}\n", "utf-8");
    writeFileSync(srcReadme, "# readme\n", "utf-8");
    writeFileSync(scriptsFoo, "def foo(): pass\n", "utf-8");
    writeFileSync(scriptsBar, "def bar(): pass\n", "utf-8");
    writeFileSync(nestedIndex, "export {};\n", "utf-8");
  });

  afterAll(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns empty array for empty input", () => {
    expect(autoGroupByHeuristic([])).toEqual([]);
  });

  it("filters out ---GROUP:id--- markers defensively", () => {
    /** Callers may hand us the raw input_files_paths array — drop markers */
    const result = autoGroupByHeuristic([
      "---GROUP:foo---",
      srcAuth,
      "---/GROUP:foo---",
    ]);
    expect(result).toHaveLength(1);
    // All 3 files aren't real — only srcAuth is a real file, so it ends up
    // in one group. The markers must not appear in any group's file list.
    for (const g of result) {
      expect(g.files.some((f) => f.includes("GROUP"))).toBe(false);
    }
  });

  it("clusters same-extension files in the same directory into one group", () => {
    const result = autoGroupByHeuristic([srcAuth, srcAuthTest, srcDb]);
    expect(result).toHaveLength(1);
    expect(result[0].files.sort()).toEqual([srcAuth, srcAuthTest, srcDb].sort());
  });

  it("splits different extensions in the same directory into separate groups", () => {
    /** src/*.ts and src/README.md live in the same dir but different ext */
    const result = autoGroupByHeuristic([srcAuth, srcDb, srcReadme]);
    expect(result).toHaveLength(2);
    const ids = result.map((g) => g.id).sort();
    // Both group ids start with "src-" plus the extension
    expect(ids[0]).toMatch(/^src-md$/);
    expect(ids[1]).toMatch(/^src-ts$/);
  });

  it("splits different directories even with the same extension", () => {
    /** src/*.ts and scripts/*.py → 2 groups by (dir, ext) */
    const result = autoGroupByHeuristic([srcAuth, srcDb, scriptsFoo, scriptsBar]);
    expect(result).toHaveLength(2);
    const byId = new Map(result.map((g) => [g.id, g.files.sort()]));
    expect(byId.get("src-ts")).toEqual([srcAuth, srcDb].sort());
    expect(byId.get("scripts-py")).toEqual([scriptsBar, scriptsFoo].sort());
  });

  it("splits nested subdirectories into their own group", () => {
    /** src/*.ts and src/nested/*.ts → 2 groups (different parent dirs) */
    const result = autoGroupByHeuristic([srcAuth, nestedIndex]);
    expect(result).toHaveLength(2);
    const ids = result.map((g) => g.id).sort();
    expect(ids).toEqual(["nested-ts", "src-ts"]);
  });

  it("assigns stable deterministic ids derived from parent dir + extension", () => {
    /** Calling twice with the same input produces the same ids */
    const first = autoGroupByHeuristic([srcAuth, scriptsFoo]);
    const second = autoGroupByHeuristic([srcAuth, scriptsFoo]);
    expect(first.map((g) => g.id).sort()).toEqual(
      second.map((g) => g.id).sort(),
    );
  });

  it("handles a single file input (one group with one file)", () => {
    const result = autoGroupByHeuristic([srcAuth]);
    expect(result).toHaveLength(1);
    expect(result[0].files).toEqual([srcAuth]);
    expect(result[0].id).toBe("src-ts");
  });

  it("splits an oversized bucket via FFD into sub-groups with -p{n} suffix", () => {
    /** Force a split by passing a tiny maxGroupBytes so even 20 B files
     * exceed the limit. The helper should emit multiple sub-groups. */
    const result = autoGroupByHeuristic(
      [srcAuth, srcAuthTest, srcDb],
      10, // 10 bytes — every file is larger than this
    );
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Every original file must appear in exactly one sub-group
    const allFiles = result.flatMap((g) => g.files).sort();
    expect(allFiles).toEqual([srcAuth, srcAuthTest, srcDb].sort());
    // Split sub-group ids carry a "-p{n}" or prefix suffix
    for (const g of result) {
      expect(g.id).toMatch(/^src-ts/);
    }
  });

  it("assigns unique ids when two distinct paths collapse to the same raw id", () => {
    /** Two different "src" directories produce the same lastDir="src" — the
     *  second one must get a unique-id suffix (e.g. src-ts_2). We simulate
     *  this by creating a second dir literally named "src" under a different
     *  parent. */
    const altRoot = join(tmpRoot, "alt");
    const altSrc = join(altRoot, "src");
    mkdirSync(altSrc, { recursive: true });
    const altFile = join(altSrc, "other.ts");
    writeFileSync(altFile, "export {};\n", "utf-8");

    const result = autoGroupByHeuristic([srcAuth, altFile]);
    expect(result).toHaveLength(2);
    const ids = result.map((g) => g.id).sort();
    // Both start with "src-ts" but the second one has a counter suffix
    expect(ids[0]).toBe("src-ts");
    expect(ids[1]).toMatch(/^src-ts_\d+$/);
  });
});

// ── splitPerFileSections ───────────────────────────────────────────────

describe("splitPerFileSections", () => {
  const fileA = "/path/to/src/auth.ts";
  const fileB = "/path/to/src/db.ts";
  const fileC = "/path/to/src/routes.ts";

  it("returns empty map for empty input", () => {
    expect(splitPerFileSections("", [fileA]).size).toBe(0);
    expect(splitPerFileSections("some content", []).size).toBe(0);
  });

  it("returns empty map when no `## File:` headers are present", () => {
    /** If the LLM didn't emit the structured format, fall through */
    expect(
      splitPerFileSections("just a plain response", [fileA]).size,
    ).toBe(0);
  });

  it("parses exact-path sections", () => {
    const content =
      `## File: ${fileA}\n\n` +
      `Body for auth.\n\n---\n\n` +
      `## File: ${fileB}\n\n` +
      `Body for db.`;
    const result = splitPerFileSections(content, [fileA, fileB]);
    expect(result.size).toBe(2);
    expect(result.get(fileA)).toBe("Body for auth.");
    expect(result.get(fileB)).toBe("Body for db.");
  });

  it("matches by suffix when LLM emits only a relative path", () => {
    /** Some LLMs drop the leading slash or directory prefix */
    const content =
      `## File: src/auth.ts\n\n` +
      `Body for auth.\n`;
    const result = splitPerFileSections(content, [fileA, fileB]);
    expect(result.get(fileA)).toBe("Body for auth.");
  });

  it("matches by basename when LLM emits only the filename", () => {
    const content =
      `## File: auth.ts\n\n` +
      `Body for auth.`;
    const result = splitPerFileSections(content, [fileA, fileB]);
    expect(result.get(fileA)).toBe("Body for auth.");
  });

  it("tolerates Windows-style CRLF line endings", () => {
    /** The trailing \r is stripped via .trim() on the captured path */
    const content =
      `## File: ${fileA}\r\n\r\n` +
      `Body for auth.\r\n\r\n---\r\n\r\n` +
      `## File: ${fileB}\r\n\r\n` +
      `Body for db.\r\n`;
    const result = splitPerFileSections(content, [fileA, fileB]);
    expect(result.size).toBe(2);
    expect(result.get(fileA)).toBe("Body for auth.");
    // The body for the last file may include trailing whitespace — trimmed.
    expect(result.get(fileB)?.startsWith("Body for db.")).toBe(true);
  });

  it("tolerates backtick and quote decorations around the path", () => {
    const content =
      '## File: `' + fileA + '`\n\n' +
      'Body with backticks.\n';
    const result = splitPerFileSections(content, [fileA]);
    expect(result.get(fileA)).toBe("Body with backticks.");
  });

  it("omits files for which the LLM produced no section", () => {
    /** If the LLM skips a file, the map must not contain that key — the
     * caller uses this to build a MISSING SECTIONS summary */
    const content =
      `## File: ${fileA}\n\n` +
      `Only auth was analysed.`;
    const result = splitPerFileSections(content, [fileA, fileB, fileC]);
    expect(result.has(fileA)).toBe(true);
    expect(result.has(fileB)).toBe(false);
    expect(result.has(fileC)).toBe(false);
  });

  it("does not overwrite a matched section with a duplicate header", () => {
    /** If the LLM emits the same file twice, keep the first section */
    const content =
      `## File: ${fileA}\n\n` +
      `First version.\n\n---\n\n` +
      `## File: ${fileA}\n\n` +
      `Second version.`;
    const result = splitPerFileSections(content, [fileA]);
    expect(result.get(fileA)).toBe("First version.");
  });

  it("trims the trailing section separator `---`", () => {
    const content =
      `## File: ${fileA}\n\n` +
      `Body with separator.\n\n---\n\n` +
      `## File: ${fileB}\n\n` +
      `Other.`;
    const result = splitPerFileSections(content, [fileA, fileB]);
    expect(result.get(fileA)).toBe("Body with separator.");
    expect(result.get(fileA)?.endsWith("---")).toBe(false);
  });

  it("handles a single-file section without trailing separator", () => {
    const content =
      `## File: ${fileA}\n\n` +
      `Just one file.`;
    const result = splitPerFileSections(content, [fileA]);
    expect(result.get(fileA)).toBe("Just one file.");
  });
});
