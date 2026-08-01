// Hermetic tests for the search_existing_implementations benchmark runner
// (TRDD-828238b5 A6). NO network, NO module mocking of anything under test —
// the ONLY fake is the FetchImpl seam (the same seam the security_scan judge
// uses). The fake returns canned chat/completions JSON whose content carries
// correct per-file `## File: <abs>` sections, so the REAL pipeline runs end to
// end (fixture walked, FFD batches formed, merged report assembled) and the
// deterministic scorer produces real scores.

import { describe, it, expect } from "vitest";

import type { FetchImpl } from "../../security_scan/judge.js";
import { runSearchExistingBenchmarkOnModel } from "./runner.js";
import {
  SEARCH_EXISTING_CASES,
  type SearchExistingCase,
} from "./dataset.js";

function caseById(id: string): SearchExistingCase {
  const c = SEARCH_EXISTING_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`fixture case not found: ${id}`);
  return c;
}

/**
 * Extract the absolute file paths the pipeline put in a batch request. The body
 * is the JSON-stringified chat payload, so we PARSE it and read the un-escaped
 * user-message text before matching — matching the raw JSON string would see
 * `\n` as the two-char escape, not a newline. readFileAsCodeBlock wraps each
 * path as `<filename>\n<abs>\n</filename>`, so this recovers the exact group
 * order without guessing.
 */
function pathsInRequest(body: string): string[] {
  const parsed = JSON.parse(body) as { messages?: { content?: string }[] };
  // The user message carries the file blocks; concatenate every message's
  // content so the matcher is robust to message ordering.
  const text = (parsed.messages ?? []).map((m) => m.content ?? "").join("\n");
  const re = /<filename>\s*\n(.+?)\n<\/filename>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

/** The whole request text (every message's content), un-escaped from the JSON body. */
function requestText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { content?: string }[] };
  return (parsed.messages ?? []).map((m) => m.content ?? "").join("\n");
}

/**
 * The INSTRUCTIONS/feature portion of the request — everything before the first
 * `<filename>` file block. The feature_description lives here; the file CONTENTS
 * (which can mention any keyword incidentally, e.g. slug.ts's body is full of
 * "slug") come after, so matching the feature against this region only is what
 * makes a "correct" fake answer the CURRENT feature and not leak file text.
 */
function featureRegion(body: string): string {
  const full = requestText(body);
  const idx = full.indexOf("<filename>");
  return idx === -1 ? full : full.slice(0, idx);
}

/**
 * Build a faithful fake: a "correct" model that answers the CURRENT case's
 * golden truth. `decideYes(feature, path)` returns true when `path` genuinely
 * implements the feature in `feature` (the request's own description) — so the
 * same fake gives the right answer for EVERY case, not a path set fixed to one
 * case. For each file in the batch it emits one `## File: <abs>` section
 * (`YES symbol=… lines=…` / `NO`). Returns canned chat/completions JSON with a
 * usage block so the runner accumulates a real (non-zero) cost.
 */
