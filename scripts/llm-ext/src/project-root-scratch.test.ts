/**
 * TRDD-PNU8XECB — the scratch-output root and the per-file-piece router.
 *
 * USER directive 2026-11-15: reports/ (git-tracked) holds only final, complete or
 * merged reports; reports_dev/ (gitignored) holds intermediate artifacts. These tests
 * pin defaultScratchDir()'s precedence chain and mergePieceDir()'s FINAL/INTERMEDIATE
 * decision against real temp directories (resolveProjectMainRoot only honours a
 * CLAUDE_PROJECT_DIR that exists on disk).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetDefaultOutputDirCache,
  defaultOutputDir,
  defaultScratchDir,
  mergePieceDir,
} from "./project-root.js";

const ENV_KEYS = ["CLAUDE_PROJECT_DIR", "LLM_EXT_OUTPUT_DIR", "LLM_EXT_SCRATCH_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), "llmext-scratch-root-"));
  process.env.CLAUDE_PROJECT_DIR = root;
  _resetDefaultOutputDirCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetDefaultOutputDirCache();
  rmSync(root, { recursive: true, force: true });
});

describe("defaultScratchDir", () => {
  it("defaults to <project>/reports_dev/llm-externalizer while final reports stay in reports/", () => {
    expect(defaultScratchDir()).toBe(join(root, "reports_dev", "llm-externalizer"));
    expect(defaultOutputDir()).toBe(join(root, "reports", "llm-externalizer"));
  });

  it("honours an explicit main-root override like defaultOutputDir does", () => {
    process.env.LLM_EXT_SCRATCH_DIR = join(root, "ignored");
    expect(defaultScratchDir("/tmp/fake-root")).toBe("/tmp/fake-root/reports_dev/llm-externalizer");
  });

  it("LLM_EXT_SCRATCH_DIR relocates only the scratch root", () => {
    process.env.LLM_EXT_SCRATCH_DIR = join(root, "scratch-here");
    expect(defaultScratchDir()).toBe(resolve(root, "scratch-here"));
    expect(defaultOutputDir()).toBe(join(root, "reports", "llm-externalizer"));
  });

  it("LLM_EXT_OUTPUT_DIR alone keeps every write in that one dir (isolation is not leaked)", () => {
    process.env.LLM_EXT_OUTPUT_DIR = join(root, "iso");
    expect(defaultScratchDir()).toBe(resolve(root, "iso"));
    expect(defaultOutputDir()).toBe(resolve(root, "iso"));
  });

  it("LLM_EXT_SCRATCH_DIR wins over LLM_EXT_OUTPUT_DIR", () => {
    process.env.LLM_EXT_OUTPUT_DIR = join(root, "iso");
    process.env.LLM_EXT_SCRATCH_DIR = join(root, "scr");
    expect(defaultScratchDir()).toBe(resolve(root, "scr"));
  });

  it("is recomputed after _resetDefaultOutputDirCache", () => {
    expect(defaultScratchDir()).toBe(join(root, "reports_dev", "llm-externalizer"));
    process.env.LLM_EXT_SCRATCH_DIR = join(root, "later");
    _resetDefaultOutputDirCache();
    expect(defaultScratchDir()).toBe(resolve(root, "later"));
  });
});

describe("mergePieceDir", () => {
  it("routes pieces of a merging run to the scratch root", () => {
    expect(mergePieceDir(undefined, true)).toBe(join(root, "reports_dev", "llm-externalizer"));
  });

  it("leaves mode-0 per-file reports on the final default (undefined = defaultOutputDir)", () => {
    expect(mergePieceDir(undefined, false)).toBeUndefined();
  });

  it("an explicit output dir wins for pieces too", () => {
    expect(mergePieceDir("/x/out", true)).toBe("/x/out");
    expect(mergePieceDir("/x/out", false)).toBe("/x/out");
  });
});
