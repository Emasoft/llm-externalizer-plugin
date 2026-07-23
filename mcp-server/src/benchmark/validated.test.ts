// Phase 3 (TRDD-8b6b3646): the IRON RULE validation gate + difficulty hierarchy.
// A paid OpenRouter model is validated for a tool iff it passed that tool's
// benchmark OR any HARDER one; local + ':free' are exempt; a missing ledger
// refuses (cost-safety does NOT fail open). Reads real ledger files from an
// isolated temp config dir (LLM_EXT_CONFIG_DIR).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  validatedForTool,
  validatedModelsForTool,
  assertModelValidated,
  setValidationBypassForTests,
  setBenchmarkValidationExempt,
  recordGeneralKeywordPasses,
  clearValidatedMemo,
  rankForTool,
  TOOL_DIFFICULTY_RANK,
} from "./validated.js";

let cfg: string;
let prevCfgDir: string | undefined;

/** Write a `modelId::date::hash`-keyed deterministic ledger (failureReasons=[]
 *  means PASS). */
function writeDeterministic(file: string, entries: Record<string, { failureReasons: string[] }>) {
  const out: Record<string, unknown> = {};
  for (const [modelId, v] of Object.entries(entries)) {
    out[`${modelId}::2026-07-16::hashA`] = { date: "2026-07-16", failureReasons: v.failureReasons };
  }
  writeFileSync(join(cfg, file), JSON.stringify(out), "utf-8");
}

function writeTriage(entries: Record<string, { pass: boolean; inconclusive: boolean }>) {
  const out: Record<string, unknown> = {};
  for (const [modelId, v] of Object.entries(entries)) {
    out[`${modelId}::2026-07-16::hashB`] = { date: "2026-07-16", score: { pass: v.pass, inconclusive: v.inconclusive } };
  }
  writeFileSync(join(cfg, "security-triage-results.json"), JSON.stringify(out), "utf-8");
}

function writeKeyword(rows: Array<{ modelId: string; ok: boolean; pass: boolean }>) {
  writeFileSync(join(cfg, "benchmark-results.json"), JSON.stringify({ results: rows }), "utf-8");
}

beforeEach(() => {
  cfg = mkdtempSync(join("/tmp", "validated-"));
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfg;
});
afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  rmSync(cfg, { recursive: true, force: true });
});

describe("validated — difficulty hierarchy", () => {
  it("ranks code_task hardest and unknown tools at the floor (0)", () => {
    expect(TOOL_DIFFICULTY_RANK.code_task).toBe(5);
    expect(rankForTool("code_task")).toBeGreaterThan(rankForTool("security_scan"));
    expect(rankForTool("chat")).toBe(0); // no dedicated benchmark → floor
    expect(rankForTool("cluster_synonyms")).toBe(0);
  });

  it("a HARDER pass covers an EASIER tool, but not vice-versa", () => {
    // deepseek passed code_task (hardest); qwen passed only security_scan (easiest tool w/ bench).
    writeDeterministic("code-task-results.json", { "d/deepseek": { failureReasons: [] } });
    writeTriage({ "q/qwen": { pass: true, inconclusive: false } });

    // deepseek (code_task pass) is validated for code_task AND every easier tool.
    expect(validatedForTool("d/deepseek", "code_task")).toBe(true);
    expect(validatedForTool("d/deepseek", "security_scan")).toBe(true);
    expect(validatedForTool("d/deepseek", "chat")).toBe(true); // rank-0 tool

    // qwen (security_scan pass) is validated for security_scan and the rank-0 floor,
    // but NOT for the harder code_task.
    expect(validatedForTool("q/qwen", "security_scan")).toBe(true);
    expect(validatedForTool("q/qwen", "chat")).toBe(true);
    expect(validatedForTool("q/qwen", "code_task")).toBe(false);
  });

  it("a GENERAL keyword pass validates only rank-0 tools, never a benchmarked tool", () => {
    writeKeyword([{ modelId: "g/general", ok: true, pass: true }]);
    expect(validatedForTool("g/general", "chat")).toBe(true); // floor
    expect(validatedForTool("g/general", "security_scan")).toBe(false); // rank 1 > 0
    expect(validatedForTool("g/general", "code_task")).toBe(false);
  });
});

describe("validated — pass/fail extraction", () => {
  it("a non-empty failureReasons is NOT a pass (empty/errored/429 runs excluded)", () => {
    writeDeterministic("code-task-results.json", {
      "good/model": { failureReasons: [] },
      "bad/model": { failureReasons: ["case1: wrong"] },
    });
    const set = validatedModelsForTool("code_task");
    expect(set.has("good/model")).toBe(true);
    expect(set.has("bad/model")).toBe(false);
  });

  it("an inconclusive triage run is NOT a pass", () => {
    writeTriage({
      "p/pass": { pass: true, inconclusive: false },
      "i/incon": { pass: false, inconclusive: true },
    });
    const set = validatedModelsForTool("security_scan");
    expect(set.has("p/pass")).toBe(true);
    expect(set.has("i/incon")).toBe(false);
  });
});

