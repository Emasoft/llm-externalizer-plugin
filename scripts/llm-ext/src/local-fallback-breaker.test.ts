/**
 * local-fallback-breaker.test.ts — TRDD-WSPV40Y5 (increment 1d): a local-fallback send (options.localFallback) never heals the
 * remote SERVICE_HEALTH breaker. WHY it matters: the breaker is process-global and counts the REMOTE service; a local answer says
 * nothing about it, so healing it on a local success would let the next remote attempt of another command skip the backoff the
 * remote outage earned. The breaker is put at its threshold with the completion.ts test hooks (as local-fallback-dispatch.test.ts
 * does), one REAL request is answered by a REAL node:http server, and the count is read back. A control run without the flag,
 * below the threshold (so it does not wait the 60 s rung), heals to 0: the assertion can fail.
 * Each case reaches a different gated success site in chatCompletionWithRetry (all five): stop with content, length with content,
 * content_filter, length on a request_options profile, and an empty reply. Temp dirs carry the llm-ext-e2e- prefix only.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "./test-tmp-root.js";
import { chatCompletionWithRetry, resetServiceHealthForTests, serviceFailureCountForTests, setServiceFailuresForTests, tripServiceHealthForTests } from "./provider/completion.js";
import type { BackendConfig, CompletionDeps } from "./provider/types.js";
import type { ResolvedRequestOptions } from "./provider/request-options.js";

let server: Server | undefined;
const created: string[] = [];
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  resetServiceHealthForTests();
  vi.unstubAllEnvs();
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A local OpenAI-compatible server answering every POST with one completion of `finish` (streamed or not, as asked). Counts the POSTs. */
async function answeringServer(finish: string, content: string): Promise<{ url: string; posts: () => number }> {
  let posts = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      posts++;
      const stream = (JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { stream?: boolean }).stream === true;
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c1", model: "local-m", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c1", model: "local-m", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "c1", model: "local-m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, posts: () => posts };
}

function depsFor(url: string, ro: ResolvedRequestOptions | null): CompletionDeps {
  const backend: BackendConfig = { type: "local", billable: false, isLocal: true, baseUrl: url, apiKey: "local-key", model: "local-m", __version: 1 };
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => null,
    routeHeaders: () => ({ "Content-Type": "application/json" }),
    getSoftTimeoutMs: () => 10_000,
    isFreeOnly: () => false,
    isLMStudioProvider: () => false,
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }),
    getEnsemblePriceCeilingUsd: () => 1.3,
    defaultTemperature: 0.7,
    getDefaultMaxTokens: () => 64,
    getRequestOptions: () => ro,
  };
}

const STORY = "Once upon a time there was a cat.";
/** Each case reaches a different gated recordServiceSuccess site of chatCompletionWithRetry (provider/completion.ts). */
const CASES: Array<{ name: string; finish: string; content: string; ro: ResolvedRequestOptions | null }> = [
  { name: "stop with content", finish: "stop", content: STORY, ro: null },
  { name: "length with content", finish: "length", content: STORY, ro: null },
  { name: "content_filter", finish: "content_filter", content: STORY, ro: null },
  // On a request_options profile a length reply is an OutputLimitError, after its own gated success site.
  { name: "length on a request_options profile", finish: "length", content: STORY, ro: { maxOutputTokens: 64 } },
  // An empty reply over a working transport: the last gated site, before the empty-response retries.
  { name: "an empty reply", finish: "stop", content: "", ro: null },
];

describe("TRDD-WSPV40Y5: a local-fallback success does not heal the remote SERVICE_HEALTH breaker", () => {
  for (const c of CASES) {
    it(`${c.name}: the breaker stays tripped after a local reply; the same reply without the flag heals it`, async () => {
      vi.stubEnv("LLM_EXT_CONFIG_DIR", (() => {
        const d = mkdtempSync(join(tmpdir(), "llm-ext-e2e-breaker-"));
        created.push(d);
        return d;
      })());
      const s = await answeringServer(c.finish, c.content);
      const deps = depsFor(s.url, c.ro);
      const messages = [{ role: "user" as const, content: "Say hello." }];
      // Whatever the call returns or throws: the subject is the breaker count, not the reply.
      const settle = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);
      // The remote failures counted up to the threshold, as an outage leaves them when the fallback starts.
      tripServiceHealthForTests();
      const tripped = serviceFailureCountForTests();
      expect(tripped).toBeGreaterThan(0);
      const t0 = Date.now();
      await settle(chatCompletionWithRetry(messages, { model: "local-m", retryClock: {}, localFallback: true }, deps));
      expect(Date.now() - t0, "a local send does not wait the breaker rung").toBeLessThan(30_000);
      expect(s.posts(), "the local server answered").toBeGreaterThan(0);
      expect(serviceFailureCountForTests(), "the remote breaker is still tripped after the local reply").toBe(tripped);
      // Control: the same real reply as a REMOTE send heals the breaker. Below the threshold, so it does not wait the 60 s rung.
      setServiceFailuresForTests(tripped - 1);
      await settle(chatCompletionWithRetry(messages, { model: "local-m", retryClock: {} }, deps));
      expect(serviceFailureCountForTests(), "control: a remote reply over a working transport heals").toBe(0);
    }, 120_000);
  }
});
