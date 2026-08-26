// Hermetic tests for the text-tools benchmark runner (summarize / topics /
// sem_deduplicate / describe).
//
// NO network. NO module mocking of anything under test. The ONLY fake is the
// FetchImpl seam (the same seam every other benchmark runner in this repo
// uses). Everything else is REAL: the real hand-curated corpus (dataset.ts),
// the REAL per-tool pipeline (text-tools/core.ts::runSummarize/runTopics/
// runSemDeduplicate/runDescribe — real validation, real one-retry loop, real
// response gate), and the REAL deterministic scorer (score.ts). Never mock
// the thing under test.

import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, it, expect } from "vitest";

import type { FetchImpl } from "../../security_scan/judge.js";
import { runTextToolBenchmarkOnModel } from "./bench-runner.js";
import { DESCRIBE_CASES, SEM_DEDUP_CASES, SUMMARIZE_CASES, TOPICS_CASES } from "./dataset.js";

const PRICING = { input_per_m_usd: 1, output_per_m_usd: 2, context_window: 128_000 };

function userContent(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  return (parsed.messages ?? []).find((m) => m.role === "user")?.content ?? "";
}

/** A fake OpenRouter that always answers 200/OK with `answer(body)` as the content. */
function fakeOpenRouter(answer: (body: string) => string): FetchImpl {
  return (async (_url: string, init: { body: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: answer(init.body) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    }),
    text: async () => "",
  })) as unknown as FetchImpl;
}

