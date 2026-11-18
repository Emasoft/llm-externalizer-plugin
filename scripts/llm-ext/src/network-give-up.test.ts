/**
 * network-give-up.test.ts — TRDD-PN0N4290 (increment 1b of TRDD-WSPV40Y5): the bounded give-up window for network-level remote
 * failures, the STRICT provider probe, and the three-part arming condition (trigger c, strict probe, a local target ready now).
 *
 * REAL node:http servers, a REAL closed port and a REAL unresolvable name (`.invalid`, RFC 6761); nothing under test is mocked. The one
 * pure unit test is classifyFailure for the OpenRouter-host name-lookup case, which cannot be forced for real (Required test 1).
 * The readiness fixture is real files: a hub-layout model cache, an executable named llama-server on a throwaway PATH (readiness
 * only checks that it exists and is executable; nothing is ever spawned) and a schema-valid ok calibration record in a throwaway config dir.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordFixture } from "./calibration/test-record.js";
import { writeRecord } from "./calibration/record.js";
import { loadSettings, networkGiveUpErrors, type Settings } from "./config.js";
import { extractTimeoutFlags } from "./cli/timeout-flags.js";
import {
  DEFAULT_NETWORK_GIVE_UP_S,
  makeNetworkGiveUp,
  networkGiveUpMs,
  probeBaseUrl,
  readyLocalTarget,
  remoteFallbackApplies,
  setNetworkGiveUpOverrideS,
  strictProviderAnswer,
} from "./network-give-up.js";
import {
  classifyFailure,
  fetchWithRetry429,
  failureOf,
  NETWORK_GIVE_UP_KEY,
  NETWORK_ISOLATION_CODES,
  type RetryClock,
} from "./provider/http.js";

const MODEL = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const GENUINE_MODELS = JSON.stringify({ data: [{ id: "vendor/some-model" }] });

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setNetworkGiveUpOverrideS(undefined);
  vi.unstubAllEnvs();
});
beforeEach(() => setNetworkGiveUpOverrideS(undefined));

function tempDir(kind: string): string {
  const d = mkdtempSync(join("/tmp", `llm-ext-ngu-${kind}-`));
  dirs.push(d);
  return d;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Answers every GET /v1/models with `status`, `contentType` and `body`; counts the requests it saw. */
async function modelsServer(status: number, contentType: string, body: string, headers: Record<string, string> = {}) {
  let seen = 0;
  const server = createServer((req, res) => {
    seen++;
    req.resume();
    res.writeHead(status, { "Content-Type": contentType, ...headers });
    res.end(body);
  });
  return { url: await listen(server), seen: () => seen };
}

/** A server that resets every TCP connection at accept time: the client sees ECONNRESET on the request AND on any probe. */
async function resetServer() {
  let connections = 0;
  const server = createServer();
  server.on("connection", (socket) => {
    connections++;
    socket.resetAndDestroy();
  });
  return { url: await listen(server), connections: () => connections };
}

async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

interface ReadyFixture {
  settings: Settings;
  cfgDir: string;
  env: NodeJS.ProcessEnv;
}

