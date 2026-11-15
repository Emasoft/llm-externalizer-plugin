import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalDecider, localFallbackErrors, singletonInstalledAt, type LocalDeciderConfig, type LocalDeciderDeps } from "./local-decider.js";
import type { GlobalFetch } from "../l0/transport.js";
import { isDeciderServerCommand, listenersOf, parseLsofListeners } from "./local-discovery.js";

/**
 * The adopt-only rules of the local decider (TRDD-O93LFMF3): llm-ext finds the one mlx-decision singleton or
 * refuses, and never starts a server. Two kinds of test, neither of which reaches the real machine:
 * - REAL loopback HTTP against a server the test itself creates on a free port (adopt / wait / abort), with the
 *   process scan, the platform and the install check always injected;
 * - an injected fetch that answers per url (everything that needs a specific shape of /health answer, such as a
 *   404 or a non-JSON body, or the singleton well-known port, which no test may open for real).
 * WHY discovery, platform and install check are pinned in deps(): production scans the real process table and
 * disk, so a test that left any out would adopt whichever singleton runs on the machine running it, which is
 * nondeterministic and the reason assertions once failed only when a real server existed.
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

/** A loopback decider whose `loaded` list the Nth request decides, so a test can move it from [] to a model. */
async function serveLoaded(loadedFor: (hit: number) => unknown): Promise<{ baseUrl: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", loaded: loadedFor(hits) }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, hits: () => hits };
}

/** A port nothing listens on: bind, record the number, close. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function cfg(overrides: Partial<LocalDeciderConfig> = {}): LocalDeciderConfig {
  return {
    enabled: true,
    url: "http://127.0.0.1:57455",
    startTimeoutMs: 5000,
    attemptTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxAttempts: 1,
    ...overrides,
  };
}

function deps(overrides: Partial<LocalDeciderDeps> = {}): LocalDeciderDeps {
  return {
    fetch,
    now: () => Date.now(),
    discover: async () => [],
    platform: "darwin",
    singletonInstalled: () => false,
    ...overrides,
  };
}

/** An answer of the injected fetch: a status and a body, or a refused connection. */
type Reply = { status?: number; body: string } | "refused";

/** A fetch that answers per url and records every url asked; an unlisted url is a refused connection. */
function fakeFetch(routes: Record<string, Reply>, seen: string[] = []): GlobalFetch {
  return async (url) => {
    seen.push(url);
    const reply = routes[url];
    if (reply === undefined || reply === "refused") throw new Error("connect ECONNREFUSED");
    return new Response(reply.body, { status: reply.status ?? 200 });
  };
}

const health = (loaded: unknown): Reply => ({ body: JSON.stringify({ status: "ok", loaded }) });

/** A clock that jumps 2000 ms per reading, so a wait with a short startTimeoutMs ends on its second reading with no real sleep. */
function jumpingNow(): () => number {
  let t = 0;
  return () => (t += 2000);
}

const CFG_URL = "http://127.0.0.1:57455";
const SINGLETON_URL = "http://127.0.0.1:8123";

