/**
 * Emission tests for the durable model-health ledger (TRDD-828238b5 A7-P1).
 *
 * A1 shipped the ledger + aggregator and emitted only `param_drop` and
 * `reasoning_downgrade`. A7-P1 wires the OTHER FIVE kinds at their model-aware
 * hot-path sites. These tests drive the REAL judge fetch+retry loop
 * (`judgeGroups` → `judgeOneGroup` → the real `appendModelEvent`) through the
 * injected `FetchImpl` seam the existing security_scan tests use — forcing a
 * 429, a 4xx, an empty body, and a clean success — and assert the ledger gains
 * exactly the right line(s), with NO false degradation signal on success.
 *
 * Why the judge path: it is the one network hot-path with a public, injectable
 * `FetchImpl` (the main-path chatCompletion* helpers go through globalThis.fetch
 * and a real backend, which a unit test cannot drive). The judge emits
 * rate_limit_429, non_retryable_failure, and empty_response — exactly the three
 * the TRDD asks to assert. The ledger writer is shared, so these also exercise
 * the same appendModelEvent the main-path sites call.
 *
 * Config-dir isolation: each test points LLM_EXT_CONFIG_DIR at a fresh /tmp dir
 * (getConfigDir() only permits $HOME or /tmp), so the ledger file is per-test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { judgeGroups, type FetchImpl, type JudgeOptions } from "./security_scan/judge.js";
import type { DedupGroup } from "./security_scan/intake.js";
import type { ModelPricing } from "./mass_scouting/cost-estimate.js";
import { readModelEvents, type ModelEventKind } from "./model-events.js";

// A model id ending in ':free' so the airtight free_only cost-safety guard
// (assertFreeOnlyModel) is a no-op regardless of any global free_only flag a
// previously-run test may have toggled — keeps this suite order-independent.
const TEST_MODEL = "test/judge-model:free";

const TEST_PRICING: ModelPricing = {
  input_per_m_usd: 0.04,
  output_per_m_usd: 0.1,
  context_window: 32_000,
};

const ORIG_CFG = process.env.LLM_EXT_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "model-events-emit-"));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (ORIG_CFG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG_CFG;
  else delete process.env.LLM_EXT_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

/** One dedup group with benign content (no injection markers to muddy the verdict). */
function group(content = "let x = 1 + 1;"): DedupGroup {
  return {
    key: "g1",
    category: "generic",
    language: "javascript",
    content,
    members: [{ id: "m1", category: "generic", language: "javascript", content }],
  };
}

/** Base judge options — fast, single worker, a couple of retries so a flaky
 *  early failure can still resolve to a valid verdict on a later attempt. */
function opts(overrides: Partial<JudgeOptions> = {}): JudgeOptions {
  return {
    model: TEST_MODEL,
    apiKey: "test-key",
    pricing: TEST_PRICING,
    apiUrl: "https://example.invalid/api",
    workers: 1,
    maxRetries: 5,
    perCallTimeoutMs: 5_000,
    consecutiveFailureLimit: 0, // never trip the circuit in these unit cases
    defaultVerdictOnError: "uncertain",
    rubrics: {},
    ...overrides,
  };
}

/** A schema-valid judge reply (so a "good" attempt resolves the group cleanly). */
const VALID_VERDICT = JSON.stringify({
  verdict: "not_threat",
  confidence: 0.6,
  reason: "benign arithmetic",
  injection_observed: false,
});

/** Pack a model "reply" string into an OpenRouter chat.completions JSON body. */
function chatPayload(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}

/**
 * Build a FetchImpl whose Nth call is scripted by `script[n]`. Each entry says
 * what HTTP status to return and what the model "replied" (or that the body has
 * no content). A missing entry (script exhausted) returns a clean VALID_VERDICT
 * so the group always terminates.
 */
