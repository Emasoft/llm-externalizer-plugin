/**
 * local-fallback-e2e.test.ts — TRDD-WSPV40Y5 (increment 1d), card section 6 cases 1, 3, 9 and 12: a REAL local answer end to end.
 * The CLI is bundled from the current source with esbuild (as broker/broker.test.ts does, so its broker can start: the client's
 * default broker entry is the bundle it runs from), and runs as its own process. The remote is a REAL node:http server that resets
 * every connection (the strict probe's GET /v1/models included), reached through the free profile's own `url:` key; the window is
 * the real --network_give_up flag. The local target is the built-in local_llama profile, `server: managed`, ready for real: the
 * llama-server on PATH, the model file on disk, and an ok calibration record whose fingerprint was measured from a real server of
 * that model (the broker refuses a record that does not name the weights it loaded). WHY a patched copy of stories15M: the GGUF
 * declares a 128-token training context and llama-server caps each slot at it, so the ~710-token prompt of a real command cannot
 * fit; the copy differs only in llama.context_length (E2E_CTX, the value broker.test.ts uses for the same reason).
 * Temp dirs carry the llm-ext-e2e- prefix only (never __llm_ext_); every process started is stopped in afterEach.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { builtinModules } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "./test-tmp-root.js";
import { BROKER_ARGV, isBrokerProcess, readBrokerState } from "./broker/protocol.js";
import { readRegistry } from "./broker/registry.js";
import { writeRecord } from "./calibration/record.js";
import { recordFixture } from "./calibration/test-record.js";
import { loadedIdentity, type LoadedIdentity } from "./calibration/fingerprint.js";
import { startCalServer } from "./calibration/runner.js";
import { isLocalsServerArgv, processSnapshot } from "./local-llama-server.js";
import { RETRY_MAX_ATTEMPTS } from "./provider/http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLAMA_CACHE = "/tmp/llm-ext-llama-cache";
const E2E_CTX = 3584;
const NETWORK = "no network path to the remote provider; answered locally";

let cli = "";
let cliDir = "";
let modelsDir = "";
let preloadDir = "";
let preload = "";

/**
 * The remote boundary of the child CLI: a remote profile refuses a local URL ("Remote mode cannot use local URL"), so the free
 * profile keeps its real openrouter.ai endpoint and this preload (NODE_OPTIONS --import) sends ONLY openrouter.ai requests to the
 * test server, path kept: the pattern of the in-process tests (outage-detection.test.ts), in a child. The broker inherits it and
 * is untouched, because its traffic never names openrouter.ai.
 */
const PRELOAD = `const base = process.env.LLM_EXT_E2E_REMOTE;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (base && u.hostname === "openrouter.ai") return realFetch(base + u.pathname + u.search, init);
  return realFetch(input, init);
};
`;
let model = "";
let identity: LoadedIdentity;
const dirs: string[] = [];
let server: Server | undefined;

function tempDir(kind: string): string {
  const d = mkdtempSync(join(tmpdir(), `llm-ext-e2e-${kind}-`));
  dirs.push(d);
  return d;
}

