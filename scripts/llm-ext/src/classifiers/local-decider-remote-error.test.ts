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
      settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$XJE_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 1 } as unknown as Profile } },
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