/** A local_llama profile on the tiny-llamas model (or on `id` plus the snapshot file names `files`, for a repo:quant id), with the three readiness parts present unless switched off. */
function readyFixture(o: { binary?: boolean; model?: boolean; record?: "ok" | "failed" | "none"; id?: string; files?: string[] } = {}): ReadyFixture {
  const cfgDir = tempDir("cfg");
  const binDir = tempDir("bin");
  const cache = tempDir("cache");
  const id = o.id ?? MODEL;
  writeFileSync(
    join(cfgDir, "settings.yaml"),
    ["active: local_llama", "profiles:", "  local_llama:", "    profile-type: local", "    mode: local", "    api: llamacpp-local", "    url: http://127.0.0.1:8181", "    server: managed", `    model: ${id}`, ""].join("\n"),
    "utf-8",
  );
  if (o.binary !== false) {
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(join(binDir, "llama-server"), 0o755);
  }
  if (o.model !== false) {
    const repoDir = join(cache, `models--${(o.id === undefined ? "ggml-org/tiny-llamas" : id.split(":")[0]).replace("/", "--")}`);
    const snap = join(repoDir, "snapshots", "rev1");
    mkdirSync(join(repoDir, "refs"), { recursive: true });
    writeFileSync(join(repoDir, "refs", "main"), "rev1", "utf-8");
    mkdirSync(snap, { recursive: true });
    for (const name of o.files ?? ["stories15M-q4_0.gguf"]) {
      // A name may carry a subdirectory ("sub/model-Q4_0.gguf"): TRDD-4W3Q2B4S.
      mkdirSync(dirname(join(snap, name)), { recursive: true });
      writeFileSync(join(snap, name), "not real weights: readiness only checks that the file exists", "utf-8");
    }
  }
  if (o.record === "failed") writeRecord(cfgDir, recordFixture("llama", id, { step: "phase-a/thinking-off", message: "thinking cannot be turned off" }));
  else if (o.record !== "none") writeRecord(cfgDir, recordFixture("llama", id));
  vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  const settings = loadSettings();
  if (settings === null) throw new Error("fixture settings.yaml did not load");
  return { settings, cfgDir, env: { PATH: binDir, LLAMA_CACHE: cache } };
}

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const call = (url: string, clock: RetryClock, signal?: AbortSignal) =>
  fetchWithRetry429(`${url}/v1/chat/completions`, { method: "POST", body: "{}", signal }, 60_000, Date.now(), undefined, clock);

describe("classifyFailure under the armed rule (Required test 1: the OpenRouter-host DNS case, unit level)", () => {
  const OR = "openrouter.ai";
  const window = (elapsedMs: number, windowMs = 30_000) => ({ sinceMs: 1_000_000, windowMs, nowMs: 1_000_000 + elapsedMs });

  it.each(["ENOTFOUND", "EAI_AGAIN"])("%s on the OpenRouter host: inside the window it is neverSent as before, at the window it gives up", (code) => {
    expect(classifyFailure({ networkCode: code }, OR, window(29_999))).toEqual({ neverSent: true });
    const v = classifyFailure({ networkCode: code }, OR, window(30_000));
    expect(v.budget).toEqual({ key: NETWORK_GIVE_UP_KEY, tries: 1 });
    expect(v.neverSent).toBeUndefined();
    expect(v.hint).toContain("30 s");
    expect(v.hint).toContain(code);
    expect(v.hint).toContain(OR);
  });

  it("without a window every verdict is the existing one (an unarmed command is unchanged)", () => {
    expect(classifyFailure({ networkCode: "ENOTFOUND" }, OR)).toEqual({ neverSent: true });
    expect(classifyFailure({ networkCode: "ENOTFOUND" }, OR, undefined)).toEqual({ neverSent: true });
    expect(classifyFailure({ networkCode: "ECONNREFUSED" }, "localhost").budget?.key).toBe("ECONNREFUSED");
    expect(classifyFailure({ networkCode: "ECONNRESET" }, OR)).toEqual({});
  });

  it.each([...NETWORK_ISOLATION_CODES])("%s past the window gives up, ahead of any per-code budget", (code) => {
    const v = classifyFailure({ networkCode: code }, OR, window(60_000));
    expect(v.budget?.key).toBe(NETWORK_GIVE_UP_KEY);
    expect(v.neverSent).toBeUndefined();
  });

  it("only isolation codes give up: the local timeout, TLS errors and statuses keep their own verdicts", () => {
    expect(classifyFailure({ networkCode: "ETIMEDOUT-LOCAL" }, OR, window(60_000))).toEqual({});
    expect(classifyFailure({ networkCode: "CERT_HAS_EXPIRED" }, OR, window(60_000)).stop).toBe(true);
    expect(classifyFailure({ status: 503 }, OR, window(60_000))).toEqual({});
    expect(classifyFailure({ status: 504 }, OR, window(60_000)).budget?.key).toBe("504");
  });
});

