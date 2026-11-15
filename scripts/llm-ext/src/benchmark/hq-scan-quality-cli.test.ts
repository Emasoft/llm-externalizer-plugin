// TRDD-FUHTNE04 — the --hq-scan-quality benchmark flag. runHqScanQualityBenchmark had
// no caller, so hq-scan-quality-results.json was never written and high_quality_scan
// never got a verdict. These tests pin the flag parse and the pre-call dispatch decision
// (roster resolution + the paid-benchmark cost guard) with NO network: the catalog is
// passed in as data.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { parseArgs, type CliOptions } from "./cli-args.js";
import {
  hqSpendRefusal,
  isTransientFailureReason,
  resolveHqScanQualityRoster,
  runHqScanQualityRoster,
  type HqScanQualityResult,
  type HqScanQualityRosterEntry,
} from "./hq-scan-quality.js";
import { setPaidBenchmarksAllowed, type OpenRouterModel } from "./discover.js";
import { setAllowPaidModels } from "../paid-switch.js";

function parse(...args: string[]): CliOptions {
  return parseArgs(["node", "benchmark.js", ...args]);
}

const catalog: OpenRouterModel[] = [
  { id: "v/cheap", context_length: 64000, pricing: { prompt: "0.0000005", completion: "0.0000005" } },
  { id: "v/zero", context_length: 32000, pricing: { prompt: "0", completion: "0" } },
  { id: "v/listed:free", context_length: 16000, pricing: { prompt: "0", completion: "0" } },
  { id: "v/noctx:free", pricing: { prompt: "0", completion: "0" } },
  { id: "v/badprice", context_length: 8000, pricing: { prompt: "n/a", completion: "0" } },
];

describe("parseArgs — --hq-scan-quality", () => {
  it("is off by default", () => {
    const o = parse();
    expect(o.hqScanQuality).toBe(false);
    expect(o.hqScanQualityModels).toEqual([]);
  });

  it("collects every following non-flag token as a model id", () => {
    const o = parse("--hq-scan-quality", "a/b:free", "c/d", "--allow-paid-models-tests");
    expect(o.hqScanQuality).toBe(true);
    expect(o.hqScanQualityModels).toEqual(["a/b:free", "c/d"]);
    expect(o.allowPaidModelsTests).toBe(true);
  });

  it("survives next to --dry-run", () => {
    const o = parse("--dry-run", "--hq-scan-quality", "a/b:free");
    expect(o.dryRun).toBe(true);
    expect(o.hqScanQualityModels).toEqual(["a/b:free"]);
  });
});

describe("resolveHqScanQualityRoster — dispatch decision before any model call", () => {
  beforeEach(() => {
    setAllowPaidModels(true);
    setPaidBenchmarksAllowed(false);
  });
  afterEach(() => {
    setAllowPaidModels(false);
    setPaidBenchmarksAllowed(false);
  });

  it("refuses an empty roster (there is no auto-discovery)", () => {
    expect(() => resolveHqScanQualityRoster([], catalog)).toThrow(/at least one model id/);
  });

  it("runs :free and $0-priced ids with no paid opt-in", () => {
    const r = resolveHqScanQualityRoster(["v/listed:free", "v/zero"], catalog);
    expect(r.map((e) => e.id)).toEqual(["v/listed:free", "v/zero"]);
    for (const e of r) {
      expect(e.pricing.input_per_m_usd).toBe(0);
      expect(e.pricing.output_per_m_usd).toBe(0);
    }
  });

  it("refuses a billable id without --allow-paid-models-tests", () => {
    expect(() => resolveHqScanQualityRoster(["v/listed:free", "v/cheap"], catalog)).toThrow(/v\/cheap/);
  });

  it("admits a billable id once the paid opt-in is on, priced from the catalog", () => {
    setPaidBenchmarksAllowed(true);
    const [e] = resolveHqScanQualityRoster(["v/cheap"], catalog);
    expect(e.pricing.input_per_m_usd).toBeCloseTo(0.5, 10);
    expect(e.pricing.context_window).toBe(64000);
  });

  it("refuses a billable id the catalog does not price", () => {
    setPaidBenchmarksAllowed(true);
    expect(() => resolveHqScanQualityRoster(["v/unknown"], catalog)).toThrow(/not in the OpenRouter catalog/);
  });

  it("refuses even a :free id the catalog does not list (no guessed price or context window)", () => {
    expect(() => resolveHqScanQualityRoster(["v/unlisted:free"], catalog)).toThrow(/not in the OpenRouter catalog/);
  });

  it("refuses a catalog entry with no context window or an unparseable price", () => {
    expect(() => resolveHqScanQualityRoster(["v/noctx:free"], catalog)).toThrow(/context window/);
    setPaidBenchmarksAllowed(true);
    expect(() => resolveHqScanQualityRoster(["v/badprice"], catalog)).toThrow(/price of v\/badprice is missing or invalid/);
  });
});

