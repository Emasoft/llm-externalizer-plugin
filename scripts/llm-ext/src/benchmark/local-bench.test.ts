// D7a — the benchmark runner's endpoint parameter + the sequential local-model
// benchmark core (USER spec 2026-09-18 point 3.2).
//
// Real 127.0.0.1 HTTP servers stand in for local LLM servers (llama.cpp, LM
// Studio, Ollama, vLLM). The code under test — runner.ts, score.ts and
// local-bench.ts — runs for real; nothing of it is mocked. The one non-local URL
// (OpenRouter, the runner's default) is reached only through the runner's own
// fetchImpl seam, which records the request instead of sending it, so this file
// never touches the external network.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BENCHMARK_KEYWORDS, buildGroundTruth } from "./ground-truth.js";
import { runBenchmarkOnModel } from "./runner.js";
import { benchmarkModelsSequentially, isNonBillableEndpoint, rankLocalModels } from "./local-bench.js";

// The keyword sweep's own ground truth, from the bundled fixtures — the same
// GroundTruth the production caller hands to benchmarkModelsSequentially.
const truth = buildGroundTruth(join(dirname(fileURLToPath(import.meta.url)), "fixtures"), BENCHMARK_KEYWORDS);

type Answer = "correct" | "wrong" | "schema-noncompliant";

interface Behaviour {
  answer: Answer;
  /** Server-side think time before the reply, in ms. */
  delayMs?: number;
  /** usage.completion_tokens of the timed (benchmark) reply. */
  completionTokens?: number;
  /** llama.cpp-style generation timings, echoed on the timed reply when set. */
  timings?: { predicted_n: number; predicted_ms: number };
}

interface LoggedRequest {
  port: number;
  model: string;
  /** A warm-up carries no response_format; the timed benchmark request does. */
  warmup: boolean;
  start: number;
  end: number;
  path: string | undefined;
  authorization: string | undefined;
}

function answerFor(answer: Answer): Record<string, string[]> {
  const [k1, k2, k3] = truth.keywordFunctions;
  if (answer === "correct") return { kw1_functions: k1, kw2_functions: k2, kw3_functions: k3 };
  // Buckets 1 and 2 swapped: valid schema, wrong content.
  if (answer === "wrong") return { kw1_functions: k2, kw2_functions: k1, kw3_functions: k3 };
  // Right content under the short field names: a schema violation.
  return { kw1: k1, kw2: k2, kw3: k3 };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** A fake local OpenAI-compatible server serving `models`; every request is appended to `log`. */
async function startServer(log: LoggedRequest[], models: Record<string, Behaviour>): Promise<string> {
  const server = createServer((req, res) => {
    const start = performance.now();
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; response_format?: unknown };
      const behaviour = models[body.model];
      const warmup = body.response_format === undefined;
      setTimeout(() => {
        if (!behaviour) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `model '${body.model}' not found` }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                { message: { content: warmup ? "OK" : JSON.stringify(answerFor(behaviour.answer)) }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 100, completion_tokens: warmup ? 1 : (behaviour.completionTokens ?? 0) },
              ...(behaviour.timings && !warmup ? { timings: behaviour.timings } : {}),
            }),
          );
        }
        log.push({
          port: (server.address() as AddressInfo).port,
          model: body.model,
          warmup,
          start,
          end: performance.now(),
          path: req.url,
          authorization: req.headers.authorization,
        });
      }, behaviour?.delayMs ?? 20);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const localModel = (id: string) => ({ id, inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 });

