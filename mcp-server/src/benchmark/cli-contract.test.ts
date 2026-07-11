// The CLI's machine-readable contract (P1 zero-token model pipeline).
//
// Every path must end with EXACTLY ONE `[OK] …` / `[FAILED] …` line on stdout and a
// correct exit code, so the slash command can print that line verbatim instead of
// asking an LLM to read stderr, judge whether the run worked, and pick a template.
//
// These spawn the REAL bundled entry point (dist/benchmark.js) — the same binary the
// slash commands run — and are HERMETIC: every case below either fails before the
// first API call, or picks from a synthetic on-disk cache. No network, no API key, no
// mocks of anything under test. A tmp LLM_EXT_CONFIG_DIR keeps every settings WRITE
// off the developer's real ~/.llm-externalizer.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_JS = join(HERE, "..", "..", "dist", "benchmark.js");

const SETTINGS = [
  "active: ens",
  "profiles:",
  "  ens:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    model: vendor/dead-model",
  "    second_model: vendor/live-model",
  "    api_key: sk-test-literal",
  "",
].join("\n");

/** A cache with 3 qualifying survivors + 1 flunker + 1 baseline. */
function cacheJson(): string {
  const base = {
    isBaseline: false,
    contextTokens: 200000,
    maxOutputTokens: 128000,
    supportsStructured: true,
    supportsReasoning: true,
    ok: true,
    pass: true,
    schemaCompliant: true,
    latencyMs: 1000,
  };
  return JSON.stringify({
    timestamp: "2026-07-11T10:00:00.000Z",
    keywords: ["JSON.parse(", "new URLSearchParams", "performance.now()"],
    groundTruth: {},
    roster: { candidates: [], baselines: [] },
    results: [
      { ...base, modelId: "v/best", name: "best", meanF1: 1.0, actualCost: 0.01, inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.2 },
      { ...base, modelId: "v/mid", name: "mid", meanF1: 0.98, actualCost: 0.02, inputDollarsPerMillion: 0.2, outputDollarsPerMillion: 0.3 },
      { ...base, modelId: "v/ok", name: "ok", meanF1: 0.96, actualCost: 0.03, inputDollarsPerMillion: 0.3, outputDollarsPerMillion: 0.4 },
      { ...base, modelId: "v/flunker", name: "flunker", pass: false, meanF1: 0.4, actualCost: 0.01, inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.1 },
      { ...base, modelId: "v/baseline", name: "baseline", isBaseline: true, meanF1: 1.0, actualCost: 0.9, inputDollarsPerMillion: 5, outputDollarsPerMillion: 9 },
    ],
  });
}

/** A ledger line in the exact on-disk format appendModelEvent writes. */
function ledgerLine(model: string, hoursAgo: number, kind: string, detail: string): string {
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  const ts = at.toISOString().replace(/\.\d{3}Z$/, "") + "+0000";
  return `${ts} - ${model} - ${kind} - ${detail}`;
}

