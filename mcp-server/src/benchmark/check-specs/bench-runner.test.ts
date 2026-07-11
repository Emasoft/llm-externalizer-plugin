// Hermetic tests for the check_against_specs (SPEC ADHERENCE) benchmark runner — P2d.
//
// NO network. NO module mocking of anything under test. The ONLY fake is the FetchImpl
// seam (the same seam the security_scan judge uses). Everything else is REAL: the real
// thirteen-file corpus on disk, the REAL check_against_specs pipeline
// (check-specs/core.ts::runCheckAgainstSpecs — real validation, real spec block, real
// mode-0 per-file loop), the REAL auditor system prompt (CHECK_SPECS_SYSTEM_PROMPT), the
// REAL readFileAsCodeBlock, and the REAL deterministic scorer. Never mock the thing under
// test.
//
// NOTE: this file is DISTINCT from runner.test.ts in the same directory, which tests the
// check_against_specs pipeline CORE (P2a). This one tests the BENCHMARK runner — and,
// most importantly, it is where the corpus's DISCRIMINATING POWER is proved.

import { describe, it, expect } from "vitest";

import type { FetchImpl } from "../../security_scan/judge.js";
import { CHECK_SPECS_SYSTEM_PROMPT } from "../../check-specs/core.js";
import { runCheckSpecsBenchmarkOnModel } from "./bench-runner.js";
import { NAIVE_STRATEGIES, accuracyOf, passesThresholds } from "./score.js";
import {
  CHECK_SPECS_FIXTURES,
  CHECK_SPECS_INSTRUCTIONS,
  expectedViolations,
  fixtureFilePaths,
} from "./dataset.js";

const PRICING = { input_per_m_usd: 1, output_per_m_usd: 2, context_window: 128_000 };
const FILES = fixtureFilePaths();
const VIOLATIONS = expectedViolations();

/** The concatenated message text of a captured request body. */
function requestText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).map((m) => m.content ?? "").join("\n");
}

function messageOf(body: string, role: "system" | "user"): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).find((m) => m.role === role)?.content ?? "";
}

/** Which fixture is this request auditing? Read from the source file's own tag. */
function fixtureOfRequest(body: string): string {
  const m = /<filename>\n([^\n]+)\n<\/filename>/.exec(messageOf(body, "user"));
  if (!m) throw new Error("no <filename> tag in the user message — the pipeline changed shape");
  return m[1];
}

/**
 * ONLY the audited file's bytes — the text of the LAST <file-content> block.
 *
 * Load-bearing for the naive-baseline tests below, and it hides THREE traps that each
 * silently fake a result:
 *
 *  1. The SPEC is in every request, and the spec is ABOUT LIVE_TESTS and
 *     OPENROUTER_API_KEY. A baseline that grepped the whole REQUEST finds its needle in
 *     the spec on every single file, answers VIOLATION to all thirteen, and "proves" a
 *     discriminating power the corpus does not have. A code-blind model greps the CODE,
 *     so the fake must too.
 *  2. The SYSTEM prompt carries FILE_FORMAT_EXAMPLE, whose own <file-content> block holds
 *     the literal placeholder {FILE_CONTENTS_HERE} and comes FIRST. A non-greedy match
 *     from the start returns the PLACEHOLDER — the fake then sees no code at all and the
 *     test goes green while running nothing. Hence: the LAST block. (This is P2c's bug,
 *     reproduced here on purpose so it cannot happen twice.)
 *  3. The spec's own block is tagged <specs-file-content>, a DIFFERENT tag, so it is not
 *     picked up by this pattern at all — which is exactly why the pipeline tags it that
 *     way, and is asserted below.
 */
function auditedFileBytes(body: string): string {
  const blocks = [...requestText(body).matchAll(/<file-content>([\s\S]*?)<\/file-content>/g)];
  const last = blocks.at(-1);
  if (!last) throw new Error("no <file-content> block in the request — the pipeline changed shape");
  if (last[1].includes("{FILE_CONTENTS_HERE}")) {
    throw new Error(
      "auditedFileBytes picked up the system prompt's FORMAT EXAMPLE instead of the file — the request shape changed and this fake would silently score nothing.",
    );
  }
  if (last[1].includes("`npm test` is offline and free")) {
    throw new Error(
      "auditedFileBytes picked up the SPEC instead of the audited file — a baseline reading this would find the spec's own vocabulary on every file and prove nothing.",
    );
  }
  return last[1];
}

/** A fake OpenRouter that answers each request with `answer(body)`. */
function fakeOpenRouter(answer: (body: string) => string, captured?: string[]): FetchImpl {
  return (async (_url: string, init: { body: string }) => {
    if (captured) captured.push(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: answer(init.body) } }],
        usage: { prompt_tokens: 2000, completion_tokens: 80 },
      }),
      text: async () => "",
    };
  }) as unknown as FetchImpl;
}

/** A model with perfect knowledge — answers straight from the ground truth. */
const ORACLE = (body: string): string =>
  VIOLATIONS.has(fixtureOfRequest(body))
    ? "VIOLATION: R2 — the live suite is not gated"
    : "CLEAN — no spec violations found.";

