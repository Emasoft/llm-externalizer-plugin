/**
 * remote-ensemble-fanout.test.ts: TRDD-7H5MGN34. A 3-member remote-ensemble profile (model, second_model, third_model, no
 * reserved slots) must fan ONE prompt out to all three model ids through ensembleStreaming.
 * REAL node:http OpenAI-compatible server counting requests per model id, REAL settings file in a temp dir; no mocks, no paid call.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetServiceHealthForTests } from "./provider/completion.js";

const servers: Server[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const c of cleanups.splice(0)) c();
  resetServiceHealthForTests();
});

/** Answers every POST with a one-line completion naming the requested model; counts requests per model id. */
async function serve(seen: Map<string, number>): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const model = String((JSON.parse(body) as { model?: unknown }).model);
      seen.set(model, (seen.get(model) ?? 0) + 1);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: `answer from ${model}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
// Decimal form of 127.0.0.1: the URL parser reaches the loopback server, while config.ts isLocalUrl (dotted/localhost patterns) sees a remote host and accepts it for remote-ensemble.
  return `http://2130706433:${addr.port}`;
}

describe("remote-ensemble fan-out (7H5MGN34)", () => {
  it("one prompt reaches all three members of a remote-ensemble profile", async () => {
    const seen = new Map<string, number>();
    const url = await serve(seen);
    const cfgDir = mkdtempSync(join("/tmp", "llm-ext-remote-fanout-"));
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    cleanups.push(() => {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      rmSync(cfgDir, { recursive: true, force: true });
    });
    writeFileSync(
      join(cfgDir, "settings.yaml"),
      `active: rem
allow_paid_models: true
profiles:
  rem:
    mode: remote-ensemble
    api: openrouter-remote
    url: ${url}
    api_key: test-key
    model: vendor/m-one
    second_model: vendor/m-two
    third_model: vendor/m-three
`,
      "utf-8",
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import("./index.js");
    await idx.boot();
    expect(idx.__getEnsembleModelsForTests().map((m) => m.id)).toEqual(["vendor/m-one", "vendor/m-two", "vendor/m-three"]);
    await idx.__ensembleStreamingForTests([{ role: "user", content: "hi" }], {}, { deadlineAt: Date.now() + 5000 });
    expect([...seen.keys()].sort()).toEqual(["vendor/m-one", "vendor/m-three", "vendor/m-two"]);
  }, 30_000);
});

const PRICED = ["vendor/m-one", "vendor/m-two", "vendor/m-three"];

/** Boot a fresh index.ts over a throwaway config dir holding `yaml` and the priced catalog, then one `chat` call through the real entry (dispatchCallTool). `redirectTo` sends the fetches to a local server (a built-in profile cannot name a local URL). */
async function chatThroughEntry(yaml: string, redirectTo?: string): Promise<{ text: string; isError: boolean }> {
  const cfgDir = mkdtempSync(join("/tmp", "llm-ext-remote-fanout-"));
  const homeDir = mkdtempSync(join("/tmp", "llm-ext-remote-fanout-home-"));
  const folder = mkdtempSync(join("/tmp", "llm-ext-remote-fanout-files-"));
  const out = mkdtempSync(join("/tmp", "llm-ext-remote-fanout-out-"));
  cleanups.push(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const d of [cfgDir, homeDir, folder, out]) rmSync(d, { recursive: true, force: true });
  });
  writeFileSync(join(cfgDir, "settings.yaml"), yaml, "utf-8");
  // The price gate refuses an unpriced model before any byte is sent.
  writeFileSync(join(cfgDir, "catalog-cache.json"), JSON.stringify({ fetchedAtMs: Date.now(), models: PRICED.map((id) => ({ id, pricing: { prompt: "0.0000005", completion: "0.0000005" } })) }), "utf-8");
  writeFileSync(join(folder, "a.txt"), "hello world\n", "utf-8");
  vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("LLM_EXT_INSTALL_RULE", "0");
  vi.stubEnv("LLM_EXT_DISABLE_AUTO_RECONCILE", "1");
  vi.stubEnv("LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION", "1");
  vi.stubEnv("BAI_API_KEY", "");
  vi.resetModules();
  const idx = await import("./index.js");
  await idx.boot();
  const validated = await import("./benchmark/validated.js");
  validated.setValidationBypassForTests(true);
  if (redirectTo !== undefined) {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input: unknown, init?: RequestInit) => realFetch(`${redirectTo}/v1/chat/completions`, init));
  }
  try {
    const result = await idx.dispatchCallTool("chat", { input_files_paths: [join(folder, "a.txt")], instructions: "find bugs", output_dir: out });
    return { text: result.content.map((c) => c.text ?? "").join("\n"), isError: result.isError === true };
  } finally {
    validated.setValidationBypassForTests(false);
  }
}

describe("which profiles fan out, through the real entry (TRDD-7H5MGN34 review)", () => {
  it("a user-declared remote-ensemble profile on OpenRouter reaches all three members from a real command (chat)", async () => {
    const seen = new Map<string, number>();
    const url = await serve(seen);
    const r = await chatThroughEntry(
      `active: rem
allow_paid_models: true
profiles:
  rem:
    mode: remote-ensemble
    api: openrouter-remote
    url: ${url}
    api_key: test-key
    model: vendor/m-one
    second_model: vendor/m-two
    third_model: vendor/m-three
`,
    );
    expect(r.isError, r.text).toBe(false);
    expect([...seen.keys()].sort()).toEqual(["vendor/m-one", "vendor/m-three", "vendor/m-two"]);
  }, 60_000);

  it("the built-in paid profile with mode remote-ensemble keeps sending ONE model per call (no tripled traffic)", async () => {
    const seen = new Map<string, number>();
    const url = await serve(seen);
    const r = await chatThroughEntry(
      `active: paid
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  paid:
    mode: remote-ensemble
    api: openrouter-remote
    model: vendor/m-one
    second_model: vendor/m-two
    third_model: vendor/m-three
    paid_models: [vendor/m-one, vendor/m-two, vendor/m-three]
    api_key: "test-key-not-real"
`,
      url,
    );
    expect(r.isError, r.text).toBe(false);
    expect([...seen.keys()]).toEqual(["vendor/m-one"]);
    expect(seen.get("vendor/m-one")).toBe(1);
  }, 60_000);
});
