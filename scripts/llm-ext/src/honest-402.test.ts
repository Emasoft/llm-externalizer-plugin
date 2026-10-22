/**
 * TRDD w2-honest-402 — a profile must not CLAIM a switch to free that never
 * happened, on a 402 (credit exhausted).
 *
 * Two real, independent code sites carried the same shape of bug:
 *
 *  - Path 1 (index.ts): classifyError() on a 402 always called engageAutoFree()
 *    and reported `unrecoverable: false` with a "switching to free model"
 *    reason, even when engageAutoFree could not engage (empty pool). The
 *    per-file retry loop (robustPerFileProcess) then retried the SAME paid
 *    model up to max_retries times — burning requests that could never
 *    succeed, on a false premise.
 *  - Path 2 (free-rotation.ts): withFreeRotation's PAID-mode 402 branch wrote
 *    "switching this command to the free pool" to stderr BEFORE checking
 *    whether the pool was actually non-empty.
 *
 * TRDD-OE27RD7I addendum 4 (USER, no exceptions: "no switching to free models
 * ... must exist anymore") then deleted engageAutoFree() itself, so Path 1's
 * old "(b) control" case — a configured free pool DOES engage, unchanged —
 * no longer holds: a 402 is honest regardless of whether the profile has any
 * free_models at all. Test (b) below asserts that inverted behaviour.
 *
 * These tests exercise the REAL functions against REAL local node:http
 * servers — no mock of index.ts, free-rotation.ts, or the completion layer.
 *
 * Test (a)/(b) call classifyError DIRECTLY (via the test-only export
 * __classifyErrorForTests, the same "private by design" convention already
 * used for getEnsembleModels/etc. in this file) rather than through the full
 * dispatchCallTool -> processFileCheck -> ensembleStreaming ->
 * chatCompletionWithRetry pipeline. This is deliberate, not a shortcut:
 * chatCompletionWithRetry's OWN 402 handler (provider/completion.ts:1064-1095)
 * ALREADY makes a second, independent HTTP attempt against a hard-coded
 * default free model id (FREE_MODEL_ID, "poolside/laguna-m.1:free" unless
 * overridden) whenever backend.type === "openrouter" -- regardless of
 * whether the ACTIVE PROFILE itself has any free_models configured. That
 * fallback is a pre-existing, unrelated mechanism (see its own doc comment:
 * "this single id is only the narrow fallback") and is OUT OF SCOPE for this
 * ticket, which only covers classifyError (Path 1) and withFreeRotation
 * (Path 2). Driving the real error through the real classifier via
 * chatCompletionSimple (the single-attempt primitive chatCompletionWithRetry
 * itself calls in a loop, provider/completion.ts:1060) isolates Path 1's own
 * behaviour and yields a verifiable, exact request count.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletionSimple } from "./provider/completion.js";
import type { BackendConfig, CompletionDeps } from "./provider/types.js";
import { withFreeRotation, type RotatingFetchImpl } from "./free-rotation.js";
import { STATIC_PROFILE_EXHAUSTED_MESSAGE } from "./profile-fallback.js";

const TMP_BASE = process.platform === "win32" ? tmpdir() : "/tmp";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A local server that answers every GET 404 (the getModelSupportedParams
 *  /v1/models/{id}/endpoints probe -- non-fatal, returns null on a non-ok
 *  response) and every POST 402 with a fixed JSON error body. Tracks POST and
 *  GET counts SEPARATELY, per the review requirement to count chat-completion
 *  POSTs only and disclose any additional probe traffic. Also records the
 *  `model` field of every POST body (modelsRequested) — the count alone
 *  cannot prove WHICH model was contacted, and a per-file retry loop
 *  (scan_folder's own, unrelated to this phase — see dispatch-reload.test.ts's
 *  identical caveat) can legitimately re-POST the SAME model more than once. */