describe("hqSpendRefusal — stop before a model the remaining budget cannot cover", () => {
  it("always runs a $0 model, even with nothing left", () => {
    expect(hqSpendRefusal(0, 5, 2, 0)).toBeNull();
  });

  it("runs a paid model that fits both the run budget and the daily remainder", () => {
    expect(hqSpendRefusal(0.1, 0.5, 2, 0.4)).toBeNull();
  });

  it("stops when the estimate exceeds what is left of --budget-usd", () => {
    expect(hqSpendRefusal(0.6, 1.5, 2, 10)).toMatch(/--budget-usd/);
  });

  it("stops when the estimate exceeds what is left of the daily cap", () => {
    expect(hqSpendRefusal(0.3, 0, 2, 0.2)).toMatch(/daily_cap/);
  });
});

describe("isTransientFailureReason — only provider outages, never model facts", () => {
  it("classifies network errors, 408/429/5xx and malformed bodies as transient", () => {
    expect(isTransientFailureReason("request failed: fetch failed")).toBe(true);
    expect(isTransientFailureReason("API error 429: rate limited")).toBe(true);
    expect(isTransientFailureReason("API error 408: timeout")).toBe(true);
    expect(isTransientFailureReason("API error 503: upstream")).toBe(true);
    expect(isTransientFailureReason("malformed response body (HTTP 200): Unexpected end")).toBe(true);
  });

  it("treats a timeout, a non-retryable 4xx and an empty reply as facts about the model", () => {
    expect(isTransientFailureReason("request failed: The operation was aborted due to timeout")).toBe(false);
    expect(isTransientFailureReason("API error 400: context length exceeded")).toBe(false);
    expect(isTransientFailureReason("API error 404: no such model")).toBe(false);
    expect(isTransientFailureReason("LLM returned empty response")).toBe(false);
    expect(isTransientFailureReason("no report produced")).toBe(false);
  });
});

function fakeResult(id: string, pass: boolean, inconclusive: boolean, costUsd: number): HqScanQualityResult {
  return { modelId: id, pass, inconclusive, microF1: 0, microRecall: 0, microPrecision: 0, coverage: 0, failures: [], costUsd, summaryLine: "" };
}

const entry = (id: string, price: number): HqScanQualityRosterEntry => ({
  id,
  inputDollarsPerMillion: price,
  outputDollarsPerMillion: price,
  pricing: { input_per_m_usd: price, output_per_m_usd: price, context_window: 1000 },
});

describe("runHqScanQualityRoster — the phase loop with injected side effects", () => {
  it("runs every model, books each actual cost once, and labels inconclusive apart from fail", async () => {
    const booked: number[] = [];
    const out = await runHqScanQualityRoster([entry("a:free", 0), entry("b", 1), entry("c", 1)], {
      budgetUsd: 10,
      estimateUsd: (e) => (e.inputDollarsPerMillion === 0 ? 0 : 0.5),
      dailyRemainingUsd: () => 10,
      bookSpend: (usd) => booked.push(usd),
      run: async (e) => (e.id === "a:free" ? fakeResult(e.id, true, false, 0) : e.id === "b" ? fakeResult(e.id, false, true, 0.2) : fakeResult(e.id, false, false, 0.3)),
    });
    expect(out.stopped).toBeUndefined();
    expect(out.results.map((r) => r.label)).toEqual(["pass", "inconclusive", "fail"]);
    expect(booked).toEqual([0, 0.2, 0.3]);
    expect(out.spendUsd).toBeCloseTo(0.5, 10);
  });

  it("stops before the model the remaining run budget cannot cover and lists every model not run", async () => {
    const ran: string[] = [];
    const out = await runHqScanQualityRoster([entry("b", 1), entry("c", 1), entry("d", 1)], {
      budgetUsd: 1,
      estimateUsd: () => 0.6,
      dailyRemainingUsd: () => 10,
      bookSpend: () => {},
      run: async (e) => {
        ran.push(e.id);
        return fakeResult(e.id, true, false, 0.5);
      },
    });
    expect(ran).toEqual(["b"]);
    expect(out.stopped?.beforeId).toBe("c");
    expect(out.stopped?.notRun).toEqual(["c", "d"]);
    expect(out.stopped?.reason).toMatch(/--budget-usd/);
  });

  it("never consults the daily remainder for a $0 model (a corrupt ledger reads 0 and must not block free runs)", async () => {
    let asked = 0;
    const out = await runHqScanQualityRoster([entry("a:free", 0)], {
      budgetUsd: 0,
      estimateUsd: () => 0,
      dailyRemainingUsd: () => {
        asked++;
        return 0;
      },
      bookSpend: () => {},
      run: async (e) => fakeResult(e.id, true, false, 0),
    });
    expect(asked).toBe(0);
    expect(out.results).toHaveLength(1);
  });

  it("stops a paid model when the daily remainder is exhausted, before sending it", async () => {
    const out = await runHqScanQualityRoster([entry("b", 1)], {
      budgetUsd: 10,
      estimateUsd: () => 0.1,
      dailyRemainingUsd: () => 0,
      bookSpend: () => {},
      run: async () => {
        throw new Error("must not run");
      },
    });
    expect(out.stopped?.reason).toMatch(/daily_cap/);
  });
});
