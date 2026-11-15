// Review of 3e281b35, finding 9: the paid question of `classify ping` is written to the usage history, so the lifetime totals count it. Real local node:http server; the GlobalFetch only maps the origin.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../../config.js";
import { readHistory } from "../../usage-history.js";
import { runPing } from "./ping.js";

let server: Server;
let base: string;
let tmp: string;
let reply: Record<string, unknown>;
let prev: Record<string, string | undefined>;
beforeEach(async () => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-pinghist-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, PINGH_KEY: process.env.PINGH_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.PINGH_KEY = "k-pinghist";
  reply = { model: "typesafe/jev-1.13-20260917", answers: { ping: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 292, output_tokens: 21, cost: 0.000012264 } };
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "GET" ? JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } }) : JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

const profile = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$PINGH_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2 } as unknown as Profile;
async function ping(argv: string[]): Promise<{ code: number; err: string[] }> {
  const err: string[] = [];
  const code = await runPing(argv, undefined, {
    settings: { active: "c", active_classifier: "c", profiles: { c: profile } },
    fetch: (url, init) => fetch(url.replace("https://openrouter.ai", base), init),
    stdout: () => {},
    stderr: (l) => err.push(l),
    // WHY the local decider is OFF here: these tests pin the usage history of a REMOTE ping, and a local answer
    // would write a different endpoint. WHY off explicitly and not merely left out: an absent section means
    // ENABLED by default, so a failing remote call would reach — or start — the real 15 GB decider.
    localFallback: { enabled: false },
  });
  return { code, err };
}

describe("classify ping usage history", () => {
  it("records the question with its measured cost and input tokens", async () => {
    expect((await ping([])).code).toBe(0);
    const h = readHistory();
    expect(h).toHaveLength(1);
    // WHY toContain and a rounded cost: the history line writes the tool with its params in parentheses and the cost to 6 decimals.
    expect(h[0]!.tool).toContain("cli:classify-ping");
    expect(h[0]).toMatchObject({ endpoint: "decisions", inputTokens: 292, ok: true });
    expect(h[0]!.costUsd).toBeCloseTo(0.000012, 6);
  });
  it("records nothing when --no-call sends no question", async () => {
    expect((await ping(["--no-call"])).code).toBe(0);
    expect(readHistory()).toEqual([]);
  });
  it("a billed but unusable reply is recorded as a failed request and ping fails", async () => {
    reply = { ...reply, answers: {} };
    const r = await ping([]);
    expect(r.code).not.toBe(0);
    const h = readHistory();
    expect(h).toHaveLength(1);
    expect(h[0]!.ok).toBe(false);
  });
  it("a reply with no cost writes no history entry and says so on stderr", async () => {
    reply = { ...reply, usage: { input_tokens: 292, output_tokens: 21 } };
    const r = await ping([]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("cost unknown; not added to the usage history");
    expect(readHistory()).toEqual([]);
  });
  it("a history that cannot be written exits 1 with a message that is not a service failure", async () => {
    // A directory where history.log should be makes the append fail with EISDIR.
    mkdirSync(join(tmp, "history.log"));
    const r = await ping([]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/the decisions service answered, but the usage history could not be written: .*EISDIR/);
    expect(r.err.join("\n")).not.toMatch(/ping failed/);
  });
});