async function start402Server() {
  let postCount = 0;
  let getCount = 0;
  const modelsRequested: string[] = [];
  server = createServer((req, res) => {
    if (req.method === "GET") {
      getCount++;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    postCount++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          model?: unknown;
        };
        if (typeof body.model === "string") modelsRequested.push(body.model);
      } catch {
        // Not JSON, or no model field — nothing to record.
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
    modelsRequested: () => [...modelsRequested],
    postCount: () => postCount,
    getCount: () => getCount,
  };
}

function completionDeps(backend: BackendConfig): CompletionDeps {
  return {
    getBackend: () => backend,
    apiHeaders: () => ({ "Content-Type": "application/json" }),
    routeForModel: () => null,
    routeHeaders: () => ({ "Content-Type": "application/json" }),
    getSoftTimeoutMs: () => 10_000,
    isFreeOnly: () => false,
    isLMStudioProvider: () => false,
    // No provenance-exempt model in this suite's fixtures — every model here
    // is treated as auto-picked, same as before manualModels existed.
    getActiveProtocol: () => "openai_api",
    isManualModel: () => false,
    // TRDD-FDI9NYAS D3c: a recorded, well-under-ceiling price so the NEW
    // send-time price check never blocks these 402-handling scenarios (their
    // subject is the credit-error classification, not pricing).
    getModelPricePerMillion: () => ({ inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 0.5 }),
    getEnsemblePriceCeilingUsd: () => 1.3,
    defaultTemperature: 0.7,
    getDefaultMaxTokens: () => 256,
  };
}

/** index.ts reads settings once at module import; re-import fresh against a
 *  throwaway config dir per scenario (same recipe as index.test.ts's
 *  loadFresh / route-headers.test.ts's loadFreshIndex). */
async function loadFreshIndex(settingsYaml: string) {
  const cfgDir = mkdtempSync(join(TMP_BASE, "llm-ext-w2-cfg-"));
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
  const prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  const idx = await import("./index.js");
  return {
    idx,
    cleanup: () => {
      if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
      rmSync(cfgDir, { recursive: true, force: true });
    },
  };
}

const NO_FREE_MODELS_YAML = `active: bare402
allow_paid_models: true
profiles:
  bare402:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "sk-test-fake-openrouter-key"
`;

const WITH_FREE_MODELS_YAML = `active: bare402pool
allow_paid_models: true
profiles:
  bare402pool:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "sk-test-fake-openrouter-key"
    free_models: [vendor/free-a:free, vendor/free-b:free]
`;

describe("Path 1 (index.ts classifyError) — a static profile with no free models", () => {
  it(
    "(a) never claims a switch: exactly one chat-completion POST, unrecoverable=true, honest credit-exhausted reason, no 'switching'",
    async () => {
      const { url, postCount, getCount } = await start402Server();
      const backend: BackendConfig = {
        type: "openrouter",
        billable: true,
        isLocal: false,
        baseUrl: url,
        apiKey: "sk-test-fake-openrouter-key",
        model: "vendor/whatever",
        __version: 1,
      };
      const deps = completionDeps(backend);

      // The REAL error, produced by a REAL HTTP 402 from chatCompletionSimple
      // (the single-attempt primitive) -- not synthesized.
      let caught: unknown;
      try {
        await chatCompletionSimple(
          [{ role: "user", content: "hi" }],
          { model: "vendor/whatever", reasoning: "off" }, // reasoning:"off" -> single ladder rung
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/API error 402\b/);

      // Exactly ONE chat-completion POST reached the server for this call.
      // getModelSupportedParams also probes GET /v1/models/{id}/endpoints for
      // an openrouter backend -- disclosed here, not silently absorbed into
      // the POST count.
      expect(postCount()).toBe(1);
      expect(getCount()).toBeGreaterThanOrEqual(0); // documents the GET probe may fire; never counted as a completion attempt

      const { idx, cleanup } = await loadFreshIndex(NO_FREE_MODELS_YAML);
      try {
        const verdict = idx.__classifyErrorForTests(caught);
        expect(verdict.unrecoverable).toBe(true);
        expect(verdict.serviceLevel).toBe(true); // aborts the WHOLE batch — see index.ts's near-identical per-file retry loops: every remaining file on this profile would hit the identical 402
        expect(verdict.reason).not.toContain("switching");
        expect(verdict.reason).toMatch(/credit exhausted/i);
        expect(verdict.reason).toMatch(/add credits|--profile/i); // names the actual fix
      } finally {
        cleanup();
      }
    },
    30_000,
  );

  it(
    "(b) inverted (TRDD-OE27RD7I addendum 4): a configured free pool no longer changes anything — a 402 is STILL honest, never claims 'switching'",
    async () => {
      const { url } = await start402Server();
      const backend: BackendConfig = {
        type: "openrouter",
        billable: true,
        isLocal: false,
        baseUrl: url,
        apiKey: "sk-test-fake-openrouter-key",
        model: "vendor/whatever",
        __version: 1,
      };
      const deps = completionDeps(backend);

      let caught: unknown;
      try {
        await chatCompletionSimple(
          [{ role: "user", content: "hi" }],
          { model: "vendor/whatever", reasoning: "off" },
          deps,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);

      const { idx, cleanup } = await loadFreshIndex(WITH_FREE_MODELS_YAML);
      try {
        const verdict = idx.__classifyErrorForTests(caught);
        // Before addendum 4, a configured free pool made classifyError engage
        // and report recoverable/"switching to free model". engageAutoFree
        // is deleted outright now — a free pool on the profile changes
        // nothing about how the 402 is classified.
        expect(verdict.unrecoverable).toBe(true);
        expect(verdict.serviceLevel).toBe(true);
        expect(verdict.reason).not.toContain("switching");
        expect(verdict.reason).toMatch(/credit exhausted/i);
      } finally {
        cleanup();
      }
    },
    30_000,
  );
});

describe("Path 2 (free-rotation.ts withFreeRotation) — PAID mode, 402, EMPTY pool", () => {
  it(
    "(c) never claims a switch: the caller gets the ORIGINAL 402 status+body back, and stderr has no 'switching this command' line",
    async () => {
      const { url, postCount } = await start402Server();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const inner: RotatingFetchImpl = async (u, init) => {
          const r = await fetch(u, init as RequestInit);
          const body = await r.text();
          return {
            ok: r.ok,
            status: r.status,
            text: async () => body,
            json: async () => JSON.parse(body) as unknown,
          };
        };
        const wrapped = withFreeRotation(inner, {
          pool: () => [], // EMPTY — the profile defines no free models
          freeActive: () => false, // PAID mode
          now: () => Date.now(),
        });

        const res = await wrapped(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "vendor/whatever", messages: [{ role: "user", content: "hi" }] }),
        });

        expect(res.status).toBe(402);
        const bodyText = await res.text();
        expect(bodyText).toContain("Insufficient credits"); // the ORIGINAL body, untouched
        expect(postCount()).toBe(1); // exactly one request reached the real server

        // PAID mode's 402 branch (and its "no free models" stderr notice) was
        // deleted outright (TRDD-OE27RD7I addendum 4) along with the switch it
        // used to attempt — a paid 402 is now a silent pass-through, so there
        // is no rotation-related stderr output to assert at all, only its
        // absence.
        const stderrLines = stderrSpy.mock.calls.map((c) => String(c[0]));
        expect(stderrLines.some((l) => l.includes("switching this command"))).toBe(false);
        expect(stderrLines.some((l) => l.includes("402") && l.includes("no free models"))).toBe(false);
      } finally {
        stderrSpy.mockRestore();
      }
    },
    30_000,
  );
});