describe("localFallbackErrors", () => {
  it("accepts absent, and the full valid block at both ends of every range", () => {
    expect(localFallbackErrors(undefined)).toEqual([]);
    expect(localFallbackErrors(null)).toEqual([]);
    expect(localFallbackErrors({ enabled: false, url: "http://127.0.0.1:57455", startTimeoutMs: 1000, attemptTimeoutMs: 1000, requestTimeoutMs: 1000, maxAttempts: 1 })).toEqual([]);
    expect(localFallbackErrors({ enabled: true, url: "http://localhost:8080", startTimeoutMs: 900000, attemptTimeoutMs: 600000, requestTimeoutMs: 600000, maxAttempts: 100 })).toEqual([]);
  });

  it("refuses a non-mapping block", () => {
    expect(localFallbackErrors([1])).toEqual(["local_fallback must be a mapping of enabled, url, startTimeoutMs, attemptTimeoutMs, requestTimeoutMs, maxAttempts, got [1]"]);
    expect(localFallbackErrors(7)).toEqual(["local_fallback must be a mapping of enabled, url, startTimeoutMs, attemptTimeoutMs, requestTimeoutMs, maxAttempts, got 7"]);
  });

  it("refuses an unknown key by name", () => {
    expect(localFallbackErrors({ urlz: "http://127.0.0.1:1" })).toEqual(["local_fallback.urlz is not a known key (known: enabled, url, startTimeoutMs, attemptTimeoutMs, requestTimeoutMs, maxAttempts)"]);
  });

  it("refuses the keys of the retired start path: nothing is started, so nothing is configured for it", () => {
    // They never shipped in a tag, so there is no migration: a settings.yaml that still carries one fails loudly.
    for (const key of ["contextTokens", "minFreeMemoryGb", "maxCpuLoad"]) {
      const errors = localFallbackErrors({ [key]: 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`local_fallback.${key} was removed: llm-ext no longer starts the mlx-decision decider`);
    }
  });

  it("refuses a non-boolean enabled", () => {
    expect(localFallbackErrors({ enabled: "yes" })).toEqual(["local_fallback.enabled must be true or false, got \"yes\""]);
  });

  it("refuses a non-loopback url with the exact refusal wording", () => {
    expect(localFallbackErrors({ url: "https://decider.example.com:443" })).toEqual([
      // WHY: config.ts (23f70d87, TRDD-O93LFMF3) deliberately widened the wording: the url must also carry no path, query or
      // fragment, because local-transport appends /v1/systemone itself. The assertion pins that exact current text.
      "local_fallback.url must be http://127.0.0.1:<port> or http://localhost:<port> with no path, query or fragment (llm-ext appends /v1/systemone itself) — refused: not a loopback decider url, got \"https://decider.example.com:443\"",
    ]);
    expect(localFallbackErrors({ url: "http://192.168.1.5:57455" })).toHaveLength(1);
  });

  it("refuses a url whose real host is remote, however loopback its prefix looks", () => {
    // The prefix test this replaced accepted both: RFC 3986 reads everything before `@` as userinfo, so the real
    // host is evil.example.com and the state would leave the machine with no Authorization header at all.
    for (const url of ["http://127.0.0.1:57455@evil.example.com", "http://localhost:80@evil.example.com"]) {
      const errors = localFallbackErrors({ url });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("refused: not a loopback decider url");
    }
  });

  it("refuses a url with no port and a url on port 0", () => {
    // A portless url names no server to adopt and port 0 is an ephemeral port nothing can reach, so accepting
    // either here would only move the failure later, after the config was declared valid.
    for (const url of ["http://127.0.0.1:", "http://localhost:", "http://127.0.0.1:0", "http://localhost:0"]) {
      expect(localFallbackErrors({ url })).toHaveLength(1);
    }
  });

  it("accepts the loopback spellings a URL parser normalizes, and only those", () => {
    // The first two are the two canonical spellings and were accepted before. The last three are WIDER than the
    // prefix pattern this replaced, on purpose: all three really are 127.0.0.1/localhost once a parser normalizes
    // them. Pinned so that a future reader who sees the numeric form accepted knows it is intended, not a bypass.
    for (const url of ["http://127.0.0.1:57455", "http://localhost:57455", "HTTP://LOCALHOST:57455", "http://2130706433:57455", "http://127.1:57455"]) {
      expect(localFallbackErrors({ url })).toEqual([]);
    }
    // Still refused: other loopback-range aliases and the wider isLoopbackUrl set, which this section does not promise.
    for (const url of ["http://127.0.0.2:57455", "http://[::1]:57455", "http://0.0.0.0:57455", "https://127.0.0.1:57455", "http://localhost"]) {
      expect(localFallbackErrors({ url })).toHaveLength(1);
    }
  });

  it("refuses an out-of-range integer", () => {
    expect(localFallbackErrors({ startTimeoutMs: 999 })).toEqual(["local_fallback.startTimeoutMs must be an integer from 1000 to 900000, got 999"]);
    expect(localFallbackErrors({ startTimeoutMs: 900001 })).toHaveLength(1);
    expect(localFallbackErrors({ attemptTimeoutMs: 999 })).toHaveLength(1);
    expect(localFallbackErrors({ requestTimeoutMs: 600001 })).toHaveLength(1);
    expect(localFallbackErrors({ maxAttempts: 0 })).toEqual(["local_fallback.maxAttempts must be an integer from 1 to 100, got 0"]);
    expect(localFallbackErrors({ maxAttempts: 101 })).toHaveLength(1);
    expect(localFallbackErrors({ startTimeoutMs: 1500.5 })).toHaveLength(1);
  });
});

describe("localFallbackErrors — removed keys and the absent start/request cross-check", () => {
  it("a requestTimeoutMs below the default startTimeoutMs, or a startTimeoutMs above the default requestTimeoutMs, is NOT an error", () => {
    // Defaults merge first, so a cross-check would fail the settings load on a key the user never wrote. The outer
    // deadline cuts the load wait anyway: the effective wait is min(startTimeoutMs, the remaining request budget).
    expect(localFallbackErrors({ requestTimeoutMs: 100000, attemptTimeoutMs: 50000 })).toEqual([]);
    expect(localFallbackErrors({ startTimeoutMs: 450000 })).toEqual([]);
    expect(localFallbackErrors({ startTimeoutMs: 500000, requestTimeoutMs: 400000 })).toEqual([]);
  });

  it("a removed key is refused with a message that says it was removed, not that it is a typo", () => {
    expect(localFallbackErrors({ maxCpuLoad: 90 })).toEqual([
      "local_fallback.maxCpuLoad was removed: llm-ext no longer starts the mlx-decision decider, so this setting has no effect — delete it from settings.yaml (known: enabled, url, startTimeoutMs, attemptTimeoutMs, requestTimeoutMs, maxAttempts)",
    ]);
  });
});

describe("singletonInstalledAt — the production install check, over a temp HOME and PATH", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A fresh HOME and a fresh bin directory, both empty. */
  function fresh(): { home: string; bin: string } {
    const root = mkdtempSync(join(tmpdir(), "llm-ext-installed-"));
    roots.push(root);
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    return { home, bin };
  }
  function launchAgents(home: string): string {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("the binary as a regular file on PATH is installed", () => {
    const { home, bin } = fresh();
    writeFileSync(join(bin, "mlx-decision"), "#!/bin/sh\n");
    expect(singletonInstalledAt(home, `/nonexistent-dir:${bin}`)).toBe(true);
  });

  it("a DIRECTORY named mlx-decision on PATH is not a binary", () => {
    const { home, bin } = fresh();
    mkdirSync(join(bin, "mlx-decision"));
    expect(singletonInstalledAt(home, bin)).toBe(false);
  });

  it("a LaunchAgent .plist naming mlx-decision is installed", () => {
    const { home, bin } = fresh();
    writeFileSync(join(launchAgents(home), "com.example.mlx-decision.plist"), "<plist/>");
    expect(singletonInstalledAt(home, bin)).toBe(true);
  });

  it("neither a binary nor a LaunchAgents directory is not installed", () => {
    const { home, bin } = fresh();
    expect(singletonInstalledAt(home, bin)).toBe(false);
  });

  it("a .plist.bak or an unrelated plist alone is not installed: launchd never loads them", () => {
    const { home, bin } = fresh();
    const dir = launchAgents(home);
    writeFileSync(join(dir, "com.example.mlx-decision.plist.bak"), "<plist/>");
    writeFileSync(join(dir, "com.example.other.plist"), "<plist/>");
    expect(singletonInstalledAt(home, bin)).toBe(false);
  });
});

describe("ensureLocalDecider — a discovered server that recovers", () => {
  it("answers 503, then a non-JSON page, each a RETRYABLE refusal, and is adopted once it answers healthy", async () => {
    const answers: Reply[] = [{ status: 503, body: "starting" }, { body: "<html>warming up</html>" }, health(["elephant-1"])];
    const asked: string[] = [];
    const f: GlobalFetch = async (url) => {
      asked.push(url);
      if (url !== `${SINGLETON_URL}/health`) throw new Error("connect ECONNREFUSED");
      const reply = answers.shift();
      if (reply === undefined || reply === "refused") throw new Error("connect ECONNREFUSED");
      return new Response(reply.body, { status: reply.status ?? 200 });
    };
    const d = deps({ fetch: f, discover: async () => [{ pid: 23342, urls: [SINGLETON_URL] }] });
    const first = await ensureLocalDecider(cfg({ url: CFG_URL }), d);
    expect(first).toMatchObject({ ok: false, retryable: true });
    const second = await ensureLocalDecider(cfg({ url: CFG_URL }), d);
    expect(second).toMatchObject({ ok: false, retryable: true });
    const third = await ensureLocalDecider(cfg({ url: CFG_URL }), d);
    expect(third).toEqual({ ok: true, baseUrl: SINGLETON_URL });
    expect(answers).toHaveLength(0);
  });
});
describe("ensureLocalDecider — the configured url", () => {
  it("a server answering 2xx with the model loaded is adopted at once", async () => {
    const { baseUrl, hits } = await serveLoaded(() => ["elephant-1"]);
    const result = await ensureLocalDecider(cfg({ url: baseUrl }), deps());
    expect(result).toEqual({ ok: true, baseUrl });
    expect(hits()).toBe(1);
  });

  it("a 200 with loaded: [] is NOT readiness: it keeps polling until the model appears", async () => {
    const { baseUrl, hits } = await serveLoaded((n) => (n < 3 ? [] : ["elephant-1"]));
    const result = await ensureLocalDecider(cfg({ url: baseUrl }), deps());
    expect(result).toEqual({ ok: true, baseUrl });
    expect(hits()).toBeGreaterThanOrEqual(3);
  }, 10_000);

  it("a decider that never finishes loading is a RETRYABLE refusal (the singleton is still loading), not a replacement", async () => {
    const seen: string[] = [];
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL, startTimeoutMs: 1000 }),
      deps({ fetch: fakeFetch({ [`${CFG_URL}/health`]: health([]) }, seen), now: jumpingNow() }),
    );
    expect(result).toEqual({ ok: false, retryable: true, reason: `the mlx-decision server on ${CFG_URL} is still loading its model after 1000 ms: llm-ext never starts or replaces it` });
  });

  it("a decider serving ANOTHER model is a non-retryable refusal naming the model and the singleton rule", async () => {
    const result = await ensureLocalDecider(cfg({ url: CFG_URL }), deps({ fetch: fakeFetch({ [`${CFG_URL}/health`]: health(["some-other-model"]) }) }));
    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: `the mlx-decision server on ${CFG_URL} serves some-other-model, not elephant-1: the singleton must serve elephant-1; llm-ext never starts or replaces it, so this run cannot use it`,
    });
  });

  it("an aborted signal ends the wait instead of polling out the timeout", async () => {
    const { baseUrl } = await serveLoaded(() => []);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await ensureLocalDecider(cfg({ url: baseUrl, startTimeoutMs: 60_000 }), deps({ signal: controller.signal }));
    // WHY detail: the budget ending mid-wait must still say WHAT was being waited for (the singleton was up, just slow).
    expect(result).toMatchObject({ ok: false, reason: "the local decider lookup was aborted", retryable: false, aborted: true });
    expect((result as { detail?: string }).detail).toContain(`the mlx-decision server on ${baseUrl} was still loading its model`);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15_000);

  it("a signal aborted while the first probe is in flight never reaches the scan", async () => {
    // The abort hole this pins: the signal is cancelled WHILE the first /health probe is in flight. The probe
    // aborted signal is indistinguishable from an unreachable port (probeHealth maps both to unreachable), so
    // without a re-check after that probe the lookup would go on to scan for an already-cancelled request.
    const controller = new AbortController();
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      controller.abort();
      // Never answer: the aborted fetch rejects on its own.
      res.on("close", () => {
        /* the client hung up */
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    let scans = 0;
    const result = await ensureLocalDecider(
      cfg({ url: `http://127.0.0.1:${port}` }),
      deps({
        signal: controller.signal,
        discover: async () => {
          scans++;
          return [];
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "the local decider lookup was aborted", retryable: false, aborted: true });
    expect(hits).toBe(1);
    expect(scans).toBe(0);
  }, 10_000);
});

describe("ensureLocalDecider — what counts as a decider at the configured url", () => {
  it("a 404 at the configured url is no decider: the scan finds the singleton on another port and it is adopted", async () => {
    // The bug this pins: any HTTP answer used to mean "a decider holds this port", so a 404 from another program
    // on the configured port hid the real singleton, which listens elsewhere.
    const scanned: string[] = [];
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({ [`${CFG_URL}/health`]: { status: 404, body: "not found" }, [`${SINGLETON_URL}/health`]: health(["elephant-1"]) }, scanned),
        discover: async () => [{ pid: 23342, urls: [SINGLETON_URL] }],
      }),
    );
    expect(result).toEqual({ ok: true, baseUrl: SINGLETON_URL });
    expect(scanned).toEqual([`${CFG_URL}/health`, `${SINGLETON_URL}/health`]);
  });

  it("a 200 with a non-JSON body is no decider: the scan is used", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({ [`${CFG_URL}/health`]: { body: "<html>hello</html>" }, [`${SINGLETON_URL}/health`]: health(["elephant-1"]) }),
        discover: async () => [{ pid: 1, urls: [SINGLETON_URL] }],
      }),
    );
    expect(result).toEqual({ ok: true, baseUrl: SINGLETON_URL });
  });

  it("a JSON body without a loaded array is no decider: the scan is used", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({ [`${CFG_URL}/health`]: { body: JSON.stringify({ status: "ok" }) }, [`${SINGLETON_URL}/health`]: health(["elephant-1"]) }),
        discover: async () => [{ pid: 1, urls: [SINGLETON_URL] }],
      }),
    );
    expect(result).toEqual({ ok: true, baseUrl: SINGLETON_URL });
  });

  it("a decider-shaped body behind a 500 is no decider: only 2xx counts", async () => {
    const { baseUrl } = await (async () => {
      const server = createServer((_req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ loaded: ["elephant-1"] }));
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
    })();
    const result = await ensureLocalDecider(cfg({ url: baseUrl }), deps());
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});