describe("runner endpoint parameter (D7a)", () => {
  it("defaults to OpenRouter when no baseUrl is given — every existing sweep caller is unchanged", async () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const out = await runBenchmarkOnModel(localModel("vendor/model"), truth.keywords, truth.fixtures, {
      apiKey: "k-test",
      freeOnly: false,
      fetchImpl: async (url, init) => {
        seen.push({ url, authorization: (init.headers as Record<string, string>).Authorization });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answerFor("correct")) } }] }), {
          status: 200,
        });
      },
    });
    expect(seen).toEqual([{ url: "https://openrouter.ai/api/v1/chat/completions", authorization: "Bearer k-test" }]);
    expect(out.ok).toBe(true);
  });

  it("sends to a given local base URL, with no Authorization header when no key is given", async () => {
    const log: LoggedRequest[] = [];
    const baseUrl = await startServer(log, { "qwen3:8b": { answer: "correct" } });
    const out = await runBenchmarkOnModel(localModel("qwen3:8b"), truth.keywords, truth.fixtures, {
      baseUrl,
      freeOnly: false,
    });
    expect(out.ok).toBe(true);
    expect(log.map((r) => ({ path: r.path, model: r.model, authorization: r.authorization }))).toEqual([
      { path: "/v1/chat/completions", model: "qwen3:8b", authorization: undefined },
    ]);
  });
});