describe("runCheckSpecsBenchmarkOnModel — hermetic, real pipeline + real scorer", () => {
  it("drives the REAL pipeline: one LLM call per file, with the SERVER's own auditor prompt", async () => {
    const bodies: string[] = [];
    const run = await runCheckSpecsBenchmarkOnModel(
      "vendor/fake",
      CHECK_SPECS_FIXTURES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE, bodies),
    );

    // Mode 0: exactly one call per source file, and one verdict per source file.
    expect(bodies).toHaveLength(13);
    expect(run.failures).toEqual([]);

    // The REAL system prompt reached the model — not a benchmark-only copy that could
    // drift from what the server actually sends.
    expect(messageOf(bodies[0], "system")).toBe(CHECK_SPECS_SYSTEM_PROMPT);
    expect(messageOf(bodies[0], "system")).toContain("strict specification compliance auditor");

    // Every request carries the REAL spec, under the REAL specs- tag prefix, and the
    // instructions the dataset forces — so the model is asked what a real caller asks.
    for (const b of bodies) {
      const user = messageOf(b, "user");
      expect(user).toContain("<specs-filename>");
      expect(user).toContain("`npm test` is offline and free"); // TESTING.md's own words
      expect(user).toContain("## ADDITIONAL INSTRUCTIONS");
      expect(user).toContain(CHECK_SPECS_INSTRUCTIONS);
    }

    // Each call audited exactly one corpus file, and between them they covered all 13.
    expect([...bodies.map(fixtureOfRequest)].sort()).toEqual([...FILES].sort());

    // The default token cap must not punish a reasoning model for thinking (the P2b
    // lesson: max_tokens bounds reasoning + content TOGETHER on most providers).
    expect((JSON.parse(bodies[0]) as { max_tokens: number }).max_tokens).toBe(4096);

    // A perfect model scores perfectly and passes.
    expect(run.aggregate.microF1).toBe(1);
    expect(run.accuracy).toBe(1);
    expect(run.pass).toBe(true);
    // Usage really was read from the response (13 × 2000 in, 13 × 80 out, at 1/2 $/M).
    expect(run.costUsd).toBeCloseTo((13 * 2000) / 1e6 + (13 * 80 * 2) / 1e6, 9);
  });

  it("the spec block is tagged differently from the source block — the model can tell rules from code", async () => {
    const bodies: string[] = [];
    await runCheckSpecsBenchmarkOnModel(
      "vendor/fake",
      CHECK_SPECS_FIXTURES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE, bodies),
    );
    const user = messageOf(bodies[0], "user");
    expect(user).toContain("<specs-file-content>");
    expect(user).toContain("<file-content>");
    // …and the audited-file extractor above really does get the CODE, not the spec.
    expect(auditedFileBytes(bodies[0])).not.toContain("`npm test` is offline and free");
  });
});

// ── THE DISCRIMINATION CHECK — the reason this corpus is worth its cost ─────
//
// P2c shipped a first corpus that a pure keyword matcher scored F1 0.909 on. It PASSED
// the gate. It measured nothing: the "benchmark" would have handed a passing grade to
// grep. The lesson is made structural here — every code-blind baseline is run through the
// REAL pipeline and the REAL scorer, and every one of them MUST fail the gate. If a future
// corpus edit ever lets one through, these tests go red and say so before a cent is spent.