function fakeFetch(
  decideYes: (featurePrompt: string, path: string) => boolean,
): { fetch: FetchImpl; calls: () => number } {
  let calls = 0;
  const fetch: FetchImpl = async (_url, init) => {
    calls++;
    // Decide against the FEATURE region only — not the file contents, which can
    // incidentally contain the feature's keywords (slug.ts's body says "slug").
    const feature = featureRegion(init.body);
    const paths = pathsInRequest(init.body);
    const sections = paths
      .map((p) =>
        decideYes(feature, p)
          ? `## File: ${p}\n\nYES symbol=fn lines=1-10\n\n---`
          : `## File: ${p}\n\nNO\n\n---`,
      )
      .join("\n\n");
    const json = {
      choices: [{ message: { content: sections } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    };
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
  return { fetch, calls: () => calls };
}

/**
 * A correct model for the two cases under test: it says YES for slug.ts ONLY
 * when the feature is the slugify one (the prompt mentions "slug"). For the
 * websocket-pool feature it says NO for everything — exactly the golden truth,
 * so the absent case yields zero false positives.
 */
function correctSlugifyModel(featurePrompt: string, path: string): boolean {
  return /\bslug\b/i.test(featurePrompt) && path.endsWith("/src/util/slug.ts");
}

const PRICING = { input_per_m_usd: 0.04, output_per_m_usd: 0.1, context_window: 128_000 };

describe("runSearchExistingBenchmarkOnModel — hermetic, real pipeline", () => {
  it("scores a correct model perfectly across a case subset and accumulates cost from usage", async () => {
    // Correct truth for the two cases: slugify → src/util/slug.ts is the only
    // YES; absent-feature-websocket-pool → every file is NO (the model answers
    // the CURRENT feature, so slug.ts is NOT a false positive in the absent case).
    const { fetch, calls } = fakeFetch(correctSlugifyModel);

    const subset = [caseById("slugify"), caseById("absent-feature-websocket-pool")];
    const result = await runSearchExistingBenchmarkOnModel(
      "vendor/test-model",
      subset,
      { apiKey: "sk-test", pricing: PRICING },
      fetch,
    );

    // The REAL pipeline ran: a batch was formed and the fake was called.
    expect(calls()).toBeGreaterThan(0);
    expect(result.modelId).toBe("vendor/test-model");
    expect(result.caseScores).toHaveLength(2);
    expect(result.failures).toHaveLength(0);

    // Perfect deterministic scores: micro-F1 / recall 1.0, full coverage, pass.
    expect(result.aggregate.microF1).toBe(1);
    expect(result.aggregate.microRecall).toBe(1);
    expect(result.aggregate.coverage).toBe(1);
    expect(result.pass).toBe(true);

    // slugify produced the single true positive; the absent-feature case scored
    // every file as a true negative (no false positives → hallucination-resistant).
    const slug = result.caseScores.find((s) => s.caseId === "slugify")!;
    expect(slug.truePositives).toBe(1);
    expect(slug.falsePositives).toBe(0);
    expect(slug.falseNegatives).toBe(0);
    const absent = result.caseScores.find((s) => s.caseId === "absent-feature-websocket-pool")!;
    expect(absent.truePositives).toBe(0);
    expect(absent.falsePositives).toBe(0);
    expect(absent.trueNegatives).toBeGreaterThan(0);

    // Cost accumulated from the fake usage (1000 in + 200 out per call), > 0.
    expect(result.costUsd).toBeGreaterThan(0);
    const expectedPerCall = (1000 / 1e6) * PRICING.input_per_m_usd + (200 / 1e6) * PRICING.output_per_m_usd;
    expect(result.costUsd).toBeCloseTo(expectedPerCall * calls(), 10);
    expect(result.meanLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records a wrong-answer model as a non-perfect score without throwing", async () => {
    // A model that answers NO for slug.ts misses the only duplicate → false
    // negative → recall < 1 → fails the benchmark. No throw, just a low score.
    const { fetch } = fakeFetch(() => false); // never says YES
    const subset = [caseById("slugify")];
    const result = await runSearchExistingBenchmarkOnModel(
      "vendor/wrong",
      subset,
      { apiKey: "sk-test", pricing: PRICING },
      fetch,
    );
    expect(result.failures).toHaveLength(0); // pipeline succeeded; the model was just wrong
    const slug = result.caseScores.find((s) => s.caseId === "slugify")!;
    expect(slug.falseNegatives).toBe(1);
    expect(result.aggregate.microRecall).toBeLessThan(1);
    expect(result.pass).toBe(false);
  });

  it("records an injected HTTP-500 case as a failure and does NOT abort the run", async () => {
    let calls = 0;
    // Always 500 — every batch errors. The pipeline returns isError for the
    // whole case (zero usable output); the runner records ONE failure and
    // scores the case all-unscored rather than throwing.
    const fail500: FetchImpl = async () => {
      calls++;
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "internal server error",
      };
    };
    const subset = [caseById("slugify")];
    const result = await runSearchExistingBenchmarkOnModel(
      "vendor/down",
      subset,
      { apiKey: "sk-test", pricing: PRICING },
      fail500,
    );

    // The run completed (did not throw) and recorded the failure.
    expect(calls).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].caseId).toBe("slugify");
    expect(result.failures[0].reason).toContain("FAILED");

    // The case was still scored (all scanned files unscored → expected-YES
    // become false negatives), so a degraded provider tanks the score instead
    // of crashing the sweep.
    expect(result.caseScores).toHaveLength(1);
    const slug = result.caseScores[0];
    expect(slug.unscored).toBe(slug.scannedFiles);
    expect(slug.falseNegatives).toBeGreaterThan(0); // slug.ts expected YES, got nothing
    expect(result.pass).toBe(false);
    // No usage was billed on a failed call.
    expect(result.costUsd).toBe(0);
  });

  it("fires per-case onProgress callbacks", async () => {
    const { fetch } = fakeFetch(correctSlugifyModel);
    const subset = [caseById("slugify"), caseById("absent-feature-websocket-pool")];
    const seen: Array<[number, number]> = [];
    await runSearchExistingBenchmarkOnModel(
      "vendor/test-model",
      subset,
      {
        apiKey: "sk-test",
        pricing: PRICING,
        onProgress: (done, total) => seen.push([done, total]),
      },
      fetch,
    );
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