beforeAll(async () => {
  // Under the package node_modules (a gitignored cache), not /tmp: the bundle keeps better-sqlite3 external, and an ESM import
  // resolves it only from a node_modules folder above the importing file (the cliBundle recipe of broker.test.ts).
  cliDir = mkdtempSync(join(HERE, "..", "node_modules", ".cache-llm-ext-e2e-cli-"));
  cli = join(cliDir, "llm-ext.mjs");
  preloadDir = mkdtempSync(join(tmpdir(), "llm-ext-e2e-preload-"));
  preload = join(preloadDir, "redirect-openrouter.mjs");
  writeFileSync(preload, PRELOAD, "utf-8");
  await build({
    entryPoints: [join(HERE, "cli", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: `import { createRequire as __cjsCreateRequire } from "node:module";\nimport { fileURLToPath as __cjsFileURLToPath } from "node:url";\nimport { dirname as __cjsDirname } from "node:path";\nconst require = __cjsCreateRequire(import.meta.url);\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);\n` },
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"],
    outfile: cli,
    logLevel: "error",
  });
  // The cached -hf download (broker.test.ts fills it on a fresh machine; never downloaded here).
  const snaps = join(LLAMA_CACHE, "models--ggml-org--tiny-llamas", "snapshots");
  const rev = existsSync(snaps) ? readdirSync(snaps).find((r) => existsSync(join(snaps, r, "stories15M-q4_0.gguf"))) : undefined;
  if (rev === undefined) throw new Error(`stories15M-q4_0.gguf is not in ${snaps}: run src/broker/broker.test.ts once to fill the cache`);
  const b = readFileSync(realpathSync(join(snaps, rev, "stories15M-q4_0.gguf")));
  const key = Buffer.from("llama.context_length");
  const at = b.indexOf(key);
  if (at < 0 || b.readUInt32LE(at + key.length) !== 4) throw new Error("llama.context_length is not a u32");
  b.writeUInt32LE(E2E_CTX, at + key.length + 4);
  modelsDir = mkdtempSync(join(tmpdir(), "llm-ext-e2e-models-"));
  model = join(modelsDir, "ctx-stories15M-q4_0.gguf");
  writeFileSync(model, b);
  // The identity a record must carry: measured once from a real cal server of this model, in a scratch dir, then stopped.
  const scratch = mkdtempSync(join(tmpdir(), "llm-ext-e2e-measure-"));
  try {
    const s = await startCalServer(scratch, "llama", model, 1024, 1, () => undefined);
    try {
      identity = await loadedIdentity("llama", s.baseUrl, s.apiKey, model, scratch);
    } finally {
      await s.stop("measured");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 300_000);

afterAll(() => {
  if (cliDir) rmSync(cliDir, { recursive: true, force: true });
  if (modelsDir) rmSync(modelsDir, { recursive: true, force: true });
  if (preloadDir) rmSync(preloadDir, { recursive: true, force: true });
});

/** Stops what a command left for this config dir: its broker (by the state file), the llama-servers of its registry, any process naming the dir; then proves none is left. Never signals this runner's own process group. */
async function stopAll(cfg: string): Promise<void> {
  const st = readBrokerState(cfg);
  if (st && (await isBrokerProcess(st.pid))) {
    try {
      process.kill(st.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 100 && (await isBrokerProcess(st.pid)); i++) await new Promise((r) => setTimeout(r, 100));
    if (await isBrokerProcess(st.pid)) process.kill(st.pid, "SIGKILL");
  }
  const rows = await processSnapshot();
  const ownPgid = rows.find((r) => r.pid === process.pid)?.pgid;
  if (ownPgid === undefined) throw new Error(`stopAll: this runner (pid ${process.pid}) is not in the process snapshot; refusing to signal any group`);
  const pgids = new Set(readRegistry(cfg, "llama").map((e) => e.pgid));
  const serverOrBroker = (argv: readonly string[]) => basename(argv[0] ?? "") === "llama-server" || isLocalsServerArgv(argv) || argv.includes(BROKER_ARGV);
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    if (row.command.includes(cfg) || (pgids.has(row.pgid) && serverOrBroker(row.argv))) {
      try {
        if (row.pgid === ownPgid || row.pgid <= 1) process.kill(row.pid, "SIGKILL");
        else process.kill(-row.pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const left = (await processSnapshot()).filter((r) => r.command.includes(cfg));
  expect(left.map((r) => r.argv.join(" ")), "no process of this config dir is left").toEqual([]);
}

afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  for (const d of dirs.splice(0).reverse()) {
    if (existsSync(join(d, "settings.yaml"))) await stopAll(d);
    rmSync(d, { recursive: true, force: true });
  }
}, 120_000);

/** A remote that reads each request, records it, then resets the connection (ECONNRESET, a network-isolation cause). */
async function resettingRemote(): Promise<{ url: string; seen: () => Array<{ at: number; method: string; path: string; body: string }> }> {
  const seen: Array<{ at: number; method: string; path: string; body: string }> = [];
  server = createServer((req) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ at: Date.now(), method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString("utf-8") });
      req.socket.resetAndDestroy();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, seen: () => [...seen] };
}

/** A config dir: the free profile (its default openrouter.ai endpoint, redirected by the preload), the built-in local_llama profile on the patched model, and its ok record. */
function configDir(): string {
  const cfg = tempDir("cfg");
  const yaml = [
    "active: free",
    "profiles:",
    "  # <-- do not touch, generated by llm-ext -->",
    "  free:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    free_only: true",
    "    free_models: [vendor/free-a:free, vendor/free-b:free]",
    "    model: vendor/free-a:free",
    '    api_key: "sk-or-v1-e2e-test-key-not-real"',
    "  local_llama:",
    "    profile-type: local",
    "    mode: local",
    "    api: llamacpp-local",
    // The port binds nothing under the broker: the url is only the key the walker marks dead.
    "    url: http://127.0.0.1:18432",
    "    server: managed",
    `    model: ${model}`,
    `    context_window: ${E2E_CTX}`,
    "",
  ].join("\n");
  writeFileSync(join(cfg, "settings.yaml"), yaml, "utf-8");
  // The catalog the free pool and the price gate read (as local-fallback-dispatch.test.ts writes it): without it no request is sent.
  const ids = ["vendor/free-a:free", "vendor/free-b:free"];
  writeFileSync(join(cfg, "catalog-cache.json"), JSON.stringify({ fetchedAtMs: Date.now(), models: ids.map((id) => ({ id, pricing: { prompt: "0", completion: "0" } })) }), "utf-8");
  writeRecord(cfg, { ...recordFixture("llama", model), fingerprint: identity.fingerprint, engine_version: identity.engineVersion, engine_version_checked: identity.engineVersion });
  return cfg;
}

/** One real CLI command in its own process; resolves with its exit code, stdout, stderr and wall time. */
function runCli(cfg: string, remoteUrl: string, args: string[]): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cfg, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLAMA_CACHE, LLM_EXT_DISABLE_AUTO_RECONCILE: "1", LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1", LLM_EXT_E2E_REMOTE: remoteUrl, NODE_OPTIONS: `--import=${preload}` };
  // A b.ai key adds a reserved slot that fans out (the ensemble site, a later increment); a real OpenRouter key is never needed.
  delete env.BAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: cfg, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    const kill = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, out, err, ms: Date.now() - t0 });
    });
  });
}