describe("strictProviderAnswer (the captive-portal-proof probe)", () => {
  it("a real JSON models list with a data array is a provider answer", async () => {
    const s = await modelsServer(200, "application/json", GENUINE_MODELS);
    expect(await strictProviderAnswer(s.url)).toBe(true);
  });

  it("a captive portal answering 200 HTML is NOT a provider answer", async () => {
    const s = await modelsServer(200, "text/html", "<html><body>Sign in to the Wi-Fi</body></html>");
    expect(await strictProviderAnswer(s.url)).toBe(false);
    expect(s.seen()).toBe(1);
  });

  it("a captive portal answering 302 is NOT a provider answer, and the redirect is NOT followed", async () => {
    const real = await modelsServer(200, "application/json", GENUINE_MODELS);
    const portal = await modelsServer(302, "text/html", "", { Location: `${real.url}/v1/models` });
    expect(await strictProviderAnswer(portal.url)).toBe(false);
    expect(real.seen(), "redirect: manual must not reach the genuine server behind the portal").toBe(0);
  });

  it.each([
    ["JSON without a data array", 200, "application/json", "{}"],
    ["a JSON array", 200, "application/json", "[1]"],
    ["a JSON data that is not an array", 200, "application/json", "{\"data\":\"x\"}"],
    ["a 503", 503, "application/json", GENUINE_MODELS],
    ["a 404", 404, "application/json", GENUINE_MODELS],
    ["a 401", 401, "application/json", GENUINE_MODELS],
  ])("%s is not a provider answer", async (_label, status, contentType, body) => {
    const s = await modelsServer(status, contentType, body);
    expect(await strictProviderAnswer(s.url)).toBe(false);
  });

  it("a closed port, a reset connection and an unresolvable name are not a provider answer", async () => {
    expect(await strictProviderAnswer(await closedPortUrl())).toBe(false);
    expect(await strictProviderAnswer((await resetServer()).url)).toBe(false);
    expect(await strictProviderAnswer("http://no-such-host.invalid")).toBe(false);
  });
});