describe("ensureLocalDecider — nothing found anywhere", () => {
  it("an empty scan with an installed singleton is a RETRYABLE refusal: the singleton may be restarting", async () => {
    const result = await ensureLocalDecider(cfg({ url: CFG_URL }), deps({ fetch: fakeFetch({}), singletonInstalled: () => true }));
    expect(result).toEqual({ ok: false, retryable: true, reason: "no mlx-decision server is running yet (the singleton may be restarting); llm-ext never starts one" });
  });

  it("an empty scan with no singleton installed is a NON-retryable refusal that says to install it", async () => {
    const result = await ensureLocalDecider(cfg({ url: CFG_URL }), deps({ fetch: fakeFetch({}), singletonInstalled: () => false }));
    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: "mlx-decision is not installed and no singleton server is running; llm-ext never starts one — install mlx-decision and its login agent",
    });
  });

  it("an install check that throws is a non-retryable refusal, never a throw", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({}),
        singletonInstalled: () => {
          throw new Error("EACCES: LaunchAgents");
        },
      }),
    );
    expect(result).toEqual({ ok: false, retryable: false, reason: "cannot check whether mlx-decision is installed: EACCES: LaunchAgents" });
  });

  it("a platform other than macOS is a non-retryable refusal and the scan is never run", async () => {
    let scans = 0;
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({}),
        platform: "linux",
        discover: async () => {
          scans++;
          return [];
        },
      }),
    );
    expect(result).toEqual({ ok: false, retryable: false, reason: "the local mlx-decision decider runs only on macOS (Apple silicon)" });
    expect(scans).toBe(0);
  });

  it("a scan that throws is a RETRYABLE refusal: nothing is ever started, so looking again is safe", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({}),
        discover: async () => {
          throw new Error("ps exited 1");
        },
      }),
    );
    expect(result).toEqual({ ok: false, retryable: true, reason: "cannot list running mlx-decision servers with ps and lsof (ps exited 1); llm-ext never starts one" });
  });

  it("a matched server process with no usable listener is a RETRYABLE refusal naming its pid, not 'no server running'", async () => {
    const result = await ensureLocalDecider(cfg({ url: CFG_URL }), deps({ fetch: fakeFetch({}), discover: async () => [{ pid: 4242, urls: [] }] }));
    expect(result).toEqual({
      ok: false,
      retryable: true,
      reason: "an mlx-decision server process (pid 4242) is running but has no listener llm-ext can reach on 127.0.0.1; llm-ext never starts or replaces it",
    });
  });
});

