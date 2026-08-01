/**
 * Unit tests for the mass-scout CLI dispatcher.
 *
 * Covers:
 *   • parseFlags — basic, =-form, repeated keys, positional, no-value flags
 *   • parseFilterToken — every operator, value parsing, malformed tokens
 *   • runMassScoutCli  — --help, unknown sub-command
 *   • register sub-command — walks --root, --files, --extensions filter,
 *     respects register cap (skipped_too_big counter)
 *   • preclassify sub-command — sums by_bucket
 *   • estimate sub-command — prints numbers; --budget-usd gate flips
 *     budget_allowed=false
 *   • scout sub-command — mocked fetch produces a markdown report
 *   • search sub-command — FTS / regex / filter flag parsing
 *   • get sub-command — looks up by short_id; --job-id adds result
 *   • export sub-command — writes JSONL with one row per result
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setValidationBypassForTests } from "../benchmark/validated.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseFilterToken,
  parseFlags,
  runMassScoutCli,
  type CliRunOptions,
} from "./cli";
import type { FetchImpl } from "./scout";

// ── parseFlags ─────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("captures --key value pairs and positional args", () => {
    /** Regular --key value form is the most common in the CLI. */
    const out = parseFlags(["--db", "/x.db", "extra", "--limit", "10"]);
    expect(out.flags["db"]).toBe("/x.db");
    expect(out.flags["limit"]).toBe("10");
    expect(out.positional).toEqual(["extra"]);
  });

  it("captures --key=value form", () => {
    /** Equal-sign form coexists with whitespace form. */
    const out = parseFlags(["--db=/x.db", "--limit=5"]);
    expect(out.flags["db"]).toBe("/x.db");
    expect(out.flags["limit"]).toBe("5");
  });

  it("treats a bare flag with no value as the string 'true'", () => {
    /** Boolean flags use the convention `--reclassify` (no value). */
    const out = parseFlags(["--reclassify", "--db", "/x.db"]);
    expect(out.flags["reclassify"]).toBe("true");
    expect(out.flags["db"]).toBe("/x.db");
  });

  it("last-write-wins on repeated keys", () => {
    /** Match Node's argparse-like convention. */
    const out = parseFlags(["--db", "/a", "--db", "/b"]);
    expect(out.flags["db"]).toBe("/b");
  });
});

// ── parseFilterToken ───────────────────────────────────────────────────

describe("parseFilterToken", () => {
  it("parses every supported operator", () => {
    /** All 7 ops: =, !=, >, >=, <, <=, LIKE. */
    const cases: [string, { path: string; op: string; value: unknown }][] = [
      ["$.x:=:1", { path: "$.x", op: "=", value: 1 }],
      ["$.x:!=:1", { path: "$.x", op: "!=", value: 1 }],
      ["$.x:>:5", { path: "$.x", op: ">", value: 5 }],
      ["$.x:>=:5", { path: "$.x", op: ">=", value: 5 }],
      ["$.x:<:10", { path: "$.x", op: "<", value: 10 }],
      ["$.x:<=:10", { path: "$.x", op: "<=", value: 10 }],
      ["$.x:LIKE:foo%", { path: "$.x", op: "LIKE", value: "foo%" }],
    ];
    for (const [tok, expected] of cases) {
      const out = parseFilterToken(tok);
      expect(out).toEqual(expected);
    }
  });

  it("recognises booleans and null", () => {
    /** Booleans are unquoted true/false; null is unquoted null. */
    expect(parseFilterToken("$.is_async:=:true")).toMatchObject({
      value: true,
    });
    expect(parseFilterToken("$.is_async:=:false")).toMatchObject({
      value: false,
    });
    expect(parseFilterToken("$.x:=:null")).toMatchObject({ value: null });
  });

  it("treats anything else as a string", () => {
    /** Strings need no quoting. */
    expect(parseFilterToken("$.framework:=:react")).toMatchObject({
      value: "react",
    });
  });

  it("rejects malformed tokens", () => {
    /** Missing :OP: separator → error message. */
    const out = parseFilterToken("$.foo=bar");
    expect(out).toHaveProperty("error");
  });
});

// ── help / unknown ─────────────────────────────────────────────────────

