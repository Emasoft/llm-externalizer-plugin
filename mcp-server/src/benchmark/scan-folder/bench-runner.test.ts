// Hermetic tests for the scan_folder (MASS SEARCH) benchmark runner — P2c.
//
// NO network. NO module mocking of anything under test. The ONLY fake is the
// FetchImpl seam (the same seam the security_scan judge uses). Everything else is
// REAL: the real ten-file corpus on disk, the REAL scan_folder pipeline
// (scan-folder/core.ts::runScanFolder — real validation, real walkDir discovery,
// real rateLimitedParallel dispatch), the REAL system prompt
// (scan-pipeline.ts::codeTaskSystemPrompt), the REAL readFileAsCodeBlock, and the
// REAL deterministic scorer. Never mock the thing under test.
//
// NOTE: this file is DISTINCT from runner.test.ts in the same directory, which
// tests the scan_folder pipeline CORE. This one tests the BENCHMARK runner.

import { describe, it, expect } from "vitest";

import type { FetchImpl } from "../../security_scan/judge.js";
import { runScanFolderBenchmarkOnModel } from "./bench-runner.js";
import {
  SCAN_FOLDER_CASES,
  deriveMatchingFiles,
  scannedFilesFor,
  type ScanFolderCase,
} from "./dataset.js";

const PRICING = { input_per_m_usd: 1, output_per_m_usd: 2, context_window: 128_000 };
const FILE_DECISIONS = SCAN_FOLDER_CASES.reduce((n, c) => n + scannedFilesFor(c).length, 0);

/** The concatenated message text of a captured request body. */
function requestText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).map((m) => m.content ?? "").join("\n");
}

function systemText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).find((m) => m.role === "system")?.content ?? "";
}

/**
 * ONLY the attached file's bytes — the text of the LAST <file-content> block, with
 * the system prompt and the instructions stripped out.
 *
 * Load-bearing for the keyword-matcher test below, and it hides TWO traps that both
 * silently fake a result:
 *
 *  1. The QUESTIONS contain the keywords ("…through Node's child_process API",
 *     "…from Node's crypto module"). A fake that grepped the whole REQUEST finds its
 *     needle in the prompt on every file, answers MATCH to all twelve, and invents a
 *     discriminating power the corpus does not have. A keyword-matching model greps
 *     the CODE, so the fake must too.
 *  2. There are TWO <file-content> blocks in every request: the SYSTEM prompt's own
 *     INPUT FORMAT example comes FIRST (it contains the literal placeholder
 *     `{FILE_CONTENTS_HERE}`), and the real file comes second. A non-greedy match
 *     from the start therefore returns the PLACEHOLDER — the fake then sees no code
 *     at all, answers NO_MATCH to everything, and the test "proves" the corpus
 *     defeats a keyword matcher when in fact it never ran one. Hence: the LAST block.
 */
function fileContentOf(body: string): string {
  const blocks = [...requestText(body).matchAll(/<file-content>([\s\S]*?)<\/file-content>/g)];
  const last = blocks.at(-1);
  if (!last) throw new Error("no <file-content> block in the request — the pipeline changed shape");
  if (last[1].includes("{FILE_CONTENTS_HERE}")) {
    throw new Error(
      "fileContentOf picked up the system prompt's FORMAT EXAMPLE instead of the file — the request shape changed and this fake would silently score nothing.",
    );
  }
  return last[1];
}

/**
 * Build a fake OpenRouter that answers each request with `answer(body)`. The body
 * carries the fixture's REAL bytes (the REAL readFileAsCodeBlock put them there),
 * so a fake can decide its verdict by looking at the very code the model would see
 * — which is what lets these tests drive the real pipeline end to end.
 */
function fakeOpenRouter(answer: (body: string) => string, captured?: string[]): FetchImpl {
  return (async (_url: string, init: { body: string }) => {
    if (captured) captured.push(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: answer(init.body) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
      }),
      text: async () => "",
    };
  }) as unknown as FetchImpl;
}

/** Which fixture is in this request? Matched on the path in the file tag. */
function fixtureOfRequest(body: string): string {
  const text = requestText(body);
  const all = scannedFilesFor(SCAN_FOLDER_CASES[0]);
  const hit = all.find((rel) => text.includes(`/${rel}`));
  if (!hit) throw new Error(`no fixture matched the request: ${text.slice(0, 200)}`);
  return hit;
}

/** Which query is this request for? Matched on the criterion text in the prompt. */
function caseOfRequest(body: string): ScanFolderCase {
  const text = requestText(body);
  const hit = SCAN_FOLDER_CASES.find((c) => text.includes(c.criterion.split("\n")[0]));
  if (!hit) throw new Error(`no case matched the request: ${text.slice(0, 200)}`);
  return hit;
}

