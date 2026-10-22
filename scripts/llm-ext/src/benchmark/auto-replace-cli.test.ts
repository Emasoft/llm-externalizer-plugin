// CLI-surface tests for `--auto-replace` / `--apply` (TRDD-828238b5 A7-P3).
//
// These spawn the REAL parseArgs + main() routing + runAutoReplacePhase glue end
// to end. They are HERMETIC by construction: an EMPTY ledger means every
// incumbent is healthy, so planToolReplacements runs ZERO benchmarks — no
// network, no API key needed. A tmp LLM_EXT_CONFIG_DIR holds settings.yaml +
// the (absent) ledger; a tmp CLAUDE_PROJECT_DIR receives the report. We assert
// the advisory posture, the gate (--apply requires --auto-replace), and that
// NOTHING is written to settings in the advisory path.
//
// row99 fix-queue item 6 (S6): these used to spawn dist/benchmark.js — build
// output that `npm run build` may not have refreshed, so a green run here
// could still be exercising yesterday's behavior. Converted to
// settings-resolution-failfast.test.ts's own pattern: build the bundle HERE,
// from the CURRENT source, with esbuild, so a change to index.ts is always
// what these tests actually run against.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBenchmarkTestBundle, cleanupTestBundle, type TestBundle } from "./test-bundle.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let bundle: TestBundle;
let BENCH_JS = "";

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
  // review of 43e3694 (S5): auto-replace's report now routes through
  // defaultOutputDir(), which honours LLM_EXT_OUTPUT_DIR when set — a value
  // leaked in from the HOST shell that invoked this test suite would move
  // the report outside the tmp `root` these tests assert against, and
  // `readdirSync(reportDir)` below would throw ENOENT instead of failing on
  // the assertion. Delete it from the child env explicitly, same as
  // cli-contract.test.ts already does for OPENROUTER_API_KEY.
  const fullEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete fullEnv.LLM_EXT_OUTPUT_DIR;
  return spawnSync(process.execPath, [BENCH_JS, ...args], {
    encoding: "utf-8",
    env: fullEnv,
  });
}

describe("benchmark CLI — --auto-replace / --apply (TRDD-828238b5 A7-P3)", () => {
  let cfg = "";
  let root = "";

  beforeAll(async () => {
    // See test-bundle.ts's own doc comment for why realpathSync matters here
    // (macOS /tmp symlink vs. index.ts's self-execution guard).
    bundle = await buildBenchmarkTestBundle(HERE, "arcli-bundle-");
    BENCH_JS = bundle.benchJs;
  });

  afterAll(() => {
    cleanupTestBundle(bundle);
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
    // row99 fix-queue item 1: `active:` is the live default-profile pointer
    // again (5502ca5/c1646e6, TRDD-G6XT3AY9) and costGateProfile/
    // benchmarkTargetProfile now resolve it the same way cli/main.ts does —
    // NO --profile here on purpose, so this proves the fixture's `active: t`
    // is what gets targeted (not the built-in `free`), through main()'s own
    // fail-fast resolution (CLAUDE.md fail-fast rule): a mismatch here would
    // refuse outright instead of silently running against the wrong profile.
    //
    // row99 fix-queue item 6 (S6): this is the discriminating case — proven by
    // temporarily reverting benchmarkTargetProfile to `explicit ||
    // DEFAULT_PROFILE_NAME` (dropping the `active:` fallback): this test goes
    // red (the generated-target refusal fires for 'free' instead of running
    // against 'active: t'); restoring the source makes it green again.
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
    // row99c SF6: routed through defaultOutputDir() (project-root.ts), which
    // nests under <project>/reports/llm-externalizer/ — the ONLY USER-approved
    // report root — instead of the old <project>/reports/auto-replace/.
    const reportDir = join(root, "reports", "llm-externalizer", "auto-replace");
    const reports = readdirSync(reportDir).filter((f) => f.endsWith("-auto-replace.md"));
    expect(reports.length).toBe(1);
    const md = readFileSync(join(reportDir, reports[0]!), "utf-8");
    expect(md).toContain("Auto-replacement plan");
    expect(md).toContain("ADVISORY ONLY");
    // The advisory path MUST NOT have touched settings.yaml.
    expect(readFileSync(join(cfg, "settings.yaml"), "utf-8")).not.toContain("tool_models");
  });

  it("--auto-replace --apply on a healthy ledger writes nothing (no changed recommendation)", () => {
    // P6b-fix2 B-1: --apply names its target with --profile explicitly here,
    // so this fixture's absent `active:` is moot either way -- an unnamed
    // target would resolve to the built-in default ('free', TRDD-G6XT3AY9's
    // fallback when `active:` is also absent) — a GENERATED section this
    // command must refuse.
    const r = runBench(["--auto-replace", "--apply", "--profile", "t"], {
      LLM_EXT_CONFIG_DIR: cfg,
      CLAUDE_PROJECT_DIR: root,
    });
    expect(r.status).toBe(0);
    // No degraded incumbent → no changed recommendation → nothing to write.
    expect(`${r.stdout}${r.stderr}`).toMatch(/no changed recommendation to adopt/);
    expect(readFileSync(join(cfg, "settings.yaml"), "utf-8")).not.toContain("tool_models");
  });
});
