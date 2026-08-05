/**
 * Unit tests for the --estimate dry-run estimator (task #187).
 *
 * Everything is pure and deps-injected, so these tests assert the exact
 * arithmetic — no fs, no network, no engine boot. The load-bearing negatives:
 * an unknown tool must THROW (never print a fabricated number), and a ':free'
 * slot must price at $0 even when the catalog carries no entry for it.
 */
import { describe, it, expect } from "vitest";
import {
  estimateToolRun,
  renderEstimate,
  PROMPT_OVERHEAD_TOKENS,
  EXPECTED_OUTPUT_TOKENS_PER_REQUEST,
  type EstimateDeps,
} from "./estimate.js";
import { foldOutputEwma } from "./usage-history.js";

/** 4000-byte files → exactly 1000 tokens each under the bytes/4 model. */
function deps(overrides: Partial<EstimateDeps> = {}): EstimateDeps {
  return {
    resolveFiles: () => ({ files: ["/a.ts", "/b.ts"] }),
    fileSizeBytes: () => 4000,
    ensembleSlots: () => [{ id: "vendor/model-paid", maxOutput: 8000 }],
    pricingFor: () => ({ inputUsdPerM: 1, outputUsdPerM: 2 }),
    defaultMaxTokens: () => 4000,
    ...overrides,
  };
}

describe("estimateToolRun — arithmetic", () => {
  it("per-file tool: requests = files × slots; input re-bills instructions+overhead per request", () => {
    const e = estimateToolRun("scan_folder", { instructions: "x".repeat(400) }, deps());
    expect(e.files).toBe(2);
    expect(e.requests).toBe(2); // 2 files × 1 slot
    const row = e.rows[0];
    // Per file: 1000 (body) + 100 (instructions) + overhead; × 2 files.
    expect(row.inputTokens).toBe(2 * (1000 + 100 + PROMPT_OVERHEAD_TOKENS));
    // Ceiling: max_tokens default 4000 (< maxOutput 8000) × 2 requests.
    expect(row.outputCeilingTokens).toBe(8000);
    expect(row.outputExpectedTokens).toBe(2 * EXPECTED_OUTPUT_TOKENS_PER_REQUEST);
    // USD: in 5200/1M×$1 + outCeil 8000/1M×$2.
    expect(row.ceilingUsd).toBeCloseTo(0.0052 + 0.016, 10);
    expect(e.totalCeilingUsd).toBeCloseTo(row.ceilingUsd as number, 10);
  });

  it("max_tokens is clamped by the slot's own maxOutput", () => {
    const e = estimateToolRun(
      "code_task",
      { max_tokens: 64000 },
      deps({ ensembleSlots: () => [{ id: "m", maxOutput: 3000 }] }),
    );
    expect(e.rows[0].outputCeilingTokens).toBe(2 * 3000);
  });

  it("ensemble multiplies requests across slots, each slot priced on its own", () => {
    const e = estimateToolRun(
      "scan_folder",
      {},
      deps({
        ensembleSlots: () => [
          { id: "a", maxOutput: 4000 },
          { id: "b", maxOutput: 4000 },
          { id: "c", maxOutput: 4000 },
        ],
      }),
    );
    expect(e.requests).toBe(6); // 2 files × 3 slots
    expect(e.rows).toHaveLength(3);
  });

  it("':free' slots are $0 even with no catalog pricing", () => {
    const e = estimateToolRun(
      "scan_folder",
      {},
      deps({
        ensembleSlots: () => [{ id: "v/m:free", maxOutput: 4000 }],
        pricingFor: () => null,
      }),
    );
    expect(e.rows[0].ceilingUsd).toBe(0);
    expect(e.totalCeilingUsd).toBe(0);
  });

  it("unknown pricing on a PAID slot degrades to tokens-only (null USD) with a note", () => {
    const e = estimateToolRun(
      "scan_folder",
      {},
      deps({ pricingFor: () => null }),
    );
    expect(e.rows[0].ceilingUsd).toBeNull();
    expect(e.totalCeilingUsd).toBeNull();
    expect(e.notes.join(" ")).toContain("pricing unknown");
  });

  it("zero-cost tools report $0 without resolving files", () => {
    const e = estimateToolRun(
      "discover",
      {},
      deps({
        resolveFiles: () => {
          throw new Error("must not be called");
        },
      }),
    );
    expect(e.totalCeilingUsd).toBe(0);
    expect(e.requests).toBe(0);
  });
});

describe("estimateToolRun — fail-fast negatives", () => {
  it("THROWS for a tool it does not model — a guess is worse than an error", () => {
    expect(() => estimateToolRun("some_future_tool", {}, deps())).toThrow(
      /does not model/,
    );
  });

  it("THROWS when the run would process zero files", () => {
    expect(() =>
      estimateToolRun("scan_folder", {}, deps({ resolveFiles: () => ({ files: [] }) })),
    ).toThrow(/zero files/);
  });

  it("THROWS on file-resolution failure instead of estimating a different file set", () => {
    expect(() =>
      estimateToolRun(
        "scan_folder",
        {},
        deps({ resolveFiles: () => ({ files: [], error: "folder_path not found: /x" }) }),
      ),
    ).toThrow(/folder_path not found/);
  });

  it("points mass_scout at its own tighter estimator", () => {
    expect(() => estimateToolRun("mass_scout_run", {}, deps())).toThrow(
      /own estimator/,
    );
  });

  it("refuses security_scan — it routes through mass_scouting on models this estimator cannot see (ultracode F5)", () => {
    expect(() => estimateToolRun("security_scan", {}, deps())).toThrow(
      /mass_scouting subsystem/,
    );
  });
});

