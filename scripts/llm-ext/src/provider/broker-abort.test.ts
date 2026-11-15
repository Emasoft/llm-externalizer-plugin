/**
 * TRDD-3SNQAGIC (local racers): a caller abort reaches a request that goes through the local-model broker.
 *
 * WHY this file: sendChat used to call brokerExchange without the caller signal, so an aborted local racer kept
 * its broker job queued or running (a governor lease and the local server held for a result nobody reads). Real
 * throughout: a node:http server on 127.0.0.1 stands in for the broker (real sockets), and the request goes through
 * the real chatCompletionWithRetry, resolveConnection, sendChat and brokerExchange. Nothing of ours is mocked.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import { chatCompletionSimple, chatCompletionWithRetry } from "./completion.js";
import type { BackendConfig, CompletionDeps } from "./types.js";

let root = "";
const saved: Record<string, string | undefined> = {};
const servers: Server[] = [];

beforeAll(() => {
  // The FAIL history line and every other config write go to a throwaway dir, never the user config.
  root = mkdtempSync(join(tmpdir(), "broker-abort-"));
  for (const k of ["LLM_EXT_CONFIG_DIR", "LLM_EXT_DUMP_REQUESTS"]) saved[k] = process.env[k];
  process.env.LLM_EXT_CONFIG_DIR = root;
  delete process.env.LLM_EXT_DUMP_REQUESTS;
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** A fake broker: POST /v1/jobs accepts job "j1" (when `onPost` calls accept, else at once); a poll is answered by `onPoll`; DELETE is recorded. */
async function fakeBroker(onPoll: (res: ServerResponse) => void, onPost?: (accept: () => void) => void): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
    req.resume();
    if (req.method === "POST" && req.url === "/v1/jobs") {
      const accept = (): void => {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ job: "j1", state: "queued" }));
      };
      if (onPost) onPost(accept);
      else accept();
    } else if (req.method === "GET" && req.url?.startsWith("/v1/jobs/j1")) {
      onPoll(res);
    } else if (req.method === "DELETE" && req.url === "/v1/jobs/j1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, seen };
}

function brokerDeps(url: string): CompletionDeps {
  const backend: BackendConfig = { type: "local", billable: false, isLocal: true, baseUrl: url, apiKey: "k", model: "m", __version: 1 };
  const h = (): Record<string, string> => ({ "Content-Type": "application/json" });
  return {
    getBackend: () => backend,
    apiHeaders: h,
    routeForModel: () => null,
    routeHeaders: h,
    getSoftTimeoutMs: () => 30_000,
    isFreeOnly: () => false,
    isLMStudioProvider: () => false,
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }),
    getEnsemblePriceCeilingUsd: () => 1,
    defaultTemperature: 0,
    getDefaultMaxTokens: () => 16,
    getRequestOptions: () => null,
    localBroker: () => Promise.resolve({ url, token: "t", pid: process.pid, engine: "llama", ctx: 0, reconnect: () => Promise.reject(new Error("no broker")) }),
  };
}

const failLines = (): string[] => {
  const p = join(root, "history.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.includes(" - FAIL - ")) : [];
};

describe("a caller abort on a broker request (TRDD-3SNQAGIC)", () => {
  it("control: a broker job that fails is a FAIL history line, so the check below can see one", async () => {
    const broker = await fakeBroker((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "failed", submittedAt: Date.now(), error: "model crashed" }));
    });
    const before = failLines().length;
    await expect(chatCompletionSimple([{ role: "user", content: "hi" }], { model: "m" }, brokerDeps(broker.url))).rejects.toThrow(/model crashed/);
    expect(failLines().length).toBe(before + 1);
  }, 30_000);

  it("an abort while the job is polled cancels the job at the broker (DELETE) and is no failure: the abort reason, one POST, no FAIL line", async () => {
    const ac = new AbortController();
    const reason = new Error("racer lost: the winner committed the chunk");
    // The poll is held open (a job still queued or running at the broker); the caller aborts while it waits.
    const broker = await fakeBroker(() => ac.abort(reason));
    const before = failLines().length;
    const call = chatCompletionWithRetry([{ role: "user", content: "hi" }], { model: "m", signal: ac.signal }, brokerDeps(broker.url));
    await expect(call).rejects.toBe(reason);
    // brokerExchange awaits its own DELETE in its finally, so the broker has seen it when the call rejects.
    expect(broker.seen).toEqual(["POST /v1/jobs", "GET /v1/jobs/j1", "DELETE /v1/jobs/j1"]);
    expect(failLines().length).toBe(before);
  }, 30_000);

  it("an abort while the broker POST is outstanding still cancels the accepted job (DELETE) and is no failure: no poll, the abort reason, no FAIL line", async () => {
    const ac = new AbortController();
    const reason = new Error("racer lost during submit");
    // The broker has the request but has not answered 202 yet when the caller aborts; it answers 50 ms later.
    const broker = await fakeBroker(
      (res) => {
        // No poll is expected; one would show in `seen` and fail the toEqual below.
        res.writeHead(500);
        res.end();
      },
      (accept) => {
        ac.abort(reason);
        setTimeout(accept, 50);
      },
    );
    const before = failLines().length;
    const call = chatCompletionWithRetry([{ role: "user", content: "hi" }], { model: "m", signal: ac.signal }, brokerDeps(broker.url));
    await expect(call).rejects.toBe(reason);
    // WHY DELETE is expected: an abort that cut the POST would leave the client without the id, and the broker abandon
    // rule drops only queued jobs, so a dispatched one would keep the local server busy (broker/client.ts POST comment).
    expect(broker.seen).toEqual(["POST /v1/jobs", "DELETE /v1/jobs/j1"]);
    expect(failLines().length).toBe(before);
  }, 30_000);
});
