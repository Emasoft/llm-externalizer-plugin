// Hermetic tests for the code_task CODE-AUDIT benchmark runner (P2b).
//
// NO network. NO module mocking of anything under test. The ONLY fake is the
// FetchImpl seam (the same seam the security_scan judge uses). Everything else is
// REAL: the real dataset.jsonl, the real fixture corpus on disk, the REAL
// code_task pipeline (code-task/core.ts::runCodeTask — real validation, real path
// resolution, real single-file route), the REAL system prompt
// (scan-pipeline.ts::codeTaskSystemPrompt), the REAL readFileAsCodeBlock, and the
// REAL deterministic scorer. Never mock the thing under test.
//
// NOTE: this file is DISTINCT from runner.test.ts in the same directory, which
// tests the code_task pipeline CORE. This one tests the BENCHMARK runner.

import { describe, it, expect } from "vitest";

import type { FetchImpl } from "../../security_scan/judge.js";
import { runCodeAuditBenchmarkOnModel } from "./bench-runner.js";
import { CODE_AUDIT_INSTRUCTIONS, loadDataset, type CodeAuditCase } from "./dataset.js";

const CASES = loadDataset();
const DEFECT_CASES = CASES.filter((c) => c.buggySymbols.length > 0);
const CLEAN_CASES = CASES.filter((c) => c.buggySymbols.length === 0);

const PRICING = { input_per_m_usd: 1, output_per_m_usd: 2, context_window: 128_000 };

/** The user-message text of a captured request, un-escaped from the JSON body. */
function requestText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).map((m) => m.content ?? "").join("\n");
}

function systemText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).find((m) => m.role === "system")?.content ?? "";
}

/**
 * Build a fake OpenRouter that answers each request with `answer(body)`. The
 * request body carries the fixture's real bytes (the REAL readFileAsCodeBlock put
 * them there), so a fake can decide what to "find" by looking at which fixture it
 * was handed — exactly how the search-existing runner test does it.
 */
function fakeOpenRouter(
  answer: (body: string) => string,
  captured?: string[],
): FetchImpl {
  return (async (_url: string, init: { body: string }) => {
    if (captured) captured.push(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: answer(init.body) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      }),
      text: async () => "",
    };
  }) as unknown as FetchImpl;
}

/** Which case's fixture is in this request? Matched on the path in the file tag. */
function caseOfRequest(body: string, cases: readonly CodeAuditCase[]): CodeAuditCase {
  const text = requestText(body);
  const hit = cases.find((c) => text.includes(`/${c.file}`));
  if (!hit) throw new Error(`no fixture matched the request: ${text.slice(0, 200)}`);
  return hit;
}

