/**
 * Unit tests for the mass-scouting MCP tool surface.
 *
 * Covers:
 *   • MASS_SCOUT_TOOLS — every tool has name + description + inputSchema
 *   • MASS_SCOUT_TOOL_NAMES — set has all 8 names
 *   • dispatchMassScoutTool — every name routes to the right CLI sub-command
 *     and returns an MCP envelope; unknown name returns isError
 *   • dispatchMassScoutTool — args are coerced (str/num/bool/array) and
 *     translated to the right CLI flags
 *   • Error paths — missing required arg, unknown sub-command
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MASS_SCOUT_TOOLS,
  MASS_SCOUT_TOOL_NAMES,
  dispatchMassScoutTool,
} from "./mcp-tools";
import type { OpenRouterModel } from "../benchmark/discover";

// ── Static shape checks ────────────────────────────────────────────────

describe("MASS_SCOUT_TOOLS", () => {
  it("has nineteen tools with the documented names", () => {
    /** Phase B added 3 (jobs_list/audit_sample/body_get).
     *  Phase C2 added 2 (build_fieldset/propose_fieldset).
     *  Phase C3 added 2 (diff/chain).
     *  Phase F added 1 (list_bundled_fieldsets).
     *  TRDD-5bd98017 added 1 (security_scan — dedicated, not a mass_scout
     *  sub-command but registered in the same array so index.ts picks it up).
     *  TRDD-973a0265 added 1 (security_triage_benchmark — model qualification
     *  for the security_scan triage task; DB-free, in-process orchestrator).
     *  TRDD-f45eeaa0 added 1 (assess_model — cross-tool requirements assessment;
     *  DB-free, offline, in-process).
     *  TRDD-828238b5 A2 added 1 (check_model_health — configured-model self-check;
     *  DB-free, offline catalog fetch, in-process).
     *  TRDD-828238b5 A4 added 1 (discover_new_models — new-arrivals autodiscovery;
     *  DB-free, offline catalog fetch, in-process).
     *  Total = 8 base + 5 + 2 + 1 + 1 + 1 + 1 + 1 + 1 = 21. */
    expect(MASS_SCOUT_TOOLS.length).toBe(21);
    const names = MASS_SCOUT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "assess_model",
        "check_model_health",
        "discover_new_models",
        "mass_scout",
        "mass_scout_audit_sample",
        "mass_scout_body_get",
        "mass_scout_build_fieldset",
        "mass_scout_chain",
        "mass_scout_diff",
        "mass_scout_estimate",
        "mass_scout_export",
        "mass_scout_get",
        "mass_scout_jobs_list",
        "mass_scout_list_bundled_fieldsets",
        "mass_scout_preclassify",
        "mass_scout_propose_fieldset",
        "mass_scout_register",
        "mass_scout_search",
        "mass_scout_search_xjob",
        "security_scan",
        "security_triage_benchmark",
      ].sort(),
    );
  });

  it("every tool has a non-empty description", () => {
    /** Empty descriptions confuse the calling agent. */
    for (const t of MASS_SCOUT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("every db-bound tool's inputSchema declares db_path as required", () => {
    /** Most sub-commands need the registry path. The fieldset-builders
     *  (mass_scout_build_fieldset, mass_scout_propose_fieldset) and
     *  mass_scout_list_bundled_fieldsets operate without a DB. security_scan
     *  is a dedicated tool with its own (DB-free) input shape (targets[]). */
    const NO_DB = new Set([
      "mass_scout_build_fieldset",
      "mass_scout_propose_fieldset",
      "mass_scout_list_bundled_fieldsets",
      "security_scan",
      "security_triage_benchmark",
      "assess_model",
      "check_model_health",
      "discover_new_models",
    ]);
    for (const t of MASS_SCOUT_TOOLS) {
      if (NO_DB.has(t.name)) continue;
      expect(t.inputSchema.required).toContain("db_path");
    }
  });

  it("MASS_SCOUT_TOOL_NAMES contains every tool name", () => {
    /** The set is the dispatcher's gating check. */
    for (const t of MASS_SCOUT_TOOLS) {
      expect(MASS_SCOUT_TOOL_NAMES.has(t.name)).toBe(true);
    }
    expect(MASS_SCOUT_TOOL_NAMES.size).toBe(MASS_SCOUT_TOOLS.length);
  });
});

// ── Dispatch — happy paths ─────────────────────────────────────────────

let workdir: string;
let sourceRoot: string;
let dbPath: string;
let fieldsetPath: string;

beforeEach(() => {
  workdir = join(
    tmpdir(),
    `mcp-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  sourceRoot = join(workdir, "tree");
  mkdirSync(sourceRoot, { recursive: true });
  dbPath = join(workdir, "scout.db");
  fieldsetPath = join(workdir, "fields.json");
});

afterEach(() => {
  if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
});

function writeFieldset(): void {
  writeFileSync(
    fieldsetPath,
    JSON.stringify({
      version: 1,
      fieldset_name: "mcp-test",
      fields: [
        {
          name: "summary",
          description: "one-line description",
          type: { kind: "string", max_length: 80 },
        },
      ],
    }),
    "utf-8",
  );
}

function writeFiles(spec: Record<string, string>): void {
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(sourceRoot, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

describe("dispatchMassScoutTool — register + preclassify + estimate + get", () => {
  it("mass_scout_register registers files via folder_path", async () => {
    /** Happy path — minimum viable register call. */
    writeFiles({ "src/a.ts": "export const a = 1\n" });
    const r = await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      folder_path: sourceRoot,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/registered=1/);
  });

  it("mass_scout_register translates file_paths array to --files", async () => {
    /** Array → comma-separated --files. */
    writeFiles({ "x/a.ts": "x", "x/b.ts": "y" });
    const r = await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      file_paths: [join(sourceRoot, "x/a.ts"), join(sourceRoot, "x/b.ts")],
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/registered=2/);
  });

  it("mass_scout_preclassify reports by-bucket counts", async () => {
    /** End-to-end: register first, then classify. */
    writeFiles({ "src/a.ts": "x", "src/CLAUDE.md": "rules" });
    await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      folder_path: sourceRoot,
    });
    const r = await dispatchMassScoutTool("mass_scout_preclassify", {
      db_path: dbPath,
    });
    expect(r.content[0]!.text).toMatch(/sourcecode=1/);
    expect(r.content[0]!.text).toMatch(/rules_to_eval=1/);
  });

  it("mass_scout_estimate returns cost numbers", async () => {
    /** Estimate is read-only — no LLM call. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      folder_path: sourceRoot,
    });
    const r = await dispatchMassScoutTool("mass_scout_estimate", {
      db_path: dbPath,
      fields_file: fieldsetPath,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/files_eligible=1/);
    expect(r.content[0]!.text).toMatch(/budget_allowed=true/);
  });

  it("mass_scout_estimate honors budget_usd=0", async () => {
    /** Budget gate flips to false when est_cost > 0 budget. */
    writeFiles({ "src/a.ts": "x" });
    writeFieldset();
    await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      folder_path: sourceRoot,
    });
    const r = await dispatchMassScoutTool("mass_scout_estimate", {
      db_path: dbPath,
      fields_file: fieldsetPath,
      budget_usd: 0,
    });
    expect(r.content[0]!.text).toMatch(/budget_allowed=false/);
  });

  it("mass_scout_get prints the file row", async () => {
    /** short_id → JSON row. */
    writeFiles({ "src/a.ts": "x" });
    await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      folder_path: sourceRoot,
    });
    const r = await dispatchMassScoutTool("mass_scout_get", {
      db_path: dbPath,
      short_id: 1,
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0]!.text) as { short_id: number };
    expect(parsed.short_id).toBe(1);
  });
});

// ── Dispatch — error paths ─────────────────────────────────────────────

describe("dispatchMassScoutTool — error paths", () => {
  it("unknown tool name returns isError", async () => {
    /** Defensive: never silently accept typos. */
    const r = await dispatchMassScoutTool("mass_scout_nope", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/unknown/i);
  });

  it("missing required db_path bubbles up as isError", async () => {
    /** The CLI's --db check fires; isError reflects the non-zero exit. */
    const r = await dispatchMassScoutTool("mass_scout_register", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/--db is required/);
  });

  it("missing fields_file in estimate bubbles up", async () => {
    /** Required-flag check propagates the CLI's error message. */
    const r = await dispatchMassScoutTool("mass_scout_estimate", {
      db_path: dbPath,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/--fields-file is required/);
  });
});

// ── Phase B tools ──────────────────────────────────────────────────────

describe("dispatchMassScoutTool — jobs_list / audit_sample / body_get", () => {
  it("mass_scout_jobs_list returns '(no jobs)' for an empty DB", async () => {
    /** The DB is created lazily on first registry open. */
    const r = await dispatchMassScoutTool("mass_scout_jobs_list", {
      db_path: dbPath,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/no jobs/);
  });

  it("mass_scout_body_get prints the cached body by short_id", async () => {
    /** Phase B unlocks the body cache as a tool. */
    writeFiles({ "src/a.ts": "hello world\n" });
    await dispatchMassScoutTool("mass_scout_register", {
      db_path: dbPath,
      folder_path: sourceRoot,
    });
    const r = await dispatchMassScoutTool("mass_scout_body_get", {
      db_path: dbPath,
      short_id: 1,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain("hello world");
  });

  it("mass_scout_body_get errors on unknown short_id", async () => {
    /** Defensive: don't silently return empty. */
    const r = await dispatchMassScoutTool("mass_scout_body_get", {
      db_path: dbPath,
      short_id: 999,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no body cached/);
  });

  it("mass_scout_audit_sample requires job_id", async () => {
    /** Required-flag check propagates. */
    const r = await dispatchMassScoutTool("mass_scout_audit_sample", {
      db_path: dbPath,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/--job-id is required/);
  });
});

// ── Phase C3 tools ─────────────────────────────────────────────────────

describe("dispatchMassScoutTool — diff / chain", () => {
  it("mass_scout_diff requires from_job and to_job", async () => {
    /** The dispatcher maps from_job/to_job → --from / --to. */
    const r = await dispatchMassScoutTool("mass_scout_diff", {
      db_path: dbPath,
      to_job: "y",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/--from is required/);
  });

  it("mass_scout_diff rejects matching job ids", async () => {
    /** Comparing a job with itself is meaningless. */
    const r = await dispatchMassScoutTool("mass_scout_diff", {
      db_path: dbPath,
      from_job: "x",
      to_job: "x",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/must be different/);
  });

  it("mass_scout_chain requires every flag in the schema", async () => {
    /** Missing --filter → required-flag error. */
    const r = await dispatchMassScoutTool("mass_scout_chain", {
      db_path: dbPath,
      source_job: "src",
      new_job_id: "new",
      new_fields_file: "/nonexistent.json",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/--filter/);
  });

  it("mass_scout_list_bundled_fieldsets returns the 4 standard sets", async () => {
    /** No-arg call lists every bundled fieldset shipped with the plugin. */
    const r = await dispatchMassScoutTool(
      "mass_scout_list_bundled_fieldsets",
      { json: true },
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0]!.text) as { name: string }[];
    const names = parsed.map((p) => p.name).sort();
    expect(names).toEqual(
      ["code-audit", "pr-review", "security-audit", "skill-audit"],
    );
  });
});

describe("dispatchMassScoutTool — assess_model (TRDD-f45eeaa0)", () => {
  // A cheap, big, reasoning+structured model qualifies for every tool. Injected
  // so the dispatch never touches the network (pricing is per-TOKEN).
  const catalog: OpenRouterModel[] = [
    {
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 64_000 },
      supported_parameters: ["response_format", "reasoning"],
      pricing: { prompt: "0.00000015", completion: "0.0000006" }, // $0.15 / $0.60 per M
    },
  ];

  it("assesses a model offline via the injected catalog and returns an OK/NO table", async () => {
    const res = await dispatchMassScoutTool(
      "assess_model",
      { model: "google/gemini-2.5-flash" },
      { modelCatalogFetch: async () => catalog },
    );
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain("google/gemini-2.5-flash");
    expect(text).toContain("security_scan");
    expect(text).toContain("benchmark: security-triage");
  });

  it("returns isError when 'model' is missing", async () => {
    const res = await dispatchMassScoutTool(
      "assess_model",
      {},
      { modelCatalogFetch: async () => catalog },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/requires a 'model' id/);
  });

  it("returns isError when the model id is absent from the catalog", async () => {
    const res = await dispatchMassScoutTool(
      "assess_model",
      { model: "nope/missing" },
      { modelCatalogFetch: async () => catalog },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not found in the OpenRouter catalog/);
  });
});

describe("dispatchMassScoutTool — check_model_health (TRDD-828238b5 A2)", () => {
  // Hermetic: a tmp config dir holds settings.yaml + the seeded baseline; the
  // report writes under a tmp CLAUDE_PROJECT_DIR. The catalog is injected so the
  // dispatch never touches the network.
  const ORIG_CFG = process.env.LLM_EXT_CONFIG_DIR;
  const ORIG_PROJ = process.env.CLAUDE_PROJECT_DIR;
  let tmp: string;

  const catalog: OpenRouterModel[] = [
    {
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 64_000 },
      supported_parameters: ["response_format", "reasoning"],
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
    },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join("/tmp", "cmh-dispatch-"));
    process.env.LLM_EXT_CONFIG_DIR = tmp;
    process.env.CLAUDE_PROJECT_DIR = tmp;
    writeFileSync(
      join(tmp, "settings.yaml"),
      [
        "active: t",
        "profiles:",
        "  t:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: google/gemini-2.5-flash",
        "    api_key: sk-test-literal",
        "",
      ].join("\n"),
    );
  });
  afterEach(() => {
    if (ORIG_CFG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG_CFG;
    else delete process.env.LLM_EXT_CONFIG_DIR;
    if (ORIG_PROJ !== undefined) process.env.CLAUDE_PROJECT_DIR = ORIG_PROJ;
    else delete process.env.CLAUDE_PROJECT_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("checks the active profile's model offline and returns a summary + report path", async () => {
    const res = await dispatchMassScoutTool(
      "check_model_health",
      {},
      { modelCatalogFetch: async () => catalog },
    );
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain("google/gemini-2.5-flash");
    expect(text).toContain("Report:");
    expect(text).toContain("reports/model-health");
  });

  it("flags isError + critical when the configured model is absent from the catalog", async () => {
    const res = await dispatchMassScoutTool(
      "check_model_health",
      {},
      { modelCatalogFetch: async () => [] },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("deprecated/removed");
  });
});

describe("dispatchMassScoutTool — discover_new_models (TRDD-828238b5 A4)", () => {
  // Hermetic: a tmp config dir holds the catalog snapshot; the report writes
  // under a tmp CLAUDE_PROJECT_DIR. The catalog is injected so the dispatch
  // never touches the network. No settings.yaml needed (profile-independent).
  const ORIG_CFG = process.env.LLM_EXT_CONFIG_DIR;
  const ORIG_PROJ = process.env.CLAUDE_PROJECT_DIR;
  let tmp: string;

  const model = (id: string): OpenRouterModel => ({
    id,
    name: id,
    context_length: 1_000_000,
    top_provider: { max_completion_tokens: 64_000 },
    supported_parameters: ["response_format", "reasoning"],
    pricing: { prompt: "0.00000001", completion: "0.00000001" },
  });

  beforeEach(() => {
    tmp = mkdtempSync(join("/tmp", "dnm-dispatch-"));
    process.env.LLM_EXT_CONFIG_DIR = tmp;
    process.env.CLAUDE_PROJECT_DIR = tmp;
  });
  afterEach(() => {
    if (ORIG_CFG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG_CFG;
    else delete process.env.LLM_EXT_CONFIG_DIR;
    if (ORIG_PROJ !== undefined) process.env.CLAUDE_PROJECT_DIR = ORIG_PROJ;
    else delete process.env.CLAUDE_PROJECT_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("first run seeds the snapshot and returns a report path", async () => {
    const res = await dispatchMassScoutTool(
      "discover_new_models",
      {},
      { modelCatalogFetch: async () => [model("vendor/a")] },
    );
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    expect(text).toContain("seeded the snapshot");
    expect(text).toContain("reports/model-arrivals");
  });

  it("second run reports the genuinely-new model offline", async () => {
    await dispatchMassScoutTool(
      "discover_new_models",
      {},
      { modelCatalogFetch: async () => [model("vendor/a")] },
    );
    const res = await dispatchMassScoutTool(
      "discover_new_models",
      {},
      { modelCatalogFetch: async () => [model("vendor/a"), model("vendor/b")] },
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("vendor/b");
  });
});