describe("readyLocalTarget (no process, no download: files and the PATH only)", () => {
  const LINUX = { platform: "linux", arch: "x64" };

  it("engine binary on PATH + model on disk + ok calibration record = ready", () => {
    const f = readyFixture();
    expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toEqual({ profile: "local_llama", engine: "llama", model: MODEL });
  });

  it.each([
    ["the engine binary missing", { binary: false }],
    ["the model not on disk", { model: false }],
    ["no calibration record", { record: "none" as const }],
    ["a failed calibration record", { record: "failed" as const }],
  ])("%s = not ready", (_label, o) => {
    const f = readyFixture(o);
    expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toBeUndefined();
  });

  it("a relative PATH entry is never trusted", () => {
    const f = readyFixture();
    expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: { ...f.env, PATH: "bin" } })).toBeUndefined();
  });

  it("an unmanaged local profile has no record and is never ready", () => {
    const f = readyFixture();
    const unmanaged = { ...f.settings, profiles: { local_llama: { ...f.settings.profiles.local_llama, server: undefined } } } as Settings;
    expect(readyLocalTarget(unmanaged, f.cfgDir, { ...LINUX, env: f.env })).toBeUndefined();
  });

  // TRDD-GNKO7WZS: a repo:quant id is on disk only when llama-server -hf would load a LLM weight file for that quant from the cache
  // (common/download.cpp find_best_model): not an mmproj/imatrix sidecar, and the quant as a whole token, not a prefix of another quant.
  it.each([
    ["the head model AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K", "AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K", ["LFM3-1.7B-Uncensored-AD-Q4_K_M.gguf", "LFM3-1.7B-Uncensored-AD-Q6_K.gguf"], true],
    ["a sharded model (first shard present)", "acme/big-GGUF:Q4_K_M", ["big-Q4_K_M-00001-of-00002.gguf", "big-Q4_K_M-00002-of-00002.gguf"], true],
    ["a sharded model with only a later shard present (llama.cpp counts a split only at shard 1)", "acme/big-GGUF:Q4_K_M", ["big-Q4_K_M-00002-of-00002.gguf"], false],
    ["a sharded model with shard 1 of 2 present and shard 2 missing (llama-server -hf downloads the missing shard: download.cpp:842, arg.cpp:529-541)", "acme/big-GGUF:Q4_K_M", ["big-Q4_K_M-00001-of-00002.gguf"], false],
    ["the quant in lower case in the file name", "acme/small-GGUF:Q8_0", ["small-q8_0.gguf"], true],
    ["the quant preceded by an underscore", "acme/small-GGUF:Q4_K_M", ["small_Q4_K_M.gguf"], true],
    ["Q4_0 asked, only IQ4_0 present (the quant is glued to a letter, not a token)", "acme/small-GGUF:Q4_0", ["small-IQ4_0.gguf"], false],
    ["only mmproj files carry the quant (Q8_0 and F16 projectors, no weights)", "acme/vl-GGUF:Q8_0", ["mmproj-vl-Q8_0.gguf", "mmproj-vl-F16.gguf"], false],
    ["only an mmproj file carries the quant F16", "acme/vl-GGUF:F16", ["mmproj-vl-F16.gguf", "vl-Q4_K_M.gguf"], false],
    ["Q4_K asked, only Q4_K_M present (a shorter quant is not a longer one)", "acme/small-GGUF:Q4_K", ["small-Q4_K_M.gguf"], false],
    ["Q4_K asked, only Q4_K_S and a sharded Q4_K_M present", "acme/small-GGUF:Q4_K", ["small-Q4_K_S.gguf", "small-Q4_K_M-00001-of-00002.gguf"], false],
    ["an imatrix file named after the quant is not the weights", "acme/small-GGUF:Q2_K", ["small-Q2_K.imatrix.gguf"], false],
    ["a non-gguf file named after the quant is not the weights", "acme/small-GGUF:Q8_0", ["small-Q8_0.gguf.part"], false],
    ["an upper-case .GGUF extension (llama.cpp string_ends_with is case-sensitive)", "acme/small-GGUF:Q8_0", ["small-Q8_0.GGUF"], false],
    // TRDD-4W3Q2B4S: llama.cpp matches the quant on the repo-relative path, so a GGUF in a snapshot subdirectory is a model on disk.
    ["a model in a snapshot subdirectory", "acme/sub-GGUF:Q4_0", ["sub/sub-Q4_0.gguf"], true],
    ["a model two subdirectories deep", "acme/sub-GGUF:Q4_0", ["a/b/sub-Q4_0.gguf"], true],
    ["only an mmproj file in a subdirectory carries the quant", "acme/sub-GGUF:Q8_0", ["vision/mmproj-sub-Q8_0.gguf"], false],
    ["a sharded model in a subdirectory with every shard present", "acme/big-GGUF:Q4_K_M", ["q4/big-Q4_K_M-00001-of-00002.gguf", "q4/big-Q4_K_M-00002-of-00002.gguf"], true],
    ["a sharded model in a subdirectory with shard 2 missing", "acme/big-GGUF:Q4_K_M", ["q4/big-Q4_K_M-00001-of-00002.gguf"], false],
    ["a sharded model whose shards sit in different subdirectories", "acme/big-GGUF:Q4_K_M", ["a/big-Q4_K_M-00001-of-00002.gguf", "b/big-Q4_K_M-00002-of-00002.gguf"], false],
  ])("a repo:quant model: %s", (_label, id, files, ready) => {
    const f = readyFixture({ id, files });
    expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toEqual(ready ? { profile: "local_llama", engine: "llama", model: id } : undefined);
  });

  // TRDD-4W3Q2B4S: an unreadable subdirectory is "no model there", never a throw out of readyLocalTarget (the give-up path). chmod 000 does not bind root or Windows.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
    ["only the unreadable subdirectory holds the model", ["locked/lk-Q4_0.gguf"], false],
    ["a readable file beside the unreadable subdirectory holds the model", ["lk-Q4_0.gguf", "locked/other.bin"], true],
  ])("an unreadable snapshot subdirectory: %s", (_label, files, ready) => {
    const id = "acme/lk-GGUF:Q4_0";
    const f = readyFixture({ id, files });
    const locked = join(f.env.LLAMA_CACHE as string, "models--acme--lk-GGUF", "snapshots", "rev1", "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toEqual(ready ? { profile: "local_llama", engine: "llama", model: id } : undefined);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
  // TRDD-4W3Q2B4S: a hub-layout snapshot entry is a symlink to a blob, and a snapshot may hold a directory symlink. Skipped on Windows, where a symlink needs a privilege.
  describe.skipIf(process.platform === "win32")("snapshot symlinks", () => {
    it("a repo:quant model whose snapshot file is a symlink to a blob in a subdirectory is on disk", () => {
      const id = "acme/link-GGUF:Q4_0";
      const f = readyFixture({ id, files: [] });
      const sub = join(f.env.LLAMA_CACHE as string, "models--acme--link-GGUF", "snapshots", "rev1", "sub");
      mkdirSync(sub, { recursive: true });
      const blob = join(tempDir("blob"), "sha256-deadbeef");
      writeFileSync(blob, "not real weights", "utf-8");
      symlinkSync(blob, join(sub, "link-Q4_0.gguf"));
      expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toEqual({ profile: "local_llama", engine: "llama", model: id });
    });

    it.each([
      ["a model sits beside the loop", ["sub/loop-Q4_0.gguf"], true],
      ["no model sits beside the loop", [], false],
    ])("a directory symlink loop in the snapshot ends the walk: %s", (_label, files, ready) => {
      const id = "acme/loop-GGUF:Q4_0";
      const f = readyFixture({ id, files });
      const snap = join(f.env.LLAMA_CACHE as string, "models--acme--loop-GGUF", "snapshots", "rev1");
      mkdirSync(join(snap, "sub"), { recursive: true });
      symlinkSync(snap, join(snap, "sub", "back"));
      expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toEqual(ready ? { profile: "local_llama", engine: "llama", model: id } : undefined);
    });

    // llama.cpp get_cached_files (hf-cache.cpp:428, recursive_directory_iterator) does not enter a directory symlink either, so a GGUF behind one is not in its cached listing.
    it("a GGUF behind a directory symlink is not on disk", () => {
      const id = "acme/dirlink-GGUF:Q4_0";
      const f = readyFixture({ id, files: [] });
      const snap = join(f.env.LLAMA_CACHE as string, "models--acme--dirlink-GGUF", "snapshots", "rev1");
      const target = tempDir("realdir");
      writeFileSync(join(target, "dirlink-Q4_0.gguf"), "not real weights", "utf-8");
      symlinkSync(target, join(snap, "linked"));
      expect(readyLocalTarget(f.settings, f.cfgDir, { ...LINUX, env: f.env })).toBeUndefined();
    });
  });
});

describe("the arming condition: ALL THREE (ready local target, trigger c, no genuine provider answer)", () => {
  const LINUX = { platform: "linux", arch: "x64" };
  const refused = (code = "ECONNREFUSED") => Object.assign(new Error("fetch failed"), { failure: { networkCode: code } });

  it("all three hold (a closed port, a captive portal answering HTML): armed", async () => {
    const f = readyFixture();
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env });
    expect(await gu.arm(refused(), `${await closedPortUrl()}/v1/chat/completions`)).toBe(true);
    const portal = await modelsServer(200, "text/html", "<html>login</html>");
    expect(await gu.arm(refused(), `${portal.url}/v1/chat/completions`)).toBe(true);
  });

  it("a genuine provider answer to the strict probe vetoes it (the provider is up, so this is not isolation)", async () => {
    const f = readyFixture();
    const up = await modelsServer(200, "application/json", GENUINE_MODELS);
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env });
    expect(await gu.arm(refused(), `${up.url}/v1/chat/completions`)).toBe(false);
    expect(up.seen()).toBe(1);
  });

  it("no ready local target: unarmed, and ZERO network I/O (the probe is never sent)", async () => {
    const f = readyFixture({ record: "none" });
    const up = await modelsServer(200, "text/html", "x");
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env });
    expect(await gu.arm(refused(), `${up.url}/v1/chat/completions`)).toBe(false);
    expect(up.seen()).toBe(0);
  });

  it("trigger c not met (the local timeout, a status failure, no typed code): unarmed, probe never sent", async () => {
    const f = readyFixture();
    const up = await modelsServer(200, "text/html", "x");
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env });
    const url = `${up.url}/v1/chat/completions`;
    expect(await gu.arm(refused("ETIMEDOUT-LOCAL"), url)).toBe(false);
    expect(await gu.arm(Object.assign(new Error("API error 503"), { failure: { status: 503 } }), url)).toBe(false);
    expect(await gu.arm(new Error("fetch failed"), url)).toBe(false);
    expect(up.seen()).toBe(0);
  });

  it("a request URL that is not <base>/v1/chat/completions gives no probe base: unarmed", async () => {
    const f = readyFixture();
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env });
    expect(probeBaseUrl("https://x.example/api/v1/chat")).toBeUndefined();
    expect(await gu.arm(refused(), "https://x.example/api/v1/chat")).toBe(false);
    expect(probeBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api");
  });

  it("sendReady false (TRDD-WSPV40Y5 F2: a ready target with no calibrated sizing for the tool) keeps the window unarmed, probe never sent", async () => {
    const f = readyFixture();
    const up = await modelsServer(200, "text/html", "x");
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env, sendReady: () => false });
    expect(await gu.arm(refused(), `${up.url}/v1/chat/completions`)).toBe(false);
    expect(up.seen()).toBe(0);
  });

  it("sendReady true leaves the other conditions in force (armed on a closed port)", async () => {
    const f = readyFixture();
    const gu = makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env, sendReady: () => true });
    expect(await gu.arm(refused(), `${await closedPortUrl()}/v1/chat/completions`)).toBe(true);
  });

  it("an arm that throws (TRDD-WSPV40Y5 F3) resolves false and writes exactly one stderr line naming the cause", async () => {
    const f = readyFixture();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const gu = makeNetworkGiveUp(f.settings, f.cfgDir, {
        ...LINUX,
        env: f.env,
        sendReady: () => {
          throw new Error("EACCES: cannot read the calibration record");
        },
      });
      expect(await gu.arm(refused(), `${await closedPortUrl()}/v1/chat/completions`)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[llm-externalizer\] .*EACCES: cannot read the calibration record\n$/);
  });
});