describe("runCodeAuditBenchmarkOnModel — hermetic, real pipeline + real scorer", () => {
  it("sends the REAL code_task system prompt and the real fixture bytes, one call per case", async () => {
    const bodies: string[] = [];
    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/fake",
      CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "NO DEFECTS", bodies),
    );

    // One LLM call per case: every fixture is a single input file, so the
    // pipeline's SINGLE-FILE route runs and never batches.
    expect(bodies.length).toBe(CASES.length);
    expect(run.caseScores.length).toBe(CASES.length);
    expect(run.failures).toEqual([]);

    // The system prompt is the SERVER's, not a benchmark-only copy — this is what
    // makes the score mean something about how the tool really behaves.
    const sys = systemText(bodies[0]);
    expect(sys).toContain("Identify code by FUNCTION/CLASS/METHOD NAME, never by line number");
    expect(sys).toContain("INPUT FORMAT:");
    expect(sys).toContain("OUTPUT RULES:");

    // The user message carries the audit task AND the fixture's real bytes,
    // wrapped by the REAL readFileAsCodeBlock.
    const user = requestText(bodies[0]);
    expect(user).toContain(CODE_AUDIT_INSTRUCTIONS.split("\n")[0]);
    expect(user).toContain("<filename>");
    expect(user).toContain("<file-content>");
  });

  it("a PERFECT model (names exactly the planted defects, silent on clean files) scores 1.0 and PASSES", async () => {
    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/perfect",
      CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter((body) => {
        const c = caseOfRequest(body, CASES);
        if (c.buggySymbols.length === 0) return "NO DEFECTS";
        return c.buggySymbols.map((s) => `DEFECT: ${s} — the real bug`).join("\n");
      }),
    );

    expect(run.aggregate.macroF1).toBe(1);
    expect(run.aggregate.microRecall).toBe(1);
    expect(run.aggregate.microPrecision).toBe(1);
    expect(run.aggregate.exactMatches).toBe(CASES.length);
    expect(run.aggregate.hallucinations).toBe(0);
    expect(run.aggregate.anchoredRate).toBeGreaterThan(0); // the defect cases parsed anchored
    expect(run.pass).toBe(true);
    // Cost is accumulated from real usage numbers against the supplied pricing.
    expect(run.costUsd).toBeCloseTo(CASES.length * (1000 / 1e6 + (100 / 1e6) * 2), 9);
  });

  it("a SILENT model (always 'NO DEFECTS') FAILS on the recall floor — silence is not a strategy", async () => {
    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/silent",
      CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "NO DEFECTS"),
    );
    expect(run.aggregate.microRecall).toBe(0);
    expect(run.pass).toBe(false);
  });

  it("a SHOTGUN model (accuses everything, everywhere) FAILS — precision collapses on the clean files", async () => {
    // It has perfect recall by construction; the clean fixtures are what stop it.
    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/shotgun",
      CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter((body) => {
        // Accuse every symbol the fixture actually declares.
        const text = requestText(body);
        const names = [...text.matchAll(/^(?:export )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
        return names.map((n) => `DEFECT: ${n} — maybe`).join("\n") || "DEFECT: somethingElse — maybe";
      }),
    );
    expect(run.aggregate.microRecall).toBeGreaterThan(0);
    expect(run.aggregate.microPrecision).toBeLessThan(0.5);
    expect(run.pass).toBe(false);
  });

  it("an API error on one case is recorded as a failure and scored as a MISS — the sweep never aborts", async () => {
    const victim = DEFECT_CASES[0];
    const impl = (async (_url: string, init: { body: string }) => {
      const c = caseOfRequest(init.body, CASES);
      if (c.id === victim.id) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => "upstream down" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  c.buggySymbols.length === 0
                    ? "NO DEFECTS"
                    : c.buggySymbols.map((s) => `DEFECT: ${s} — real`).join("\n"),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      };
    }) as unknown as FetchImpl;

    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/flaky",
      CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      impl,
    );

    // The run completed — a single bad case never throws out of the sweep.
    expect(run.caseScores.length).toBe(CASES.length);
    expect(run.failures.map((f) => f.caseId)).toEqual([victim.id]);
    const failed = run.caseScores.find((s) => s.caseId === victim.id)!;
    expect(failed.failed).toBe(true);
    // Penalised, not silently dropped: its defects became false negatives.
    expect(failed.returned).toEqual([]);
    expect(failed.recall).toBe(0);
    // One failure is tolerated (maxFailedCases: 1), so an otherwise-perfect model
    // is still admissible.
    expect(run.aggregate.failedCases).toBe(1);
  });

  it("scores the FREETEXT fallback when a model ignores the DEFECT: contract", async () => {
    // A model that writes prose but names the right function FOUND the bug;
    // scoring it 0 would measure formatting, not code understanding.
    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/prose",
      DEFECT_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter((body) => {
        const c = caseOfRequest(body, CASES);
        return c.buggySymbols.map((s) => `The bug lives in ${s} and it corrupts state.`).join("\n");
      }),
    );
    expect(run.aggregate.anchoredRate).toBe(0);
    expect(run.caseScores.every((s) => s.mode === "freetext")).toBe(true);
    expect(run.aggregate.microRecall).toBe(1);
  });

  it("does not confuse a real fixture symbol with a hallucinated one", async () => {
    const run = await runCodeAuditBenchmarkOnModel(
      "vendor/dreamer",
      CLEAN_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "DEFECT: totallyInventedSymbol — not in this file"),
    );
    // An invented name is a hallucination, NOT a false positive against a symbol
    // that does not exist — so precision on the clean cases stays 1.
    expect(run.aggregate.hallucinations).toBe(CLEAN_CASES.length);
    expect(run.aggregate.microPrecision).toBe(1);
  });
});