function scriptedFetch(
  script: Array<{ status?: number; content?: string; noContent?: boolean }>,
): { fetch: FetchImpl; calls: number } {
  let calls = 0;
  const impl = (async () => {
    const step = script[calls] ?? { content: VALID_VERDICT };
    calls++;
    const status = step.status ?? 200;
    const ok = status >= 200 && status < 300;
    const payload = step.noContent
      ? { choices: [{ message: {} }], usage: { prompt_tokens: 10, completion_tokens: 0 } }
      : chatPayload(step.content ?? VALID_VERDICT);
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as FetchImpl;
  return {
    fetch: impl,
    get calls() {
      return calls;
    },
  };
}

/** Count ledger lines of a given kind for the test model. */
function countKind(kind: ModelEventKind): number {
  return readModelEvents().filter((e) => e.kind === kind && e.model === TEST_MODEL).length;
}

describe("model-health emission — security_scan judge path (real judgeGroups)", () => {
  it("emits exactly ONE rate_limit_429 for a call that hit several 429s", async () => {
    // Three 429s, then a valid verdict on the 4th attempt.
    const m = scriptedFetch([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { content: VALID_VERDICT },
    ]);
    const res = await judgeGroups([group()], opts(), m.fetch);

    // The retry loop ran (≥4 attempts) and resolved cleanly.
    expect(m.calls).toBeGreaterThanOrEqual(4);
    expect(res.verdicts).toHaveLength(1);
    // Exactly one rate_limit_429 — NOT one per 429 attempt (idempotent per call).
    expect(countKind("rate_limit_429")).toBe(1);
    // A 429 is NOT a non-retryable failure.
    expect(countKind("non_retryable_failure")).toBe(0);
  });

  it("emits ONE non_retryable_failure on a 400 (4xx, non-429)", async () => {
    // A 400 every attempt — the group exhausts retries → fail-safe.
    const m = scriptedFetch([{ status: 400 }, { status: 400 }, { status: 400 }]);
    const res = await judgeGroups([group()], opts({ maxRetries: 2 }), m.fetch);

    expect(res.verdicts[0]?.failSafe).toBe(true);
    // One non_retryable_failure for the call, even across the 400 retries.
    expect(countKind("non_retryable_failure")).toBe(1);
    expect(countKind("rate_limit_429")).toBe(0);
    expect(countKind("empty_response")).toBe(0);
  });

  it("emits ONE empty_response when the reply has no message content", async () => {
    // Body parses but carries no message.content — the empty-response signal.
    const m = scriptedFetch([{ noContent: true }, { content: VALID_VERDICT }]);
    const res = await judgeGroups([group()], opts(), m.fetch);

    expect(res.verdicts).toHaveLength(1);
    expect(countKind("empty_response")).toBe(1);
    expect(countKind("rate_limit_429")).toBe(0);
    expect(countKind("non_retryable_failure")).toBe(0);
  });

  it("a 429 on the FINAL retry still records exactly one rate_limit_429", async () => {
    // Only one attempt allowed, and it 429s → fail-safe, but the signal lands.
    const m = scriptedFetch([{ status: 429 }]);
    const res = await judgeGroups([group()], opts({ maxRetries: 0 }), m.fetch);

    expect(res.verdicts[0]?.failSafe).toBe(true);
    expect(countKind("rate_limit_429")).toBe(1);
  });

  it("a fully successful call appends NO failure-kind events (no false degradation)", async () => {
    // First (and only) attempt returns a clean valid verdict.
    const m = scriptedFetch([{ content: VALID_VERDICT }]);
    const res = await judgeGroups([group()], opts(), m.fetch);

    expect(m.calls).toBe(1);
    expect(res.verdicts[0]?.failSafe).toBe(false);
    // None of the five failure kinds — a healthy call is silent.
    for (const k of [
      "rate_limit_429",
      "non_retryable_failure",
      "empty_response",
      "schema_heal",
      "truncation_retry",
    ] as ModelEventKind[]) {
      expect(countKind(k)).toBe(0);
    }
    // And the ledger file holds nothing for this model at all.
    expect(readModelEvents().filter((e) => e.model === TEST_MODEL)).toHaveLength(0);
  });

  it("distinct failure modes across groups accumulate independently", async () => {
    // Group A: 429 then recover. Group B: empty body then recover.
    // workers:1 makes the fetch script deterministic (groups judged in order).
    const gA = { ...group("const a = 1;"), key: "gA", members: [{ id: "a", category: "generic", language: "javascript", content: "const a = 1;" }] };
    const gB = { ...group("const b = 2;"), key: "gB", members: [{ id: "b", category: "generic", language: "javascript", content: "const b = 2;" }] };
    const m = scriptedFetch([
      { status: 429 }, // gA attempt 1
      { content: VALID_VERDICT }, // gA attempt 2
      { noContent: true }, // gB attempt 1
      { content: VALID_VERDICT }, // gB attempt 2
    ]);
    const res = await judgeGroups([gA, gB], opts({ workers: 1 }), m.fetch);

    expect(res.verdicts).toHaveLength(2);
    // The model id is shared, so per-kind totals are 1 each.
    expect(countKind("rate_limit_429")).toBe(1);
    expect(countKind("empty_response")).toBe(1);
    expect(countKind("non_retryable_failure")).toBe(0);
  });
});