describe("remoteFallbackApplies (TRDD-WSPV40Y5 F1: the one predicate of the give-up window and the fallback step)", () => {
  const remote = { isLocal: false, mode: "remote" as const };

  it.each([["free"], ["paid"]])("the built-in remote dynamic profile '%s' applies", (name) => {
    expect(remoteFallbackApplies(remote, name)).toBe(true);
  });

  it("a static user-defined remote profile does not apply (no fallback follows, so no window)", () => {
    expect(remoteFallbackApplies(remote, "my-openrouter")).toBe(false);
  });

  it("a local profile does not apply, even under the dynamic name 'local'", () => {
    expect(remoteFallbackApplies({ isLocal: true, mode: "local" }, "local")).toBe(false);
    expect(remoteFallbackApplies({ isLocal: false, mode: "local" }, "free")).toBe(false);
    expect(remoteFallbackApplies({ isLocal: true, mode: "remote" }, "free")).toBe(false);
  });

  it("no resolved profile does not apply", () => {
    expect(remoteFallbackApplies(null, "free")).toBe(false);
  });
});

describe("the window: settings key, flag, default", () => {
  const plain = (extra: Record<string, unknown> = {}): Settings => ({ profiles: {}, ...extra }) as unknown as Settings;

  it("default 30 s, the key overrides it, the flag overrides the key", () => {
    expect(DEFAULT_NETWORK_GIVE_UP_S).toBe(30);
    expect(networkGiveUpMs(plain())).toBe(30_000);
    expect(networkGiveUpMs(plain({ network_give_up_seconds: 12 }))).toBe(12_000);
    setNetworkGiveUpOverrideS(2);
    expect(networkGiveUpMs(plain({ network_give_up_seconds: 12 }))).toBe(2_000);
    setNetworkGiveUpOverrideS(undefined);
    expect(networkGiveUpMs(plain({ network_give_up_seconds: 12 }))).toBe(12_000);
  });

  it("a malformed key is an error naming the key and the range, never the default", () => {
    // TRDD-PN0N4290 N3: the top is below the 300 s retry window (a window of 300 s or more could never fire), the same constant as the flag.
    for (const bad of [0, -3, 300, 3600, 3601, 1.5, "30", true, [30], {}]) {
      expect(networkGiveUpErrors(bad)[0]).toContain("network_give_up_seconds must be an integer from 1 to 299 (the remote retry window closes after 300 s, so a larger give-up window could never fire)");
      expect(() => networkGiveUpMs(plain({ network_give_up_seconds: bad }))).toThrow(/network_give_up_seconds/);
    }
    expect(networkGiveUpErrors(undefined)).toEqual([]);
    expect(networkGiveUpErrors(null)).toEqual([]);
    expect(networkGiveUpErrors(1)).toEqual([]);
    expect(networkGiveUpErrors(299)).toEqual([]);
  });

  it("the flag takes both spellings, `--x N` and `--x=N`, whole seconds >= 1, and is stripped from argv", () => {
    expect(extractTimeoutFlags(["scan", "--network_give_up", "5", "./src"])).toMatchObject({ argv: ["scan", "./src"], networkGiveUpS: 5 });
    expect(extractTimeoutFlags(["scan", "--network-give-up=7"])).toMatchObject({ argv: ["scan"], networkGiveUpS: 7 });
    expect(extractTimeoutFlags(["scan"]).networkGiveUpS).toBeUndefined();
    for (const bad of [["--network_give_up"], ["--network_give_up", "0"], ["--network_give_up=abc"], ["--network-give-up", "-2"]]) {
      expect(() => extractTimeoutFlags(bad)).toThrow(/--network[_-]give[_-]up expects a whole number of seconds/);
    }
  });

  it("TRDD-PN0N4290 N3: the flag has the SAME range as the key, 1 to 299 (below the 300 s retry window); a larger value is an error naming the limit and why", () => {
    expect(extractTimeoutFlags(["--network_give_up", "299"]).networkGiveUpS).toBe(299);
    expect(networkGiveUpErrors(299)).toEqual([]);
    for (const tooBig of ["300", "3600", "2147483"]) {
      expect(() => extractTimeoutFlags(["--network_give_up", tooBig])).toThrow(`--network_give_up is at most 299 seconds (the remote retry window closes after 300 s, so a larger give-up window could never fire), got ${tooBig}`);
      expect(() => extractTimeoutFlags([`--network-give-up=${tooBig}`])).toThrow(/--network-give-up is at most 299 seconds/);
    }
    // The other two flags keep their own, larger range: only the give-up window must fit under the retry window.
    expect(extractTimeoutFlags(["--command_timeout", "3600"]).commandTimeoutS).toBe(3600);
  });
  it("a settings.yaml with a malformed key fails validateSettings (a typo is reported, not defaulted)", async () => {
    const cfgDir = tempDir("badkey");
    writeFileSync(join(cfgDir, "settings.yaml"), ["active: lc", "network_give_up_seconds: soon", "profiles:", "  lc:", "    mode: local", "    api: llamacpp-local", "    url: http://127.0.0.1:1", "    model: m", ""].join("\n"), "utf-8");
    vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
    const { validateSettings } = await import("./config.js");
    const settings = loadSettings();
    expect(settings?.network_give_up_seconds).toBe("soon");
    const result = validateSettings(settings as Settings);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("network_give_up_seconds must be an integer from 1 to 299 (the remote retry window closes after 300 s, so a larger give-up window could never fire), got \"soon\"");
  });
});