describe("assertModelValidated — the send-time chokepoint", () => {
  it("refuses an unvalidated paid model with a copy-pasteable validate command", () => {
    let msg = "";
    try {
      assertModelValidated("x/unvalidated", "code_task", "openrouter");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("IRON RULE");
    expect(msg).toContain("x/unvalidated");
    expect(msg).toContain("--code-task");
    expect(msg).toContain("--allow-paid-models-tests");
    expect(msg).toContain("no money");
  });

  it("REFUSES on a missing ledger — cost-safety does not fail open", () => {
    // No ledger files written at all.
    expect(() => assertModelValidated("x/paid", "code_task", "openrouter")).toThrow(/IRON RULE/);
  });

  it("allows a validated paid model", () => {
    writeDeterministic("code-task-results.json", { "ok/model": { failureReasons: [] } });
    expect(() => assertModelValidated("ok/model", "code_task", "openrouter")).not.toThrow();
  });

  it("is a NO-OP for a local backend and for a ':free' model (exempt)", () => {
    expect(() => assertModelValidated("anything/paid", "code_task", "local")).not.toThrow();
    expect(() => assertModelValidated("anything:free", "code_task", "openrouter")).not.toThrow();
  });

  it("the test-only bypass suppresses the gate, and resets cleanly", () => {
    setValidationBypassForTests(true);
    expect(() => assertModelValidated("x/paid", "code_task", "openrouter")).not.toThrow();
    setValidationBypassForTests(false);
    expect(() => assertModelValidated("x/paid", "code_task", "openrouter")).toThrow(/IRON RULE/);
  });

  it("the BENCHMARK exemption suppresses the gate, and resets cleanly", () => {
    // Production, not test-only: a benchmark is the ONLY thing that can PRODUCE a
    // validation, so gating its own subject is circular — security_scan's judge
    // would refuse the candidate the run exists to score, and no paid model could
    // ever become validated for it.
    setBenchmarkValidationExempt(true);
    expect(() => assertModelValidated("x/paid", "security_scan", "openrouter")).not.toThrow();
    setBenchmarkValidationExempt(false);
    expect(() => assertModelValidated("x/paid", "security_scan", "openrouter")).toThrow(/IRON RULE/);
  });
});

describe("validated — the rank-0 ledger accumulates (a later sweep cannot revoke)", () => {
  it("a ':free'-only sweep does NOT revoke a paid model's earlier rank-0 pass", () => {
    // The bug: benchmark-results.json is a whole-file SNAPSHOT. A background
    // free-pool bench overwrote it with ':free' rows only, so every rank-0 tool
    // (chat, compare_files, …) started refusing a paid model that worked minutes
    // earlier. The accumulating ledger is what makes the pass durable.
    recordGeneralKeywordPasses(
      [{ modelId: "paid/model", ok: true, pass: true, schemaCompliant: true }],
      "2026-07-20T10:00:00.000Z",
    );
    expect(validatedForTool("paid/model", "chat")).toBe(true);

    // A later ':free'-only sweep: snapshot replaced wholesale, ledger appended to.
    writeKeyword([{ modelId: "some:free", ok: true, pass: true }]);
    recordGeneralKeywordPasses(
      [{ modelId: "some:free", ok: true, pass: true, schemaCompliant: true }],
      "2026-07-21T10:00:00.000Z",
    );
    clearValidatedMemo(); // otherwise the 5s memo answers and proves nothing

    expect(validatedForTool("paid/model", "chat")).toBe(true);
    expect(validatedForTool("some:free", "chat")).toBe(true);
  });

  it("a newer FAIL in the ledger supersedes an older PASS — and the snapshot cannot resurrect it", () => {
    recordGeneralKeywordPasses(
      [{ modelId: "flaky/model", ok: true, pass: true, schemaCompliant: true }],
      "2026-07-20T10:00:00.000Z",
    );
    recordGeneralKeywordPasses(
      [{ modelId: "flaky/model", ok: true, pass: false, schemaCompliant: true }],
      "2026-07-21T10:00:00.000Z",
    );
    // A stale snapshot still claiming the old PASS must NOT override the ledger:
    // the ledger is authoritative for every model it mentions.
    writeKeyword([{ modelId: "flaky/model", ok: true, pass: true }]);
    clearValidatedMemo();
    expect(validatedForTool("flaky/model", "chat")).toBe(false);
  });

  it("the legacy snapshot still validates a model the ledger has never seen", () => {
    // Backward compatibility: an install whose only proof predates the ledger.
    writeKeyword([{ modelId: "legacy/model", ok: true, pass: true }]);
    expect(validatedForTool("legacy/model", "chat")).toBe(true);
  });

  it("schemaCompliant:false is NOT a rank-0 pass, in either source", () => {
    // ONE definition of "passed the keyword sweep" — matching --apply-free-pool's
    // own filter. Before this the gate used the looser `ok && pass`.
    recordGeneralKeywordPasses(
      [{ modelId: "noschema/ledger", ok: true, pass: true, schemaCompliant: false }],
      "2026-07-20T10:00:00.000Z",
    );
    writeFileSync(
      join(cfg, "benchmark-results.json"),
      JSON.stringify({ results: [{ modelId: "noschema/snap", ok: true, pass: true, schemaCompliant: false }] }),
      "utf-8",
    );
    clearValidatedMemo();
    expect(validatedForTool("noschema/ledger", "chat")).toBe(false);
    expect(validatedForTool("noschema/snap", "chat")).toBe(false);
  });
});
