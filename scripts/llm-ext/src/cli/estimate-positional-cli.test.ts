// NEEDS BUILD (npm run build): spawns dist/llm-ext.js on a throwaway HOME/config dir, installs no rule, sends no request (every case ends at an estimate or a refusal before dispatch).
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);
const PAID = ["active: p", "profiles:", "  p:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: $ESTP_KEY", "    model: vendor/m", ""].join("\n");

async function run(args: string[], settings?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const dir = mkdtempSync("/tmp/__llm_ext_estpos_");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  writeFileSync(join(dir, "b.txt"), "world\n");
  if (settings !== undefined) writeFileSync(join(dir, "settings.yaml"), settings);
  try {
    const o = await execFileAsync("node", [CLI_SCRIPT, ...args], { cwd: dir, env: { ...process.env, HOME: dir, LLM_EXT_CONFIG_DIR: dir, LLM_EXT_INSTALL_RULE: "0", ESTP_KEY: "k" }, timeout: 60_000 });
    return { stdout: o.stdout, stderr: o.stderr, code: 0 };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", code: x.code ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("llm-ext dry runs (built CLI)", () => {
  // TRDD-UVU9S4RV: the lone positional file stayed a string and the estimate resolver read only arrays.
  it("llm ask <file> --estimate counts the positional file", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "x", "--estimate"], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/files: 1\b/);
    expect(r.stdout).not.toContain("no input files");
  });
  // TRDD-118TUPJJ: a global flag before the group is accepted, every one of them.
  it.each([["--quiet"], ["--estimate"]])("global %s before the group is accepted", async (flag) => {
    const r = await run([flag, "llm", "ask", "a.txt", "--instructions", "x", ...(flag === "--estimate" ? [] : ["--estimate"])], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/files: 1\b/);
  });
  it("global --preview before the group lists the positional file", async () => {
    const r = await run(["--preview", "llm", "ask", "a.txt", "--instructions", "x"], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("included: 1");
  });
  // Pins CURRENT behaviour (candidate defect, TRDD-FP2SAF4P item 1): main.ts strips the dry-run flag from anywhere in argv, even after a bare `--`, and parseFlags then rejects the leftover `--`, so the command exits 1 with no dry-run output instead of treating `--estimate` as a file name or running the dry run.
  it.each([
    [["scan_folder", "--folder_path", ".", "--", "--estimate"], "unknown flag -- for 'scan-folder'"],
    [["scan", "folder", ".", "--", "--estimate"], "unknown flag -- for 'scan folder'"],
    [["scan_folder", "--folder_path", ".", "--", "--preview"], "unknown flag -- for 'scan-folder'"],
    [["scan", "folder", ".", "--", "--preview"], "unknown flag -- for 'scan folder'"],
  ])("a dry-run flag after a bare `--` is consumed, then the `--` is rejected: %j", async (args, message) => {
    const r = await run(args, PAID);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`llm-ext: ${message}. Run 'llm-ext`);
  });
  // TRDD-OK1NN5RN: a repeated array flag used to keep only its last value.
  it("a repeated --input_files_paths keeps every file", async () => {
    const r = await run(["llm", "code", "--input_files_paths", "a.txt", "--input_files_paths", "b.txt", "--instructions", "x", "--preview"], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("included: 2");
  });
  it("a positional file plus the same flag keeps both", async () => {
    const r = await run(["llm", "code", "a.txt", "--input_files_paths", "b.txt", "--instructions", "x", "--preview"], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("included: 2");
  });
  it("a file repeated among others is kept each time", async () => {
    const r = await run(["llm", "code", "--input_files_paths", "a.txt", "--input_files_paths", "b.txt", "--input_files_paths", "a.txt", "--instructions", "x", "--preview"], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("included: 3");
  });
  // Duplicates carry meaning: the merged list handed to parseFileGroups must keep the shared file in both GROUP blocks (the preview shows that list; it does not run parseFileGroups).
  it("repeated GROUP-marker occurrences keep both GROUP blocks with the shared file in the merged list", async () => {
    const r = await run(["llm", "code", "--input_files_paths", '["---GROUP:a---","a.txt","---/GROUP:a---"]', "--input_files_paths", '["---GROUP:b---","a.txt","---/GROUP:b---"]', "--instructions", "x", "--preview"], PAID);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\+ ---GROUP:a---\n\s*\+ a\.txt\n\s*\+ ---\/GROUP:a---\n\s*\+ ---GROUP:b---\n\s*\+ a\.txt\n\s*\+ ---\/GROUP:b---/);
  });
  // Fresh install: the free pool is empty and an estimate starts no repair, so it must not say a benchmark is running.
  it("an estimate on a never-populated free pool does not claim a background benchmark", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "x", "--estimate"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("A background benchmark is refreshing");
  });
});
