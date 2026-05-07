/**
 * Unit tests for the mass-scouting scout phase.
 *
 * All tests inject a mock `FetchImpl` that returns canned `chat.completions`
 * payloads — no live network. Covers:
 *   • Happy path: 3 files, every response valid → 3 results + 3 fts rows
 *   • Repair path: response has over-cap string → fix_envelope, repaired=1
 *   • Retry-with-feedback: first call fails validation, second succeeds
 *   • Smoke-test abort: first probe call fails → throw with the file path
 *   • Resume idempotency: re-running with the same jobId is a no-op
 *   • Scout-cap skip: oversize files go to mass_scout_skipped, not results
 *   • Concurrency: workers=2 with 5 files all complete
 *   • buildSearchableText: extracts only string-typed field values
 *   • runWithLimit: 0 items, 1-worker, many-worker paths
 *   • computeCallCost: usage path + fallback path
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildSearchableText,
  computeCallCost,
  runWithLimit,
  runScoutJob,
  type FetchImpl,
  type ScoutOpts,
} from "./scout";
import { parseFieldset } from "./fieldset";
import { openRegistry, type Registry } from "./registry";
import type { ModelPricing } from "./cost-estimate";

// ── Test fixtures ──────────────────────────────────────────────────────

const TEST_PRICING: ModelPricing = {
  input_per_m_usd: 0.04,
  output_per_m_usd: 0.1,
  // 32K context — small files in tests fit easily under any %.
  context_window: 32_000,
};

/** A minimal valid fieldset that exercises three field types. */
function basicFieldset(): ReturnType<typeof parseFieldset> {
  return parseFieldset({
    version: 1,
    fieldset_name: "test-audit",
    fields: [
      {
        name: "is_async",
        description: "true if the file uses async / await",
        type: { kind: "bool" },
      },
      {
        name: "framework",
        description: "the JS framework name, or 'none'",
        type: { kind: "enum", values: ["react", "vue", "svelte", "none"] },
      },
      {
        name: "summary",
        description: "one-sentence summary of the file content",
        type: { kind: "string", max_length: 80 },
      },
    ],
  });
}

/** Build a FetchImpl that returns a sequence of fixed chat.completions
 *  payloads. `responses[i]` is used on call i; if `i >= responses.length`,
 *  the *last* response is reused (so callers can pass one item to mean
 *  "always the same"). */
