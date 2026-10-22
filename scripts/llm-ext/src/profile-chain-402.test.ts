/**
 * fix-queue rows 102 / 27 (C5, C5b) — a raw provider 402 at the three sites
 * that skip walkProfileChainOnce's chain walk by design (an ensemble slot, a
 * caller-pinned modelOverride, the free-pool rotation) on a DYNAMIC
 * (`free`/`paid`) profile, driven against real local node:http servers (the
 * honest-402.test.ts / dispatch-reload.test.ts recipe) — no mock of index.ts,
 * ensembleStreaming, classifyError, or the completion layer.
 *
 * Row 102 (1), C5b: the pinned model's failure reaches the per-file loop as a
 * ProfileExhaustedError carrying the real error in `causes`, and classifyError
 * keys its verdict on that cause — a 402 aborts the batch with no retry, a 413
 * for one oversized file fails only that file.
 *
 * Row 27 asks for design §3.3's two runtime rows (report
 * reports/llm-ext-release/20260918_063842+0200-p14.1-rows104-27.md, Q2).
 * `paid` is reached through chatCompletionWithProfileFallback (a non-free_only
 * dynamic profile never builds a free-rotation pool); `free` through the
 * free-pool rotation (buildFreeRotationPool intercepts first on every real
 * free_only profile), which until D2 triggered no update at all (the C5b
 * "KNOWN GAP").
 *
 * D2 (USER 2026-09-18): when every model of a DYNAMIC profile fails, the
 * command starts the profile's background update and fails with ONE
 * retry-later message -- no wait, no second walk -- unless the failure is one
 * an update cannot fix: a paid profile whose every cause is a certain 402
 * keeps the credit verdict, any all-401 (or 401 + 402) exhaustion keeps the
 * key error, and a failure specific to one request fails only that file.
 * The background job is observed, never run: the detached child's script is a
 * marker (resolveBenchmarkScriptPath is the only thing replaced in
 * bench-spawn.ts), so the REAL requestProfileUpdate, lock and spawn decide.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATIC_PROFILE_EXHAUSTED_MESSAGE,
  dynamicProfileRetryLaterMessage,
} from "./profile-fallback.js";

const { maintainDynamicProfilesMock, marker } = vi.hoisted(() => ({
  maintainDynamicProfilesMock: vi.fn(async () => false),
  marker: { script: "", dir: "" },
}));

// A spy, never called: D2 says no command runs the maintainer in-process.
vi.mock("./dynamic-maintainer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dynamic-maintainer")>();
  return { ...actual, maintainDynamicProfiles: maintainDynamicProfilesMock };
});

// Every detached child (the end-of-dispatch detector, a requested update) runs
// this marker instead of the real benchmark entrypoint: it records whether it
// was started as a REQUESTED update, holds its lock briefly, and exits.
vi.mock("./bench-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bench-spawn")>();
  return { ...actual, resolveBenchmarkScriptPath: () => marker.script };
});

let server: Server | undefined;
afterEach(async () => {
  server?.close();
  server = undefined;
  maintainDynamicProfilesMock.mockClear();
  vi.restoreAllMocks();
  // Let marker children record themselves and exit before their dirs go.
  await new Promise((r) => setTimeout(r, 700));
});

/** Point every detached child of the next dispatch at a fresh marker. */
function installMarker(): void {
  marker.dir = tempDir("marker");
  marker.script = join(marker.dir, "marker.js");
  writeFileSync(
    marker.script,
    `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(${JSON.stringify(marker.dir)}, process.pid + ".json"),
  JSON.stringify({ requested: process.env.LLM_EXT_PROFILE_UPDATE_REQUESTED ?? null }));
setTimeout(() => process.exit(0), 400);
`,
  );
}

/** How many REQUESTED background updates were started since installMarker. */
async function requestedUpdates(): Promise<number> {
  await new Promise((r) => setTimeout(r, 600));
  return readdirSync(marker.dir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => (JSON.parse(readFileSync(join(marker.dir, f), "utf-8")) as { requested: string | null }).requested === "1")
    .length;
}

/** Every POST 402s; GETs (the getModelSupportedParams probe) 404 harmlessly.
 *  Same shape as honest-402.test.ts's start402Server, duplicated here rather
 *  than imported -- that file's copy is a describe-scoped local, not a shared
 *  export, and this file must isolate its own request counts anyway. */
async function start402Server() {
  let postCount = 0;
  const modelsRequested: string[] = [];
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    postCount++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { model?: unknown };
        if (typeof body.model === "string") modelsRequested.push(body.model);
      } catch {
        // not JSON / no model field -- nothing to record
      }
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Insufficient credits" } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    postCount: () => postCount,
    modelsRequested: () => [...modelsRequested],
  };
}

/** Redirects every real `fetch` call to the local 402 server, ignoring
 *  whatever URL the profile itself resolved (openrouter.ai) -- the same
 *  redirect honest-402.test.ts's own Path-3 test uses, so this is a genuine
 *  loopback round trip, not a mock of the completion layer. */
function redirectFetchTo(url: string) {
  const realFetch = globalThis.fetch;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((_input: unknown, init?: RequestInit) =>
      realFetch(`${url}/v1/chat/completions`, init),
    );
}

/** A POST whose body contains `marker` gets a 413 (that one file is too
 *  large for the model -- a failure specific to the request, not the
 *  service); every other POST gets a normal completion. `requestsFor(true)`
 *  counts the marker POSTs, `requestsFor(false)` the rest. */
