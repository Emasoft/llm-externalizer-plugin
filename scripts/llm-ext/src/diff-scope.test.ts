/**
 * Diff-mode scoping tests (TRDD-MNK2YNH0) — against a REAL fixture repo built
 * in a tmpdir (git init + commits), never a mock: the module's whole job is
 * delegating to git correctly, so a mocked git would test nothing.
 * Load-bearing negatives: zero-diff THROWS (a review of nothing must say so),
 * mixed modes THROW, flag-shaped refs are rejected before reaching git.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiffMode, resolveDiffScope } from "./diff-scope.js";

let repo: string;

function g(...argv: string[]): string {
  return execFileSync("git", argv, { cwd: repo, encoding: "utf-8" });
}

beforeAll(() => {
  repo = mkdtempSync(join("/tmp", "llm-ext-diffscope-"));
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  g("add", "a.ts", "b.ts");
  g("commit", "-qm", "base");
  // Range commit: change alpha()'s body.
  writeFileSync(join(repo, "a.ts"), "export function alpha() {\n  return 2;\n}\n");
  g("add", "a.ts");
  g("commit", "-qm", "change alpha");
  // Workspace: modify b (unstaged) + add an untracked file.
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  writeFileSync(join(repo, "untracked.ts"), "export const u = 1;\n");
});

describe("parseDiffMode", () => {
  it("null when no diff args — tools keep their non-diff behavior", () => {
    expect(parseDiffMode({})).toBeNull();
    expect(parseDiffMode({ folder_path: "/x" })).toBeNull();
  });
  it("mixed modes throw; half a range throws; flag-shaped refs throw", () => {
    expect(() => parseDiffMode({ diff_workspace: true, diff_commit: "HEAD" })).toThrow(/ONE of/);
    expect(() => parseDiffMode({ diff_from: "main" })).toThrow(/BOTH/);
    expect(() => parseDiffMode({ diff_commit: "--exec=x" })).toThrow(/invalid/);
  });
});

describe("resolveDiffScope — delegated to a real git repo", () => {
  it("workspace mode: modified + untracked files, each with hunks", () => {
    const s = resolveDiffScope({ kind: "workspace" }, repo);
    const names = s.files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["b.ts", "untracked.ts"]);
    const bHunk = [...s.hunksByFile.entries()].find(([k]) => k.endsWith("b.ts"))?.[1] ?? "";
    expect(bHunk).toContain("-export const b = 1;");
    expect(bHunk).toContain("+export const b = 2;");
  });

  it("commit mode: one commit vs its parent, hunk carries git's enclosing-function context", () => {
    const s = resolveDiffScope({ kind: "commit", commit: "HEAD" }, repo);
    expect(s.files.map((f) => f.split("/").pop())).toEqual(["a.ts"]);
    const hunk = [...s.hunksByFile.values()][0];
    // --function-context widens to the whole function, so the signature line
    // appears in the hunk body — the reviewer sees WHERE the change lives.
    expect(hunk).toContain("export function alpha()");
    expect(hunk).toContain("+  return 2;");
  });

  it("range mode: merge-base '...' semantics over the two fixture commits", () => {
    const s = resolveDiffScope({ kind: "range", from: "HEAD^", to: "HEAD" }, repo);
    expect(s.files.map((f) => f.split("/").pop())).toEqual(["a.ts"]);
  });

  it("THROWS on a diff with no reviewable files — never a silent empty review", () => {
    // HEAD...HEAD is an empty range.
    expect(() => resolveDiffScope({ kind: "range", from: "HEAD", to: "HEAD" }, repo)).toThrow(
      /no reviewable files/,
    );
  });

  it("THROWS outside a git repository — diff modes need git, loudly", () => {
    const notRepo = mkdtempSync(join("/tmp", "llm-ext-notrepo-"));
    expect(() => resolveDiffScope({ kind: "workspace" }, notRepo)).toThrow(/not inside a git/);
  });
});
