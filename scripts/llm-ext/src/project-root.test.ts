// Unit tests for the single-source project-root resolver. The core regression:
// CLAUDE_PROJECT_DIR is used VERBATIM and we do NOT climb to the git root, so
// reports never land outside the project (the bug where a project nested in a
// larger repo / a linked worktree got its reports written to the ancestor).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { resolveProjectMainRoot } from "./project-root.js";

const tmpDirs: string[] = [];
const savedProjDir = process.env.CLAUDE_PROJECT_DIR;

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join("/tmp", prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  if (savedProjDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveProjectMainRoot", () => {
  it("an explicit override wins over everything", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/other/place";
    expect(resolveProjectMainRoot("/explicit/root")).toBe("/explicit/root");
  });

  it("uses CLAUDE_PROJECT_DIR VERBATIM — does NOT climb to the git root (the bug fix)", () => {
    // A git repo with a nested subdir; CLAUDE_PROJECT_DIR points at the subdir.
    const repo = mkTmp("pr-repo-");
    execSync("git init -q --initial-branch=main", { cwd: repo });
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = sub;
    // Must return the subdir itself, NOT `repo` (the git root). The old code
    // climbed to `repo`, pushing reports outside the project the agent works in.
    expect(resolveProjectMainRoot()).toBe(sub);
  });

  it("ignores a CLAUDE_PROJECT_DIR that does not exist on disk", () => {
    process.env.CLAUDE_PROJECT_DIR = "/nope/does/not/exist/xyz";
    // Falls through to git/cwd — must NOT echo the bogus path back.
    expect(resolveProjectMainRoot()).not.toBe("/nope/does/not/exist/xyz");
  });
});