describe("ensureLocalDecider — a server the scan finds", () => {
  it("a discovered server serving our model is adopted by ITS url, not the configured one", async () => {
    const { baseUrl } = await serveLoaded(() => ["elephant-1"]);
    const configured = `http://127.0.0.1:${await freePort()}`;
    const result = await ensureLocalDecider(cfg({ url: configured }), deps({ discover: async () => [{ pid: 41469, urls: [baseUrl] }] }));
    expect(result).toEqual({ ok: true, baseUrl });
  });

  it("a discovered server that is still loading is waited for", async () => {
    const { baseUrl, hits } = await serveLoaded((n) => (n < 3 ? [] : ["elephant-1"]));
    const configured = `http://127.0.0.1:${await freePort()}`;
    const result = await ensureLocalDecider(cfg({ url: configured, startTimeoutMs: 5000 }), deps({ discover: async () => [{ pid: 1, urls: [baseUrl] }] }));
    expect(result).toEqual({ ok: true, baseUrl });
    expect(hits()).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("a discovered server that does not answer /health is a RETRYABLE refusal: its argv says it is running, so it is still coming up", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({ fetch: fakeFetch({}), discover: async () => [{ pid: 4242, urls: [SINGLETON_URL] }] }),
    );
    expect(result).toEqual({ ok: false, retryable: true, reason: `an mlx-decision server is running on ${SINGLETON_URL} but did not answer /health; llm-ext never starts or replaces it` });
  });

  it("a discovered server whose /health is not a decider answer is a retryable refusal naming that", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({ fetch: fakeFetch({ [`${SINGLETON_URL}/health`]: { status: 503, body: "starting" } }), discover: async () => [{ pid: 4242, urls: [SINGLETON_URL] }] }),
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect((result as { reason: string }).reason).toContain("did not answer as a decider");
  });

  it("a discovered server that never finishes loading is a retryable refusal", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL, startTimeoutMs: 1000 }),
      deps({ fetch: fakeFetch({ [`${SINGLETON_URL}/health`]: health([]) }), discover: async () => [{ pid: 1, urls: [SINGLETON_URL] }], now: jumpingNow() }),
    );
    expect(result).toEqual({ ok: false, retryable: true, reason: `the mlx-decision server on ${SINGLETON_URL} is still loading its model after 1000 ms: llm-ext never starts or replaces it` });
  });

  it("a discovered server serving ANOTHER model is a non-retryable refusal naming both models", async () => {
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({ fetch: fakeFetch({ [`${SINGLETON_URL}/health`]: health(["some-other-model"]) }), discover: async () => [{ pid: 1, urls: [SINGLETON_URL] }] }),
    );
    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: `the mlx-decision server on ${SINGLETON_URL} serves some-other-model, not elephant-1: the singleton must serve elephant-1; llm-ext never starts or replaces it, so this run cannot use it`,
    });
  });

  it("one adoptable server among several is adopted even when another is silent", async () => {
    const silent = "http://127.0.0.1:9";
    const result = await ensureLocalDecider(
      cfg({ url: CFG_URL }),
      deps({
        fetch: fakeFetch({ [`${SINGLETON_URL}/health`]: health(["elephant-1"]) }),
        discover: async () => [
          { pid: 1, urls: [silent] },
          { pid: 2, urls: [SINGLETON_URL] },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, baseUrl: SINGLETON_URL });
  });

  it("a scan that finds a server on the configured url is probed again and adopted (the /health flake)", async () => {
    // The first /health to the configured url flakes (step a: no decider seen), the scan then names that same
    // url, and the re-probe reaches the live server. A filter dropping the configured url from the scan result
    // would erase it and report "nothing found" for a server the scan itself proved.
    const { baseUrl, hits } = await serveLoaded(() => ["elephant-1"]);
    let firstProbeFailed = false;
    const flakingFetch: GlobalFetch = (url, init) => {
      if (!firstProbeFailed && url === `${baseUrl}/health`) {
        firstProbeFailed = true;
        return Promise.reject(new Error("simulated /health flake under load"));
      }
      return fetch(url, init);
    };
    const result = await ensureLocalDecider(cfg({ url: baseUrl }), deps({ fetch: flakingFetch, discover: async () => [{ pid: 1, urls: [baseUrl] }] }));
    expect(result).toEqual({ ok: true, baseUrl });
    expect(firstProbeFailed).toBe(true);
    expect(hits()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * TRDD-O93LFMF3 fix 3: only a process whose argv STARTS with the mlx-decision server command is a discovery
 * candidate. A process that merely names the command (a grep, watch, docker, sh -c) became a phantom candidate.
 * The port is NOT read from argv any more (see parseLsofListeners / listenersOf below). Pure string function: no
 * process table, no network.
 */
describe("isDeciderServerCommand", () => {
  it("matches the measured real server (uv-tool python running the console script)", () => {
    const real =
      "/Users/someone/.local/share/uv/tools/mlx-decision/bin/python /Users/someone/.local/bin/mlx-decision server -m baselabs/elephant-1 --default-model elephant-1 --host 127.0.0.1 --port 8123";
    expect(isDeciderServerCommand(real)).toBe(true);
  });

  it("matches a direct install, with or without a port in argv", () => {
    expect(isDeciderServerCommand("/opt/homebrew/bin/mlx-decision server --port 8123")).toBe(true);
    expect(isDeciderServerCommand("/opt/homebrew/bin/mlx-decision server")).toBe(true);
  });

  it("does not match the lockf wrapper of the singleton (same --port, not the server)", () => {
    const wrapper =
      "/usr/bin/lockf -t 0 /Users/someone/Library/Caches/mlx-decision/server.lock /Users/someone/.local/bin/mlx-decision server -m baselabs/elephant-1 --default-model elephant-1 --host 127.0.0.1 --port 8123";
    expect(isDeciderServerCommand(wrapper)).toBe(false);
  });

  it("does not match a grep that names the command", () => {
    expect(isDeciderServerCommand("grep -rn mlx-decision server docs/")).toBe(false);
  });

  it("does not match watch running the command", () => {
    expect(isDeciderServerCommand("watch mlx-decision server --port 9000")).toBe(false);
  });

  it("does not match an sh -c line that mentions the command", () => {
    expect(isDeciderServerCommand('/bin/sh -c if pgrep -qf "[m]lx-decision server" ; then exec /Users/someone/.local/bin/mlx-decision server --port 8123 ; fi')).toBe(false);
  });

  it("does not match docker run naming the command", () => {
    expect(isDeciderServerCommand("docker run --rm img /usr/local/bin/mlx-decision server --port 9001")).toBe(false);
  });

  it("does not match a python script that is not mlx-decision, nor another subcommand", () => {
    expect(isDeciderServerCommand("/usr/bin/python3 /tmp/other.py mlx-decision server")).toBe(false);
    expect(isDeciderServerCommand("/opt/homebrew/bin/mlx-decision benchmark server-model.json")).toBe(false);
    expect(isDeciderServerCommand("/opt/homebrew/bin/mlx-decision --version")).toBe(false);
  });

  // TRDD-O93LFMF3 fix 3b: ps joins argv with single spaces, so a path with a space splits into several tokens, and a
  // macOS framework python shows as `…/Python.app/Contents/MacOS/Python`. A miss is worse than a phantom: llm-ext
  // would refuse "no server" while the 15 GB singleton runs.
  it("matches the exact measured server line (uv-tool python, console script, --port 8123)", () => {
    const line =
      "/Users/x/.local/share/uv/tools/mlx-decision/bin/python /Users/x/.local/bin/mlx-decision server -m baselabs/elephant-1 --default-model elephant-1 --host 127.0.0.1 --port 8123";
    expect(isDeciderServerCommand(line)).toBe(true);
  });

  it("matches a macOS framework python whose argv[0] ends in a capital-P Python", () => {
    const line =
      "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python /Users/x/.local/bin/mlx-decision server --port 8123";
    expect(isDeciderServerCommand(line)).toBe(true);
  });

  it("matches a direct executable whose path contains a space", () => {
    expect(isDeciderServerCommand("/Users/a b/.local/bin/mlx-decision server --port 8123")).toBe(true);
    expect(isDeciderServerCommand("/Users/a b/c d/bin/mlx-decision server --port 8124")).toBe(true);
  });

  it("matches a python interpreter whose path contains a space, with and without a spaced script path", () => {
    expect(isDeciderServerCommand("/Users/a b/.local/share/uv/tools/mlx-decision/bin/python /Users/x/.local/bin/mlx-decision server --port 8123")).toBe(true);
    expect(isDeciderServerCommand("/Users/a b/.local/share/uv/tools/mlx-decision/bin/python /Users/a b/.local/bin/mlx-decision server --port 8123")).toBe(true);
  });

  it("skips interpreter flags that stand alone between the python and the script", () => {
    expect(isDeciderServerCommand("/usr/bin/python3 -u -B /Users/x/.local/bin/mlx-decision server --port 8123")).toBe(true);
  });

  it("pins what stays unsupported: python -m, a global flag before server, an interpreter flag with a separate value", () => {
    expect(isDeciderServerCommand("/usr/bin/python3 -m mlx_decision server --port 8123")).toBe(false);
    expect(isDeciderServerCommand("/opt/homebrew/bin/mlx-decision --log-level debug server --port 8123")).toBe(false);
    expect(isDeciderServerCommand("/usr/bin/python3 -X utf8 /Users/x/.local/bin/mlx-decision server --port 8123")).toBe(false);
  });

  it("still rejects a wrapper whose argv has flags or absolute words before the command, even with a spaced path", () => {
    expect(isDeciderServerCommand("/usr/bin/lockf -t 0 /Users/a b/server.lock /Users/a b/.local/bin/mlx-decision server --port 8123")).toBe(false);
    expect(isDeciderServerCommand("/usr/bin/env FOO=1 /Users/x/.local/bin/mlx-decision server --port 8123")).toBe(false);
    expect(isDeciderServerCommand("/usr/bin/nice 5 mlx-decision server --port 8123")).toBe(false);
  });

  // Known, accepted phantom (TRDD-O93LFMF3): an editor given a relative path ending in /mlx-decision passes isSplitPath.
  // It still matches here, but it holds no listening socket, so it ends as the retryable "no listener" refusal, never an
  // adoption; pinned so a change to it is deliberate.
  it("pins the accepted phantom: an editor given a relative mlx-decision path still reads as a server command", () => {
    expect(isDeciderServerCommand("/usr/bin/vim notes/mlx-decision server")).toBe(true);
  });
});

/**
 * parseLsofListeners reads `lsof -F ptn` output. The first fixture is hand-made in the -F ptn form (the real lsof
 * line shapes: `p<pid>`, `f<fd>`, `t<IPv4|IPv6>`, `n<addr>`); the real-socket tests below prove the same shapes
 * against the lsof of this machine.
 */
describe("parseLsofListeners", () => {
  it("maps loopback IPv4 and wildcard sockets of two pids to loopback urls, skips other addresses, dedupes ports", () => {
    // HAND-MADE fixture (-F ptn form).
    const out = [
      "p23342", "f7", "tIPv4", "n127.0.0.1:8123", //
      "f8", "tIPv6", "n*:8123", // dual-stack twin of the same port: deduped
      "f9", "tIPv4", "n*:8124", // wildcard IPv4
      "f10", "tIPv6", "n*:8125", // wildcard IPv6: may be dual-stack, so probed, never refused
      "f11", "tIPv4", "n192.168.1.5:8126", // LAN address: skipped
      "f12", "tIPv6", "n[::1]:8127", // IPv6 loopback only: skipped
      "p41469", "f3", "tIPv4", "n127.0.0.1:9000",
      "p500", "f4", "tIPv4", "n10.0.0.1:9001", // a pid with nothing usable: present with an empty list
      "",
    ].join("\n");
    const parsed = parseLsofListeners(out);
    expect(parsed.get(23342)).toEqual(["http://127.0.0.1:8123", "http://127.0.0.1:8124", "http://127.0.0.1:8125"]);
    expect(parsed.get(41469)).toEqual(["http://127.0.0.1:9000"]);
    expect(parsed.get(500)).toEqual([]);
  });

  it("ignores unknown field letters and an n line with no t before it in the same file", () => {
    // HAND-MADE fixture: the t of the first file must not leak into the second file's n line.
    const out = ["p7", "f1", "tIPv4", "n*:1111", "f2", "n*:2222", "cpython3", "f3", "tIPv4", "n*:3333", ""].join("\n");
    expect(parseLsofListeners(out).get(7)).toEqual(["http://127.0.0.1:1111", "http://127.0.0.1:3333"]);
  });

  it("returns an empty map for empty output", () => {
    expect(parseLsofListeners("").size).toBe(0);
  });
});

/**
 * listenersOf against the REAL lsof and REAL sockets this process opens, so the output shape this machine's lsof
 * prints is what the parser is proven on.
 */
describe("listenersOf", () => {
  const tcpServers: TcpServer[] = [];
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tcpServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function listenOn(host: string): Promise<number> {
    const s = createTcpServer();
    tcpServers.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, host, resolve);
    });
    return (s.address() as { port: number }).port;
  }

  /** A tiny executable `#!/bin/sh` script standing in for lsof; returns its path. */
  function fakeLsof(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "llm-ext-lsof-"));
    tmpDirs.push(dir);
    const file = join(dir, "lsof");
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it("reports the loopback urls of real sockets bound on 127.0.0.1, 0.0.0.0 and ::", async () => {
    // WHY `::` is here: it pins the MAPPING (a tIPv6 *:P socket becomes a loopback url), not reachability. A Python
    // server bound to :: is IPv6-only and will not answer on 127.0.0.1; it ends as "did not answer /health".
    // On a host with IPv6 disabled, listen(0, "::") throws EAFNOSUPPORT.
    const ports = [await listenOn("127.0.0.1"), await listenOn("0.0.0.0"), await listenOn("::")];
    const got = (await listenersOf([process.pid])).get(process.pid) ?? [];
    for (const port of ports) expect(got).toContain(`http://127.0.0.1:${port}`);
  });

  it("a repeated pid still answers", async () => {
    const port = await listenOn("127.0.0.1");
    const got = (await listenersOf([process.pid, process.pid])).get(process.pid) ?? [];
    expect(got).toContain(`http://127.0.0.1:${port}`);
  });

  it("an empty pid list is an empty map and runs nothing", async () => {
    expect((await listenersOf([], "/nonexistent/lsof")).size).toBe(0);
  });

  it("a pid that does not exist is an empty map (lsof exit 1, no output)", async () => {
    expect((await listenersOf([999999])).size).toBe(0);
  });

  it("a missing lsof binary rejects: a failed look is never 'none running'", async () => {
    await expect(listenersOf([process.pid], "/nonexistent/lsof")).rejects.toThrow(/spawn error ENOENT/);
  });

  it("stderr output with exit 3 rejects, carrying the exit code and stderr", async () => {
    await expect(listenersOf([1], fakeLsof("echo boom >&2; exit 3"))).rejects.toThrow(/exit 3.*boom/);
  });

  it("stderr output with exit 1 rejects too (a warning on exit 1 is a retryable cannot-list)", async () => {
    await expect(listenersOf([1], fakeLsof("echo warn >&2; exit 1"))).rejects.toThrow(/exit 1.*warn/);
  });

  it("exit 1 with no output is an empty map (lsof's own 'nothing matched')", async () => {
    expect((await listenersOf([1], fakeLsof("exit 1"))).size).toBe(0);
  });
});