describe("benchmark CLI — the [OK|FAILED] final-line contract", () => {
  let cfg = "";
  let root = "";

  beforeAll(() => {
    expect(existsSync(BENCH_JS)).toBe(true); // npm run build is a prerequisite of npm test
  });

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "cli-cfg-"));
    root = mkdtempSync(join("/tmp", "cli-root-"));
    writeFileSync(join(cfg, "settings.yaml"), SETTINGS);
  });
  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** Run the bundle with NO OpenRouter credentials unless the case supplies them. */
  function run(args: string[], extraEnv: Record<string, string> = {}) {
    const env = { ...process.env, LLM_EXT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, ...extraEnv };
    delete env.OPENROUTER_API_KEY;
    delete env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
    const r = spawnSync(process.execPath, [BENCH_JS, ...args], { encoding: "utf-8", env });
    const finals = (r.stdout ?? "").split("\n").filter((l) => /^\[(OK|FAILED)\] /.test(l));
    return { ...r, finals, final: finals[0] ?? "" };
  }

  function seedCache() {
    writeFileSync(join(cfg, "benchmark-results.json"), cacheJson());
  }

  it("self-checks the API key BEFORE any work and fails with ONE line (no agent probe needed)", () => {
    const r = run([]); // a real sweep — the one path that always needs a key
    expect(r.status).not.toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] OPENROUTER_API_KEY not set/);
  });

  it("does NOT demand a key for the free paths (--from-cache picks with no credentials)", () => {
    seedCache();
    const r = run(["--from-cache", "--pick-top-n", "3"]);
    expect(r.status).toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[OK\] top-3 picks: v\/best, v\/mid, v\/ok/);
    // Baselines and sub-threshold models are never picked.
    expect(r.final).not.toContain("v/baseline");
    expect(r.final).not.toContain("v/flunker");
  });

  it("exits NON-ZERO when the pick cannot be satisfied (the discarded-exit-code bug)", () => {
    // Only 3 models clear the gate; asking for 5 must FAIL loudly, not exit 0.
    seedCache();
    const r = run(["--from-cache", "--pick-top-n", "5"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] pick failed: .*only 3 model\(s\) cleared/);
  });

  it("writes the picks into the tmp config's settings.yaml (LLM_EXT_CONFIG_DIR is honored)", () => {
    seedCache();
    const r = run(["--from-cache", "--pick-top-n", "3", "--apply-profile", "ens"]);
    expect(r.status).toBe(0);
    expect(r.final).toMatch(/^\[OK\] applied top-3 to 'ens': v\/best, v\/mid, v\/ok/);
    const doc = yamlParse(readFileSync(join(cfg, "settings.yaml"), "utf-8"));
    expect(doc.profiles.ens.model).toBe("v/best");
    expect(doc.profiles.ens.second_model).toBe("v/mid");
    expect(doc.profiles.ens.third_model).toBe("v/ok");
    expect(doc.profiles.ens.api_key).toBe("sk-test-literal"); // untouched
  });

  it("refuses --apply-free-pool without --bench-free-pool (the pool it writes would be undefined)", () => {
    const r = run(["--apply-free-pool", "ens"]);
    expect(r.status).not.toBe(0);
    expect(r.final).toMatch(/^\[FAILED\] --apply-free-pool requires --bench-free-pool/);
  });

  it("refuses --adopt without a target, and an unknown target", () => {
    const a = run(["--adopt", "v/x"]);
    expect(a.status).not.toBe(0);
    expect(a.final).toMatch(/^\[FAILED\] --adopt requires --adopt-into/);

    const b = run(["--adopt-into", "model"]);
    expect(b.status).not.toBe(0);
    expect(b.final).toMatch(/^\[FAILED\] --adopt-into \/ --adopt-profile require --adopt/);
  });

  it("--auto-replace reports a PERSISTENTLY BROKEN ensemble slot from the ledger, and writes nothing", () => {
    // 3 consecutive HTTP 404s for the profile's primary model = the code threshold.
    // The benchmarked TOOLS resolve to DEFAULT_MODEL (no tool_models override) and have
    // zero ledger events, so no tool benchmark runs → no network → hermetic.
    writeFileSync(
      join(cfg, "model-events.log"),
      [
        ledgerLine("vendor/dead-model", 5, "non_retryable_failure", "HTTP 404"),
        ledgerLine("vendor/dead-model", 3, "non_retryable_failure", "HTTP 404"),
        ledgerLine("vendor/dead-model", 1, "non_retryable_failure", "HTTP 404"),
        ledgerLine("vendor/live-model", 2, "rate_limit_429", "429 during call"),
        "",
      ].join("\n"),
    );
    const r = run(["--auto-replace"]);
    expect(r.status).toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[OK\] advisory — .*1\/2 ensemble slot\(s\) broken; nothing written\. Report: /);
    expect(r.stderr).toMatch(/ensemble\.model \(vendor\/dead-model\): BROKEN/);
    expect(r.stderr).toMatch(/ensemble\.second_model \(vendor\/live-model\): healthy/);

    // The report carries the verdict verbatim — nothing for an agent to paraphrase.
    const reportPath = /Report: (\S+)/.exec(r.final)?.[1] ?? "";
    expect(existsSync(reportPath)).toBe(true);
    const md = readFileSync(reportPath, "utf-8");
    expect(md).toContain("PERSISTENTLY BROKEN");
    expect(md).toContain("3 consecutive HTTP 404 failures");

    // ADVISORY: the config is untouched.
    expect(readFileSync(join(cfg, "settings.yaml"), "utf-8")).toBe(SETTINGS);
  });

  it("--auto-replace on an empty ledger reports a healthy ensemble", () => {
    const r = run(["--auto-replace"]);
    expect(r.status).toBe(0);
    expect(r.final).toMatch(/0\/2 ensemble slot\(s\) broken/);
    expect(r.stderr).toMatch(/ensemble\.model \(vendor\/dead-model\): healthy/);
  });

  // ── P3 + P4: --update-all and the spend cap ────────────────────────────────
  //
  // These stay hermetic by asserting only the paths that fail BEFORE the (public,
  // network) catalog fetch: usage errors and the API-key self-check. The pipeline
  // itself is covered end-to-end in update-all.test.ts with an injected catalog.

  it("refuses the cost-safety flags when they would be a SILENT NO-OP (no --update-all)", () => {
    // Typing --free / --budget-usd without --update-all means the user asked for a cost
    // guarantee that nothing would honor. That must never pass quietly.
    for (const args of [["--free"], ["--paid"], ["--both"], ["--budget-usd", "5"]]) {
      const r = run(args);
      expect(r.status).not.toBe(0);
      expect(r.final).toMatch(/^\[FAILED\] --free \/ --paid \/ --both \/ --budget-usd only apply to --update-all/);
    }
  });

  it("refuses contradictory spend modes rather than letting one silently win", () => {
    const r = run(["--update-all", "--free", "--paid"]);
    expect(r.status).not.toBe(0);
    expect(r.final).toMatch(/^\[FAILED\] --free, --paid and --both are mutually exclusive/);
  });

  it("refuses a cap that is not a positive amount (a cap you cannot trust is worse than none)", () => {
    for (const bad of ["0", "-1", "abc"]) {
      const r = run(["--update-all", "--paid", "--budget-usd", bad]);
      expect(r.status).not.toBe(0);
      expect(r.final).toMatch(/^\[FAILED\] --budget-usd must be a positive USD amount/);
    }
  });

  it("--update-all self-checks the API key before any work (one line, no agent probe)", () => {
    const r = run(["--update-all", "--paid"]);
    expect(r.status).not.toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] OPENROUTER_API_KEY not set/);
  });

  it("--paid REFUSES a free_only profile — a CLI flag may not overrule a zero-spend config", () => {
    // free_only is the user's standing "this profile must never spend". Letting --paid
    // silently flip that off is how money leaves an account (cf. 31ce212). It is a hard
    // refusal, not a warning — and it names the deliberate way to proceed.
    writeFileSync(
      join(cfg, "settings.yaml"),
      [
        "active: fo",
        "profiles:",
        "  fo:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: v/x:free",
        "    free_only: true",
        "    free_models:",
        "      - v/x:free",
        "",
      ].join("\n"),
    );
    const r = run(["--update-all", "--paid"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] --update-all --paid refused: profile 'fo' has free_only: true/);
    expect(r.final).toMatch(/must never spend/);
    // …and it beats the API-key check (which run() strips). The user's key is not the
    // problem — their REQUEST is — so reporting "OPENROUTER_API_KEY not set" here would
    // send them off fixing the wrong thing. Same ordering rule as the usage errors above.
    expect(r.final).not.toMatch(/OPENROUTER_API_KEY/);
  });
});