describe("benchmarkModelsSequentially + rankLocalModels (D7a)", () => {
  it("excludes a model that answers wrongly and one that ignores the JSON schema; writes no ledger", async () => {
    // A private config dir for THIS test, so the listing below sees only what this
    // run wrote. Named without "llm-ext" so the suite's tmpdir guard ignores it.
    const configDir = mkdtempSync(join("/tmp", "d7acfg-"));
    const previous = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = configDir;
    try {
      const log: LoggedRequest[] = [];
      const baseUrl = await startServer(log, {
        good: { answer: "correct", completionTokens: 30 },
        wrong: { answer: "wrong", completionTokens: 30 },
        noschema: { answer: "schema-noncompliant", completionTokens: 30 },
      });
      const results = await benchmarkModelsSequentially(
        [
          { baseUrl, model: "wrong" },
          { baseUrl, model: "good" },
          { baseUrl, model: "noschema" },
        ],
        { truth },
      );
      expect(results.map((r) => [r.model, r.pass])).toEqual([
        ["wrong", false],
        ["good", true],
        ["noschema", false],
      ]);
      expect(results[0].failReason).toMatch(/answered wrongly/);
      expect(results[2].failReason).toMatch(/schema/);
      const { ranked, excluded } = rankLocalModels(results);
      expect(ranked.map((r) => r.model)).toEqual(["good"]);
      expect(excluded.map((r) => r.model)).toEqual(["wrong", "noschema"]);
      // Nothing but the per-request usage log: no validation ledger, no benchmark
      // sidecar — a local id must never count as validated for a PAID OpenRouter send.
      expect(readdirSync(configDir)).toEqual(["history.log"]);
      const lines = readFileSync(join(configDir, "history.log"), "utf-8").trim().split("\n");
      expect(lines).toHaveLength(6); // 3 warm-ups + 3 timed runs
      for (const line of lines) expect(line).toContain("$0.000000");
    } finally {
      if (previous === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = previous;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("ranks passing models by context size first, then tok/s", async () => {
    const log: LoggedRequest[] = [];
    const baseUrl = await startServer(log, {
      small: { answer: "correct", timings: { predicted_n: 100, predicted_ms: 1000 } }, // 100 tok/s
      bigSlow: { answer: "correct", timings: { predicted_n: 10, predicted_ms: 1000 } }, // 10 tok/s
      bigFast: { answer: "correct", timings: { predicted_n: 50, predicted_ms: 1000 } }, // 50 tok/s
    });
    const results = await benchmarkModelsSequentially(
      [
        { baseUrl, model: "small", contextLength: 8192 },
        { baseUrl, model: "bigSlow", contextLength: 32768 },
        { baseUrl, model: "bigFast", contextLength: 32768 },
      ],
      { truth },
    );
    expect(results.every((r) => r.pass)).toBe(true);
    // Context beats speed (small is the fastest yet last); speed breaks the context tie.
    expect(rankLocalModels(results).ranked.map((r) => r.model)).toEqual(["bigFast", "bigSlow", "small"]);
  });

  it("never has two requests in flight — across models, endpoints, and a model's own warm-up vs timed run", async () => {
    const log: LoggedRequest[] = [];
    const a = await startServer(log, { a1: { answer: "correct", delayMs: 30 }, a2: { answer: "wrong", delayMs: 30 } });
    const b = await startServer(log, { b1: { answer: "correct", delayMs: 30 }, b2: { answer: "correct", delayMs: 30 } });
    await benchmarkModelsSequentially(
      [
        { baseUrl: a, model: "a1" },
        { baseUrl: b, model: "b1" },
        { baseUrl: a, model: "a2" },
        { baseUrl: b, model: "b2" },
      ],
      { truth },
    );
    const byStart = [...log].sort((x, y) => x.start - y.start);
    expect(byStart.map((r) => [r.model, r.warmup])).toEqual([
      ["a1", true],
      ["a1", false],
      ["b1", true],
      ["b1", false],
      ["a2", true],
      ["a2", false],
      ["b2", true],
      ["b2", false],
    ]);
    for (let i = 1; i < byStart.length; i++) {
      expect(byStart[i].start).toBeGreaterThanOrEqual(byStart[i - 1].end);
    }
  });

  it("fails an unreachable endpoint's model only — the rest of the list still runs", async () => {
    const log: LoggedRequest[] = [];
    const baseUrl = await startServer(log, { good: { answer: "correct" } });
    const results = await benchmarkModelsSequentially(
      [
        // Port 1: nothing listens there, so the connection is refused at once.
        { baseUrl: "http://127.0.0.1:1", model: "ghost" },
        { baseUrl, model: "good" },
      ],
      { truth },
    );
    expect(results[0]).toMatchObject({ model: "ghost", pass: false, tokPerSec: null });
    expect(results[0].failReason).toMatch(/warm-up network error/);
    expect(results[1]).toMatchObject({ model: "good", pass: true });
    expect(log.map((r) => r.model)).toEqual(["good", "good"]);
  });

  it("measures tok/s — generation-only from server timings, else completion tokens over wall clock", async () => {
    const log: LoggedRequest[] = [];
    const baseUrl = await startServer(log, {
      llamacpp: { answer: "correct", timings: { predicted_n: 50, predicted_ms: 500 } },
      ollama: { answer: "correct", completionTokens: 40, delayMs: 200 },
    });
    const [withTimings, withoutTimings] = await benchmarkModelsSequentially(
      [
        { baseUrl, model: "llamacpp" },
        { baseUrl, model: "ollama" },
      ],
      { truth },
    );
    expect(withTimings.tokPerSec).toBe(100);
    expect(withTimings.tokPerSecBasis).toMatch(/server timings/);
    // 40 tokens over >= 200 ms of wall clock: positive and at most 200 tok/s.
    expect(withoutTimings.tokPerSec).toBeGreaterThan(0);
    expect(withoutTimings.tokPerSec).toBeLessThanOrEqual(200);
    expect(withoutTimings.tokPerSecBasis).toMatch(/wall-clock/);
  });

  it("refuses a billable endpoint before sending anything to any endpoint", async () => {
    const log: LoggedRequest[] = [];
    const baseUrl = await startServer(log, { good: { answer: "correct" } });
    await expect(
      benchmarkModelsSequentially(
        [
          { baseUrl, model: "good" },
          { baseUrl: "https://openrouter.ai/api", model: "openai/gpt-5.4-nano" },
        ],
        { truth },
      ),
    ).rejects.toThrow(/refused.*billable.*https:\/\/openrouter\.ai\/api/);
    // The local pair comes FIRST, so an empty log proves the gate runs before any request.
    expect(log).toEqual([]);
  });

  it("classifies endpoints: local/private and the free provider pass, everything else is billable", () => {
    for (const url of ["http://localhost:11434", "http://127.0.0.1:8080", "http://192.168.1.20:1234", "https://api.b.ai"]) {
      expect(isNonBillableEndpoint(url), url).toBe(true);
    }
    for (const url of ["https://openrouter.ai/api", "http://api.b.ai", "https://api.b.ai.evil.com", "http://127.0.0.1.evil.com", ""]) {
      expect(isNonBillableEndpoint(url), url).toBe(false);
    }
  });
});