describe("chat with zero files (ultracode F8) — a legal billable run, one request per slot", () => {
  it("instructions-only chat estimates one request per slot instead of aborting", () => {
    const e = estimateToolRun(
      "chat",
      { instructions: "x".repeat(400) },
      deps({ resolveFiles: () => ({ files: [], error: "no input_files_paths or folder_path given" }) }),
    );
    expect(e.files).toBe(0);
    expect(e.requests).toBe(1);
    // 100 (instructions) + overhead, no file bytes.
    expect(e.rows[0].inputTokens).toBe(100 + PROMPT_OVERHEAD_TOKENS);
    expect(e.notes.join("\n")).toMatch(/instructions\/input_files_content-only chat/);
  });

  it("input_files_content bytes are counted — they are billed like any other prompt bytes", () => {
    const e = estimateToolRun(
      "chat",
      { input_files_content: "y".repeat(4000) },
      deps({ resolveFiles: () => ({ files: [] }) }),
    );
    expect(e.requests).toBe(1);
    expect(e.rows[0].inputTokens).toBe(1000 + PROMPT_OVERHEAD_TOKENS);
  });

  it("a NON-chat tool with zero files still throws — only chat is billable file-less", () => {
    expect(() =>
      estimateToolRun(
        "code_task",
        { instructions: "review" },
        deps({ resolveFiles: () => ({ files: [] }) }),
      ),
    ).toThrow(/zero files/);
  });
});

describe("compare_files (ultracode F12) — pairs, not a flat file list", () => {
  it("git mode is $0 by construction — the tool diffs refs locally without any LLM", () => {
    const e = estimateToolRun("compare_files", { git_repo: "/repo", from_ref: "a" }, deps());
    expect(e.requests).toBe(0);
    expect(e.totalCeilingUsd).toBe(0);
    expect(e.notes.join("\n")).toMatch(/no LLM request/);
  });

  it("file_pairs batch: one request per 2-element pair; group markers are not pairs", () => {
    const e = estimateToolRun(
      "compare_files",
      { file_pairs: [["group: g1"], ["/a.ts", "/b.ts"], ["/c.ts", "/d.ts"]] },
      deps(),
    );
    expect(e.requests).toBe(2); // 2 pairs × 1 slot
    // Per pair: 2×(4000+4000) bytes → 4000 tokens, + overhead; × 2 pairs.
    expect(e.rows[0].inputTokens).toBe(2 * (4000 + PROMPT_OVERHEAD_TOKENS));
  });

  it("pair mode requires exactly 2 input_files_paths — mirroring the tool's own contract", () => {
    expect(() =>
      estimateToolRun(
        "compare_files",
        {},
        deps({ resolveFiles: () => ({ files: ["/a.ts", "/b.ts", "/c.ts"] }) }),
      ),
    ).toThrow(/exactly 2/);
    const e = estimateToolRun("compare_files", {}, deps()); // default deps: 2 files
    expect(e.requests).toBe(1);
  });
});

describe("per-tool model slots (ultracode F5)", () => {
  it("the estimator asks the seam for slots WITH the tool name, so tool-specific routing can be priced", () => {
    const seen: (string | undefined)[] = [];
    estimateToolRun(
      "high_quality_scan",
      { instructions: "audit" },
      deps({
        ensembleSlots: (toolName) => {
          seen.push(toolName);
          return [{ id: "z-ai/glm-5.2", maxOutput: 8000 }];
        },
      }),
    );
    expect(seen).toEqual(["high_quality_scan"]);
  });
});

describe("calibrated EXPECTED (task #188)", () => {
  it("uses the EWMA once n ≥ 3, clamped by the ceiling; the CEILING never calibrates", () => {
    const e = estimateToolRun(
      "scan_folder",
      {},
      deps({ calibratedOutputTokens: () => ({ ewma: 900.4, n: 5 }) }),
    );
    // 2 requests × ceil(900.4) = 1802 expected; ceiling stays 2 × 4000.
    expect(e.rows[0].outputExpectedTokens).toBe(2 * 901);
    expect(e.rows[0].outputCeilingTokens).toBe(8000);
    expect(e.notes.join(" ")).toContain("calibrated from 5 recorded runs");
  });

  it("ignores a calibration with fewer than 3 samples — one lucky reply must not swing a budget", () => {
    const e = estimateToolRun(
      "scan_folder",
      {},
      deps({ calibratedOutputTokens: () => ({ ewma: 5, n: 2 }) }),
    );
    expect(e.rows[0].outputExpectedTokens).toBe(2 * EXPECTED_OUTPUT_TOKENS_PER_REQUEST);
    expect(e.notes.join(" ")).not.toContain("calibrated");
  });

  it("EWMA fold maths: first sample seeds, later samples blend at α", () => {
    const first = foldOutputEwma(undefined, 1000);
    expect(first).toEqual({ ewma: 1000, n: 1 });
    const second = foldOutputEwma(first, 2000, 0.3);
    expect(second.n).toBe(2);
    expect(second.ewma).toBeCloseTo(0.3 * 2000 + 0.7 * 1000, 10);
  });
});

describe("renderEstimate", () => {
  it("prints a greppable dry-run banner with expected and ceiling totals", () => {
    const out = renderEstimate(estimateToolRun("scan_folder", {}, deps()));
    expect(out).toContain("ESTIMATE (dry-run — nothing was sent)");
    expect(out).toMatch(/TOTAL: expected \$[0-9.]+, ceiling \$[0-9.]+/);
  });
});
