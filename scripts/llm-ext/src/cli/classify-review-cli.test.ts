// Review of the classifier commits 3e281b35, 727b9f32, 4acc83bb: NEEDS BUILD (node esbuild.config.mjs). Spawns dist/llm-ext.js on a temp HOME and config dir (LLM_EXT_INSTALL_RULE=0) against a REAL local node:http server.
// WHY a preload: the transport URLs are the fixed https://openrouter.ai ones (l0/transport.ts), so the spawned process gets a --import file that rewrites that origin to the local server's; the server counts every request, which is how "nothing was sent" is proved. No API key reaches a real service.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);
const fixture = (name: string): string => (JSON.parse(readFileSync(new URL(`../classifiers/__fixtures__/p02/${name}`, import.meta.url), "utf8")) as { body: string }).body;
const SETTINGS = ["active_classifier: cl", "profiles:", "  cl:", "    profile-type: classifier", "    api: openrouter-remote", "    api_key: $RVW_KEY", "    model: typesafe/jev-1.13", ""].join("\n");

let server: Server;
let base: string;
let seen: string[] = [];
// Every Authorization header the server received, by request: a dry run must send none.
let auths: string[] = [];
beforeAll(async () => {
  const catalog = fixture("models-decisions.json");
  const endpoints = fixture("target-endpoints.json");
  server = createServer((req, res) => {
seen.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== undefined) auths.push(`${req.method} ${req.url}`);
    const json = (status: number, body: string): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); };
    if (req.method === "GET" && req.url?.startsWith("/api/v1/models?")) return json(200, catalog);
    if (req.method === "GET" && /^\/api\/v1\/models\/.+\/endpoints$/.test(req.url ?? "")) return json(200, endpoints);
    if (req.method === "GET" && req.url === "/api/v1/key") return json(200, JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } }));
    if (req.method === "POST" && req.url === "/api/alpha/decisions") return json(200, JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: { ping: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1, cost: 0.000001 } }));
    return json(404, "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Run { stdout: string; stderr: string; code: number; sent: string[]; authorized: string[] }
async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const dir = mkdtempSync("/tmp/__llm_ext_rvw_");
  writeFileSync(join(dir, "settings.yaml"), SETTINGS);
  writeFileSync(join(dir, "a.txt"), "the build failed\nall tests passed\n");
  writeFileSync(join(dir, "preload.mjs"), `const base = process.env.RVW_BASE;\nconst real = globalThis.fetch;\nglobalThis.fetch = (input, init) => real(String(input instanceof Request ? input.url : input).replace("https://openrouter.ai", base), init);\n`);
  seen = [];
  auths = [];
  // WHY RVW_KEY is removed first: the parent environment must never supply the key; only the case that passes one gets it.
  const childEnv: Record<string, string | undefined> = { ...process.env, HOME: dir, LLM_EXT_CONFIG_DIR: dir, LLM_EXT_INSTALL_RULE: "0", NODE_OPTIONS: `--import=${join(dir, "preload.mjs")}`, RVW_BASE: base, RVW_KEY: env.RVW_KEY };
if (env.RVW_KEY === undefined) delete childEnv.RVW_KEY;
  // Round 2, major 3: no provider key of the parent reaches the child (OPENROUTER_API_KEY, every *_API_KEY, the plugin option copies); only RVW_KEY, when a case passes it.
  for (const name of Object.keys(childEnv)) if (/API_KEY|PLUGIN_OPTION/i.test(name)) delete childEnv[name];
  if (env.RVW_KEY !== undefined) childEnv.RVW_KEY = env.RVW_KEY;
  try {
    const o = await execFileAsync("node", [CLI_SCRIPT, ...args], { cwd: dir, env: childEnv, timeout: 60_000 });
    return { stdout: o.stdout, stderr: o.stderr, code: 0, sent: [...seen], authorized: [...auths] };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", code: x.code ?? -1, sent: [...seen], authorized: [...auths] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const requestsThatCost = (sent: string[]): string[] => sent.filter((s) => s.startsWith("POST ") || s === "GET /api/v1/key");

describe("classify --estimate (built CLI)", () => {
  // Finding 1 and 7: --estimate before and after the verb prices the run, sends nothing, and needs no API key (RVW_KEY is unset in the child).
  it.each([
    ["after the verb", ["classify", "filter", "does it fail?", "a.txt", "--estimate"]],
    ["after the verb, before the files", ["classify", "filter", "--estimate", "does it fail?", "a.txt"]],
    ["before the group", ["--estimate", "classify", "filter", "does it fail?", "a.txt"]],
  ])("--estimate %s: exit 0, the classify estimate text, no decisions request, no key", async (_where, args) => {
    const r = await run(args);
    expect(r.stderr).not.toContain("is not set");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("classify filter --estimate: no question was sent");
    expect(r.stdout).toContain("estimated input tokens:");
    expect(requestsThatCost(r.sent)).toEqual([]);
    expect(r.authorized).toEqual([]);
  });
  // WHY pinned: a flag in the action slot is the launcher's "show me this group" case for every group (launcher.ts resolveInvocation), so the command line is not run at all; it must stay free.
  it("--estimate between the group and the verb shows the group help and sends nothing", async () => {
    const r = await run(["classify", "--estimate", "filter", "does it fail?", "a.txt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("llm-ext classify <action>");
    expect(requestsThatCost(r.sent)).toEqual([]);
    expect(r.authorized).toEqual([]);
  });
  it("without --estimate the same command line needs the key (exit 3), so the test above proves the estimate skipped it", async () => {
    const r = await run(["classify", "filter", "does it fail?", "a.txt"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("RVW_KEY");
    expect(requestsThatCost(r.sent)).toEqual([]);
  });
});

describe("classify ping (built CLI)", () => {
  // Finding 8: a global flag typed before the group, or in flag position, is accepted by ping like by every other command.
  it.each([
    [["--quiet", "classify", "ping", "--no-call"]],
    [["classify", "ping", "--quiet", "--no-call"]],
    [["classify", "ping", "--no-call", "--profile", "cl"]],
    [["--profile", "cl", "classify", "ping", "--no-call"]],
  ])("accepts the global flags: %j", async (args) => {
    // WHY a long key: the redactor replaces the key text wherever it appears, so a one-letter key would garble the output.
    const r = await run(args, { RVW_KEY: "rvw-test-key-0123456789" });
    expect(r.stderr).not.toContain("unknown option");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("key check: ok");
expect(r.sent.filter((s) => s.startsWith("POST "))).toEqual([]);
    // Positive control: the server does record an Authorization header when the CLI sends one (the key check), so the empty lists asserted on the --estimate runs are meaningful.
    expect(r.authorized).toEqual(["GET /api/v1/key"]);
  });
});
