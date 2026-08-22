import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTranscriptPath, projectSlug } from "./session-summary-resolve.js";

describe("resolveTranscriptPath", () => {
  let dir: string;
  let projectRoot: string;
  let projectsDir: string;
  let savedProjectDirName: string | undefined;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-summary-resolve-"));
    projectRoot = join(dir, "my-project");
    projectsDir = join(dir, "claude-projects");
    savedProjectDirName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedProjectDirName === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = savedProjectDirName;
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(sessionDir: string, name: string, timestampIso?: string) {
    const p = join(sessionDir, name);
    const lines: string[] = [];
    if (timestampIso) lines.push(JSON.stringify({ type: "user", timestamp: timestampIso }));
    writeFileSync(p, lines.map((l) => l + "\n").join(""));
    return p;
  }

  it("explicit --transcript wins over everything else", () => {
    const explicit = join(dir, "explicit.jsonl");
    writeFileSync(explicit, "");
    const result = resolveTranscriptPath({
      transcriptPath: explicit,
      projectRoot,
      claudeProjectsDir: projectsDir,
    });
    expect(result).toBe(explicit);
  });

  it("throws when --transcript path does not exist", () => {
    expect(() =>
      resolveTranscriptPath({ transcriptPath: join(dir, "missing.jsonl") }),
    ).toThrow(/does not exist/);
  });

  it("CLAUDE_CODE_PROJECT_DIR_NAME overrides the derived project slug", () => {
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "short-name";
    const sessionDir = join(projectsDir, "short-name");
    mkdirSync(sessionDir, { recursive: true });
    const p = writeTranscript(sessionDir, "a.jsonl");
    const result = resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir });
    expect(result).toBe(p);
  });

  it("slug fallback is unchanged when CLAUDE_CODE_PROJECT_DIR_NAME is unset", () => {
    const slug = projectSlug(projectRoot);
    const sessionDir = join(projectsDir, slug);
    mkdirSync(sessionDir, { recursive: true });
    const p = writeTranscript(sessionDir, "a.jsonl");
    const result = resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir });
    expect(result).toBe(p);
  });

  it("CLAUDE_CONFIG_DIR moves the default projects root when claudeProjectsDir option is absent", () => {
    const cfgDir = join(dir, "cfg");
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    const slug = projectSlug(projectRoot);
    const sessionDir = join(cfgDir, "projects", slug);
    mkdirSync(sessionDir, { recursive: true });
    const p = writeTranscript(sessionDir, "a.jsonl");
    // No claudeProjectsDir option passed — must fall through to CLAUDE_CONFIG_DIR/projects.
    const result = resolveTranscriptPath({ projectRoot });
    expect(result).toBe(p);
  });

  it("explicit claudeProjectsDir option beats CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = join(dir, "cfg-should-be-ignored");
    const slug = projectSlug(projectRoot);
    const sessionDir = join(projectsDir, slug);
    mkdirSync(sessionDir, { recursive: true });
    const p = writeTranscript(sessionDir, "a.jsonl");
    const result = resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir });
    expect(result).toBe(p);
  });

  it("picks the transcript with the latest in-file timestamp, not the latest mtime", () => {
    const sessionDir = join(projectsDir, projectSlug(projectRoot));
    mkdirSync(sessionDir, { recursive: true });
    // "old" has the newer file mtime but an older in-transcript timestamp;
    // "new" has an older mtime but the genuinely latest timestamp — mirrors
    // Claude Code 2.1.239's fix: touching/reopening a file must not make it
    // look like the most recently active session.
    const oldPath = writeTranscript(sessionDir, "old.jsonl", "2020-01-01T00:00:00.000Z");
    const newPath = writeTranscript(sessionDir, "new.jsonl", "2025-01-01T00:00:00.000Z");
    const past = new Date("2021-01-01T00:00:00.000Z");
    const future = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(newPath, past, past);
    utimesSync(oldPath, future, future);

    const result = resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir });
    expect(result).toBe(newPath);
  });

  it("falls back to mtime when a transcript has no parseable timestamp", () => {
    const sessionDir = join(projectsDir, projectSlug(projectRoot));
    mkdirSync(sessionDir, { recursive: true });
    const noTsPath = writeTranscript(sessionDir, "no-ts.jsonl");
    const withTsPath = writeTranscript(sessionDir, "with-ts.jsonl", "2020-01-01T00:00:00.000Z");
    const past = new Date("2021-01-01T00:00:00.000Z");
    const future = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(withTsPath, past, past);
    utimesSync(noTsPath, future, future);

    const result = resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir });
    // no-ts has no timestamp so it's ranked by its (newer) mtime and wins.
    expect(result).toBe(noTsPath);
  });

  it("throws when --session-id has no matching transcript", () => {
    const sessionDir = join(projectsDir, projectSlug(projectRoot));
    mkdirSync(sessionDir, { recursive: true });
    expect(() =>
      resolveTranscriptPath({
        projectRoot,
        claudeProjectsDir: projectsDir,
        sessionId: "missing-session",
      }),
    ).toThrow(/no transcript for --session-id/);
  });

  it("throws when the project's transcript directory does not exist", () => {
    expect(() =>
      resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir }),
    ).toThrow(/no transcript directory/);
  });

  it("throws when the transcript directory exists but has no .jsonl files", () => {
    const sessionDir = join(projectsDir, projectSlug(projectRoot));
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "not-a-transcript.txt"), "x");
    expect(() =>
      resolveTranscriptPath({ projectRoot, claudeProjectsDir: projectsDir }),
    ).toThrow(/no \.jsonl transcripts found/);
  });
});