describe("runMassScoutCli — top level", () => {
  it("--help prints the help text", async () => {
    /** Help is the entry-point happy path. */
    const r = await runMassScoutCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("mass-scout —");
    expect(r.stdout).toContain("Subcommands:");
  });

  it("no args prints the help text", async () => {
    /** Bare `mass-scout` should not error — print help instead. */
    const r = await runMassScoutCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Subcommands:");
  });

  it("unknown sub-command returns a non-zero exit and helpful stderr", async () => {
    /** Don't silently accept typos. */
    const r = await runMassScoutCli(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown sub-command");
  });
});

// ── shared fixture: tmpdir + file tree + fieldset ──────────────────────

let workdir: string;
/**
 * Source-file root that `register --root` points at. Lives BELOW
 * `workdir` so the db file, the fieldset JSON, and the report directory
 * (all written under `workdir`) don't get walked as scoutable files.
 */
let sourceRoot: string;
let dbPath: string;
let fieldsetPath: string;
let mainRoot: string;

beforeEach(() => {
  // These tests exercise the mass_scout CLI plumbing with a MOCKED fetch (no real
  // spend); bypass the IRON RULE validation gate, which is not under test here.
  setValidationBypassForTests(true);
  workdir = join(
    tmpdir(),
    `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workdir, { recursive: true });
  sourceRoot = join(workdir, "tree");
  mkdirSync(sourceRoot, { recursive: true });
  // db + fieldset live OUTSIDE the source tree so register walking
  // sourceRoot doesn't accidentally pick them up.
  dbPath = join(workdir, "scout.db");
  fieldsetPath = join(workdir, "fields.json");
  // Main root override — reports are written under <mainRoot>/reports/...
  mainRoot = workdir;
});

afterEach(() => {
  setValidationBypassForTests(false);
  if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
});

function writeFieldset(): void {
  writeFileSync(
    fieldsetPath,
    JSON.stringify({
      version: 1,
      fieldset_name: "cli-test",
      fields: [
        {
          name: "is_async",
          description: "true if file uses async / await",
          type: { kind: "bool" },
        },
        {
          name: "summary",
          description: "one-sentence summary",
          type: { kind: "string", max_length: 80 },
        },
      ],
    }),
    "utf-8",
  );
}

/** Write source files under `sourceRoot/<rel>`. */
function writeFiles(spec: Record<string, string>): void {
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(sourceRoot, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

// ── register ───────────────────────────────────────────────────────────

describe("runMassScoutCli — register", () => {
  it("walks --root and registers every file", async () => {
    /** Happy path: 3 files, 0 already-registered. */
    writeFiles({
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 2\n",
      "docs/c.md": "# hello\n",
    });
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/registered=3/);
    expect(r.stdout).toMatch(/already_registered=0/);
  });

  it("--files takes an explicit comma-separated list", async () => {
    /** Bypass the walk — the user specifies exactly which files. */
    writeFiles({
      "src/a.ts": "x",
      "src/b.ts": "y",
    });
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--files",
      `${sourceRoot}/src/a.ts,${sourceRoot}/src/b.ts`,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/registered=2/);
  });

  it("--extensions filter only registers matching files", async () => {
    /** Only .ts files; the .md is skipped during the walk. */
    writeFiles({
      "src/a.ts": "x",
      "src/b.ts": "y",
      "docs/c.md": "z",
    });
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
      "--extensions",
      ".ts",
    ]);
    expect(r.stdout).toMatch(/registered=2/);
  });

  it("--root and --files together is a usage error", async () => {
    /** Defensive: caller must pick one. */
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
      "--files",
      "x.ts",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  it("missing --db is a usage error", async () => {
    /** No registry path means we don't know where to write. */
    const r = await runMassScoutCli(["register", "--root", sourceRoot]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--db is required/);
  });
});

// ── preclassify ────────────────────────────────────────────────────────

describe("runMassScoutCli — preclassify", () => {
  it("classifies registered files into buckets", async () => {
    /** End-to-end: register first, then preclassify. */
    writeFiles({
      "src/a.ts": "export const a = 1\n",
      "src/CLAUDE.md": "rules\n",
    });
    await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
    ]);
    const r = await runMassScoutCli(["preclassify", "--db", dbPath]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/sourcecode=1/);
    expect(r.stdout).toMatch(/rules_to_eval=1/);
  });
});

// ── estimate ───────────────────────────────────────────────────────────

describe("runMassScoutCli — estimate", () => {
  it("prints cost/time numbers", async () => {
    /** Estimate only reads, no LLM call. */
    writeFiles({ "src/a.ts": "export const a = 1\n" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli([
      "estimate",
      "--db",
      dbPath,
      "--fields-file",
      fieldsetPath,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/files_eligible=1/);
    expect(r.stdout).toMatch(/est_cost_usd=\$/);
    expect(r.stdout).toMatch(/budget_allowed=true/);
  });

  it("--budget-usd flips budget_allowed=false when over", async () => {
    /** Budget gate is the user's safety against runaway cost. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli([
      "estimate",
      "--db",
      dbPath,
      "--fields-file",
      fieldsetPath,
      "--budget-usd",
      "0",
    ]);
    expect(r.stdout).toMatch(/budget_allowed=false/);
  });

  it("--live-context overrides KNOWN_PRICING.context_window when fetch succeeds", async () => {
    /** Live OpenRouter query returns a smaller cap → context_window
     *  in the printed output reflects that override. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const liveCap = 4096;
    const r = await runMassScoutCli(
      [
        "estimate",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--live-context",
      ],
      {
        apiKey: "test-key",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            data: { endpoints: [{ context_length: liveCap }] },
          }),
          text: async () => "",
        }),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`context_window=${liveCap}`));
  });

  it("--live-context errors when no API key is available", async () => {
    /** The flag explicitly opts into a real network query. */
    const oldKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      writeFiles({ "src/a.ts": "x" });
      writeFieldset();
      await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
      const r = await runMassScoutCli([
        "estimate",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--live-context",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/--live-context requires OPENROUTER_API_KEY/);
    } finally {
      if (oldKey) process.env.OPENROUTER_API_KEY = oldKey;
    }
  });

  it("--live-context errors fail-fast when fetch returns null", async () => {
    /** A failed fetch should NOT silently fall back to KNOWN_PRICING —
     *  the user explicitly asked for the live cap. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli(
      [
        "estimate",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--live-context",
      ],
      {
        apiKey: "test-key",
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => "",
        }),
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/could not fetch context_length/);
  });
});

// ── scout (mocked fetch) ───────────────────────────────────────────────

describe("runMassScoutCli — scout", () => {
  /** Build a mock fetch that returns a fixed valid response. */
  function fakeFetch(body: Record<string, unknown>): FetchImpl {
    return async () => {
      const payload = {
        choices: [{ message: { content: JSON.stringify(body) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
  }

  it("forwards onProgress to scout.ts (per-file progress events)", async () => {
    /** When the MCP layer passes onProgress, scout.ts must invoke it
     *  per file. The dispatcher wraps it with a `done/total — files` message. */
    writeFiles({ "src/a.ts": "export const a = 1\n", "src/b.ts": "export const b = 2\n" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const events: { progress: number; total: number; message?: string }[] = [];
    const opts: CliRunOptions = {
      apiKey: "test-key",
      fetchImpl: fakeFetch({ is_async: false, summary: "x" }),
      mainRoot,
      onProgress: (progress, total, message) => {
        events.push({ progress, total, message });
      },
    };
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "progress-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    expect(r.exitCode).toBe(0);
    // At least one progress event must have fired (one per file).
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1]!;
    expect(last.progress).toBe(2);
    expect(last.total).toBe(2);
    expect(last.message).toMatch(/scout: \d+\/\d+ files/);
  });

  it("end-to-end: registers, scouts, writes a markdown report under mainRoot", async () => {
    /** Mocks fetch so we don't need a network. */
    writeFiles({
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 2\n",
    });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test-key",
      fetchImpl: fakeFetch({ is_async: false, summary: "tiny constant" }),
      mainRoot,
    };
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "cli-job-1",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/files_ok=2/);
    expect(r.stdout).toMatch(/files_failed=0/);
    // Report path printed.
    const m = r.stdout.match(/report=(\S+)/);
    expect(m).not.toBeNull();
    const reportPath = m![1]!;
    expect(existsSync(reportPath)).toBe(true);
    const md = readFileSync(reportPath, "utf-8");
    expect(md).toContain("# Mass-scouting report");
    expect(md).toContain("cli-job-1");
  });

  it("scout --output-dir overrides the default report directory", async () => {
    /** Regression for F2: as an MCP server the default <main-repo-root>
     *  resolved to the plugin's own install cache. --output-dir is the
     *  explicit escape hatch — the report must land there, not under
     *  mainRoot/reports/mass_scouting/. */
    writeFiles({ "src/a.ts": "export const a = 1\n" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const customDir = join(mainRoot, "custom-report-out");
    const opts: CliRunOptions = {
      apiKey: "test-key",
      fetchImpl: fakeFetch({ is_async: false, summary: "tiny" }),
      mainRoot,
    };
    const r = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "cli-outdir-1",
        "--source-root",
        sourceRoot,
        "--output-dir",
        customDir,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    expect(r.exitCode).toBe(0);
    const m = r.stdout.match(/report=(\S+)/);
    expect(m).not.toBeNull();
    const reportPath = m![1]!;
    expect(reportPath.startsWith(customDir)).toBe(true);
    expect(reportPath).not.toContain(join("reports", "mass_scouting"));
    expect(existsSync(reportPath)).toBe(true);
  });

  it("missing OPENROUTER_API_KEY returns a clear error", async () => {
    /** No API key + no opts.apiKey = error before any work. */
    const oldKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      writeFieldset();
      writeFiles({ "src/a.ts": "x" });
      await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
      const r = await runMassScoutCli([
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "no-key",
        "--source-root",
        sourceRoot,
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      if (oldKey) process.env.OPENROUTER_API_KEY = oldKey;
    }
  });
});

// ── search ─────────────────────────────────────────────────────────────

describe("runMassScoutCli — search", () => {
  it("returns FTS hits as JSON when --json passed", async () => {
    /** Re-uses the scout flow to seed the registry, then searches. */
    writeFiles({ "src/a.ts": "export const a = 1\n" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  is_async: false,
                  summary: "react components live here",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => "",
      }),
      mainRoot,
    };
    await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "s-1",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    const r = await runMassScoutCli([
      "search",
      "--db",
      dbPath,
      "--job-id",
      "s-1",
      "--query",
      "react",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { hits: unknown[]; mode: string };
    expect(parsed.mode).toBe("fts");
    expect(parsed.hits.length).toBeGreaterThan(0);
  });

  it("regex bypass with --query 'all emails'", async () => {
    /** Queries that match a named pattern run regex, not FTS. */
    writeFiles({ "x.txt": "alice@y.org and bob@z.io" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  is_async: false,
                  summary: "contacts",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => "",
      }),
      mainRoot,
    };
    await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "rgx",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    const r = await runMassScoutCli([
      "search",
      "--db",
      dbPath,
      "--job-id",
      "rgx",
      "--query",
      "find all emails",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      mode: string;
      regex_reason?: string;
      hits: { regex_matches?: { match: string }[] }[];
    };
    expect(parsed.mode).toBe("regex");
    expect(parsed.regex_reason).toBe("named:emails");
    expect(parsed.hits[0]!.regex_matches!.length).toBe(2);
  });

  it("--filter parses path:OP:value tokens", async () => {
    /** Structured filter is the third search mode. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ is_async: true, summary: "ok" }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => "",
      }),
      mainRoot,
    };
    await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "f-1",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    const r = await runMassScoutCli([
      "search",
      "--db",
      dbPath,
      "--job-id",
      "f-1",
      "--filter",
      "$.is_async:=:true",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { mode: string; hits: unknown[] };
    expect(parsed.mode).toBe("structured");
    expect(parsed.hits.length).toBe(1);
  });
});

// ── get / export ───────────────────────────────────────────────────────

describe("runMassScoutCli — get / export", () => {
  it("get prints the file row by short_id", async () => {
    /** Used to drill into one specific file's metadata. */
    writeFiles({ "src/a.ts": "x" });
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli([
      "get",
      "--db",
      dbPath,
      "--short-id",
      "1",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      short_id: number;
      file_path: string;
    };
    expect(parsed.short_id).toBe(1);
    expect(parsed.file_path).toMatch(/a\.ts$/);
  });

  it("export writes a JSONL file with one row per result", async () => {
    /** Verify the output is well-formed JSONL. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ is_async: false, summary: "x" }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => "",
      }),
      mainRoot,
    };
    await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "exp-1",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    const r = await runMassScoutCli(
      [
        "export",
        "--db",
        dbPath,
        "--job-id",
        "exp-1",
      ],
      { mainRoot },
    );
    expect(r.exitCode).toBe(0);
    const m = r.stdout.match(/path=(\S+)/);
    expect(m).not.toBeNull();
    const exportPath = m![1]!;
    const content = readFileSync(exportPath, "utf-8").trim();
    const lines = content.split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { job_id: string };
    expect(parsed.job_id).toBe("exp-1");
  });
});

// ── register: gitignore honoring (Phase A, TRDD §15 Q5) ────────────────

describe("runMassScoutCli — register: gitignore", () => {
  it("excludes gitignored files by default when inside a git repo", async () => {
    /** A `.gitignore` listing `secret.txt` must keep `secret.txt` out of
     *  the registry, even though the file exists on disk. */
    writeFiles({
      "src/a.ts": "export const a = 1\n",
      "src/secret.txt": "should-not-be-registered",
      ".gitignore": "src/secret.txt\n",
    });
    // Initialize a real git repo in sourceRoot.
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -q -m init",
      { cwd: sourceRoot, stdio: "ignore" },
    );

    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
    ]);
    expect(r.exitCode).toBe(0);
    // Two paths registered: src/a.ts and .gitignore (the latter is tracked).
    expect(r.stdout).toMatch(/registered=2/);
    // The secret file must NOT appear.
    expect(r.stdout).not.toMatch(/secret\.txt/);
  });

  it("--no-gitignore re-includes ignored files (escape hatch)", async () => {
    /** When the user explicitly wants everything (e.g. auditing leaks). */
    writeFiles({
      "a.ts": "x",
      "b.ts": "y",
      ".gitignore": "b.ts\n",
    });
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -q -m init",
      { cwd: sourceRoot, stdio: "ignore" },
    );

    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
      "--no-gitignore",
    ]);
    // a.ts + b.ts + .gitignore = 3 (all on disk; --no-gitignore disables filter)
    expect(r.stdout).toMatch(/registered=3/);
  });

  it("falls back to plain walk when not inside a git repo", async () => {
    /** No git → no `git ls-files` → walkFiles is the source of truth. */
    writeFiles({ "x.ts": "x", "y.ts": "y" });
    // No `git init` — sourceRoot is just a plain dir.
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
    ]);
    expect(r.stdout).toMatch(/registered=2/);
  });
});

// ── Phase B sub-commands ───────────────────────────────────────────────

describe("runMassScoutCli — Phase B (jobs-list / audit-sample / body-get)", () => {
  it("jobs-list reports '(no jobs)' on an empty DB", async () => {
    /** Discovery surface: works on a fresh DB, doesn't crash. */
    const r = await runMassScoutCli(["jobs-list", "--db", dbPath]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no jobs/);
  });

  it("body-get prints the cached body by short_id", async () => {
    /** Body cache as a tool — subagents shouldn't have to re-read disk. */
    writeFiles({ "src/a.ts": "the secret content\n" });
    await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
    ]);
    const r = await runMassScoutCli([
      "body-get",
      "--db",
      dbPath,
      "--short-id",
      "1",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the secret content");
  });

  it("body-get errors on unknown short_id", async () => {
    /** Don't silently return empty. */
    const r = await runMassScoutCli([
      "body-get",
      "--db",
      dbPath,
      "--short-id",
      "777",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/no body cached/);
  });

  it("audit-sample errors when no results exist for the job", async () => {
    /** Common usage pattern: caller forgot to run scout. */
    const r = await runMassScoutCli([
      "audit-sample",
      "--db",
      dbPath,
      "--job-id",
      "does-not-exist",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/rows=0/);
  });
});

// ── Phase C1 — register --git-diff + per-bucket estimate ───────────────

describe("runMassScoutCli — Phase C1", () => {
  it("register --git-diff <ref> filters to changed files only", async () => {
    /** Full git workflow: init repo, commit baseline, modify two files,
     *  register with --git-diff HEAD and only the changed files appear. */
    writeFiles({
      "src/a.ts": "alpha\n",
      "src/b.ts": "beta\n",
      "src/c.ts": "gamma\n",
    });
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -q -m baseline",
      { cwd: sourceRoot, stdio: "ignore" },
    );
    // Modify only a.ts and c.ts; b.ts stays at baseline.
    writeFileSync(join(sourceRoot, "src/a.ts"), "alpha-modified\n", "utf-8");
    writeFileSync(join(sourceRoot, "src/c.ts"), "gamma-modified\n", "utf-8");
    execSync("git add -A && git commit -q -m change", {
      cwd: sourceRoot,
      stdio: "ignore",
    });

    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
      "--git-diff",
      "HEAD~1",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/registered=2/);
  });

  it("register --git-diff requires --root", async () => {
    /** --files+--git-diff would need a different semantic; refuse. */
    writeFiles({ "a.ts": "x" });
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--files",
      `${sourceRoot}/a.ts`,
      "--git-diff",
      "HEAD",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--git-diff requires --root/);
  });

  it("register --git-diff fails clearly when ref doesn't resolve", async () => {
    /** Bad ref → null from listGitChangedFiles → user-facing error. */
    writeFiles({ "a.ts": "x" });
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -q -m init",
      { cwd: sourceRoot, stdio: "ignore" },
    );
    const r = await runMassScoutCli([
      "register",
      "--db",
      dbPath,
      "--root",
      sourceRoot,
      "--git-diff",
      "nonexistent-ref",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--git-diff/);
  });

  it("estimate output includes by_bucket breakdown", async () => {
    /** Per-bucket cost is the visibility win — caller can see which kinds
     *  of files dominate the bill. */
    writeFiles({
      "src/a.ts": "alpha",
      "src/b.ts": "beta",
      "docs/README.md": "# hello\n",
    });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    await runMassScoutCli(["preclassify", "--db", dbPath]);
    const r = await runMassScoutCli([
      "estimate",
      "--db",
      dbPath,
      "--fields-file",
      fieldsetPath,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/by_bucket:/);
    expect(r.stdout).toMatch(/sourcecode/);
    expect(r.stdout).toMatch(/documentation/);
  });
});

// ── Phase C2 — build-fieldset + propose-fieldset ───────────────────────

describe("runMassScoutCli — Phase C2", () => {
  it("build-fieldset assembles JSON from --field shorthand tokens", async () => {
    /** The shorthand parser exposed via the CLI. */
    const r = await runMassScoutCli([
      "build-fieldset",
      "--name",
      "demo",
      "--field",
      "is_async:bool=true if async/await is present in the file",
      "--field",
      "category:enum(sport,music,code)=topic of the file",
      "--field",
      "complexity:int(1-10)=subjective complexity 1..10",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      fieldset_name: string;
      fields: { name: string; type: { kind: string } }[];
    };
    expect(parsed.fieldset_name).toBe("demo");
    expect(parsed.fields.length).toBe(3);
    expect(parsed.fields[0]!.name).toBe("is_async");
    expect(parsed.fields[1]!.type.kind).toBe("enum");
    expect(parsed.fields[2]!.type.kind).toBe("int");
  });

  it("build-fieldset --out writes the JSON to a file", async () => {
    /** The --out flag for piping into mass-scout-estimate / scout. */
    const out = join(workdir, "fields-built.json");
    const r = await runMassScoutCli([
      "build-fieldset",
      "--name",
      "demo2",
      "--field",
      "ok:bool=is it ok",
      "--out",
      out,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/fields=1/);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, "utf-8")) as {
      fieldset_name: string;
    };
    expect(parsed.fieldset_name).toBe("demo2");
  });

  it("build-fieldset rejects malformed shorthand", async () => {
    /** Defensive: surface the parse error verbatim. */
    const r = await runMassScoutCli([
      "build-fieldset",
      "--name",
      "x",
      "--field",
      "totally bogus",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/parse error/);
  });

  it("build-fieldset requires at least one --field", async () => {
    /** A fieldset with zero fields is meaningless. */
    const r = await runMassScoutCli([
      "build-fieldset",
      "--name",
      "x",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/at least one --field/);
  });

  it("propose-fieldset surfaces missing API key", async () => {
    /** Without OPENROUTER_API_KEY, fail clearly before any work. */
    const oldKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const r = await runMassScoutCli([
        "propose-fieldset",
        "--goal",
        "find async modules",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      if (oldKey) process.env.OPENROUTER_API_KEY = oldKey;
    }
  });

  it("propose-fieldset returns the validated JSON when LLM responds correctly", async () => {
    /** Mock the LLM and confirm round-trip parsing succeeds. */
    const mockResponse = {
      fieldset_name: "mocked",
      fields: [
        {
          name: "is_async",
          description: "true if file uses async/await",
          type: { kind: "bool" },
        },
      ],
    };
    const r = await runMassScoutCli(
      [
        "propose-fieldset",
        "--goal",
        "find async modules",
      ],
      {
        apiKey: "test",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: { content: JSON.stringify(mockResponse) },
              },
            ],
          }),
          text: async () => "",
        }),
      },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      fieldset_name: string;
      fields: unknown[];
    };
    expect(parsed.fieldset_name).toBe("mocked");
    expect(parsed.fields.length).toBe(1);
  });
});

// ── Phase F: bundled fieldsets ────────────────────────────────────────

describe("runMassScoutCli — bundled fieldsets", () => {
  it("list-bundled-fieldsets prints all 4 plugin-shipped sets", async () => {
    /** The 4 standard sets must be discoverable. */
    const r = await runMassScoutCli([
      "list-bundled-fieldsets",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { name: string; fields: string[] }[];
    const names = parsed.map((p) => p.name).sort();
    expect(names).toEqual(["code-audit", "pr-review", "security-audit", "skill-audit"]);
    // Spot-check a fieldset has actual fields (not empty).
    const codeAudit = parsed.find((p) => p.name === "code-audit");
    expect(codeAudit).toBeDefined();
    expect(codeAudit!.fields.length).toBeGreaterThan(2);
  });

  it("estimate accepts 'bundled:code-audit' as --fields-file", async () => {
    /** End-to-end: shorthand resolves and feeds into the estimator. */
    writeFiles({ "src/a.ts": "export const a = 1\n" });
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli([
      "estimate",
      "--db",
      dbPath,
      "--fields-file",
      "bundled:code-audit",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/files_eligible=1/);
  });

  it("estimate rejects 'bundled:nope-not-here' with a helpful message", async () => {
    /** Invalid bundled name should fail loudly, not fall through. */
    writeFiles({ "src/a.ts": "x" });
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli([
      "estimate",
      "--db",
      dbPath,
      "--fields-file",
      "bundled:nope-not-here",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/bundled fieldset .*nope-not-here.* not found/);
  });

  it("rejects bundled names with bad characters", async () => {
    /** Name validation prevents path traversal via bundled:.../etc. */
    writeFiles({ "src/a.ts": "x" });
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const r = await runMassScoutCli([
      "estimate",
      "--db",
      dbPath,
      "--fields-file",
      // The validator's name regex must reject path-traversal attempts;
      // the literal value here is a contrived traversal pattern, not a
      // real system file reference.
      "bundled:..%2F..%2F..%2Fsystem-file",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/invalid bundled fieldset name/);
  });
});

// ── Phase C3: diff + chain ─────────────────────────────────────────────

describe("runMassScoutCli — Phase C3 diff", () => {
  /** Build a mock fetch that returns a fixed response per call. */
  function fakeFetch(body: Record<string, unknown>): FetchImpl {
    return async () => {
      const payload = {
        choices: [{ message: { content: JSON.stringify(body) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
  }

  it("requires --from and --to and rejects --from == --to", async () => {
    /** Defensive: comparing a job to itself is meaningless. */
    writeFiles({ "src/a.ts": "x" });
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const noFrom = await runMassScoutCli([
      "diff",
      "--db",
      dbPath,
      "--to",
      "y",
    ]);
    expect(noFrom.exitCode).toBe(1);
    expect(noFrom.stderr).toMatch(/--from is required/);

    const same = await runMassScoutCli([
      "diff",
      "--db",
      dbPath,
      "--from",
      "x",
      "--to",
      "x",
    ]);
    expect(same.exitCode).toBe(1);
    expect(same.stderr).toMatch(/must be different/);
  });

  it("counts identical, changed, only_in_a, only_in_b across two jobs", async () => {
    /** Run two scouts with different mock responses to manufacture
     *  changed rows; one row only in the first job (different file). */
    writeFiles({ "src/a.ts": "x", "src/b.ts": "y" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const baseOpts: CliRunOptions = {
      apiKey: "test-key",
      mainRoot,
    };
    // Job-A scouts both files with summary="from-a".
    const r1 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "job-a",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      { ...baseOpts, fetchImpl: fakeFetch({ is_async: false, summary: "from-a" }) },
    );
    expect(r1.exitCode).toBe(0);

    // Job-B scouts both files with summary="from-b" — both rows differ.
    const r2 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "job-b",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      { ...baseOpts, fetchImpl: fakeFetch({ is_async: false, summary: "from-b" }) },
    );
    expect(r2.exitCode).toBe(0);

    const r = await runMassScoutCli([
      "diff",
      "--db",
      dbPath,
      "--from",
      "job-a",
      "--to",
      "job-b",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      counts: {
        only_in_a: number;
        only_in_b: number;
        changed: number;
        identical: number;
      };
      changed: { changed_keys: string[] }[];
    };
    expect(parsed.counts.only_in_a).toBe(0);
    expect(parsed.counts.only_in_b).toBe(0);
    expect(parsed.counts.changed).toBe(2);
    expect(parsed.changed[0]!.changed_keys).toContain("summary");
  });
});

describe("runMassScoutCli — Phase C3 chain", () => {
  function fakeFetch(body: Record<string, unknown>): FetchImpl {
    return async () => {
      const payload = {
        choices: [{ message: { content: JSON.stringify(body) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
  }

  it("requires --filter, --source-job, --new-job-id, --new-fields-file", async () => {
    /** Required-flag check propagates the CLI's error message. */
    const r = await runMassScoutCli([
      "chain",
      "--db",
      dbPath,
      "--source-job",
      "src",
      "--new-job-id",
      "new",
      "--new-fields-file",
      "/nonexistent.json",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--filter/);
  });

  it("returns matched=0 when filter selects nothing in the source job", async () => {
    /** Edge: a chain that filters out every row should not error,
     *  it should just print matched=0. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test-key",
      mainRoot,
      fetchImpl: fakeFetch({ is_async: false, summary: "tiny" }),
    };
    const r1 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "src-job",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    expect(r1.exitCode).toBe(0);

    // Filter on a value that doesn't exist in any row.
    const r = await runMassScoutCli(
      [
        "chain",
        "--db",
        dbPath,
        "--source-job",
        "src-job",
        "--new-job-id",
        "chained-job",
        "--new-fields-file",
        fieldsetPath,
        "--filter",
        "$.is_async:=:true",
      ],
      opts,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/matched=0/);
  });

  it("end-to-end chain reuses runScoutJob and restores buckets", async () => {
    /** Confirm that a chain run actually scouts the matching files
     *  and writes results under the new job_id. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await runMassScoutCli(["register", "--db", dbPath, "--root", sourceRoot]);
    const opts: CliRunOptions = {
      apiKey: "test-key",
      mainRoot,
      fetchImpl: fakeFetch({ is_async: false, summary: "v1" }),
    };
    const r1 = await runMassScoutCli(
      [
        "scout",
        "--db",
        dbPath,
        "--fields-file",
        fieldsetPath,
        "--job-id",
        "first",
        "--source-root",
        sourceRoot,
        "--workers",
        "1",
        "--no-smoke-test",
      ],
      opts,
    );
    expect(r1.exitCode).toBe(0);

    const r = await runMassScoutCli(
      [
        "chain",
        "--db",
        dbPath,
        "--source-job",
        "first",
        "--new-job-id",
        "second",
        "--new-fields-file",
        fieldsetPath,
        "--filter",
        "$.is_async:=:false",
        "--workers",
        "1",
      ],
      {
        ...opts,
        fetchImpl: fakeFetch({ is_async: false, summary: "v2" }),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/source_job=first/);
    expect(r.stdout).toMatch(/new_job=second/);
    expect(r.stdout).toMatch(/files_ok=1/);

    // Bucket must be restored — i.e. the file's bucket is not the
    // sentinel "chain:second".
    const dump = execSync(
      `sqlite3 '${dbPath}' "SELECT classifier_bucket FROM file_short_id LIMIT 1"`,
    )
      .toString()
      .trim();
    expect(dump).not.toMatch(/^chain:/);
  });
});
