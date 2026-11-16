// NEEDS BUILD (npm run build): spawns dist/llm-ext.js on a throwaway HOME/config dir, installs no rule, sends no request (every case ends at a refusal or an estimate before dispatch).
// TRDD-WB9N5UDV: a repeated scalar flag used to keep only its last value silently.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);
const PAID = ["active: p", "profiles:", "  p:", "    profile-type: paid", "    mode: remote", "    api: openrouter-remote", "    api_key: $RPT_KEY", "    model: vendor/m", ""].join("\n");

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const dir = mkdtempSync("/tmp/__llm_ext_rptscalar_");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  writeFileSync(join(dir, "b.txt"), "world\n");
  writeFileSync(join(dir, "settings.yaml"), PAID);
  try {
    const o = await execFileAsync("node", [CLI_SCRIPT, ...args], { cwd: dir, env: { ...process.env, HOME: dir, LLM_EXT_CONFIG_DIR: dir, LLM_EXT_INSTALL_RULE: "0", RPT_KEY: "k" }, timeout: 60_000 });
    return { stdout: o.stdout, stderr: o.stderr, code: 0 };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", code: x.code ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("llm-ext repeated scalar flag (built CLI)", () => {
  it("a repeated --instructions exits non-zero and names the flag", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "a", "--instructions", "b", "--estimate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--instructions was given more than once");
  });
  it("kebab plus underscore spelling of one flag is a repeat; two different flags are not", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions_files_paths", "a.txt", "--instructions", "a", "--estimate"]);
    expect(r.code).toBe(0);
    const k = await run(["llm", "ask", "a.txt", "--max-files", "10", "--max_files", "20", "--instructions", "a", "--estimate"]);
    expect(k.code).not.toBe(0);
    expect(k.stderr).toContain("was given more than once");
  });
  it("a repeated number flag is refused too", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "a", "--max_files", "10", "--max_files", "20", "--estimate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--max_files was given more than once");
  });
  it("a positional plus the same scalar flag is refused naming the flag", async () => {
    const r = await run(["llm", "summarize", "a.txt", "--input_file", "b.txt", "--estimate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--input_file was given more than once");
  });
it("-o plus --output_dir (the same flag) is refused", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "a", "-o", "/tmp/__rpt_o1", "--output_dir", "/tmp/__rpt_o2", "--estimate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("was given more than once");
  });
  it("two timeout aliases do not collide with the scalar refusal (consumed before parseFlags)", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "a", "--timeout", "50", "--command_timeout", "60", "--estimate"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("was given more than once");
  });
  it("a repeated boolean flag is not refused (last-wins, unchanged)", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "a", "--scan_secrets", "true", "--scan_secrets", "false", "--estimate"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("was given more than once");
  });
  it("a positional with no repeated flag still runs", async () => {
    const r = await run(["llm", "ask", "a.txt", "--instructions", "a", "--estimate"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/files: 1\b/);
  });
});
