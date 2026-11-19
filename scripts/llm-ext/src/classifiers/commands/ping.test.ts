// C4-07 (TRDD-MVT4DCHS): `classify ping` against a real local node:http server. The only seam is the GlobalFetch the command already takes; it maps https://openrouter.ai to the server, so the real transport, headers, body and parser run and no request leaves the machine.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../../config.js";
import { classifyArgv, GROUPS } from "../../cli/launcher.js";
import { buildTools } from "../../tools/definitions.js";
import { __resetLocalFallbackForTests } from "../l2/local-fallback.js";
import { KEY_URL, type GlobalFetch } from "../l0/transport.js";
import { PING_LOCAL_REQUEST_TIMEOUT_MS, runPing } from "./ping.js";
import { PING_TOOL_NAME } from "./ping-flags.js";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const LABEL = "sk-or-v1-012...def-label-must-not-print";

interface Seen { method: string; url: string; auth: string | undefined; body: string }
let server: Server;
let base: string;
let seen: Seen[];
// What the decisions route answers: the usable answer by default, or a 200 reply that has none.
let answers: Record<string, unknown>;
let prevKey: string | undefined;

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

beforeEach(async () => {
  seen = [];
  answers = { ping: { type: "noul", noul: 0.94 } };
  prevKey = process.env.PING_TEST_KEY;
  process.env.PING_TEST_KEY = KEY;
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const json = (status: number, v: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { code: 401, message: "No auth credentials found" } }); // ubs:ignore the test server compares the fake test key, not a secret; timing is irrelevant
      if (req.method === "GET" && req.url === "/api/v1/key") return json(200, { data: { label: LABEL, usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } });
      if (req.method === "POST" && req.url === "/api/alpha/decisions") return json(200, { model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 292, output_tokens: 21, cost: 0.000012264 } });
      return json(404, { error: { code: 404, message: "no such route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (prevKey === undefined) delete process.env.PING_TEST_KEY; else process.env.PING_TEST_KEY = prevKey;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const profile = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$PING_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2 } as unknown as Profile; // ubs:ignore env-var reference, not a secret

async function ping(argv: string[], profileFlag?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPing(argv, profileFlag, {
    settings: { active: "c", active_classifier: "c", profiles: { c: profile } },
    fetch: (url, init) => fetch(url.replace("https://openrouter.ai", base), init),
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
    // WHY the local decider is OFF here: these tests pin the remote key check and the one paid question, and a
    // fallback answer would mask them. WHY off explicitly and not merely left out: an absent section means
    // ENABLED by default, so a test whose remote call fails would reach — or start — the real 15 GB decider.
    localFallback: { enabled: false },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("classify ping", () => {
  it("a good key: the free GET, then one noul question; exit 0; the key and the key label are never printed", async () => {
    const r = await ping([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("key check: ok");
    expect(r.out).toContain("spent 1.5 USD, limit 10 USD, 8.5 USD left");
    expect(r.out).toContain("decision call: ok");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /api/v1/key", "POST /api/alpha/decisions"]);
    expect(seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
    const sent = JSON.parse(seen[1]!.body) as { model: string; questions: Record<string, { type: string }> };
    expect(sent.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(sent.questions)).toEqual(["ping"]);
    expect(sent.questions.ping!.type).toBe("noul");
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("label-must-not-print");
    }
  });

  it("--no-call (also spelled --no_call) makes no question: only the GET reaches the server", async () => {
    for (const spelling of ["--no-call", ...classifyArgv(["--no_call"])]) {
      seen = [];
      const r = await ping([spelling]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("decision call: skipped (--no-call)");
      // TRDD-VUPK2NM7: the output must say the credit balance was not checked, so "ok" is not read as "remote calls will work".
      expect(r.out).toContain("the key was accepted, but the credit balance and the model call are not checked: run without --no-call to test a real call");
      expect(seen.map((s) => s.method)).toEqual(["GET"]);
    }
  });

  it("a rejected key (401) exits 3 at the free step, sends no question, and does not print the bad key", async () => {
    process.env.PING_TEST_KEY = "sk-or-v1-wrong-key-wrong-key-wrong-key-0000";
    const r = await ping([]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("classify ping failed: API error 401");
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    expect(r.out + r.err).not.toContain("wrong-key-wrong-key");
  });

  it("an unset key variable exits 3 naming the variable and sends nothing", async () => {
    delete process.env.PING_TEST_KEY;
    const r = await ping([]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("PING_TEST_KEY");
    expect(seen).toEqual([]);
  });

  it("asks the unambiguous fixed question and prints the expected side beside the answer (quality eval of run 20261031_191133)", async () => {
    const r = await ping([]);
    expect(r.code).toBe(0);
    const sent = JSON.parse(seen[1]!.body) as { state: unknown; questions: { ping: { instructions: string } } };
    // WHY literals, not the exported constants: a test comparing the constant with itself cannot catch the question being changed back.
    expect(sent.state).toBe("Water boils at 100 degrees Celsius at sea level.");
    expect(sent.questions.ping.instructions).toBe("Does `state` say that water boils at 100 degrees Celsius at sea level?");
    expect(r.out).toContain("answer 0.94, expected above 0.5,");
    expect(r.err).not.toContain("warning: the ping answer");
  });
  it("an answer below the expected side warns on stderr and still exits 0: ping is a round-trip check", async () => {
    answers = { ping: { type: "noul", noul: 0.2 } };
    const r = await ping([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("decision call: ok");
    expect(r.err).toContain("warning: the ping answer 0.2 is below the expected 0.5");
  });
  it("a 200 decisions reply with no usable ping answer exits 5", async () => {
    answers = { other: { type: "noul", noul: 0.5 } };
    const r = await ping([]);
    expect(r.code).toBe(5);
    expect(r.err).toContain("no usable answer");
  });

  it("an unknown option and an unknown profile exit 1 before any request", async () => {
    expect((await ping(["--bogus"])).code).toBe(1);
    const p = await ping([], "nope");
    expect(p.code).toBe(1);
    expect(p.err).toContain("unknown profile");
    expect(seen).toEqual([]);
  });
});

describe("classify ping — the local fallback budget", () => {
  it("a remote failure followed by a not-ready local decider ends after 30 s, not after the configured 400 s", async () => {
    expect(PING_LOCAL_REQUEST_TIMEOUT_MS).toBe(30000);
    // All in memory (no real socket): the key check answers, the decisions call fails, every loopback url is refused,
    // and the scan finds nothing while the install check says a singleton may still appear, so the lookup keeps
    // retrying until its budget ends. The clock is fake, so the 30 s cost no real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    __resetLocalFallbackForTests();
    try {
      const longProfile = { ...profile, timeout_ms: 120000 } as unknown as Profile;
      const fetchImpl: GlobalFetch = async (url) => {
        if (url === KEY_URL) return new Response(JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } }), { status: 200 });
        if (url.startsWith("https://openrouter.ai/")) return new Response(JSON.stringify({ error: { code: 500, message: "boom" } }), { status: 500 });
        throw new Error("connect ECONNREFUSED");
      };
      const err: string[] = [];
      let done = false;
      const p = runPing([], undefined, {
        settings: { active: "c", active_classifier: "c", profiles: { c: longProfile } },
        fetch: fetchImpl,
        stdout: () => {},
        stderr: (l) => err.push(l),
        // An empty section: the defaults, which carry the 400 s requestTimeoutMs the 30 s cap must beat.
        localFallback: {},
        localFallbackDeps: { discover: async () => [], platform: "darwin", singletonInstalled: () => true },
      });
      void p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(done).toBe(true);
      expect(await p).not.toBe(0);
      expect(err.join("\n")).toContain("the local decider fallback did not answer either");
    } finally {
      vi.useRealTimers();
      __resetLocalFallbackForTests();
    }
  });

  // TRDD-O93LFMF3: the deadline stays the outcome, but the remote error must reach the user.
  it("a remote failure whose local escalation outlasts the deadline still ends as a deadline error, and says why the remote call failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    __resetLocalFallbackForTests();
    try {
      // The deadline (10 s) is shorter than the 30 s local escalation, which keeps retrying while no decider appears.
      const shortProfile = { ...profile, timeout_ms: 10000 } as unknown as Profile;
      const fetchImpl: GlobalFetch = async (url) => {
        if (url === KEY_URL) return new Response(JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } }), { status: 200 });
        if (url.startsWith("https://openrouter.ai/")) return new Response(JSON.stringify({ error: { code: 500, message: "remote-marker-boom" } }), { status: 500 });
        throw new Error("connect ECONNREFUSED");
      };
      const err: string[] = [];
      const p = runPing([], undefined, {
        settings: { active: "c", active_classifier: "c", profiles: { c: shortProfile } },
        fetch: fetchImpl,
        stdout: () => {},
        stderr: (l) => err.push(l),
        localFallback: {},
        localFallbackDeps: { discover: async () => [], platform: "darwin", singletonInstalled: () => true },
      });
      // WHY a settle loop, not one fixed advance: the remote retry timing is not what this test pins, so the clock is stepped until the run ends (capped).
      let settled = false;
      const run = p.then((c) => { settled = true; return c; }, (e: unknown) => { settled = true; throw e; });
      for (let step = 0; step < 180 && !settled; step++) await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      expect(await run).toBe(5);
      const text = err.join("\n");
      // The outcome is unchanged: the deadline error ends the run.
      expect(text).toContain("classify ping failed: deadline exceeded");
      // The remote error is no longer lost.
      expect(text).toContain("the remote call had failed before the deadline ran out");
      expect(text).toContain("remote-marker-boom");
      // The remote reason is said before the deadline error that ends the run.
      expect(text.indexOf("the remote call had failed before the deadline ran out")).toBeLessThan(text.indexOf("classify ping failed: deadline exceeded"));
    } finally {
      vi.useRealTimers();
      __resetLocalFallbackForTests();
    }
  });
});
describe("classify ping registration", () => {
  it("is an action of the classify group, a classifier-only tool, and --no-call is a boolean that takes no value", () => {
    expect(GROUPS.classify!.ping).toEqual({ command: PING_TOOL_NAME });
    const tool = (buildTools("") as Array<{ name: string; acceptedProfileTypes: readonly string[]; inputSchema: { properties: Record<string, { type: string }> } }>).find((t) => t.name === PING_TOOL_NAME)!;
    expect(tool.acceptedProfileTypes).toEqual(["classifier"]);
    expect(tool.inputSchema.properties.no_call!.type).toBe("boolean");
    expect(classifyArgv(["--no_call", "--profile", "c"])).toEqual(["--no-call", "--profile", "c"]);
  });
});