describe("the window at the HTTP layer (real servers, a real closed port, a real unresolvable name)", () => {
  const LINUX = { platform: "linux", arch: "x64" };

  it("ARMED, a real closed port: the typed ECONNREFUSED error is thrown in under 5 s (a bound the old code also meets: REFUSED_TRIES = 2 ends it at about 1 s)", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(1);
    const url = await closedPortUrl();
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(call(url, clock));
    expect(err).toBeInstanceOf(Error);
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
    expect(failureOf(err)?.final).toBe("budget");
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);

  it("ARMED, a real unresolvable `.invalid` host: a typed name-lookup error in under 5 s", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(2);
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(call("http://no-such-host.invalid", clock));
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(failureOf(err)?.networkCode);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);

  it("ARMED, resets on every attempt (ECONNRESET: no per-code verdict, 31 s of retries before): gives up at the window, in under 5 s", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(2);
    const srv = await resetServer();
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(call(srv.url, clock));
    const elapsed = Date.now() - t0;
    expect(failureOf(err)?.networkCode).toBe("ECONNRESET");
    expect(failureOf(err)?.hint).toContain("gave up retrying the remote service");
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(srv.connections(), "the strict probe went to the same dead server once").toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("a blip shorter than the window still heals: the call succeeds once the server comes back", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(30);
    let connections = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    server.on("connection", (socket) => {
      // The first three connections (the failed request, the strict probe, the first retry) are reset; the fourth is served.
      if (++connections <= 3) socket.resetAndDestroy();
    });
    const url = await listen(server);
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const res = await call(url, clock);
    expect(res.status).toBe(200);
    expect(clock.networkGiveUp?.failingSince, "a response ends the run of failures").toBeUndefined();
  }, 30_000);

  it("UNARMED because the probe gets a genuine provider answer: the existing retries run, the window never ends the call", async () => {
    const f = readyFixture();
    setNetworkGiveUpOverrideS(1);
    let posts = 0;
    let gets = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (req.method === "GET") {
        gets++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(GENUINE_MODELS);
        return;
      }
      posts++;
      req.socket.resetAndDestroy();
    });
    const url = await listen(server);
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const ac = new AbortController();
    let settled = false;
    const pending = caught(call(url, clock, ac.signal)).then((e) => {
      settled = true;
      return e;
    });
    await sleep(3_000);
    // Armed, the 1 s window would have ended the call by now (it lands on 1 s); the existing backoff (1, 2, 4, ... s) is still running.
    expect(settled, "the call is still retrying past the window").toBe(false);
    expect(gets, "the strict probe ran once and found the provider up").toBe(1);
    expect(posts).toBeGreaterThanOrEqual(2);
    ac.abort();
    await pending;
  }, 30_000);

  it("UNARMED because no local target is ready: the existing retries run, and the probe server sees ZERO requests", async () => {
    const f = readyFixture({ record: "none" });
    setNetworkGiveUpOverrideS(1);
    let gets = 0;
    let posts = 0;
    const server = createServer((req) => {
      req.resume();
      if (req.method === "GET") gets++;
      else posts++;
      req.socket.resetAndDestroy();
    });
    const url = await listen(server);
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const ac = new AbortController();
    let settled = false;
    const pending = caught(call(url, clock, ac.signal)).then((e) => {
      settled = true;
      return e;
    });
    await sleep(3_000);
    expect(settled, "no ready local target: the window does not arm, the call keeps retrying").toBe(false);
    expect(gets).toBe(0);
    expect(posts).toBeGreaterThanOrEqual(2);
    ac.abort();
    await pending;
  }, 30_000);

  it("UNARMED, a real closed port, no ready local profile (Required test 5): the old ECONNREFUSED budget, after at least the old retry time", async () => {
    const f = readyFixture({ binary: false });
    setNetworkGiveUpOverrideS(1);
    const url = await closedPortUrl();
    const clock: RetryClock = { networkGiveUp: makeNetworkGiveUp(f.settings, f.cfgDir, { ...LINUX, env: f.env }) };
    const t0 = Date.now();
    const err = await caught(call(url, clock));
    const elapsed = Date.now() - t0;
    expect(failureOf(err)?.networkCode).toBe("ECONNREFUSED");
    // The existing verdict (REFUSED_TRIES = 2: one backoff of 1 s +- 25 percent), not the window verdict.
    expect(failureOf(err)?.hint).toContain("nothing is listening");
    expect(failureOf(err)?.hint).not.toContain("gave up");
    expect(elapsed).toBeGreaterThanOrEqual(700);
  }, 30_000);

  it("no clock window at all (the default for every dispatch that does not set one): byte-for-byte the existing verdict", async () => {
    const url = await closedPortUrl();
    const err = await caught(call(url, {}));
    expect(failureOf(err)?.hint).toContain("nothing is listening");
  }, 30_000);
});