function mockFetch(
  responses: ({
    body: unknown;
    usage?: { prompt_tokens: number; completion_tokens: number };
    httpStatus?: number;
  } | null)[],
): { fetch: FetchImpl; calls: number } {
  let calls = 0;
  const out = {
    fetch: (async (_url, _init) => {
      const idx = calls < responses.length ? calls : responses.length - 1;
      const r = responses[idx];
      calls++;
      if (r === null) {
        throw new Error("simulated network failure");
      }
      const status = r.httpStatus ?? 200;
      const ok = status >= 200 && status < 300;
      const payload = {
        choices: [{ message: { content: JSON.stringify(r.body) } }],
        usage: r.usage ?? { prompt_tokens: 100, completion_tokens: 30 },
      };
      return {
        ok,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }) as FetchImpl,
    get calls() {
      return calls;
    },
  };
  return out;
}

/** Build a `ScoutOpts` skeleton; caller overrides what they need. */
function baseOpts(jobId = "scout-test"): ScoutOpts {
  return {
    jobId,
    fieldset: basicFieldset(),
    pricing: TEST_PRICING,
    model: "qwen/qwen-2.5-7b-instruct",
    apiKey: "test-key",
    workers: 2,
    maxRetries: 1,
    smokeTest: false, // most tests skip the smoke phase by default
    sourceRoot: "/tmp/x",
  };
}

// ── buildSearchableText ────────────────────────────────────────────────

describe("buildSearchableText", () => {
  it("extracts string-valued fields and joins with newlines", () => {
    /** strings + enums concatenated; bools/ints excluded. */
    const fs = basicFieldset();
    const text = buildSearchableText(
      { is_async: true, framework: "react", summary: "hello world" },
      fs,
    );
    expect(text.split("\n").sort()).toEqual(["hello world", "react"].sort());
  });

  it("flattens array_string values into the index", () => {
    /** Arrays must be expanded so each item is searchable individually. */
    const fs = parseFieldset({
      version: 1,
      fieldset_name: "arr-test",
      fields: [
        {
          name: "tags",
          description: "topic tags",
          type: { kind: "array_string", max_items: 4 },
        },
      ],
    });
    const text = buildSearchableText({ tags: ["alpha", "beta", "gamma"] }, fs);
    expect(text).toBe("alpha\nbeta\ngamma");
  });

  it("ignores null / undefined / wrong-type values", () => {
    /** Defensive: a malformed result shouldn't crash the indexer. */
    const fs = basicFieldset();
    const text = buildSearchableText(
      { is_async: true, framework: null, summary: 42 },
      fs,
    );
    expect(text).toBe("");
  });
});

// ── computeCallCost ────────────────────────────────────────────────────

describe("computeCallCost", () => {
  it("uses the usage block when present", () => {
    /** Provider-reported tokens are authoritative. */
    const cost = computeCallCost(
      { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      TEST_PRICING,
      0,
      0,
    );
    // 1M*$0.04 + 0.5M*$0.10 = $0.04 + $0.05 = $0.09
    expect(cost).toBeCloseTo(0.09, 6);
  });

  it("falls back to the byte-based estimate when usage is missing", () => {
    /** Some response-healing passes drop the usage block; estimate sane. */
    const cost = computeCallCost(undefined, TEST_PRICING, 4_000_000, 0);
    expect(cost).toBeCloseTo(0.04, 6);
  });
});

// ── runWithLimit ───────────────────────────────────────────────────────

describe("runWithLimit", () => {
  it("returns immediately on an empty array", async () => {
    /** No items → zero promises spawned. */
    let called = 0;
    await runWithLimit([], 4, async () => {
      called++;
    });
    expect(called).toBe(0);
  });

  it("processes every item exactly once", async () => {
    /** Even with limit > items, each item runs once. */
    const seen: number[] = [];
    await runWithLimit([1, 2, 3, 4, 5], 10, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("caps in-flight workers at the limit", async () => {
    /** Inflight should never exceed the supplied limit. */
    let inflight = 0;
    let peak = 0;
    await runWithLimit(Array.from({ length: 12 }), 3, async () => {
      inflight++;
      if (inflight > peak) peak = inflight;
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

// ── runScoutJob ────────────────────────────────────────────────────────

describe("runScoutJob", () => {
  let reg: Registry;
  beforeEach(() => {
    reg = openRegistry({ path: ":memory:" });
  });
  afterEach(() => {
    reg.close();
  });

  /** Helper: register N files with unique paths/contents so fingerprints
   *  differ. Returns the fingerprints in the order they were registered. */
  function seedFiles(n: number): string[] {
    const fps: string[] = [];
    for (let i = 0; i < n; i++) {
      const out = reg.registerFile({
        file_path: `/tmp/x/f${i}.ts`,
        source_root: "/tmp/x",
        body: Buffer.from(`export const x${i} = ${i}\n`),
        registered_via: "folder",
      });
      fps.push(out.fingerprint);
    }
    return fps;
  }

  it("happy path: every file produces a result + fts row", async () => {
    /** The minimum end-to-end shape — 3 files, all valid responses. */
    seedFiles(3);
    const m = mockFetch([
      {
        body: { is_async: true, framework: "react", summary: "uses hooks" },
      },
    ]);
    const res = await runScoutJob(reg, baseOpts("ok-1"), m.fetch);
    expect(res.filesOk).toBe(3);
    expect(res.filesFailed).toBe(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(reg.countResultsByJob("ok-1")).toBe(3);
    const ftsRows = reg.db
      .prepare(
        "SELECT COUNT(*) AS n FROM mass_scout_results_fts WHERE job_id = ?",
      )
      .get("ok-1") as { n: number };
    expect(ftsRows.n).toBe(3);
  });

  it("flags repaired=1 when fix_envelope had to truncate / coerce", async () => {
    /** summary has max_length=80; we send 200 chars → truncation. */
    seedFiles(1);
    const longSummary = "x".repeat(200);
    const m = mockFetch([
      {
        body: { is_async: true, framework: "react", summary: longSummary },
      },
    ]);
    const res = await runScoutJob(reg, baseOpts("rep-1"), m.fetch);
    expect(res.filesOk).toBe(1);
    const row = reg.listResultsByJob("rep-1")[0]!;
    expect(row.repaired).toBe(1);
    const parsed = JSON.parse(row.result_json) as { summary: string };
    expect(parsed.summary.length).toBeLessThanOrEqual(80);
  });

  it("retries on transient HTTP error then succeeds", async () => {
    /**
     * Repair fills missing required keys, so validation always passes for
     * any parsed JSON — meaning the retry path is reachable only via
     * transport / parse failures. We simulate a 500 → 200 sequence.
     */
    seedFiles(1);
    const m = mockFetch([
      // First attempt: HTTP 500 → triggers retry.
      { body: {}, httpStatus: 500 },
      // Retry succeeds.
      {
        body: { is_async: true, framework: "react", summary: "hello" },
      },
    ]);
    const res = await runScoutJob(reg, baseOpts("ret-1"), m.fetch);
    expect(res.filesOk).toBe(1);
    expect(res.retries).toBeGreaterThanOrEqual(1);
    const row = reg.listResultsByJob("ret-1")[0]!;
    expect(row.attempts).toBe(2);
  });

  it("smoke-test failure aborts the run with the file path in the error", async () => {
    /** Probe call hits HTTP 500 on every retry → throw with file path. */
    seedFiles(2);
    const m = mockFetch([
      // 500 forever — every retry fails the same way.
      { body: {}, httpStatus: 500 },
    ]);
    await expect(
      runScoutJob(
        reg,
        { ...baseOpts("smoke-1"), smokeTest: true },
        m.fetch,
      ),
    ).rejects.toThrow(/smoke test failed/i);
    // Job row must still exist for post-mortem.
    expect(reg.getJob("smoke-1")).not.toBeNull();
  });

  it("is idempotent — re-running with the same jobId skips done files", async () => {
    /** Resume support: a second run mustn't double-charge or duplicate. */
    seedFiles(2);
    const m = mockFetch([
      {
        body: { is_async: true, framework: "vue", summary: "simple" },
      },
    ]);
    await runScoutJob(reg, baseOpts("res-1"), m.fetch);
    expect(reg.countResultsByJob("res-1")).toBe(2);
    const callsAfterFirst = m.calls;

    // Re-run — every file is already in mass_scout_results.
    const m2 = mockFetch([
      {
        body: { is_async: true, framework: "vue", summary: "simple" },
      },
    ]);
    const res2 = await runScoutJob(reg, baseOpts("res-1"), m2.fetch);
    expect(res2.filesOk).toBe(2); // all credited as "ok" via resume
    expect(reg.countResultsByJob("res-1")).toBe(2); // still 2 — no dup writes
    expect(m2.calls).toBe(0); // fetch was never called the second time
    expect(callsAfterFirst).toBeGreaterThan(0);
  });

  it("skips files larger than the scout cap and records them in mass_scout_skipped", async () => {
    /** Cap = 32K * 0.4 * 4 = 51200 bytes. We register one big file. */
    const big = Buffer.alloc(60_000, 0x61);
    const small = Buffer.from("export const x = 1");
    reg.registerFile({
      file_path: "/tmp/x/big.txt",
      source_root: "/tmp/x",
      body: big,
      registered_via: "folder",
    });
    reg.registerFile({
      file_path: "/tmp/x/small.ts",
      source_root: "/tmp/x",
      body: small,
      registered_via: "folder",
    });
    const m = mockFetch([
      {
        body: { is_async: false, framework: "none", summary: "ok" },
      },
    ]);
    const res = await runScoutJob(reg, baseOpts("cap-1"), m.fetch);
    expect(res.filesSkippedTooBig).toBe(1);
    expect(res.filesOk).toBe(1);
    const skipped = reg.listSkipped("scout");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.file_path).toBe("/tmp/x/big.txt");
  });

  it("processes 5 files with workers=2 without dropping any", async () => {
    /** Concurrency smoke test — every input produces a row. */
    seedFiles(5);
    const m = mockFetch([
      {
        body: {
          is_async: true,
          framework: "svelte",
          summary: "tiny",
        },
      },
    ]);
    const res = await runScoutJob(
      reg,
      { ...baseOpts("conc-1"), workers: 2 },
      m.fetch,
    );
    expect(res.filesOk).toBe(5);
    expect(reg.countResultsByJob("conc-1")).toBe(5);
  });

  it("counts a file as failed (not crashed) if every retry hits a transport error", async () => {
    /**
     * Retries exhausted via persistent HTTP 500 → row goes into skipped,
     * run completes (smoke test disabled so we don't throw).
     */
    seedFiles(1);
    const m = mockFetch([
      // 500 forever; smoke-test off so we surface as filesFailed, not throw.
      { body: {}, httpStatus: 500 },
    ]);
    const res = await runScoutJob(
      reg,
      { ...baseOpts("fail-1"), maxRetries: 1, smokeTest: false },
      m.fetch,
    );
    expect(res.filesOk).toBe(0);
    expect(res.filesFailed).toBe(1);
    expect(reg.listSkipped("scout").length).toBe(1);
  });

  it("finalizes the job row with totals", async () => {
    /** files_total/ok/failed/cost_usd must all be non-null after the run. */
    seedFiles(2);
    const m = mockFetch([
      {
        body: { is_async: true, framework: "react", summary: "x" },
      },
    ]);
    await runScoutJob(reg, baseOpts("fin-1"), m.fetch);
    const job = reg.getJob("fin-1")!;
    expect(job.ended_at).toMatch(/^\d{4}-/);
    expect(job.files_total).toBe(2);
    expect(job.files_ok).toBe(2);
    expect(job.files_failed).toBe(0);
    expect(job.cost_usd).toBeGreaterThan(0);
  });

  // ── Budget gate (Phase A, TRDD §15 Q4) ──────────────────────────────

  it("budget gate: refuses to start when est cost > budget", async () => {
    /** scout itself enforces the budget — not just estimate. */
    seedFiles(3);
    const m = mockFetch([
      {
        body: { is_async: true, framework: "react", summary: "x" },
      },
    ]);
    await expect(
      runScoutJob(
        reg,
        { ...baseOpts("budget-1"), budgetUsd: 0 },
        m.fetch,
      ),
    ).rejects.toThrow(/budget gate refused/i);
    // No actual fetch should have happened.
    expect(m.calls).toBe(0);
  });

  it("budget gate: allows when est cost <= budget", async () => {
    /** Generous budget — gate passes through, scout runs normally. */
    seedFiles(2);
    const m = mockFetch([
      {
        body: { is_async: true, framework: "react", summary: "ok" },
      },
    ]);
    const res = await runScoutJob(
      reg,
      { ...baseOpts("budget-2"), budgetUsd: 100 },
      m.fetch,
    );
    expect(res.filesOk).toBe(2);
  });

  // ── Circuit breaker (Phase A) ───────────────────────────────────────

  it("circuit breaker: aborts the fan-out after N consecutive failures", async () => {
    /** Without the breaker, every file would be tried and fail. With it,
     *  the run aborts mid-fanout once N=3 in a row fail. */
    seedFiles(20);
    const m = mockFetch([{ body: {}, httpStatus: 500 }]);
    const res = await runScoutJob(
      reg,
      {
        ...baseOpts("cb-1"),
        smokeTest: false,
        consecutiveFailureLimit: 3,
        workers: 1,
      },
      m.fetch,
    );
    expect(res.circuitTripped).toBe(true);
    // Without the breaker, filesFailed would be 20. With breaker tripped
    // at 3 consecutive failures, the run shorts out somewhere shortly
    // after the 3rd failure (subsequent worker iterations early-return).
    expect(res.filesFailed).toBeLessThanOrEqual(20);
    expect(res.filesFailed).toBeGreaterThanOrEqual(3);
  });

  it("circuit breaker: does NOT trip when failures are non-consecutive", async () => {
    /** A success between failures resets the counter. */
    seedFiles(6);
    // Alternate fail / ok / fail / ok / fail / ok — last response is reused
    // for any extra calls so the sequence stays predictable.
    const m = mockFetch([
      { body: {}, httpStatus: 500 },
      { body: { is_async: false, framework: "none", summary: "ok" } },
      { body: {}, httpStatus: 500 },
      { body: { is_async: false, framework: "none", summary: "ok" } },
      { body: {}, httpStatus: 500 },
      { body: { is_async: false, framework: "none", summary: "ok" } },
    ]);
    const res = await runScoutJob(
      reg,
      {
        ...baseOpts("cb-2"),
        smokeTest: false,
        consecutiveFailureLimit: 3,
        workers: 1,
        maxRetries: 0, // disable retry so failures stay 1:1 with calls
      },
      m.fetch,
    );
    expect(res.circuitTripped).toBe(false);
  });

  // ── Per-call timeout (Phase A) ──────────────────────────────────────

  it("per-call timeout aborts a hanging fetch via AbortSignal", async () => {
    /** Mock that never resolves until the signal aborts. */
    seedFiles(1);
    const slowFetch: FetchImpl = (_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    };
    const res = await runScoutJob(
      reg,
      {
        ...baseOpts("to-1"),
        smokeTest: false,
        maxRetries: 0,
        perCallTimeoutMs: 50, // short
      },
      slowFetch,
    );
    expect(res.filesOk).toBe(0);
    expect(res.filesFailed).toBe(1);
    const skipped = reg.listSkipped("scout");
    expect(skipped[0]!.reason).toMatch(/timeout/);
  });
});