/** The broker's dispatch times (ms) from its log, in order. */
function dispatchTimes(cfg: string): number[] {
  const log = join(cfg, "broker-local.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").flatMap((l) => {
    const m = /^(\S+) dispatch job /.exec(l);
    return m ? [Date.parse(m[1])] : [];
  });
}

const reportsIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : []);

/** The model text of a report: everything after its header rule. */
const bodyOf = (report: string): string => report.split("\n---\n").slice(1).join("\n---\n").trim();

describe("TRDD-WSPV40Y5 end to end: a dead remote, a READY managed local_llama, a real local answer", () => {
  it("llm ask on two files, twice: exit 0, both reports hold local model text, the 'answered locally' line, file 1's retries end at the 2 s give-up window, file 2 never reaches the remote (latch), and a new command tries the remote again", async () => {
    const remote = await resettingRemote();
    const cfg = configDir();
    const src = join(cfg, "src");
    mkdirSync(src);
    const files = [1, 2].map((i) => join(src, `f${i}.txt`));
    files.forEach((f, i) => writeFileSync(f, `Once upon a time there was cat number ${i + 1}.\n`));
    const timings: string[] = [];
    let remoteBefore = 0;
    let dispatchesBefore = 0;
    for (const run of ["cold", "warm"] as const) {
      const out = join(cfg, `out-${run}`);
      const t0 = Date.now();
      const r = await runCli(cfg, remote.url, ["--network_give_up", "2", "llm", "ask", "--input_files_paths", JSON.stringify(files), "--instructions", "continue the story", "--answer_mode", "0", "-o", out]);
      const dispatches = dispatchTimes(cfg).slice(dispatchesBefore);
      const posts = remote.seen().filter((s) => s.method === "POST").slice(remoteBefore);
      // Answer times: each report is written when its file's answer returned (answer_mode 0, files in turn), so the first report's mtime is start-to-first-answer.
      const answeredAt = reportsIn(out).map((f) => Math.round(statSync(f).mtimeMs) - t0).sort((a, b) => a - b);
      timings.push(`${run}: command ${r.ms} ms, first local dispatch ${dispatches[0] === undefined ? "none" : dispatches[0] - t0} ms, answers written at ${answeredAt.join(" and ")} ms after start (card case 3 target: 15 s to the first local answer, warm server)`);
      expect(r.code, `${r.out}\n${r.err}`).toBe(0);
      expect(r.err).toContain(`${NETWORK} by profile 'local_llama' (model ${model})`);
      // WHY (TRDD-WPH1158N): the old cap, expect(r.ms).toBeLessThan(60_000), timed a cold broker and model start plus real inference and failed at 60045 ms
      // under host load 209. Timers never fire early, so load can only lower the attempt count inside the 2 s give-up window; this upper bound is not made
      // flaky by load (reasoned, not measured under load). The per-command latch is asserted by the event checks below; runCli's 180 s kill and the 300 s test timeout guard a hang.
      const file1Posts = posts.filter((p) => p.body.includes("cat number 1")).length;
      expect(file1Posts, "the 2 s give-up window ended file 1's retries before a full ladder").toBeLessThan(RETRY_MAX_ATTEMPTS + 1);
      const reports = reportsIn(out);
      expect(reports, r.out).toHaveLength(2);
      for (const rep of reports) {
        const text = readFileSync(rep, "utf8");
        expect(text, "the answerer is the local model").toContain(`**Model**: \`${model}\``);
        expect(bodyOf(text).length, "the report holds model text").toBeGreaterThan(0);
      }
      // A new command starts clean (Q8 latch is per command): file 1 tries the remote first, every run.
      expect(posts.filter((p) => p.body.includes("cat number 1")).length, "file 1 reached the remote first").toBeGreaterThan(0);
      // The latch: file 2 never reaches the remote, and no remote request follows the first local answer of the command.
      expect(posts.filter((p) => p.body.includes("cat number 2")), "file 2 made no remote request").toEqual([]);
      expect(dispatches.length, "both files were answered by the broker").toBe(2);
      expect(posts.filter((p) => p.at >= dispatches[0]), "no remote request after the switch").toEqual([]);
      remoteBefore += posts.length;
      dispatchesBefore += dispatches.length;
    }
    // The measured time to the first local answer, for the report (vitest swallows console output in this config).
    if (process.env.LLM_EXT_E2E_TIMINGS) writeFileSync(process.env.LLM_EXT_E2E_TIMINGS, `${timings.join("\n")}\n`, { flag: "a" });
  }, 300_000);
});