describe("runTextToolBenchmarkOnModel — hermetic, real pipeline + real scorer", () => {
  it("summarize: a good model (hits every concept, stays in budget) scores > 0 and PASSES", async () => {
    const fake = fakeOpenRouter((body) => {
      const text = userContent(body);
      const c = SUMMARIZE_CASES.find((x) => text.includes(x.text.slice(0, 30)))!;
      return c.concepts.map((forms) => forms[0]).join(" ");
    });
    const run = await runTextToolBenchmarkOnModel(
      "summarize",
      "vendor/good",
      { apiKey: "k", pricing: PRICING },
      fake,
    );
    expect(run.perCase.length).toBe(SUMMARIZE_CASES.length);
    expect(run.failures).toEqual([]);
    expect(run.aggregate.meanScore).toBeGreaterThan(0);
    expect(run.pass).toBe(true);
  });

  it("topics: a good model (right language, on-topic keywords) scores > 0 and PASSES", async () => {
    const fake = fakeOpenRouter((body) => {
      const text = userContent(body);
      const c = TOPICS_CASES.find((x) => text.includes(x.text.slice(0, 30)))!;
      return JSON.stringify({
        language: c.language[0],
        keywords: c.concepts.map((forms) => forms[0]),
        keyphrases: [],
      });
    });
    const run = await runTextToolBenchmarkOnModel(
      "topics",
      "vendor/good",
      { apiKey: "k", pricing: PRICING },
      fake,
    );
    expect(run.perCase.length).toBe(TOPICS_CASES.length);
    expect(run.failures).toEqual([]);
    expect(run.aggregate.meanScore).toBeGreaterThan(0);
    expect(run.pass).toBe(true);
  });

  it("sem_deduplicate: one survivor per cluster scores > 0 and PASSES", async () => {
    const fake = fakeOpenRouter((body) => {
      const text = userContent(body);
      // Match on the LAST cluster's first phrase, never the first: the
      // sem-dedup PROMPT quotes worked examples of its own, so a first-cluster
      // probe can match the template text instead of the case's list and hand
      // every case the same (wrong) answer.
      const c = SEM_DEDUP_CASES.find((x) =>
        text.includes(x.clusters[x.clusters.length - 1][0]),
      )!;
      return JSON.stringify(c.clusters.map((cl) => cl[0]));
    });
    const run = await runTextToolBenchmarkOnModel(
      "sem_deduplicate",
      "vendor/good",
      { apiKey: "k", pricing: PRICING },
      fake,
    );
    expect(run.perCase.length).toBe(SEM_DEDUP_CASES.length);
    expect(run.failures).toEqual([]);
    expect(run.aggregate.meanScore).toBeGreaterThan(0);
    expect(run.pass).toBe(true);
  });

  it("describe: a good model (hits every concept, stays in budget) scores > 0 and PASSES", async () => {
    const fake = fakeOpenRouter((body) => {
      const text = userContent(body);
      const c = DESCRIBE_CASES.find((x) => text.includes(x.fileName))!;
      return c.concepts.map((forms) => forms[0]).join(" ");
    });
    const run = await runTextToolBenchmarkOnModel(
      "describe",
      "vendor/good",
      { apiKey: "k", pricing: PRICING },
      fake,
    );
    expect(run.perCase.length).toBe(DESCRIBE_CASES.length);
    expect(run.failures).toEqual([]);
    expect(run.aggregate.meanScore).toBeGreaterThan(0);
    expect(run.pass).toBe(true);
  });

  it("an API error (HTTP 500) on one case is recorded as a CaseFailure — the sweep never throws", async () => {
    const victim = SUMMARIZE_CASES[0];
    const impl = (async (_url: string, init: { body: string }) => {
      if (userContent(init.body).includes(victim.text.slice(0, 30))) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "upstream down" };
      }
      const c = SUMMARIZE_CASES.find((x) => userContent(init.body).includes(x.text.slice(0, 30)))!;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: c.concepts.map((forms) => forms[0]).join(" ") } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      };
    }) as unknown as FetchImpl;

    const run = await runTextToolBenchmarkOnModel(
      "summarize",
      "vendor/flaky",
      { apiKey: "k", pricing: PRICING },
      impl,
    );
    // The run completed — a single bad case never throws out of the sweep.
    expect(run.perCase.length).toBe(SUMMARIZE_CASES.length);
    expect(run.failures.map((f) => f.caseId)).toEqual([victim.id]);
    expect(run.perCase.find((p) => p.caseId === victim.id)!.score).toBe(0);
    // Every other case still scored normally.
    expect(run.perCase.filter((p) => p.caseId !== victim.id).every((p) => p.score > 0)).toBe(true);
  });

  it("a malformed JSON response body on one case is recorded as a CaseFailure — the sweep never throws", async () => {
    const victim = SUMMARIZE_CASES[0];
    const impl = (async (_url: string, init: { body: string }) => {
      if (userContent(init.body).includes(victim.text.slice(0, 30))) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("Unexpected end of JSON input");
          },
          text: async () => "",
        };
      }
      const c = SUMMARIZE_CASES.find((x) => userContent(init.body).includes(x.text.slice(0, 30)))!;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: c.concepts.map((forms) => forms[0]).join(" ") } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => "",
      };
    }) as unknown as FetchImpl;

    const run = await runTextToolBenchmarkOnModel(
      "summarize",
      "vendor/malformed",
      { apiKey: "k", pricing: PRICING },
      impl,
    );
    expect(run.perCase.length).toBe(SUMMARIZE_CASES.length);
    expect(run.failures.map((f) => f.caseId)).toEqual([victim.id]);
  });

  it("accumulates cost from real usage numbers against the supplied pricing, across every case", async () => {
    const fake = fakeOpenRouter((body) => {
      const text = userContent(body);
      const c = SUMMARIZE_CASES.find((x) => text.includes(x.text.slice(0, 30)))!;
      return c.concepts.map((forms) => forms[0]).join(" ");
    });
    const run = await runTextToolBenchmarkOnModel(
      "summarize",
      "vendor/priced",
      { apiKey: "k", pricing: PRICING },
      fake,
    );
    // Exactly one call per case (a good answer never triggers the corrective
    // retry), so the fixed usage bills once per case at the supplied rates.
    const perCallCost = (1000 / 1e6) * PRICING.input_per_m_usd + (100 / 1e6) * PRICING.output_per_m_usd;
    expect(run.costUsd).toBeCloseTo(SUMMARIZE_CASES.length * perCallCost, 9);
  });

  it("describe: the per-case tmp file directory is removed — no leaked llm-ext-describe-bench-* dir", async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((n) => n.startsWith("llm-ext-describe-bench-")),
    );
    const fake = fakeOpenRouter((body) => {
      const text = userContent(body);
      const c = DESCRIBE_CASES.find((x) => text.includes(x.fileName))!;
      return c.concepts.map((forms) => forms[0]).join(" ");
    });
    await runTextToolBenchmarkOnModel("describe", "vendor/tidy", { apiKey: "k", pricing: PRICING }, fake);
    // Every tmp dir the run created (one mkdtemp per case) must be gone again —
    // the `finally` in bench-runner.ts's describe case builder removes it
    // synchronously before the pipeline call resolves.
    const after = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("llm-ext-describe-bench-") && !before.has(n),
    );
    expect(after).toEqual([]);
  });
});
