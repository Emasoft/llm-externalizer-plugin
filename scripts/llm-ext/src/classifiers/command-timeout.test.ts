// Review of 4856f009, finding 4: classify honours --command_timeout like every other request path. Once the command is
// stopping (cli/main.ts armCommandTimeout calls stopCommand at expiry), no new request and no retry is sent, the answers
// already received are kept as a partial result, and the run exits 124. Real catalog, endpoints and decisions replies
// recorded by P-01/P-02, served through the GlobalFetch seam; no network.
// WHY a file of its own and a fresh module graph per test: the stop flag is module state with no reset (a command stops
// once), so it must not leak into the other classify tests or into the next test here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../config.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import type { RunDeps } from "./run-decision.js";

const KEY = "sk-or-v1-CTSECRETKEYVALUE0123456789abcdef0123";
const STOP = "--command_timeout: the command ran longer than 1 s and was stopped";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

/** The real P-01 noul reply, re-labeled to the question keys of the request. */
function relabeled(questions: Record<string, unknown>): Response {
  const rec = fx("p01", "dec-noul");
  const body = JSON.parse(rec.body) as { answers: Record<string, unknown> };
  const real = body.answers.is_bug!;
  body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, real]));
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}

/** Catalog and endpoints from P-02 (Jev the only System One model, so no fallback is tried); `onDecision` answers each decisions request. */
function serve(onDecision: (n: number, questions: Record<string, unknown>) => Response): { fetch: GlobalFetch; decisions: number } {
  const s = { decisions: 0, fetch: (async () => new Response()) as GlobalFetch };
  s.fetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) {
      const body = JSON.parse(fx("p02", "models-decisions").body) as { data: { id: string; description?: string }[] };
      body.data = body.data.filter((m) => m.id.includes("typesafe/") || !/system\s*one/i.test(m.description ?? ""));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    s.decisions++;
    return onDecision(s.decisions, (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
  };
  return s;
}

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  vi.resetModules();
  tmp = mkdtempSync(join("/tmp", "llm-ext-cmd-timeout-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, CT_TEST_KEY: process.env.CT_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.CT_TEST_KEY = KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const deps = (fetch: GlobalFetch, over: Record<string, unknown> = {}): RunDeps => ({
  settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$CT_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 1, ...over } as unknown as Profile } },
  fetch,
  catalogOptions: { path: join(tmp, "catalog.json") },
  sigint: new EventEmitter(),
});
const input = (n: number) => ({ input: { question: "Does it fail?", items: Array.from({ length: n }, (_, k) => ({ id: `f.log:${k + 1}`, text: `line number ${k}` })) } });

describe("classify and --command_timeout", () => {
  it("after the stop no new request is sent: the answers received are kept, the rest are not_sent_timeout, stopped timeout, exit 124", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { stopCommand } = await import("../command-stop.js");
    const { spec } = await import("./catalog/filter.js");
    // The timeout expires while the first request is in flight: that request is answered, the next two never start.
    const s = serve((_n, q) => {
      stopCommand(STOP);
      return relabeled(q);
    });
    const out = await runDecision(spec, input(3), deps(s.fetch));
    expect(s.decisions).toBe(1);
    expect(out.exitCode).toBe(124);
    const env = out.envelope!;
    expect(env.stopped).toBe("timeout");
    expect((env.decision as { matched_count: number }).matched_count).toBe(1);
    const invalid = (env.decision as { invalid: { reason: string }[] }).invalid;
    expect(invalid.map((i) => i.reason)).toEqual([`not_sent_timeout: ${STOP}`, `not_sent_timeout: ${STOP}`]);
    expect(env.warnings.find((w) => w.code === "command-timeout-stop")?.message).toBe("--command_timeout stopped the run: 2 of 3 requests not sent; the answers already received are kept");
    // The partial result is printed: the stdout text is the envelope.
    expect(JSON.parse(out.text!)).toEqual(JSON.parse(JSON.stringify(env)));
  });

  it("a retry is not sent after the stop: a 503 during the timeout ends that request, no second send", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { stopCommand } = await import("../command-stop.js");
    const { spec } = await import("./catalog/filter.js");
    const s = serve(() => {
      stopCommand(STOP);
      return syntheticResponse(503, JSON.stringify({ error: { code: 503, message: "busy" } }), { "content-type": "application/json", "retry-after-ms": "1" });
    });
    const out = await runDecision(spec, input(1), deps(s.fetch, { max_attempts: 3 }));
    expect(s.decisions).toBe(1);
    expect(out.exitCode).toBe(124);
    expect(out.envelope!.stopped).toBe("timeout");
  });

  it("a run that is never stopped is unchanged: every request is sent, stopped null, exit 0", async () => {
    const { runDecision } = await import("./run-decision.js");
    const { spec } = await import("./catalog/filter.js");
    const s = serve((_n, q) => relabeled(q));
    const out = await runDecision(spec, input(3), deps(s.fetch));
    expect(s.decisions).toBe(3);
    expect(out.exitCode).toBe(0);
    expect(out.envelope!.stopped).toBeNull();
  });
});
