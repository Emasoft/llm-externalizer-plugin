// TRDD-XJE5DDK2: when a remote decision call fails and the local decider answers instead, the stderr line and the local_decider warning
// must name the remote error. WHY: on 2026-11-14 a 402 "Insufficient credits" was swallowed by the notice, a paid model was silently
// replaced by a local one with exit 0, and a whole live check was void. Real catalog and endpoints replies recorded by P-01/P-02 and
// a recorded decisions answer, served through the GlobalFetch seam; the local decider is a fetch + discover seam like in
// command-timeout.test.ts. No mock of the code under test, no network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../config.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import type { RunDeps } from "./run-decision.js";

const KEY = "[REDACTED:openai-key]";
const DECIDER = "http://127.0.0.1:8000";
const KEY_REF = "$XJE_TEST_KEY"; // WHY: the settings env-reference syntax for the key set at process.env.XJE_TEST_KEY, not a key itself
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join("/tmp", "llm-ext-remote-error-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, LLM_EXT_GOVERNOR_ENABLED: process.env.LLM_EXT_GOVERNOR_ENABLED, XJE_TEST_KEY: process.env.XJE_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
  process.env.XJE_TEST_KEY = KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

describe("classify, a remote failure answered by the local decider", () => {
  it("a split of the local escalation whose piece the decider refuses names that piece reason in a split_piece_failed warning and on stderr (TRDD-1L9VMEY7)", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { spec } = await import("./catalog/filter.js");
    const stderr: string[] = [];
    const refusal = (needed: number): Response => new Response(JSON.stringify({ error: { message: `the question with its state needs ${needed} tokens; the limit is 16384 and input is not cut`, type: "invalid_request_error" } }), { status: 422 });
    let singles = 0;
    const fetch: GlobalFetch = async (url, init) => {
      if (url.startsWith(DECIDER)) {
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
        const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
        // the decider refuses every multi-question request, then the second single-question piece
        if (Object.keys(q).length > 1) return refusal(20001);
        singles++;
        if (singles === 2) return refusal(16460);
        const real = (JSON.parse(fx("p01", "dec-noul").body) as { answers: Record<string, unknown> }).answers.is_bug;
        return new Response(JSON.stringify({ model: "elephant-1", answers: Object.fromEntries(Object.keys(q).map((k) => [k, real])), usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
      }
      if (url.includes("output_modalities=decisions")) {
        const body = JSON.parse(fx("p02", "models-decisions").body) as { data: { id: string; description?: string }[] };
        body.data = body.data.filter((m) => m.id.includes("typesafe/") || !/system\s*one/i.test(m.description ?? ""));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
      return syntheticResponse(402, JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { "content-type": "application/json" });
    };
    const deps: RunDeps = {
      settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: KEY_REF, max_attempts: 1, timeout_ms: 5000, concurrency: 1 } as unknown as Profile } },
      fetch,
      catalogOptions: { path: join(tmp, "catalog.json") },
      sigint: new EventEmitter(),
      stderr: (l: string) => { stderr.push(l); },
      localFallback: { requestTimeoutMs: 20_000, attemptTimeoutMs: 2000, startTimeoutMs: 1000, maxAttempts: 1 },
      localFallbackDeps: { discover: async () => [{ pid: 23342, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
    };
    // WHY propositions: atomic units are packed into one request (a text item travels alone), so the escalated request holds several questions.
    const out = await runDecision(spec, { input: { propositions: Array.from({ length: 4 }, (_v, i) => ({ text: `claim ${i}` })) } }, deps);
    const w = out.envelope!.warnings.filter((x) => x.code === "split_piece_failed");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("needs 16460 tokens; the limit is 16384");
    expect(w[0]!.message).toContain("a split piece of 1 question was not answered");
    expect(stderr.filter((l) => l.includes("needs 16460 tokens; the limit is 16384"))).toHaveLength(1);
  });
  // WHY not "by the decider counts": with 2 questions a split by the 422 counts and a split in halves both give [2, 1, 1], so this test cannot tell them apart.
  it("a decider 422 on a two-question local escalation splits it into single questions and answers both (TRDD-5AV8UBL1)", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { spec } = await import("./catalog/filter.js");
    const stderr: string[] = [];
    const sizes: number[] = []; // question count of every request the decider received, in order
    const fetch: GlobalFetch = async (url, init) => {
      if (url.startsWith(DECIDER)) {
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
        const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
        sizes.push(Object.keys(q).length);
        // WHY 20001 > 16384: the refusal names its counts, which is what the split must plan its pieces from
        if (Object.keys(q).length > 1) return new Response(JSON.stringify({ error: { message: "the question with its state needs 20001 tokens; the limit is 16384 and input is not cut", type: "invalid_request_error" } }), { status: 422 });
        const real = (JSON.parse(fx("p01", "dec-noul").body) as { answers: Record<string, unknown> }).answers.is_bug;
        return new Response(JSON.stringify({ model: "elephant-1", answers: Object.fromEntries(Object.keys(q).map((k) => [k, real])), usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
      }
      if (url.includes("output_modalities=decisions")) {
        const body = JSON.parse(fx("p02", "models-decisions").body) as { data: { id: string; description?: string }[] };
        body.data = body.data.filter((m) => m.id.includes("typesafe/") || !/system\s*one/i.test(m.description ?? ""));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
      return syntheticResponse(402, JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { "content-type": "application/json" });
    };
    const deps: RunDeps = {
      settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: KEY_REF, max_attempts: 1, timeout_ms: 5000, concurrency: 1 } as unknown as Profile } },
      fetch,
      catalogOptions: { path: join(tmp, "catalog.json") },
      sigint: new EventEmitter(),
      stderr: (l: string) => { stderr.push(l); },
      localFallback: { requestTimeoutMs: 20_000, attemptTimeoutMs: 2000, startTimeoutMs: 1000, maxAttempts: 1 },
      localFallbackDeps: { discover: async () => [{ pid: 23342, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
    };
    const out = await runDecision(spec, { input: { propositions: Array.from({ length: 2 }, (_v, i) => ({ text: `claim ${i}` })) } }, deps);
    // one escalated 2-question request refused, then each question alone
    expect(sizes).toEqual([2, 1, 1]);
    expect(out.exitCode).toBe(0);
    expect(out.envelope!.warnings.filter((x) => x.code === "split_piece_failed")).toHaveLength(0);
    const decision = out.envelope!.decision as { rows: { id: string }[]; invalid: unknown[] };
    expect(decision.invalid).toEqual([]);
    expect(decision.rows.map((r) => r.id).sort()).toEqual(["proposition_0", "proposition_1"]);
  });
  it("the stderr line and the local_decider warning name the remote 402 message and class", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { spec } = await import("./catalog/filter.js");
    const stderr: string[] = [];
    const fetch: GlobalFetch = async (url, init) => {
      if (url.startsWith(DECIDER)) {
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok", loaded: ["elephant-1"] }), { status: 200 });
        const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
        const real = (JSON.parse(fx("p01", "dec-noul").body) as { answers: Record<string, unknown> }).answers.is_bug;
        return new Response(JSON.stringify({ model: "elephant-1", answers: Object.fromEntries(Object.keys(q).map((k) => [k, real])), usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
      }
      if (url.includes("output_modalities=decisions")) {
        const body = JSON.parse(fx("p02", "models-decisions").body) as { data: { id: string; description?: string }[] };
        body.data = body.data.filter((m) => m.id.includes("typesafe/") || !/system\s*one/i.test(m.description ?? ""));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
      return syntheticResponse(402, JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { "content-type": "application/json" });
    };
    const deps: RunDeps = {
      settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: KEY_REF, max_attempts: 1, timeout_ms: 5000, concurrency: 1 } as unknown as Profile } },
      fetch,
      catalogOptions: { path: join(tmp, "catalog.json") },
      sigint: new EventEmitter(),
      stderr: (l: string) => { stderr.push(l); },
      localFallback: { requestTimeoutMs: 20_000, attemptTimeoutMs: 2000, startTimeoutMs: 1000, maxAttempts: 1 },
      localFallbackDeps: { discover: async () => [{ pid: 23342, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
    };
    const out = await runDecision(spec, { input: { question: "Does it fail?", items: [{ id: "f.log:1", text: "line number 0" }] } }, deps);
    expect(out.exitCode).toBe(0);
    const w = out.envelope!.warnings.find((x) => x.code === "local_decider");
    expect(w).toBeDefined();
    expect(w!.message).toContain("the local decider elephant-1");
    expect(w!.message).toContain("the remote model failed");
    expect(w!.message).toContain("Insufficient credits");
    expect(w!.message).toContain("class payment");
    const line = stderr.find((l) => l.includes("the local decider"));
    expect(line).toBeDefined();
    expect(line).toContain("the remote model failed");
    expect(line).toContain("Insufficient credits");
    expect(line).toContain("class payment");
  });
});