async function startPerFileServer(marker: string) {
  let markerPosts = 0;
  let otherPosts = 0;
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (body.includes(marker)) {
        markerPosts++;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Request too large for this model" } }));
        return;
      }
      otherPosts++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "stub",
          choices: [{ message: { role: "assistant", content: "No bugs found." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requestsFor: (hasMarker: boolean) => (hasMarker ? markerPosts : otherPosts),
  };
}

/** Answers each POST with `respond(model, rawBody)`: "ok" for a normal
 *  completion, or an error [status, message]. Counts POSTs per requested
 *  model, so a test can prove exactly how often each chain entry was asked. */
async function startScriptedServer(respond: (model: string, body: string) => "ok" | [number, string]) {
  const posts = new Map<string, number>();
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      let model = "";
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === "string") model = parsed.model;
      } catch {
        // not JSON / no model field -- counted under ""
      }
      posts.set(model, (posts.get(model) ?? 0) + 1);
      const answer = respond(model, body);
      if (answer === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model,
            choices: [{ message: { role: "assistant", content: "No bugs found." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(answer[0], { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: answer[1] } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return { url: `http://127.0.0.1:${addr.port}`, postsFor: (model: string) => posts.get(model) ?? 0 };
}

// The run's own TMPDIR (os.tmpdir(), which the isolated-run recipe points
// under /tmp), and a prefix that does NOT match /llm[-_]?ext/i:
// src/test-tmpdir-guard.ts flags any such new /tmp entry as a concurrent
// run's leak, and a killed run used to strand "llm-ext-c5-*" folders there.
// Plain "/tmp" only when os.tmpdir() is outside it (macOS's default
// /var/folders/...), because getConfigDir() (config.ts) refuses a config dir
// outside $HOME or /tmp. Everything is removed in afterEach.
const TMP_ROOT =
  process.platform === "win32" || realpathSync(tmpdir()).startsWith(`${realpathSync("/tmp")}/`)
    ? tmpdir()
    : "/tmp";
const TMP_PREFIX = join(TMP_ROOT, "chain402-");
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(kind: string): string {
  const dir = mkdtempSync(`${TMP_PREFIX}${kind}-`);
  created.push(dir);
  return dir;
}

// D3c-1 fix-up (TRDD-FDI9NYAS): every model this file's DYNAMIC (`free`/
// `paid`) profiles route through is auto-picked from resolveConnection's
// point of view (manualModels is empty for a dynamic profile -- D3b), so the
// D3c send-time price check now applies to every one of them. This file's
// whole point is exercising the HTTP-level 402/413/404/401 behaviour, not
// pricing -- so every id it ever sends needs a recorded price under the
// $1.3/M default ceiling, or the price gate refuses it before a single byte
// reaches the local mock server (postCount stays 0, not the count the test
// asserts). `:free` ids get "0"/"0", matching OpenRouter's real pricing for
// them; the rest get a token amount comfortably under the ceiling, same
// value honest-402.test.ts already seeds for the same reason.
const PRICED_MODEL_IDS = [
  "vendor/paid-head",
  "vendor/paid-a",
  "vendor/paid-b",
  "vendor/free-a:free",
  "vendor/free-b:free",
  "vendor/free-c:free",
];
async function seedCatalogCache(cfgDir: string): Promise<void> {
  const { HIGH_QUALITY_MODEL_DEFAULTS } = await import("./config.js");
  writeFileSync(
    join(cfgDir, "catalog-cache.json"),
    JSON.stringify({
      fetchedAtMs: Date.now(),
      models: [
        ...PRICED_MODEL_IDS.map((id) => ({
          id,
          pricing: id.endsWith(":free")
            ? { prompt: "0", completion: "0" }
            : { prompt: "0.0000005", completion: "0.0000005" },
        })),
        { id: HIGH_QUALITY_MODEL_DEFAULTS.id, pricing: { prompt: "0.0000005", completion: "0.0000005" } },
      ],
    }),
    "utf-8",
  );
}

/** index.ts reads settings once at module import; a fresh re-import per
 *  scenario against a throwaway config dir (loadFreshIndex recipe shared by
 *  honest-402.test.ts / dispatch-reload.test.ts / default-profile-wiring.test.ts). */
async function loadFreshIndex(settingsYaml: string) {
  const cfgDir = tempDir("cfg");
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
  await seedCatalogCache(cfgDir);
  const prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  // D5: the bai-reserved-seed migration seeds `ensemble.reserved` into a
  // fresh config dir's `free` section whenever $BAI_API_KEY resolves — the
  // ambient key on this machine is real, so without this pin every fixture
  // below silently gains a reserved slot at boot: getEnsembleModels' D-L
  // gate opens (reserved non-empty), the fan-out replaces the single-model
  // free path these fixtures were written to exercise, and glm-5.3-flash
  // takes one of the three seats. The seeded-slot behaviour itself is pinned
  // in profile-migration.test.ts; here the fixtures must stay as written.
  const prevBaiKey = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  const idx = await import("./index.js");
  await idx.boot();
  return {
    idx,
    cfgDir,
    cleanup: () => {
      if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
      if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
      else process.env.BAI_API_KEY = prevBaiKey;
    },
  };
}

function folderWithOneFile(): string {
  const dir = tempDir("folder");
  writeFileSync(join(dir, "a.txt"), "hello world\n", "utf-8");
  return dir;
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

// A DYNAMIC `paid` profile (freeOnly:false) -- `isFreeModeActive()` is false,
// so ensembleStreaming's `pool = freeMode ? buildFreeRotationPool(...) : []`
// (index.ts:2896) is unconditionally [], and the single-model path falls
// straight into chatCompletionWithProfileFallback (index.ts:2907).
const PAID_YAML = `active: paid
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  paid:
    mode: remote
    api: openrouter-remote
    model: vendor/paid-head
    paid_models: [vendor/paid-a, vendor/paid-b]
    api_key: "sk-test-fake-openrouter-key"
`;

// A DYNAMIC `free` profile, mode: remote (NOT remote-ensemble) -- getEnsembleModels()
// returns [] whenever mode !== "remote-ensemble" (index.ts:3319), so
// ensembleStreaming's single-model path runs even though scan_folder's own
// useEnsemble defaults true for an openrouter backend; freeMode is true
// (free_only), so buildFreeRotationPool (index.ts:2361) builds the pool and
// callSingleWithFreeRotation is used -- the free-pool-rotation bypass site.
const FREE_POOL_YAML = `active: free
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  free:
    mode: remote
    api: openrouter-remote
    free_only: true
    free_models: [vendor/free-a:free, vendor/free-b:free]
    model: vendor/free-a:free
    api_key: "sk-test-fake-openrouter-key"
`;

// Same DYNAMIC `free` profile, mode: remote-ensemble -- getEnsembleModels()
// now returns the free pool's top 3 (index.ts:3339, selectFreeEnsembleModels
// with a cold catalog + no benchmark record is lenient and keeps every id),
// so ensembleStreaming runs the 3-model ensemble branch and each slot goes
// through callEnsembleSlotWithRotation (index.ts:2982) -- the ensemble-slot
// bypass site.
const ENSEMBLE_FREE_YAML = `active: free
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  free:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: [vendor/free-a:free, vendor/free-b:free, vendor/free-c:free]
    model: vendor/free-a:free
    api_key: "sk-test-fake-openrouter-key"
`;

describe("Row 102 (1) — caller-pinned modelOverride bypass, DYNAMIC `paid` profile", () => {
  it(
    "high_quality_scan's pinned model 402s: the batch aborts service-level with the exhaustion sentence and the credit verdict, the dead model is asked exactly once, and nothing else is ever requested",
    async () => {
      const { url, postCount, modelsRequested } = await start402Server();
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(PAID_YAML);
      const fetchSpy = redirectFetchTo(url);
      let validated: typeof import("./benchmark/validated.js") | undefined;
      try {
        validated = await import("./benchmark/validated.js");
        validated.setValidationBypassForTests(true);
        const folder = folderWithOneFile();
        const result = await idx.dispatchCallTool("high_quality_scan", {
          folder_path: folder,
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        // high_quality_scan runs scan_folder's per-file loop, so the
        // ProfileExhaustedError from ensembleStreaming's modelOverride catch
        // goes through classifyError, which keys on its cause (C5b): a 402 is
        // service-level, so the loop aborts the batch instead of retrying.
        expect(result.isError, `must abort the batch. text:\n${text}`).toBe(true);
        expect(text).toContain(STATIC_PROFILE_EXHAUSTED_MESSAGE);
        expect(text).toMatch(/credit exhausted/i);
        expect(text).not.toContain("switching");
        // A caller-pinned model is not "the profile's models": it never
        // reaches failDynamicProfile -- proven for a profile that IS dynamic.
        expect(text).not.toContain(dynamicProfileRetryLaterMessage("paid"));
        expect(maintainDynamicProfilesMock).not.toHaveBeenCalled();
        expect(await requestedUpdates()).toBe(0);
        // Zero retries of the dead model: the completion layer never re-asks
        // on a deterministic 402, and the per-file loop no longer does either
        // (before C5b: one POST per per-file attempt, 3 in all).
        expect(postCount()).toBe(1);
        // The one request went to the pinned high-quality model -- never one
        // of the profile's own chain entries, never a ':free' id.
        const { HIGH_QUALITY_MODEL_DEFAULTS } = await import("./config.js");
        expect(modelsRequested()).toEqual([HIGH_QUALITY_MODEL_DEFAULTS.id]);
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        validated?.setValidationBypassForTests(false);
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    30_000,
  );

  it(
    "a pinned-model failure specific to ONE file (413 too large) fails only that file, without a retry, and the other files still complete",
    async () => {
      const { url, requestsFor } = await startPerFileServer("OVERSIZED-MARKER");
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(PAID_YAML);
      const fetchSpy = redirectFetchTo(url);
      let validated: typeof import("./benchmark/validated.js") | undefined;
      try {
        validated = await import("./benchmark/validated.js");
        validated.setValidationBypassForTests(true);
        const folder = tempDir("folder");
        writeFileSync(join(folder, "a.txt"), "OVERSIZED-MARKER\n", "utf-8");
        writeFileSync(join(folder, "b.txt"), "fine one\n", "utf-8");
        writeFileSync(join(folder, "c.txt"), "fine two\n", "utf-8");
        const result = await idx.dispatchCallTool("high_quality_scan", {
          folder_path: folder,
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        // Same ProfileExhaustedError type as the 402 above -- only its cause
        // differs, and the cause is what decides: a 413 is this request's
        // problem, not the service's, so it must not abort the batch.
        expect(result.isError, `must not abort the batch. text:\n${text}`).toBe(false);
        expect(text).toContain("2 processed, 1 failed, 0 skipped");
        expect(text).not.toMatch(/ABORTED/);
        const failedLine = text.split("\n").find((l) => l.includes("/a.txt: "));
        expect(failedLine, `a.txt must be listed as failed. text:\n${text}`).toContain(
          STATIC_PROFILE_EXHAUSTED_MESSAGE,
        );
        expect(failedLine).toContain("(HTTP 413)");
        expect(failedLine).not.toMatch(/Failed after \d+ retries/);
        // One chatCompletionWithRetry call for a.txt (its own same-model
        // retries of a 413 are the completion layer's policy, at most 1+3);
        // a per-file retry would have doubled or tripled that.
        expect(requestsFor(true)).toBeGreaterThan(0);
        expect(requestsFor(true)).toBeLessThanOrEqual(4);
        expect(requestsFor(false)).toBe(2);
      } finally {
        validated?.setValidationBypassForTests(false);
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    30_000,
  );
});

describe("Row 102 (2) + Row 27 `free` row — free-pool-rotation bypass, DYNAMIC `free` profile (mode: remote)", () => {
  it(
    "every free_models entry 402s: the batch aborts on the retry-later message, ONE background update starts, and only the profile's own free_models are ever requested",
    async () => {
      const { url, postCount, modelsRequested } = await start402Server();
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(FREE_POOL_YAML);
      const fetchSpy = redirectFetchTo(url);
      try {
        const folder = folderWithOneFile();
        const result = await idx.dispatchCallTool("scan_folder", {
          folder_path: folder,
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        expect(result.isError, `must abort, not silently succeed. text:\n${text}`).toBe(true);
        // D2 item 6 (the Row 27 `free` KNOWN GAP closed): on `free` a 402
        // means "no longer free", so the update IS the fix -- the retry-later
        // outcome, never the credit verdict, and never "switching".
        expect(text).toContain(dynamicProfileRetryLaterMessage("free"));
        expect(text).not.toMatch(/credit exhausted/i);
        expect(text).not.toContain("switching");
        expect(maintainDynamicProfilesMock, "the update runs in the background, never in-process").not.toHaveBeenCalled();
        expect(await requestedUpdates(), "free-pool exhaustion starts exactly one background update").toBe(1);
        const requested = modelsRequested();
        expect(
          requested.every((m) => m === "vendor/free-a:free" || m === "vendor/free-b:free"),
          `every requested model must be inside the configured free_models pool. requested: ${requested.join(", ")}`,
        ).toBe(true);
        // D1: a certain 402 skips to the pool's NEXT entry (the free pool is
        // this profile's chain) -- each model asked exactly once, no retry.
        // Before D1 the rotation re-threw the first 402 and free-b was never
        // tried (1 POST).
        // D4 amendment: the whole pool shares ONE credential (the
        // profile-level api_key), so the FIRST 402 marks that url+keyRef
        // dead and every later entry is skipped without a request — 1 POST
        // total. The outcome is unchanged (retry-later, one background
        // update); only the wasted requests are gone.
        expect(postCount()).toBe(1);
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    30_000,
  );
});

describe("Row 102 (3) — ensemble-slot bypass, DYNAMIC `free` profile (mode: remote-ensemble)", () => {
  it(
    "every ensemble slot's free pool 402s: no slot answered, so the ensemble fails with the retry-later message (never a silent partial success), ONE background update starts, and only the configured free_models are ever requested",
    async () => {
      const { url, postCount, modelsRequested } = await start402Server();
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(ENSEMBLE_FREE_YAML);
      const fetchSpy = redirectFetchTo(url);
      try {
        const folder = folderWithOneFile();
        const result = await idx.dispatchCallTool("scan_folder", {
          folder_path: folder,
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        expect(result.isError, `must abort, not silently succeed. text:\n${text}`).toBe(true);
        // callEnsembleSlotWithRotation absorbs AllFreeModelsExhaustedError PER
        // SLOT into an error-content result; once EVERY slot failed,
        // ensembleStreaming's "no slot answered" branch hands the slot errors
        // to failDynamicProfile (D2 item 10) -- on `free` a 402 is no reason
        // to skip the update, so: retry-later, not the credit verdict.
        expect(text).toContain(dynamicProfileRetryLaterMessage("free"));
        expect(text).not.toMatch(/credit exhausted/i);
        expect(text).not.toContain("switching");
        expect(maintainDynamicProfilesMock).not.toHaveBeenCalled();
        expect(await requestedUpdates()).toBe(1);
        const pool = new Set(["vendor/free-a:free", "vendor/free-b:free", "vendor/free-c:free"]);
        const requested = modelsRequested();
        expect(requested.length).toBeGreaterThan(0);
        expect(
          requested.every((m) => pool.has(m)),
          `every requested model must be inside the configured free_models pool. requested: ${requested.join(", ")}`,
        ).toBe(true);
        expect(postCount()).toBeGreaterThan(0);
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    30_000,
  );
});

// Two loopback chain walks with no breaker pause (D1): measured 188ms / 71ms /
// 26ms on the as-is / no-keys / b.ai-only legs (2026-09-18). It was 90_000
// around the breaker's 60s sleep (60.1s on all three legs, C5b report).
const TIMEOUT_ROW27_PAID_MS = 15_000;

describe("Row 27 `paid` row — chatCompletionWithProfileFallback on a DYNAMIC `paid` profile (D2)", () => {
  it(
    "every paid_models entry answers a certain 402: ONE walk, the credit verdict after STATIC_PROFILE_EXHAUSTED_MESSAGE, and NO update (USER: credit error, no update)",
    async () => {
      const { url, postCount, modelsRequested } = await start402Server();
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(PAID_YAML);
      const fetchSpy = redirectFetchTo(url);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let validated: typeof import("./benchmark/validated.js") | undefined;
      try {
        // `chat` hits the IRON RULE model-validation gate on every call; without
        // this bypass every request fails client-side ("model ... is not
        // validated for chat") and never reaches the local 402 server. D1: a
        // payment error never feeds the circuit breaker, so the walk is
        // loopback-fast.
        validated = await import("./benchmark/validated.js");
        validated.setValidationBypassForTests(true);
        const folder = folderWithOneFile();
        const t0 = Date.now();
        // `chat` calls ensembleStreaming exactly ONCE per file group, with no
        // per-file retry loop around it, so a thrown ProfileExhaustedError
        // reaches dispatchCallTool's own verbatim branch.
        const result = await idx.dispatchCallTool("chat", {
          input_files_paths: [join(folder, "a.txt")],
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        expect(result.isError, `must abort, not silently succeed. text:\n${text}`).toBe(true);
        expect(text).toMatch(STATIC_PROFILE_EXHAUSTED_MESSAGE);
        expect(text).not.toMatch(/^Error: API error 402/);
        const stderrLines = stderrSpy.mock.calls.map((c) => String(c[0]));
        expect(
          `${text}${stderrLines.join("")}`,
          "a credit problem is no reason to say an update is coming",
        ).not.toContain(dynamicProfileRetryLaterMessage("paid"));
        expect(maintainDynamicProfilesMock).not.toHaveBeenCalled();
        expect(await requestedUpdates(), "a paid benchmark would 402 too: no update").toBe(0);
        // ONE walk: head + 2 paid_models = 3 ids — but under D4 all three
        // share ONE credential (the profile-level api_key), so the FIRST 402
        // marks that url+keyRef dead and the remaining entries are skipped
        // without a request (batch abort, every group credit-dead — C8).
        // The credit verdict is unchanged; only the wasted POSTs are gone.
        const requested = modelsRequested();
        expect(requested.length).toBe(1);
        expect(
          requested.every(
            (m) => m === "vendor/paid-head" || m === "vendor/paid-a" || m === "vendor/paid-b",
          ),
          `every requested model must be inside the configured chain. requested: ${requested.join(", ")}`,
        ).toBe(true);
        expect(requested.every((m) => !m.endsWith(":free"))).toBe(true);
        expect(postCount()).toBe(1);
        expect(fetchSpy).toHaveBeenCalled();
        expect(
          stderrLines.some((l) => l.includes("[circuit-breaker]")),
          `a payment error must never trip the breaker. lines:\n${stderrLines.join("")}`,
        ).toBe(false);
        expect(Date.now() - t0).toBeLessThan(10_000);
      } finally {
        validated?.setValidationBypassForTests(false);
        stderrSpy.mockRestore();
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    TIMEOUT_ROW27_PAID_MS,
  );
});

// D4 review F4: the cause a certain-402 leaves on the exhaustion is EXACTLY
// the USER credit template — the raw provider error is MOVED to stderr, not
// appended to the cause ("(raw: …)" would leak provider error text into a
// message users match on). The stderr line is the raw error's only surface.
describe("D4 review F4 — the 402 cause is the exact USER template, the raw error goes to stderr", () => {
  it(
    "a certain 402 on a dynamic paid profile writes the raw error to stderr and never appends '(raw:' to a cause",
    async () => {
      const { url } = await start402Server();
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(PAID_YAML);
      const fetchSpy = redirectFetchTo(url);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let validated: typeof import("./benchmark/validated.js") | undefined;
      try {
        validated = await import("./benchmark/validated.js");
        validated.setValidationBypassForTests(true);
        const folder = folderWithOneFile();
        const result = await idx.dispatchCallTool("chat", {
          input_files_paths: [join(folder, "a.txt")],
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        expect(result.isError, `must abort on the credit verdict. text:\n${text}`).toBe(true);
        // The raw provider error reached stderr through the walk's own line.
        const stderrLines = stderrSpy.mock.calls.map((c) => String(c[0]));
        expect(
          stderrLines.some((l) => l.includes("failed with:") && l.toLowerCase().includes("insufficient credits")),
          `the walk must log the raw error to stderr. lines:\n${stderrLines.join("")}`,
        ).toBe(true);
        // And the cause stays the exact template: no "(raw:" anywhere.
        expect(text).not.toContain("(raw:");
        expect(stderrLines.join("")).not.toContain("(raw:");
      } finally {
        validated?.setValidationBypassForTests(false);
        stderrSpy.mockRestore();
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    TIMEOUT_ROW27_PAID_MS,
  );
});

/** The same DYNAMIC `paid` profile with a chain of `ids` (head first). A
 *  401 or a 413 is retried 3 times by the completion layer and COUNTS toward
 *  the 60 s circuit breaker (5 in a row; unchanged by D1/D2, which exempt
 *  only payment errors) -- so the 401/413 cases keep their chains short
 *  enough never to trip it. */
function paidYaml(ids: string[]): string {
  return PAID_YAML.replace("model: vendor/paid-head", `model: ${ids[0]}`).replace(
    "paid_models: [vendor/paid-a, vendor/paid-b]",
    `paid_models: [${ids.slice(1).join(", ")}]`,
  );
}

/** scan_folder on a DYNAMIC `paid` profile (default chain [vendor/paid-head,
 *  paid-a, paid-b]), every POST answered by `respond`. */
async function scanFolderOnPaid(
  respond: (model: string, body: string) => "ok" | [number, string],
  files: Record<string, string> = { "a.txt": "hello world\n" },
  yaml: string = PAID_YAML,
) {
  const srv = await startScriptedServer(respond);
  installMarker();
  const { idx, cleanup } = await loadFreshIndex(yaml);
  const fetchSpy = redirectFetchTo(srv.url);
  const validated = await import("./benchmark/validated.js");
  validated.setValidationBypassForTests(true);
  try {
    const folder = tempDir("folder");
    for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content, "utf-8");
    const result = await idx.dispatchCallTool("scan_folder", {
      folder_path: folder,
      instructions: "find bugs",
      output_dir: tempDir("out"),
    });
    return { result, text: textOf(result), postsFor: srv.postsFor };
  } finally {
    validated.setValidationBypassForTests(false);
    fetchSpy.mockRestore();
    cleanup();
    // A test may call this twice; the module-level `server` holds only the last.
    server?.close();
    server = undefined;
  }
}

describe("D2 item 11 — scan_folder's per-file path on a DYNAMIC `paid` profile", () => {
  it(
    "402 + 404 across the chain (not every cause a credit error): the retry-later message, ONE background update, ONE walk",
    async () => {
      // D4: the chain needs a SECOND credential or the first 402 marks the
      // one shared url+keyRef dead and the 404 arm is unreachable. The
      // profile-level key keeps serving the head; a providers[] group with
      // its own key (D6a: user-owned on `paid`) serves paid-a/paid-b, so a
      // 402 on the head does not silence the 404 arm.
      const yaml = PAID_YAML.replace(
        '    api_key: "sk-test-fake-openrouter-key"',
        `    api_key: "sk-test-fake-openrouter-key"
    providers:
      - name: alt-key
        api: openrouter-remote
        api_key: "sk-test-fake-openrouter-key-2"
        models: [vendor/paid-a, vendor/paid-b]`,
      );
      const { result, text, postsFor } = await scanFolderOnPaid(
        (model) =>
          model === "vendor/paid-a" ? [404, "No endpoints found for vendor/paid-a"] : [402, "Insufficient credits"],
        undefined,
        yaml,
      );
      expect(result.isError, `the batch must abort. text:\n${text}`).toBe(true);
      expect(text).toContain(dynamicProfileRetryLaterMessage("paid"));
      expect(text).not.toMatch(/credit exhausted/i);
      expect(await requestedUpdates()).toBe(1);
      expect(maintainDynamicProfilesMock).not.toHaveBeenCalled();
      // One walk: head 402s (its own key), paid-a 404s on the alt-key group,
      // paid-b is skipped (a model-level failure on paid-a skips the id's
      // remaining groups; paid-b keeps its own entry on the alt key — but the
      // 402+404 mix already exhausts the abort rule: retry-later).
      expect(postsFor("vendor/paid-head")).toBe(1);
      expect(postsFor("vendor/paid-a")).toBe(1);
    },
    30_000,
  );

  it(
    "every cause a certain 402: the credit verdict, NO background update, ONE walk",
    async () => {
      const { result, text, postsFor } = await scanFolderOnPaid(() => [402, "Insufficient credits"]);
      expect(result.isError).toBe(true);
      expect(text).toContain(STATIC_PROFILE_EXHAUSTED_MESSAGE);
      expect(text).toMatch(/credit exhausted/i);
      expect(text).not.toContain(dynamicProfileRetryLaterMessage("paid"));
      expect(await requestedUpdates()).toBe(0);
      // D4: one credential for the whole chain — the first 402 marks it dead
      // and the rest of the walk is skipped without a request (C8: every
      // group that serves a chain entry is credit-dead).
      expect(postsFor("vendor/paid-head")).toBe(1);
      expect(postsFor("vendor/paid-b")).toBe(0);
    },
    30_000,
  );

  it(
    "every cause a 401, or a 401 + 402 mix (COORDINATOR DEFAULT): the key error, never the credit verdict, NO background update",
    async () => {
      const all401 = await scanFolderOnPaid(() => [401, "User not found"], undefined, paidYaml(["vendor/paid-head"]));
      expect(all401.result.isError).toBe(true);
      expect(all401.text).toContain(`${STATIC_PROFILE_EXHAUSTED_MESSAGE} (HTTP 401)`);
      expect(await requestedUpdates()).toBe(0);

      const mixed = await scanFolderOnPaid(
        (model) => (model === "vendor/paid-head" ? [401, "User not found"] : [402, "Insufficient credits"]),
        undefined,
        paidYaml(["vendor/paid-head", "vendor/paid-a"]),
      );
      expect(mixed.result.isError).toBe(true);
      expect(mixed.text).toContain(`${STATIC_PROFILE_EXHAUSTED_MESSAGE} (HTTP 401)`);
      expect(mixed.text).not.toMatch(/credit exhausted/i);
      expect(mixed.text).not.toContain(dynamicProfileRetryLaterMessage("paid"));
      expect(await requestedUpdates()).toBe(0);
    },
    30_000,
  );

  it(
    "a failure specific to ONE file on every model (413): only that file fails, the batch goes on, NO background update",
    async () => {
      const { result, text } = await scanFolderOnPaid(
        (_model, body) => (body.includes("OVERSIZED-MARKER") ? [413, "Request too large for this model"] : "ok"),
        { "a.txt": "OVERSIZED-MARKER\n", "b.txt": "fine one\n", "c.txt": "fine two\n" },
        paidYaml(["vendor/paid-head"]),
      );
      expect(result.isError, `must not abort the batch. text:\n${text}`).toBe(false);
      expect(text).toContain("2 processed, 1 failed, 0 skipped");
      const failedLine = text.split("\n").find((l) => l.includes("/a.txt: "));
      expect(failedLine).toContain(`${STATIC_PROFILE_EXHAUSTED_MESSAGE} (HTTP 413)`);
      expect(await requestedUpdates()).toBe(0);
    },
    30_000,
  );
});

describe("D2 items 3 and 10 — a profile that still answers gets no message and no update", () => {
  it(
    "an ensemble where ONE slot answers is not 'all models failing': the result is the answer, no retry-later, no update",
    async () => {
      const srv = await startScriptedServer((model) => (model === "vendor/free-a:free" ? "ok" : [402, "Insufficient credits"]));
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(ENSEMBLE_FREE_YAML);
      const fetchSpy = redirectFetchTo(srv.url);
      try {
        const result = await idx.dispatchCallTool("scan_folder", {
          folder_path: folderWithOneFile(),
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        expect(result.isError, `one slot answered. text:\n${text}`).toBe(false);
        expect(text).not.toContain(dynamicProfileRetryLaterMessage("free"));
        expect(await requestedUpdates()).toBe(0);
      } finally {
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    30_000,
  );

  it(
    "while the profile's background update runs, a command whose model answers gets its normal result and not a word about the update",
    async () => {
      const srv = await startScriptedServer(() => "ok");
      installMarker();
      const { idx, cleanup } = await loadFreshIndex(FREE_POOL_YAML);
      const fetchSpy = redirectFetchTo(srv.url);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const { backgroundUpdateLockPathFor } = await import("./default-profiles-runner.js");
      const { claimBenchLock, commitBenchLock, releaseBenchLock } = await import("./bench-lock.js");
      // An update is running: the profile's lock is held by a live process.
      const lockPath = backgroundUpdateLockPathFor("free");
      expect(claimBenchLock(lockPath, Date.now(), () => {}).ok).toBe(true);
      commitBenchLock(lockPath, process.pid);
      try {
        const result = await idx.dispatchCallTool("scan_folder", {
          folder_path: folderWithOneFile(),
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const text = textOf(result);
        expect(result.isError, `the model answered. text:\n${text}`).toBe(false);
        const said = `${text}${stderrSpy.mock.calls.map((c) => String(c[0])).join("")}`;
        expect(said).not.toContain(dynamicProfileRetryLaterMessage("free"));
        expect(said).not.toMatch(/updat(e|ing) the profile/i);
        expect(await requestedUpdates()).toBe(0);
      } finally {
        releaseBenchLock(lockPath);
        stderrSpy.mockRestore();
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    30_000,
  );
});

describe("D3c-1 fix-up (TRDD-FDI9NYAS) — a send-time price refusal on a DYNAMIC chain entry", () => {
  it(
    "an over-ceiling/unpriced entry is skipped to the next chain entry immediately: no request, no retry, no breaker trip, and it answers in well under 1s",
    async () => {
      // vendor/paid-head: priced OVER the $1.3/M default ceiling (never sent).
      // vendor/paid-a: priced fine (answers). vendor/paid-b: never reached.
      const srv = await startScriptedServer(() => "ok");
      installMarker();
      const { idx, cfgDir, cleanup } = await loadFreshIndex(PAID_YAML);
      writeFileSync(
        join(cfgDir, "catalog-cache.json"),
        JSON.stringify({
          fetchedAtMs: Date.now(),
          models: [
            { id: "vendor/paid-head", pricing: { prompt: "0.000005", completion: "0.000005" } }, // $5/M > $1.3/M ceiling
            { id: "vendor/paid-a", pricing: { prompt: "0.0000005", completion: "0.0000005" } },
          ],
        }),
        "utf-8",
      );
      const fetchSpy = redirectFetchTo(srv.url);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const validated = await import("./benchmark/validated.js");
      validated.setValidationBypassForTests(true);
      try {
        const t0 = Date.now();
        const result = await idx.dispatchCallTool("chat", {
          input_files_paths: [join(folderWithOneFile(), "a.txt")],
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const elapsedMs = Date.now() - t0;
        const text = textOf(result);
        // "chat" (no input_files_paths.length===0 branch here, but the
        // per-file group branch below it) leaves isError UNSET on success
        // (only ever set to `true`) -- toBeFalsy(), not toBe(false).
        expect(result.isError, `vendor/paid-a must answer. text:\n${text}`).toBeFalsy();
        // The over-ceiling head never reached the wire; the chain fell straight
        // through to the next entry, which answered.
        expect(srv.postsFor("vendor/paid-head")).toBe(0);
        expect(srv.postsFor("vendor/paid-a")).toBe(1);
        // No retry-storm sleep and no breaker trip -- this used to sleep 60s+
        // once enough refusals accumulated (the regression this fix-up closes).
        expect(elapsedMs).toBeLessThan(1_000);
        const stderrLines = stderrSpy.mock.calls.map((c) => String(c[0]));
        expect(
          stderrLines.some((l) => l.includes("[circuit-breaker]")),
          `a price refusal must never trip the breaker. lines:\n${stderrLines.join("")}`,
        ).toBe(false);
        expect(
          stderrLines.some((l) => l.includes("[model-retry]") && l.includes("vendor/paid-head")),
          `a price refusal must never be retried on the same model. lines:\n${stderrLines.join("")}`,
        ).toBe(false);
      } finally {
        validated.setValidationBypassForTests(false);
        stderrSpy.mockRestore();
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    5_000,
  );

  it(
    "every chain entry unpriced (cold/absent price cache): the retry-later message, one background update, and NOT ONE request ever made ($0 spent)",
    async () => {
      const srv = await startScriptedServer(() => "ok");
      installMarker();
      const { idx, cfgDir, cleanup } = await loadFreshIndex(PAID_YAML);
      // Overwrite the default seeded cache with an EMPTY catalog -- every
      // chain entry (vendor/paid-head/a/b) is now cold/unpriced.
      writeFileSync(
        join(cfgDir, "catalog-cache.json"),
        JSON.stringify({ fetchedAtMs: Date.now(), models: [] }),
        "utf-8",
      );
      const fetchSpy = redirectFetchTo(srv.url);
      const validated = await import("./benchmark/validated.js");
      validated.setValidationBypassForTests(true);
      try {
        const t0 = Date.now();
        const result = await idx.dispatchCallTool("chat", {
          input_files_paths: [join(folderWithOneFile(), "a.txt")],
          instructions: "find bugs",
          output_dir: tempDir("out"),
        });
        const elapsedMs = Date.now() - t0;
        const text = textOf(result);
        expect(result.isError, `every entry must be refused. text:\n${text}`).toBe(true);
        // A prompt, human-readable retry-later sentence -- never a raw
        // stack/exception surfaced straight from resolveConnection's throw.
        expect(text).toContain(dynamicProfileRetryLaterMessage("paid"));
        expect(text).not.toMatch(/^Error: /m);
        expect(await requestedUpdates(), "cold-cache exhaustion starts exactly one background update").toBe(1);
        expect(maintainDynamicProfilesMock).not.toHaveBeenCalled();
        // No API call was made for any of the three entries -- $0 spent.
        expect(srv.postsFor("vendor/paid-head")).toBe(0);
        expect(srv.postsFor("vendor/paid-a")).toBe(0);
        expect(srv.postsFor("vendor/paid-b")).toBe(0);
        expect(elapsedMs).toBeLessThan(1_000);
      } finally {
        validated.setValidationBypassForTests(false);
        fetchSpy.mockRestore();
        cleanup();
      }
    },
    5_000,
  );
});

// A STATIC two-entry chain (not free/paid/local, so no dynamic update and no
// second walk). Only mode remote-ensemble accepts second_model, and on an
// OpenRouter backend that mode fans out as an ensemble instead of walking the
// chain -- so this uses the OpenAI-compatible b.ai preset (backend.type
// "local"), where ensembleStreaming takes its single-model path and a
// non-free_only profile builds no free pool: every call is
// walkProfileChainOnce over [vendor/entry-a, vendor/entry-b]. redirectFetchTo
// sends every request to the one local server, so the two entries are told
// apart by model id -- the only thing classifyError ever sees of them anyway
// (their causes).
const STATIC_CHAIN_YAML = `active: twoentry
allow_paid_models: true
profiles:
  twoentry:
    mode: remote-ensemble
    api: chat-b-ai-remote
    model: vendor/entry-a
    second_model: vendor/entry-b
    api_key: "sk-test-fake-bai-key"
    # D4: entry-b carries its OWN key, so entry-a's 402 marks only the head's
    # credential dead and entry-b stays live (the mixed-402/413 semantics this
    # file pins). One shared key would skip entry-b without a request.
    providers:
      - name: entry-b-key
        api: chat-b-ai-remote
        api_key: "sk-test-fake-bai-key-2"
        models: [vendor/entry-b]
`;

async function scanFolderOnStaticChain(files: Record<string, string>) {
  const { idx, cleanup } = await loadFreshIndex(STATIC_CHAIN_YAML);
  const validated = await import("./benchmark/validated.js");
  validated.setValidationBypassForTests(true);
  try {
    const folder = tempDir("folder");
    for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content, "utf-8");
    const result = await idx.dispatchCallTool("scan_folder", {
      folder_path: folder,
      instructions: "find bugs",
      output_dir: tempDir("out"),
    });
    return { result, text: textOf(result) };
  } finally {
    validated.setValidationBypassForTests(false);
    cleanup();
  }
}

describe("D1 — an uncertain payment-like error on a STATIC chain: one same-model retry, then the next entry", () => {
  it(
    "entry A answers 'payment method declined' (HTTP 400, uncertain) twice: A is asked exactly twice, then B answers and the file succeeds",
    async () => {
      const { url, postsFor } = await startScriptedServer((model) =>
        model === "vendor/entry-a" ? [400, "your payment method was declined"] : "ok",
      );
      const fetchSpy = redirectFetchTo(url);
      try {
        const { result, text } = await scanFolderOnStaticChain({ "a.txt": "hello world\n" });
        expect(result.isError, `must succeed on entry B. text:\n${text}`).toBe(false);
        expect(text).toContain("1 processed, 0 failed");
        // Before D1: 1 + MAX_TRUNCATION_RETRIES(3) = 4 POSTs to A.
        expect(postsFor("vendor/entry-a")).toBe(2);
        expect(postsFor("vendor/entry-b")).toBe(1);
      } finally {
        fetchSpy.mockRestore();
      }
    },
    30_000,
  );
});

// ── 9000b8d follow-ups (A, B): classifyError's verdict on a chain exhaustion ──
// (A) A certain 402 is specific to the provider route that returned it (the
// USER: "skip to the next provider"), so a 402 on one entry plus a failure
// specific to THIS request on another (a 413) must fail only this file.
// (B) A chain that exhausted with no recorded cause (no entry was ever
// tried) must fail fast at service level, not be retried per file.
describe("9000b8d follow-up (A) — mixed causes on a chain exhaustion", () => {
  it(
    "entry A 402s for every file, entry B 413s only for one oversized file: that file fails, the other two complete, the batch is NOT aborted",
    async () => {
      const { url, postsFor } = await startScriptedServer((model, body) => {
        if (model === "vendor/entry-a") return [402, "Insufficient credits"];
        return body.includes("OVERSIZED-MARKER") ? [413, "Request too large for this model"] : "ok";
      });
      const fetchSpy = redirectFetchTo(url);
      try {
        const { result, text } = await scanFolderOnStaticChain({
          "a.txt": "OVERSIZED-MARKER\n",
          "b.txt": "fine one\n",
          "c.txt": "fine two\n",
        });
        expect(result.isError, `must not abort the batch. text:\n${text}`).toBe(false);
        expect(text).toContain("2 processed, 1 failed, 0 skipped");
        expect(text).not.toMatch(/ABORTED/);
        const failedLine = text.split("\n").find((l) => l.includes("/a.txt: "));
        expect(failedLine, `a.txt must be listed as failed. text:\n${text}`).toContain(
          STATIC_PROFILE_EXHAUSTED_MESSAGE,
        );
        expect(failedLine).toContain("(HTTP 413)");
        // A: one request per file (a certain 402 is never retried, and the
        // file-level verdict is never retried per file either).
        expect(postsFor("vendor/entry-a")).toBe(3);
      } finally {
        fetchSpy.mockRestore();
      }
    },
    30_000,
  );

  it("the classifier itself: service level only when EVERY cause is service level (401/402/403/404/410)", async () => {
    const { idx, cleanup } = await loadFreshIndex(STATIC_CHAIN_YAML);
    try {
      // Same module registry as idx (loadFreshIndex reset it), so this is the
      // class index.ts's own instanceof check sees.
      const { ProfileExhaustedError } = await import("./profile-fallback.js");
      const e402 = new Error("API error 402 (openrouter): Insufficient credits");
      const e403 = new Error("API error 403 (openrouter): Access forbidden");
      const e413 = new Error("API error 413 (openrouter): Request too large for this model");
      const e503 = new Error("API error 503 (openrouter): overloaded");
      const verdict = (causes: Error[]) =>
        idx.__classifyErrorForTests(new ProfileExhaustedError("twoentry", "static", causes));

      const all402 = verdict([e402, e402]);
      expect(all402).toMatchObject({ unrecoverable: true, serviceLevel: true });
      expect(all402.reason).toMatch(/credit exhausted/i);

      const mixServiceLevel = verdict([e402, e403]);
      expect(mixServiceLevel).toMatchObject({ unrecoverable: true, serviceLevel: true });
      expect(mixServiceLevel.reason).toMatch(/credit exhausted/i);

      // The 9000b8d defect: any 402 used to abort the batch here.
      const mixFileSpecific = verdict([e402, e413]);
      expect(mixFileSpecific).toMatchObject({ unrecoverable: true, serviceLevel: false });
      expect(mixFileSpecific.reason).toBe(`${STATIC_PROFILE_EXHAUSTED_MESSAGE} (HTTP 413)`);

      // A transient cause keeps the recoverable default, unchanged.
      expect(verdict([e402, e503])).toMatchObject({ unrecoverable: false, serviceLevel: false });
    } finally {
      cleanup();
    }
  });
});

describe("9000b8d follow-up (B) — a chain exhaustion with NO recorded cause", () => {
  it("fails fast at service level with the profile's own sentence, unchanged (static and dynamic)", async () => {
    const { idx, cleanup } = await loadFreshIndex(STATIC_CHAIN_YAML);
    try {
      const { ProfileExhaustedError } = await import("./profile-fallback.js");
      // Before: no branch matched an empty `causes`, so it fell to the
      // recoverable default and every per-file loop retried it up to 3 times.
      expect(idx.__classifyErrorForTests(new ProfileExhaustedError("twoentry", "static", []))).toEqual({
        unrecoverable: true,
        serviceLevel: true,
        reason: STATIC_PROFILE_EXHAUSTED_MESSAGE,
      });
      // D2: a "dynamic" exhaustion IS the retry-later outcome (failDynamicProfile
      // already started the update) -- abort the batch with that one message.
      const { dynamicProfileRetryLaterMessage: retryLater } = await import("./profile-fallback.js");
      expect(idx.__classifyErrorForTests(new ProfileExhaustedError("paid", "dynamic", []))).toEqual({
        unrecoverable: true,
        serviceLevel: true,
        reason: retryLater("paid"),
      });
    } finally {
      cleanup();
    }
  });
});

// D5 pinning-test row, F-gamma (TRDD-90DM5YHO): the "(HTTP undefined)" render.
// classifyError's non-payment arm renders `(HTTP ${lastStatus})`, and
// lastStatus reads the LAST cause. The F-gamma finding feared an undefined
// render; tracing the arm's inputs shows the render is UNREACHABLE with an
// undefined status — reaching `(HTTP ${lastStatus})` requires payment ===
// undefined (no cause is payment-certain) AND every cause passing
// isServiceLevelCause, which (absent a certain payment verdict) requires the
// literal "API error NNN" token in EVERY cause — including the last, whose
// status lastStatus reads. Same argument for the mixed-4xx arm (its
// NON_TRANSIENT_4XX_RE alternative also carries the token). This test pins
// BOTH reachable renders of the arm so the reason shape cannot drift
// silently: (1) the payment-certain cause re-classifies through
// classifyError(payment) — the D4-review F4 template path; (2) the
// non-payment service-level arm renders the LAST cause's status. If a future
// change ever makes an "(HTTP undefined)" render reachable, the verdict
// shapes around it are already pinned here.
describe("D5 pinning row (F-gamma) — the ProfileExhaustedError reason renders", () => {
  it("a template-only certain cause re-classifies through the payment predicate (no status token needed)", async () => {
    const { idx, cleanup } = await loadFreshIndex(STATIC_CHAIN_YAML);
    try {
      const { ProfileExhaustedError } = await import("./profile-fallback.js");
      // The D4-review F4 shape: the cause is the USER template (no
      // "API error NNN" token at all) yet payment-certain, so `payment` is
      // FOUND and the reason re-runs the classifier on it — the credit
      // sentence, verbatim, with no HTTP status anywhere.
      const verdict = idx.__classifyErrorForTests(
        new ProfileExhaustedError(
          "twoentry",
          "static",
          [new Error("Provider b report insufficient credits for using the m model with this key.")],
        ),
      );
      expect(verdict).toMatchObject({ unrecoverable: true, serviceLevel: true });
      expect(verdict.reason).toMatch(/credit exhausted/i);
      expect(verdict.reason).not.toMatch(/HTTP/);
    } finally {
      cleanup();
    }
  });

  it("the non-payment service-level arm renders the LAST cause's status, never undefined (unreachability pinned)", async () => {
    const { idx, cleanup } = await loadFreshIndex(STATIC_CHAIN_YAML);
    try {
      const { ProfileExhaustedError } = await import("./profile-fallback.js");
      const verdict = (causes: Error[]) =>
        idx.__classifyErrorForTests(new ProfileExhaustedError("twoentry", "static", causes));
      // Every cause carries its own "API error NNN" token (the only way into
      // this arm without a certain payment verdict), so the render is the
      // LAST cause's status — a defined one, by construction.
      const nonPayment = verdict([
        new Error("API error 404 (openrouter): model not found"),
        new Error("API error 401 (openrouter): bad key"),
      ]);
      expect(nonPayment).toMatchObject({ unrecoverable: true, serviceLevel: true });
      expect(nonPayment.reason).toBe(`${STATIC_PROFILE_EXHAUSTED_MESSAGE} (HTTP 401)`);
    } finally {
      cleanup();
    }
  });
});
