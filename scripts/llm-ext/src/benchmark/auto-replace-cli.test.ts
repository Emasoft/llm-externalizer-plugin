// CLI-surface tests for `--auto-replace` / `--apply` (TRDD-828238b5 A7-P3).
//
// These spawn the bundled benchmark entry point (dist/benchmark.js) so they
// exercise the REAL parseArgs + main() routing + runAutoReplacePhase glue end to
// end. They are HERMETIC by construction: an EMPTY ledger means every incumbent
// is healthy, so planToolReplacements runs ZERO benchmarks — no network, no API
// key needed. A tmp LLM_EXT_CONFIG_DIR holds settings.yaml + the (absent) ledger;
// a tmp CLAUDE_PROJECT_DIR receives the report. We assert the advisory posture,
// the gate (--apply requires --auto-replace), and that NOTHING is written to
// settings in the advisory path.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/benchmark → scripts/llm-ext, then dist/benchmark.js (the bundled entry).
const BENCH_JS = join(HERE, "..", "..", "dist", "benchmark.js");

const SETTINGS = [
  "active: t",
  "profiles:",
  "  t:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    model: google/gemini-2.5-flash",
  "    api_key: sk-test-literal",
  "",
].join("\n");

function runBench(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [BENCH_JS, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe("benchmark CLI — --auto-replace / --apply (TRDD-828238b5 A7-P3)", () => {
  let cfg = "";
  let root = "";

  beforeAll(() => {
    // The bundle must exist (npm run build is a prerequisite of npm test).
    expect(existsSync(BENCH_JS)).toBe(true);
  });

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "arcli-cfg-"));
    root = mkdtempSync(join("/tmp", "arcli-root-"));
    writeFileSync(join(cfg, "settings.yaml"), SETTINGS);
  });
  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("--apply without --auto-replace fails fast with a clear message", () => {
    const r = runBench(["--apply"], {
      LLM_EXT_CONFIG_DIR: cfg,
      CLAUDE_PROJECT_DIR: root,
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/--apply requires --auto-replace/);
  });

  it("--auto-replace on a healthy ledger runs no benchmark, writes a report, writes NO settings", () => {
    const r = runBench(["--auto-replace"], {
      LLM_EXT_CONFIG_DIR: cfg,
      CLAUDE_PROJECT_DIR: root,
    });
    expect(r.status).toBe(0);
    const combined = `${r.stdout}${r.stderr}`;
    // Advisory posture announced; zero replacements on a healthy ledger.
    expect(combined).toMatch(/ADVISORY only/);
    expect(r.stdout).toMatch(/recommended_replacements=0/);
    // A report file was written under the tmp project root.
    const reportDir = join(root, "reports", "auto-replace");
    expect(existsSync(reportDir)).toBe(true);
    const reports = readdirSync(reportDir).filter((f) => f.endsWith("-auto-replace.md"));
    expect(reports.length).toBe(1);
    const md = readFileSync(join(reportDir, reports[0]!), "utf-8");
    expect(md).toContain("Auto-replacement plan");
    expect(md).toContain("ADVISORY ONLY");
    // The advisory path MUST NOT have touched settings.yaml.
    expect(readFileSync(join(cfg, "settings.yaml"), "utf-8")).not.toContain("tool_models");
  });

  it("--auto-replace --apply on a healthy ledger writes nothing (no changed recommendation)", () => {
    const r = runBench(["--auto-replace", "--apply"], {
      LLM_EXT_CONFIG_DIR: cfg,
      CLAUDE_PROJECT_DIR: root,
    });
    expect(r.status).toBe(0);
    // No degraded incumbent → no changed recommendation → nothing to write.
    expect(`${r.stdout}${r.stderr}`).toMatch(/no changed recommendation to adopt/);
    expect(readFileSync(join(cfg, "settings.yaml"), "utf-8")).not.toContain("tool_models");
  });
});
