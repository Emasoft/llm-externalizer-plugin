/**
 * Unit tests for the mass-scouting cost-estimate module.
 *
 * Covers:
 *   • estimateTokens — chars/4 with ceil; 0 bytes maps to 0
 *   • estimateFileCost — input/output split; price math matches USD/M
 *   • bytesCapFromPct — context_window * pct * BYTES_PER_TOKEN
 *   • estimateJobCost — eligible / skipped / over-cap counters; ETA math;
 *     respects `bucket` filter; sums tokens+cost
 *   • checkBudget — allows null, rejects over-budget, rejects negative
 *   • KNOWN_PRICING — qwen entry matches blueprint numbers
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_CONTEXT_PCT_SCOUT,
  KNOWN_PRICING,
  bytesCapFromPct,
  checkBudget,
  estimateFileCost,
  estimateJobCost,
  estimateTokens,
  type ModelPricing,
} from "./cost-estimate";
import { openRegistry, Registry } from "./registry";

const TEST_PRICING: ModelPricing = {
  input_per_m_usd: 0.04,
  output_per_m_usd: 0.1,
  context_window: 1_000, // small so the caps land cleanly in tests
};

// ── estimateTokens ─────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    /** Zero-byte file contributes nothing to the prompt token count. */
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-5)).toBe(0);
  });

  it("rounds up — 1 byte still costs 1 token", () => {
    /** Math.ceil prevents the estimator from under-quoting tiny files. */
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(BYTES_PER_TOKEN - 1)).toBe(1);
  });

  it("matches the BYTES_PER_TOKEN divisor exactly at boundaries", () => {
    /** Boundary check: 4 bytes = 1 token, 8 = 2, 12 = 3. */
    expect(estimateTokens(BYTES_PER_TOKEN)).toBe(1);
    expect(estimateTokens(BYTES_PER_TOKEN * 2)).toBe(2);
    expect(estimateTokens(BYTES_PER_TOKEN * 100)).toBe(100);
  });
});

// ── estimateFileCost ───────────────────────────────────────────────────

describe("estimateFileCost", () => {
  it("sums body + prompt + schema for input tokens", () => {
    /** All three input components must contribute. */
    const out = estimateFileCost({
      body_bytes: 400, // → 100 tokens
      prompt_overhead_bytes: 80, // → 20 tokens
      schema_overhead_bytes: 40, // → 10 tokens
      expected_output_bytes: 80, // → 20 tokens
      pricing: TEST_PRICING,
    });
    expect(out.input_tokens).toBe(100 + 20 + 10);
    expect(out.output_tokens).toBe(20);
  });

  it("computes USD via per-million-token math", () => {
    /** Cost = (in/1M)*p_in + (out/1M)*p_out — verify with hand-math. */
    const out = estimateFileCost({
      body_bytes: 4_000_000, // → 1_000_000 input tokens
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 4_000_000, // → 1_000_000 output tokens
      pricing: TEST_PRICING,
    });
    // 1M input @ $0.04 + 1M output @ $0.10 = $0.14
    expect(out.est_cost_usd).toBeCloseTo(0.14, 6);
  });
});

// ── bytesCapFromPct ────────────────────────────────────────────────────

describe("bytesCapFromPct", () => {
  it("returns context_window * pct * BYTES_PER_TOKEN", () => {
    /** 1000 ctx × 0.4 × 4 bytes/token = 1600 byte cap. */
    expect(bytesCapFromPct(1_000, 0.4)).toBe(1_600);
  });

  it("returns 0 for non-positive inputs", () => {
    /** Defensive: invalid input should not produce negative caps. */
    expect(bytesCapFromPct(0, 0.4)).toBe(0);
    expect(bytesCapFromPct(1_000, 0)).toBe(0);
    expect(bytesCapFromPct(-100, 0.4)).toBe(0);
  });

  it("uses the documented 40% / 50% defaults symbolically", () => {
    /** The constants must equal the TRDD §15 caps. */
    expect(DEFAULT_MAX_CONTEXT_PCT_SCOUT).toBe(0.4);
  });
});

// ── KNOWN_PRICING ──────────────────────────────────────────────────────

describe("KNOWN_PRICING", () => {
  it("has qwen-2.5-7b at the blueprint price ($0.04 in / $0.10 out)", () => {
    /** Drift here would silently break every cost estimate. */
    const p = KNOWN_PRICING["qwen/qwen-2.5-7b-instruct"];
    expect(p).toBeDefined();
    expect(p!.input_per_m_usd).toBe(0.04);
    expect(p!.output_per_m_usd).toBe(0.1);
    expect(p!.context_window).toBeGreaterThanOrEqual(32_000);
  });
});

// ── estimateJobCost (Registry-bound) ───────────────────────────────────