describe("the corpus DEFEATS every code-blind baseline", () => {
  /** Run a naive strategy through the real pipeline; it sees exactly the code a model sees. */
  async function runNaive(id: string) {
    const s = NAIVE_STRATEGIES.find((x) => x.id === id)!;
    const run = await runCheckSpecsBenchmarkOnModel(
      `naive/${id}`,
      CHECK_SPECS_FIXTURES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter((body) =>
        s.decide(auditedFileBytes(body)) === "yes"
          ? "VIOLATION: it looks wrong"
          : "CLEAN — no spec violations found.",
      ),
    );
    return run;
  }

  it("flag-everything FAILS — precision 0.31, F1 0.47", async () => {
    const run = await runNaive("flag-everything");
    expect(run.aggregate.microRecall).toBe(1); // it never misses a violation…
    expect(run.aggregate.microPrecision).toBeCloseTo(4 / 13, 3); // …and is wrong nine times
    expect(run.aggregate.microF1).toBeCloseTo(0.471, 3);
    expect(passesThresholds(run.aggregate).pass).toBe(false);
  });

  it("flag-nothing FAILS on the recall floor — perfect precision, zero value", async () => {
    const run = await runNaive("flag-nothing");
    expect(run.aggregate.microPrecision).toBe(1); // vacuously: it asserted nothing
    expect(run.aggregate.microRecall).toBe(0);
    // …and note the accuracy it scores while finding NOTHING. This is why accuracy is
    // reported and F1 + the recall floor are the gate.
    expect(accuracyOf(run.aggregate)).toBeCloseTo(9 / 13, 3);
    const r = passesThresholds(run.aggregate);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/micro-recall/);
  });

  it("spec-vocabulary-grep FAILS — the FIXED twins talk about the subject MORE than the broken ones", async () => {
    // The strategy that would have passed P2c's first corpus. Here it catches all four
    // real violations (recall 1.0) and false-positives on EIGHT of the nine clean files —
    // including all four fixed twins, whose whole diff is explanatory comments about
    // LIVE_TESTS, and config.test.ts, which carries the OpenRouter URL as a string
    // constant. The vocabulary is anti-correlated with the truth.
    const run = await runNaive("spec-vocabulary-grep");
    expect(run.aggregate.microRecall).toBe(1);
    expect(run.aggregate.microPrecision).toBeCloseTo(4 / 12, 3); // 4 TP, 8 FP
    expect(run.aggregate.microF1).toBeCloseTo(0.5, 3);
    expect(passesThresholds(run.aggregate).pass).toBe(false);
  });

  it("missing-live-gate-grep FAILS — even when HANDED spec rule R2, a grep cannot apply it", async () => {
    // The strongest cheap adversary: a grep that has been TOLD the rule ('flag any file
    // with no LIVE_TESTS gate'). It catches all four violations. It also flags all four
    // ordinary offline unit tests, because a test that makes no LLM call needs no gate —
    // a fact that lives in the code, not in the vocabulary. Knowing the rule is not the
    // same as being able to apply it, and THAT is what this benchmark measures.
    const run = await runNaive("missing-live-gate-grep");
    expect(run.aggregate.microRecall).toBe(1);
    expect(run.aggregate.microPrecision).toBeCloseTo(0.5, 3); // 4 TP, 4 FP
    expect(run.aggregate.microF1).toBeCloseTo(0.667, 3);
    expect(passesThresholds(run.aggregate).pass).toBe(false);
  });

  it("EVERY naive strategy fails the gate — the corpus cannot decay back into grep-solvable", async () => {
    // The standing invariant, asserted over the whole list so a NEW strategy added to
    // NAIVE_STRATEGIES is automatically held to it too.
    for (const s of NAIVE_STRATEGIES) {
      const run = await runNaive(s.id);
      expect(passesThresholds(run.aggregate).pass, `${s.id} must NOT pass the gate`).toBe(false);
    }
  });
});

// ── Failure handling: a flaky API must never look like a bad model ──────────

describe("fail-safe posture", () => {
  it("an API error on one file does NOT abort the sweep — that file is UNSCORED", async () => {
    // The core's mode-0 loop has no try/catch around the LLM call, so a seam that THREW
    // would abort the whole run and turn one flaky HTTP call into a zero for the model.
    // The seam therefore records the reason and returns empty content, which the pipeline
    // already understands.
    const failing = FILES[1];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      if (fixtureOfRequest(init.body) === failing) {
        return { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: ORACLE(init.body) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      };
    }) as unknown as FetchImpl;

    const run = await runCheckSpecsBenchmarkOnModel(
      "vendor/flaky",
      CHECK_SPECS_FIXTURES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fetchImpl,
    );

    expect(run.failures).toHaveLength(1);
    expect(run.failures[0].file).toBe(failing);
    // The REASON is preserved, not flattened to "no report produced": 'rate limited' and
    // 'the model returned nothing' are completely different facts about a run, and a
    // report that hid the first behind the second would hide an INVALID sweep.
    expect(run.failures[0].reason).toContain("429");
    expect(run.failures[0].reason).toContain("rate limited");
    // The other twelve files still scored.
    expect(run.aggregate.coverage).toBeCloseTo(12 / 13, 5);
  });

  it("an empty model response is UNSCORED, never guessed at", async () => {
    const run = await runCheckSpecsBenchmarkOnModel(
      "vendor/mute",
      CHECK_SPECS_FIXTURES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "   "),
    );
    expect(run.failures).toHaveLength(13);
    expect(run.failures[0].reason).toBe("LLM returned empty response");
    expect(run.aggregate.coverage).toBe(0);
    expect(run.pass).toBe(false);
  });

  it("a model that will not state a verdict is UNSCORED — coverage sinks the run", async () => {
    // No free-text fallback: guessing a verdict out of prose that refused to state one is
    // a judge, and this benchmark has none. It costs coverage, and recall on the files that
    // really were violations.
    const run = await runCheckSpecsBenchmarkOnModel(
      "vendor/waffle",
      CHECK_SPECS_FIXTURES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "The file is broadly consistent with the specification, I think."),
    );
    // The calls SUCCEEDED (so they are not failures) — the reports simply carry no verdict.
    expect(run.failures).toEqual([]);
    expect(run.aggregate.coverage).toBe(0);
    expect(run.aggregate.microRecall).toBe(0);
    expect(run.pass).toBe(false);
  });

  it("scores a subset of the corpus without complaint (the runner is fixture-list driven)", async () => {
    const subset = CHECK_SPECS_FIXTURES.slice(0, 4); // the four violations
    const bodies: string[] = [];
    const run = await runCheckSpecsBenchmarkOnModel(
      "vendor/fake",
      subset,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE, bodies),
    );
    expect(bodies).toHaveLength(4);
    expect(run.aggregate.microRecall).toBe(1);
    expect(run.aggregate.cases[0].truePositives).toBe(4);
  });
});