/** A model with perfect knowledge — answers straight from the derived ground truth. */
const ORACLE = (body: string): string => {
  const c = caseOfRequest(body);
  const file = fixtureOfRequest(body);
  return deriveMatchingFiles(c).includes(file) ? `MATCH: proof in ${file}` : "NO_MATCH";
};

describe("runScanFolderBenchmarkOnModel — hermetic, real pipeline + real scorer", () => {
  it("drives the REAL pipeline: one LLM call per file per query, with the SERVER's prompt", async () => {
    const bodies: string[] = [];
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/fake",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE, bodies),
    );

    // scan_folder is per-file-call: the real walkDir found the corpus and the real
    // rate-limited executor dispatched one call for every (query, file) pair.
    expect(bodies.length).toBe(FILE_DECISIONS);
    expect(FILE_DECISIONS).toBe(SCAN_FOLDER_CASES.length * 12);
    expect(run.caseScores.length).toBe(SCAN_FOLDER_CASES.length);
    expect(run.failures).toEqual([]);

    // The system prompt is the SERVER's, imported — not a benchmark-only copy. This
    // is what makes the score mean something about how the tool really behaves.
    const sys = systemText(bodies[0]);
    expect(sys).toContain("Identify code by FUNCTION/CLASS/METHOD NAME, never by line number");
    expect(sys).toContain("INPUT FORMAT:");
    expect(sys).toContain("OUTPUT RULES:");

    // The user message carries the forced anchor contract AND the fixture's real bytes.
    const user = requestText(bodies[0]);
    expect(user).toContain("OUTPUT FORMAT (mandatory)");
    expect(user).toContain("NO_MATCH");
    expect(user).toContain("<file-content>");
  });

  it("scores a perfect model 1.0 and PASSES it", async () => {
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/oracle",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE),
    );
    expect(run.aggregate.microF1).toBe(1);
    expect(run.aggregate.microRecall).toBe(1);
    expect(run.aggregate.coverage).toBe(1);
    expect(run.pass).toBe(true);
    // The oracle cites evidence on every MATCH — captured for the report, never graded.
    expect(run.evidence.length).toBeGreaterThan(0);
  });

  it("FAILS a model that answers NO_MATCH to everything", async () => {
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/silent",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "NO_MATCH"),
    );
    expect(run.aggregate.microRecall).toBe(0);
    expect(run.pass).toBe(false);
  });

  it("FAILS a model that answers MATCH to everything", async () => {
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/shotgun",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "MATCH: everything matches everything"),
    );
    expect(run.aggregate.microRecall).toBe(1);
    expect(run.aggregate.microPrecision).toBeLessThan(0.5);
    expect(run.pass).toBe(false);
  });

  it("FAILS the KEYWORD MATCHER — a benchmark a grep could pass would measure nothing", async () => {
    // THE test that says whether this corpus is worth anything. This fake never
    // reads the code: for each query it greps the file for the query's own keyword
    // and answers MATCH if it appears anywhere — comment, string, threat
    // description, import, it does not care. It is the archetypal weak model.
    //
    // It gets PERFECT RECALL (every real hit does contain the keyword) and is
    // destroyed on precision by the traps: the four read-only fs files, and
    // security-triage-dataset.ts, whose prose is saturated with "insecure_crypto"
    // and "md5/sha1" while importing no crypto at all. It must not pass.
    const KEYWORD: Record<string, string> = {
      "spawns-external-process": "child_process",
      "writes-to-filesystem": "node:fs",
      "uses-node-crypto": "crypto",
    };
    const keywordMatcher = (body: string): string => {
      const c = caseOfRequest(body);
      const needle = KEYWORD[c.id];
      // Greps the FILE's bytes, not the whole request — see fileContentOf.
      return fileContentOf(body).includes(needle)
        ? `MATCH: the file contains the string ${needle}`
        : "NO_MATCH";
    };
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/keyword",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(keywordMatcher),
    );

    expect(run.aggregate.microRecall).toBe(1); // it never MISSES …
    expect(run.aggregate.microPrecision).toBeLessThan(0.7); // … and is still wrong a lot
    expect(run.pass).toBe(false);

    // It is trapped on EVERY query, not just one — that is what the two
    // "describes the threat but never does it" fixtures bought.
    const fs = run.caseScores.find((c) => c.caseId === "writes-to-filesystem")!;
    expect(fs.falsePositives).toBe(4); // the four read-only fs users
    const crypto = run.caseScores.find((c) => c.caseId === "uses-node-crypto")!;
    expect(crypto.falsePositives).toBe(2); // the two files that only TALK about crypto

    // An honest limit, asserted rather than hidden: the child_process query alone IS
    // grep-solvable — the token appears in exactly the two files that import it, and
    // no real file in this repo mentions it without using it. That query is a
    // precision/format control; the corpus's discriminating power lives in the other
    // two. Pinning it here so nobody later mistakes it for something stronger.
    const spawn = run.caseScores.find((c) => c.caseId === "spawns-external-process")!;
    expect(spawn.f1).toBe(1);
  });

  it("a model that ignores the output contract loses COVERAGE, not the run", async () => {
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/chatty",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(() => "Well, it depends on how you look at it."),
    );
    // No parseable verdict anywhere → nothing is scored, and the run cannot pass.
    expect(run.aggregate.coverage).toBe(0);
    expect(run.pass).toBe(false);
    // It is a COVERAGE failure, not a crash: the sweep completed normally.
    expect(run.caseScores.length).toBe(SCAN_FOLDER_CASES.length);
  });

  it("ONE flaky file is recorded as UNSCORED, never aborts the sweep, and is TOLERATED", async () => {
    // One fixture 500s on every query; the rest answer correctly. This is the
    // fail-safe posture, and it is deliberate in BOTH directions:
    //   • the failures are RECORDED with their real reason and the files are UNSCORED
    //     (they cost coverage, and recall where the file was a true match) — never
    //     silently dropped from the denominator;
    //   • but one flaky file does NOT sink an otherwise-good model. A provider hiccup
    //     is not evidence about a model's judgment, and a benchmark that zeroed a good
    //     model for one 500 would be measuring the network.
    // The COVERAGE floor is what catches the systemic case (see the next test).
    const flaky: FetchImpl = (async (_url: string, init: { body: string }) => {
      if (requestText(init.body).includes("/src/jsonl.ts")) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: ORACLE(init.body) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 50 },
        }),
        text: async () => "",
      };
    }) as unknown as FetchImpl;

    const run = await runScanFolderBenchmarkOnModel(
      "vendor/flaky",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      flaky,
    );

    // Exactly one file × three queries produced no verdict, each with its REAL
    // reason — not a flattened "no report produced". "API error 500" and "rate
    // limited" are different facts about a run and the report must be able to say so.
    expect(run.failures.length).toBe(SCAN_FOLDER_CASES.length);
    expect(run.failures.every((f) => f.file.endsWith("/src/jsonl.ts"))).toBe(true);
    expect(run.failures.every((f) => /API error 500/.test(f.reason))).toBe(true);

    // The other 33 decisions were still scored — the sweep did not abort.
    expect(run.aggregate.coverage).toBeCloseTo(33 / 36, 5);
    // jsonl.ts is a real writer, so its missing verdict is a MISS, not an excuse.
    const fsCase = run.caseScores.find((c) => c.caseId === "writes-to-filesystem")!;
    expect(fsCase.falseNegatives).toBe(1);
    // 9 of 10 true matches found (recall 0.90) with zero false alarms → still passes.
    expect(run.aggregate.microRecall).toBeCloseTo(0.9, 5);
    expect(run.pass).toBe(true);
  });

  it("a SYSTEMIC outage cannot pass — the coverage floor turns it into 'no evidence'", async () => {
    // The other half of the fail-safe contract. When enough calls fail, the run stops
    // being evidence about the model at all, and it must NOT pass on the strength of
    // the files that happened to survive. Here a third of the corpus 500s.
    const OUT = ["/src/jsonl.ts", "/src/report.ts", "/src/rule-install.ts", "/src/unionfind.ts"];
    const outage: FetchImpl = (async (_url: string, init: { body: string }) => {
      const text = requestText(init.body);
      if (OUT.some((f) => text.includes(f))) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => "down" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: ORACLE(init.body) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 50 },
        }),
        text: async () => "",
      };
    }) as unknown as FetchImpl;

    const run = await runScanFolderBenchmarkOnModel(
      "vendor/outage",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      outage,
    );
    expect(run.aggregate.coverage).toBeCloseTo(24 / 36, 5);
    const gate = run.pass;
    expect(gate).toBe(false);
    expect(run.failures.length).toBe(OUT.length * SCAN_FOLDER_CASES.length);
  });

  it("accumulates cost from the reported token usage", async () => {
    const run = await runScanFolderBenchmarkOnModel(
      "vendor/oracle",
      SCAN_FOLDER_CASES,
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE),
    );
    // 30 calls × (1000 in @ $1/M + 50 out @ $2/M) = 30 × (0.001 + 0.0001).
    expect(run.costUsd).toBeCloseTo(FILE_DECISIONS * (0.001 + 0.0001), 6);
  });

  it("bounds max_tokens generously — a tight cap would truncate a reasoning model into silence", async () => {
    // The P2b lesson, encoded: max_tokens bounds thinking + visible content TOGETHER
    // on most providers, so a cap sized for the one-line answer would make every
    // reasoning model look incompetent. 4096 leaves room to think.
    const bodies: string[] = [];
    await runScanFolderBenchmarkOnModel(
      "vendor/fake",
      [SCAN_FOLDER_CASES[0]],
      { apiKey: "k", pricing: PRICING, apiUrl: "http://fake/v1" },
      fakeOpenRouter(ORACLE, bodies),
    );
    const body = JSON.parse(bodies[0]) as { max_tokens?: number; temperature?: number };
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.1);
  });
});