describe("estimateJobCost", () => {
  let reg: Registry;
  beforeEach(() => {
    reg = openRegistry({ path: ":memory:" });
  });
  afterEach(() => {
    reg.close();
  });

  /**
   * Helper: register a file with controlled body size and bucket. The body
   * is filled with `'a'` but the path bytes are stamped at the front so
   * different paths produce different fingerprints (the registry is
   * idempotent on fingerprint, so identical bodies dedupe to one row).
   */
  function seed(path: string, bodyBytes: number, bucket = "unknown"): string {
    const body = Buffer.alloc(bodyBytes, 0x61);
    const stamp = Buffer.from(path);
    stamp.copy(body, 0, 0, Math.min(stamp.length, bodyBytes));
    const out = reg.registerFile({
      file_path: path,
      source_root: "/x",
      body,
      registered_via: "folder",
    });
    if (bucket !== "unknown") {
      reg.updateClassification(out.fingerprint, { classifier_bucket: bucket });
    }
    return out.fingerprint;
  }

  it("counts every eligible file and sums their cost", () => {
    /** All three files fit under the 40%-of-1000 = 1600 byte scout cap. */
    seed("/x/a.ts", 100, "sourcecode");
    seed("/x/b.ts", 200, "sourcecode");
    seed("/x/c.ts", 300, "sourcecode");
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
    });
    expect(out.files_eligible).toBe(3);
    expect(out.files_skipped_too_big).toBe(0);
    expect(out.files_over_register_cap).toBe(0);
    expect(out.total_input_tokens).toBe(25 + 50 + 75); // 100/4, 200/4, 300/4
    expect(out.total_output_tokens).toBe(60); // 3 × 20
    // (150in/1M)*$0.04 + (60out/1M)*$0.10 = $0.000_006 + $0.000_006 = $0.000_012
    expect(out.est_cost_usd).toBeCloseTo(0.000_012, 8);
  });

  it("skips files larger than the scout cap (> 40% of context)", () => {
    /** Cap = 1000 × 0.4 × 4 = 1600 bytes. A 1700-byte file must skip. */
    seed("/x/small.ts", 100);
    seed("/x/big.ts", 1_700);
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
    });
    expect(out.files_eligible).toBe(1);
    expect(out.files_skipped_too_big).toBe(1);
  });

  it("counts files over the register cap separately from scout-cap skips", () => {
    /** Register cap = 1000 × 0.5 × 4 = 2000. A 2500-byte file is over both. */
    seed("/x/oversize.ts", 2_500);
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
    });
    expect(out.files_over_register_cap).toBe(1);
    expect(out.files_skipped_too_big).toBe(0);
    expect(out.files_eligible).toBe(0);
  });

  it("respects the bucket filter", () => {
    /** Only `documentation` rows should be counted. */
    seed("/x/a.md", 100, "documentation");
    seed("/x/b.ts", 100, "sourcecode");
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
      bucket: "documentation",
    });
    expect(out.files_eligible).toBe(1);
  });

  it("computes ETA = ceil(eligible * per_call_seconds / workers)", () => {
    /** 100 files × 1.0s ÷ 10 workers = 10s. */
    for (let i = 0; i < 100; i++) seed(`/x/${i}.ts`, 100);
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
      worker_count: 10,
      per_call_seconds: 1.0,
    });
    expect(out.est_seconds).toBe(10);
  });

  it("never reports negative ETA for an empty registry", () => {
    /** Defensive: caller may run estimate before any file is registered. */
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
    });
    expect(out.files_eligible).toBe(0);
    expect(out.est_seconds).toBe(0);
    expect(out.est_cost_usd).toBe(0);
  });

  it("respects custom max_context_pct_scout overrides", () => {
    /** Tightening the cap (0.1 → 400 bytes) should shed eligible rows. */
    seed("/x/a.ts", 200);
    seed("/x/b.ts", 700);
    const out = estimateJobCost(reg, {
      pricing: TEST_PRICING,
      prompt_overhead_bytes: 0,
      schema_overhead_bytes: 0,
      expected_output_bytes: 80,
      max_context_pct_scout: 0.1, // 1000 × 0.1 × 4 = 400 byte cap
    });
    expect(out.files_eligible).toBe(1); // only the 200-byte file
    expect(out.files_skipped_too_big).toBe(1);
  });
});

// ── checkBudget ────────────────────────────────────────────────────────

describe("checkBudget", () => {
  it("returns {allowed:true} when budget is null (no gate)", () => {
    /** Caller didn't pass --budget-usd → no enforcement. */
    expect(checkBudget(0.05, null)).toEqual({ allowed: true });
  });

  it("returns {allowed:true} when est <= budget", () => {
    /** Equal-to-budget is on-budget, not over-budget. */
    expect(checkBudget(0.1, 0.1)).toEqual({ allowed: true });
    expect(checkBudget(0.05, 0.1)).toEqual({ allowed: true });
  });

  it("rejects when est > budget and includes the over-amount in the reason", () => {
    /** Reason text drives the user-facing error message. */
    const out = checkBudget(0.15, 0.1);
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/0\.1500/);
    expect(out.reason).toMatch(/0\.1000/);
    expect(out.reason).toMatch(/0\.0500/);
  });

  it("rejects negative or non-finite budgets as invalid", () => {
    /** Defensive: --budget-usd -1 should not silently allow everything. */
    expect(checkBudget(0.0, -0.5).allowed).toBe(false);
    expect(checkBudget(0.0, Number.POSITIVE_INFINITY).allowed).toBe(false);
    expect(checkBudget(0.0, Number.NaN).allowed).toBe(false);
  });
});