describe("Path 3 (index.ts chatCompletionWithProfileFallback) — a real dispatch, a real 402, the profile exhaustion sentence", () => {
  it(
    "high_quality_scan on a funded (paid, non-free) profile at $0 balance: the redirected fetch runs, a 402 reaches STATIC_PROFILE_EXHAUSTED_MESSAGE, and the server never sees a request for a ':free' model id",
    async () => {
      // "$0 balance" here means the SAME thing every other case in this file
      // means it: the guaranteed, non-interrupting trigger is the mid-call
      // 402 itself, not a proactive balance probe (TRDD-OE27RD7I addendum 4
      // deleted the balance pre-flight outright — see resolveModelOverride's
      // own doc comment). start402Server 402s every POST, which is exactly
      // what a $0-balance OpenRouter key does on its very first request.
      const { url, postCount, modelsRequested } = await start402Server();
      const cfgDir = mkdtempSync(join(TMP_BASE, "llm-ext-w2-hq-cfg-"));
      const folder = mkdtempSync(join(TMP_BASE, "llm-ext-w2-hq-folder-"));
      writeFileSync(join(folder, "a.txt"), "hello world\n", "utf-8");
      writeFileSync(
        join(cfgDir, "settings.yaml"),
        [
          "active: paidstatic",
          "allow_paid_models: true",
          "profiles:",
          "  paidstatic:",
          "    mode: remote",
          "    api: openrouter-remote", // real openrouter.ai default URL — validateProfile refuses a 'remote' profile pointed at a local address
          "    model: vendor/whatever",
          '    api_key: "sk-test-fake-openrouter-key"',
          "",
        ].join("\n"),
        "utf-8",
      );
      // TRDD-FDI9NYAS D3c: HIGH_QUALITY_MODEL_DEFAULTS.id ("z-ai/glm-5.2") is
      // never manual ("llm-ext picked it" — design 2.1), so the NEW send-time
      // price check applies to it too and fails closed with no recorded
      // price. This test drives no maintainer pass to populate the catalog
      // cache, so seed one directly — same reason the IRON RULE ledger is
      // bypassed two lines below: this test's subject is the 402 exhaustion
      // path, not pricing.
      writeFileSync(
        join(cfgDir, "catalog-cache.json"),
        JSON.stringify({
          fetchedAtMs: Date.now(),
          models: [{ id: "z-ai/glm-5.2", pricing: { prompt: "0.0000005", completion: "0.0000005" } }],
        }),
        "utf-8",
      );
      const prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
      process.env.LLM_EXT_CONFIG_DIR = cfgDir;
      vi.resetModules();
      // The REAL network hop for this test: fetchWithTimeout (provider/http.ts)
      // calls the global `fetch`, so redirecting every call to start402Server's
      // real local socket -- ignoring the profile's own openrouter.ai URL --
      // is a genuine round trip over loopback, the same server every other
      // test in this file drives, not a mock of the completion/retry layer.
      const realFetch = globalThis.fetch;
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((_input: unknown, init?: RequestInit) =>
          realFetch(`${url}/v1/chat/completions`, init),
        );
      let validated: typeof import("./benchmark/validated.js") | undefined;
      try {
        // setValidationBypassForTests must be called on the SAME fresh module
        // instance index.ts's own import graph resolves to after
        // vi.resetModules() above -- the top-level import at this file's head
        // is a stale, pre-reset instance. HIGH_QUALITY_MODEL_DEFAULTS.id is a
        // real paid model gated by the IRON RULE ledger (benchmark/validated.ts);
        // this test drives no benchmark and writes no ledger, so it must opt
        // out the same way provider/connection.test.ts does.
        validated = await import("./benchmark/validated.js");
        validated.setValidationBypassForTests(true);
        const idx = await import("./index.js");
        // dispatchCallTool() refuses to run before boot() publishes the
        // free-mode state (same requirement dispatch-reload.test.ts's own
        // loadFreshIndex documents for this exact call shape).
        await idx.boot();
        const result = await idx.dispatchCallTool("high_quality_scan", {
          folder_path: folder,
          instructions: "find bugs",
        });
        const text = result.content.map((c: { text?: string }) => c.text ?? "").join("\n");
        expect(
          text,
          `must reach the profile-chain exhaustion path. text:\n${text}`,
        ).toMatch(STATIC_PROFILE_EXHAUSTED_MESSAGE);
        expect(text).not.toContain("switching");
        // scan_folder's own per-file retry loop (unrelated to this phase --
        // dispatch-reload.test.ts's near-identical test allows for the same
        // thing) may re-POST the SAME pinned model more than once before
        // giving up, so the count alone would not distinguish "retried the
        // pinned model" from "borrowed a free-pool id". The real assertion
        // is on WHICH models were actually requested: at least one attempt
        // happened, and NONE of them ever ends in ':free'.
        const requested = modelsRequested();
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.every((m) => !m.endsWith(":free"))).toBe(true);
        expect(postCount()).toBeGreaterThan(0);
        // fix-queue 98(3): postCount alone cannot prove the redirected fetch
        // (the mock above) is what actually ran the request -- a mock that
        // silently never fired and left postCount at its start402Server
        // default of 0 would pass the ">0" check above vacuously if that
        // default were ever wrong. Assert the redirect itself fired.
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        validated?.setValidationBypassForTests(false);
        fetchSpy.mockRestore();
        if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
        else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
        rmSync(cfgDir, { recursive: true, force: true });
        rmSync(folder, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
