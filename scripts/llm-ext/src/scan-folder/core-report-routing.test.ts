/**
 * TRDD-PNU8XECB — where runScanFolder writes its per-file pieces and its merged report.
 *
 * Mode 1/2 merge the per-file reports into final reports: the pieces are INTERMEDIATE
 * (gitignored reports_dev/llm-externalizer/) and the merged report is FINAL (tracked
 * reports/llm-externalizer/). Mode 0 delivers the per-file reports themselves, so they
 * stay FINAL. The per-file LLM call is the injected seam; the pieces and the merged
 * report are really written to temp directories so the merge reads real files.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetDefaultOutputDirCache, defaultOutputDir } from "../project-root.js";
import { runScanFolder, type ScanFolderDeps } from "./core.js";

const ENV_KEYS = ["CLAUDE_PROJECT_DIR", "LLM_EXT_OUTPUT_DIR", "LLM_EXT_SCRATCH_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
let srcDir: string;

interface Seen {
  pieceDirs: (string | undefined)[];
  mergedDirs: (string | undefined)[];
  mergedPaths: string[];
}

function makeDeps(seen: Seen, outputDir?: string): ScanFolderDeps {
  return {
    useEnsemble: false,
    backendModel: "test-model",
    outputDir,
    processFileCheck: async (filePath, _task, options) => {
      seen.pieceDirs.push(options.outputDir);
      // Mirror saveResponse: undefined means the final default root.
      const dir = options.outputDir ?? defaultOutputDir();
      mkdirSync(dir, { recursive: true });
      const reportPath = join(dir, `piece-${options.fileIndex ?? 0}.md`);
      writeFileSync(reportPath, `review of ${filePath}`, "utf-8");
      return { filePath, success: true, reportPath };
    },
    classifyError: (err) => ({ reason: String(err) }),
    saveResponse: (_tool, content, _meta, _unused, dir) => {
      seen.mergedDirs.push(dir);
      const target = dir ?? defaultOutputDir();
      mkdirSync(target, { recursive: true });
      const p = join(target, `merged-${seen.mergedPaths.length}.md`);
      writeFileSync(p, content, "utf-8");
      seen.mergedPaths.push(p);
      return p;
    },
    getRateLimitConfig: async () => ({ rps: 100, maxInFlight: 4 }),
    resolveDefaultMaxTokens: () => 1000,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), "llmext-sf-routing-root-"));
  process.env.CLAUDE_PROJECT_DIR = root;
  _resetDefaultOutputDirCache();
  // sanitizeInputPath only accepts paths under an allowed root (cwd), not /tmp.
  srcDir = mkdtempSync(join(process.cwd(), "sf-routing-src-"));
  writeFileSync(join(srcDir, "a.ts"), "export const a = 1;\n", "utf-8");
  writeFileSync(join(srcDir, "b.ts"), "export const b = 2;\n", "utf-8");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetDefaultOutputDirCache();
  rmSync(root, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

const args = (mode: number) => ({
  folder_path: srcDir,
  instructions: "find bugs",
  answer_mode: mode,
  use_gitignore: false,
});

describe("runScanFolder report routing (TRDD-PNU8XECB)", () => {
  it("mode 2: per-file pieces go to reports_dev (INTERMEDIATE), the merged report to reports (FINAL)", async () => {
    const seen: Seen = { pieceDirs: [], mergedDirs: [], mergedPaths: [] };
    const res = await runScanFolder(args(2), makeDeps(seen));
    expect(res.isError).toBeFalsy();
    const scratch = join(root, "reports_dev", "llm-externalizer");
    expect(seen.pieceDirs).toEqual([scratch, scratch]);
    expect(seen.mergedDirs).toEqual([undefined]);
    expect(seen.mergedPaths[0]!.startsWith(join(root, "reports", "llm-externalizer") + "/")).toBe(true);
    // The merge really read the pieces from the scratch root.
    const merged = readFileSync(seen.mergedPaths[0]!, "utf-8");
    expect(merged).toContain(`review of ${join(srcDir, "a.ts")}`);
    expect(merged).toContain(`review of ${join(srcDir, "b.ts")}`);
  });

  it("mode 0: per-file reports are the deliverable and stay on the final default", async () => {
    const seen: Seen = { pieceDirs: [], mergedDirs: [], mergedPaths: [] };
    const res = await runScanFolder(args(0), makeDeps(seen));
    expect(res.isError).toBeFalsy();
    expect(seen.pieceDirs).toEqual([undefined, undefined]);
    expect(seen.mergedPaths).toEqual([]);
  });

  it("an explicit output dir receives the pieces and the merged report alike", async () => {
    const seen: Seen = { pieceDirs: [], mergedDirs: [], mergedPaths: [] };
    const out = join(root, "explicit");
    const res = await runScanFolder(args(2), makeDeps(seen, out));
    expect(res.isError).toBeFalsy();
    expect(seen.pieceDirs).toEqual([out, out]);
    expect(seen.mergedDirs).toEqual([out]);
  });
});
