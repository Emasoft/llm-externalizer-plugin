/**
 * governor/governor-burn.test.ts — the burn tests of design/specs/local-inference-governor-design.md section 3 (unit 6,
 * TRDD-ZTO9K8EK): burn-direct, ram-limit, crash, no-touch, fairness, stop, plus enabled: false (with a usable and with an
 * unusable dir, D2), a server unregistered after a flip to disabled, a waiter disabled below a live head, the off status
 * line, and a settings.yaml edit
 * reaching a running broker. burn-broker is in governor-threads.test.ts (unit 5).
 *
 * Real processes, no mocks: the model server is a real loopback HTTP server PROCESS that appends its concurrency to a
 * file; the senders are the real CLI, bundled from the current source with esbuild (dist/ may be stale and a test must
 * never rebuild it), each with its own config dir and settings.yaml, all sharing one governor dir; CPU burners are real
 * busy node processes. Assertions are invariants read from recorded data (a maximum, a count, an order), never a fixed
 * wait (TRDD-CBOTP0DY); every wait polls a condition against a 180 s deadline. Every spawned pid is recorded and killed
 * by pid in afterEach; a ps snapshot before and after the file (reports_dev/governor/burn/) must show none of them. The
 * file loads the machine on purpose, so it runs alone, in the third sequential step of npm test.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureBroker } from "../broker/client.js";
import { isBrokerProcess, readBrokerState, TOKEN_HEADER } from "../broker/protocol.js";
import { serverStatusText } from "../broker/server-commands.js";
import { acquire, bookedBytesNow, registerServer, release, snapshot, unloadWanted, unregisterServer, withdraw, type Lease } from "./client.js";
import { readRam } from "./ram.js";
import { isGovernorDirError, withStateLock } from "./state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const SNAP_DIR = join(REPO, "reports_dev", "governor", "burn");
const DEADLINE_MS = 180_000;
const N = 16;
/** burn-direct: how long the CLIs get to be released by the reading falling before the test raises cpu_limit_pct for them (no CPU floor, TRDD-ZTO9K8EK). */
const RELEASE_WAIT_MS = 30_000;
/** Every governor variable this file sets in its own process; restored in afterAll. */
const GOV_KEYS = ["LLM_EXT_GOVERNOR_DIR", "LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_SETTLE_MS", "LLM_EXT_GOVERNOR_ENABLED", "LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN"];
const externals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"];
// The CJS shim of esbuild.config.mjs: bundled CJS deps (yaml) call require().
const BANNER = `import { createRequire as __cjsCreateRequire } from "node:module";
import { fileURLToPath as __cjsFileURLToPath } from "node:url";
import { dirname as __cjsDirname } from "node:path";
const require = __cjsCreateRequire(import.meta.url);
const __filename = __cjsFileURLToPath(import.meta.url);
const __dirname = __cjsDirname(__filename);
`;

/**
 * The stand-in model server, a process of its own: it appends "<ms> <requests now>" to a log at every start and end of a
 * POST, appends every signal it receives to a second file (and survives it, so a signal can be seen), and optionally
 * starts a child of its own, so a test can check that neither is touched.
 */
// ubs:ignore[javascript.ctcompare.unsafe_secret_compare] the child script compares an argv flag, not a credential (TRDD-ZTO9K8EK)
const SERVER = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [log, holdMs, sigLog, withChild] = process.argv.slice(2);
for (const s of ["SIGTERM", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2", "SIGQUIT"]) process.on(s, () => appendFileSync(sigLog, s + "\\n"));
const body = JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
let now = 0;
const server = createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}"); return; }
  now++;
  appendFileSync(log, Date.now() + " " + now + "\\n");
  req.resume();
  req.on("end", () => setTimeout(() => {
    now--;
    appendFileSync(log, Date.now() + " " + now + "\\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }, Number(holdMs)));
});
server.listen(0, "127.0.0.1", () => {
  const child = withChild === "1" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
  process.stdout.write(JSON.stringify({ port: server.address().port, child: child ? child.pid : null }) + "\\n");
});
`;

/** A requester with a long queue: k acquires at once, each recorded in grant order, held 30 ms, released. */
const REQUESTER = `
import { appendFileSync } from "node:fs";
import { acquire, release } from "./client.ts";
const [out, k] = process.argv.slice(2);
await Promise.all(Array.from({ length: Number(k) }, async () => {
  const lease = await acquire({ timeoutMs: 120000 });
  appendFileSync(out, process.pid + "\\n");
  await new Promise((r) => setTimeout(r, 30));
  release(lease);
}));
`;

const BROKER = `import { runBrokerMain } from "../broker/server.ts";\nawait runBrokerMain("t1");\n`;

interface StandIn {
  url: string;
  pid: number;
  child: number | null;
  log: string;
  sigLog: string;
}

let workDir: string;
let cli: string;
let serverJs: string;
let requesterJs: string;
let brokerJs: string;
let root: string;
const saved = new Map<string, string | undefined>();
/** Every pid this file started, for the after snapshot. */
const started = new Set<number>();
const children: ChildProcess[] = [];
/** Pids started by our children (the stand-in server child), killed by pid too. */
const grandchildren: number[] = [];
const held: Lease[] = [];
const brokerDirs: string[] = [];

function psSnapshot(name: string): string {
  mkdirSync(SNAP_DIR, { recursive: true });
  const text = execFileSync("ps", ["-eo", "pid,ppid,etime,command"], { encoding: "utf8" });
  writeFileSync(join(SNAP_DIR, name), text);
  return text;
}

function pidsIn(text: string): Set<number> {
  return new Set(text.split("\n").slice(1).map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => Number.isInteger(n) && n > 0));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  if (child.pid) started.add(child.pid);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

async function until(what: string, done: () => boolean | Promise<boolean>, ms = DEADLINE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Start time of a process as ps prints it: the same pid with the same start is the same process. */
function startOf(pid: number): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

async function standIn(holdMs: number, withChild = false): Promise<StandIn> {
  const log = join(root, `server-${Date.now()}-${Math.random().toString(36).slice(2)}.log`); // ubs:ignore Math.random only makes a unique temp log name, not a token
  const sigLog = `${log}.signals`;
  writeFileSync(log, "");
  writeFileSync(sigLog, "");
  const child = track(spawn(process.execPath, [serverJs, log, String(holdMs), sigLog, withChild ? "1" : "0"], { stdio: ["ignore", "pipe", "inherit"] }));
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("\n")) resolve(out.split("\n")[0]);
    });
    child.once("exit", (code) => reject(new Error(`stand-in server exited ${code}`)));
  });
  const { port, child: grandchild } = JSON.parse(line) as { port: number; child: number | null };
  if (grandchild !== null) {
    grandchildren.push(grandchild);
    started.add(grandchild);
  }
  return { url: `http://127.0.0.1:${port}`, pid: child.pid as number, child: grandchild, log, sigLog };
}

/** The server log as (time, requests now) rows. */
function events(s: StandIn): Array<{ at: number; now: number }> {
  return readFileSync(s.log, "utf8").split("\n").filter(Boolean).map((l) => {
    const [at, now] = l.split(" ").map(Number);
    return { at, now };
  });
}

/** POSTs the server has received: every row where the count went up. */
function posts(s: StandIn): number {
  let last = 0;
  let n = 0;
  for (const e of events(s)) {
    if (e.now > last) n++;
    last = e.now;
  }
  return n;
}

/** A config dir whose settings.yaml has one generic-local profile on `url` and the given local_governor section. */
function configDir(name: string, url: string, governor: string[]): string {
  const cfg = join(root, name);
  mkdirSync(cfg, { recursive: true });
  writeSettings(cfg, url, governor);
  return cfg;
}

function writeSettings(cfg: string, url: string, governor: string[]): void {
  const path = join(cfg, "settings.yaml");
  writeFileSync(path, ["active: prof-a", "profiles:", "  prof-a:", "    mode: local", "    api: generic-local", "    model: model-a", `    url: ${url}`, "    timeout: 120", ...(governor.length > 0 ? ["local_governor:", ...governor.map((l) => `  ${l}`)] : []), ""].join("\n"));
  // A rewrite inside one clock tick must still be a new stamp for the reader (governor/settings.ts).
  const at = Date.now() / 1000 + Math.random();
  utimesSync(path, at, at);
}

/**
 * One real CLI run of `llm ask` against the profile of `cfg`. The child env carries no governor limit: its own
 * settings.yaml sets them (env would win over the file, D13); only the dir and the test-only timings are passed.
 */
function runCli(cfg: string, extra: string[] = []): { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } {
  const home = join(cfg, "home");
  const tmp = join(cfg, "tmp");
  const out = join(cfg, "out");
  for (const d of [home, tmp, out]) mkdirSync(d, { recursive: true });
  const file = join(cfg, "a.txt");
  writeFileSync(file, "hello\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLM_EXT_DISABLE_AUTO_RECONCILE: "1", LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION: "1" };
  for (const k of ["LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "LLM_EXT_GOVERNOR_MAX_INFERENCES", "LLM_EXT_GOVERNOR_ENABLED", "LLM_EXT_GOVERNOR_SERVER_THREADS"]) delete env[k];
  const child = track(spawn(process.execPath, [cli, ...extra, "llm", "ask", "--input_files_paths", file, "--instructions", "say hi", "-o", out], { stdio: ["ignore", "ignore", "pipe"], env }));
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  return { child, done: exited(child).then((code) => ({ code, stderr })) };
}

/** A busy loop on one core. */
function burner(): ChildProcess {
  return track(spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore" }));
}

beforeAll(async () => {
  for (const key of GOV_KEYS) saved.set(key, process.env[key]);
  psSnapshot("ps-before.txt");
  // Under node_modules, not /tmp: the CLI bundle keeps better-sqlite3 external (a native addon), found by walking up.
  const cache = join(HERE, "..", "..", "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  workDir = mkdtempSync(join(cache, "govburn-bundle-"));
  cli = join(workDir, "cli.mjs");
  serverJs = join(workDir, "server.mjs");
  requesterJs = join(workDir, "requester.mjs");
  brokerJs = join(workDir, "broker.mjs");
  writeFileSync(serverJs, SERVER);
  const common = { bundle: true, platform: "node" as const, format: "esm" as const, target: "node22", logLevel: "error" as const, external: externals, banner: { js: BANNER } };
  await build({ ...common, entryPoints: [join(HERE, "..", "cli", "main.ts")], outfile: cli });
  await build({ ...common, stdin: { contents: REQUESTER, resolveDir: HERE, sourcefile: "requester.ts", loader: "ts" }, outfile: requesterJs });
  await build({ ...common, stdin: { contents: BROKER, resolveDir: HERE, sourcefile: "broker.ts", loader: "ts" }, outfile: brokerJs });
}, DEADLINE_MS);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Hygiene (section 3): none of the pids this file started is still running.
  const after = pidsIn(psSnapshot("ps-after.txt"));
  expect([...started].filter((pid) => after.has(pid))).toEqual([]);
});

beforeEach(() => {
  root = mkdtempSync("/tmp/govburn-");
  // This process: its own governor dir per test, beside the configs; limits out of reach unless a test sets its own.
  Object.assign(process.env, {
    LLM_EXT_GOVERNOR_DIR: join(root, "gov"),
    LLM_EXT_GOVERNOR_CPU_LIMIT_PCT: "100",
    LLM_EXT_GOVERNOR_RAM_LIMIT_PCT: "99",
    LLM_EXT_GOVERNOR_MAX_INFERENCES: "8",
    LLM_EXT_GOVERNOR_SETTLE_MS: "100",
  });
  // Set by single tests only (D2, M3, status off; the ram-limit minimum): never carried into the next test.
  delete process.env.LLM_EXT_GOVERNOR_ENABLED;
  delete process.env.LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN;
});

afterEach(async () => {
  for (const lease of held.splice(0)) release(lease);
  withdraw();
  for (const dir of brokerDirs.splice(0)) {
    const st = readBrokerState(dir);
    if (st && (await isBrokerProcess(st.pid))) {
      started.add(st.pid);
      process.kill(st.pid, "SIGTERM");
      await until("the broker to exit", () => !alive(st.pid), 15_000).catch(() => killPid(st.pid));
    }
  }
  // Wait for each killed child to be reaped: the afterAll ps snapshot ran right after a bare SIGKILL and could list the
  // not-yet-reaped pids of a failed test as left running (seen under mutants M4 and M7), adding a hygiene failure.
  const killed = children.splice(0);
  for (const child of killed) if (child.pid) killPid(child.pid);
  await Promise.all(killed.map((child) => exited(child)));
  for (const pid of grandchildren.splice(0)) killPid(pid);
  rmSync(root, { recursive: true, force: true });
});

/** A lease this process holds, so a sender behind it must wait. */
async function gate(): Promise<Lease> {
  const lease = await acquire({ timeoutMs: DEADLINE_MS });
  held.push(lease);
  return lease;
}

/** Points under the ambient RAM reading the ram-limit and stop tests put their limit: RAM moves a little while they run. */
const RAM_MARGIN_PCT = 8;

/**
 * A RAM limit under the current reading on any machine (review M5): the reading minus RAM_MARGIN_PCT, through the
 * test-only LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN (governor/controller.ts), which lets settings.yaml go under the D13
 * minimum 50 in this process and in the CLIs it starts (runCli keeps it in their env). Never a setting.
 */
async function ramLimitUnderReading(): Promise<number> {
  process.env.LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN = "1";
  const { usedBytes, totalBytes } = await readRam();
  const used = (100 * usedBytes) / totalBytes;
  const limit = Math.floor(used) - RAM_MARGIN_PCT;
  expect(limit, `ram-limit needs more than ${RAM_MARGIN_PCT + 1} % of RAM in use (now ${used.toFixed(1)} %)`).toBeGreaterThanOrEqual(1);
  return limit;
}

describe("governor burn tests (spec section 3)", () => {
  it("🐌 burn-direct: nothing is sent while CPU burners keep the reading over cpu_limit_pct and every CLI says it waits; after they are killed, more than one once the reading stays under the limit; never over max_inferences; every CLI exits 0", async () => {
    const srv = await standIn(1_000);
    const burners = Array.from({ length: 2 * cpus().length }, () => burner());
    // Burning before any CLI asks: a grant needs a fresh reading, so the first one already sees the machine over.
    const cpuLimit = 50;
    const governor = [`cpu_limit_pct: ${cpuLimit}`, "max_inferences: 4", "ram_limit_pct: 99"];
    const runs = Array.from({ length: N }, (_, i) => runCli(configDir(`cfg-${i}`, srv.url, governor)));
    const said: string[] = runs.map(() => "");
    runs.forEach((r, i) => r.child.stderr?.on("data", (c: Buffer) => (said[i] += c.toString())));
    // TRDD-ZTO9K8EK: there is no CPU floor. While the burners hold the reading over cpu_limit_pct 50 every CLI is denied
    // and waits, whatever the time (the old floor let one inference through after 30 s): all N sit in the queue, the head
    // says why on stderr, and the stand-in server has received nothing.
    await until("every CLI waiting under the burners", () => snapshot().waiters.length >= N);
    await until("a CLI to say it waits for CPU", () => said.some((s) => s.includes("local inference waiting: CPU is")));
    const over = snapshot();
    expect(over.cpuPct ?? 0, "the sampler must show CPU over cpu_limit_pct 50 while the burners run").toBeGreaterThanOrEqual(cpuLimit);
    expect(posts(srv), "no CPU floor: nothing is sent while every CLI waits over the limit").toBe(0);
    // Review M4: the governor own CPU reading after the kill, with the CLIs still waiting, so the test can tell "the
    // machine is still busy" (the brake holds, specified) from "the brake never released".
    const samples: Array<{ at: number; cpu: number | null; waiting: number }> = [];
    const killedAt = Date.now();
    for (const b of burners) if (b.pid) killPid(b.pid);
    const sampler = setInterval(() => {
      const s = snapshot();
      samples.push({ at: Date.now(), cpu: s.cpuPct, waiting: s.waiters.length });
    }, 200);
    let results: Array<{ code: number | null; stderr: string }>;
    let raisedAt: number | null = null;
    let postsAtRaise = 0;
    try {
      const finished = Promise.all(runs.map((r) => r.done));
      const settled = await Promise.race([finished.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RELEASE_WAIT_MS))]);
      if (!settled) {
        // Other programs keep the machine over the limit and, with no CPU floor, nothing here ever releases the CLIs:
        // raise cpu_limit_pct in every settings.yaml, the way ram-limit raises its limit, so the run still ends.
        raisedAt = Date.now();
        postsAtRaise = posts(srv);
        for (let i = 0; i < N; i++) writeSettings(join(root, `cfg-${i}`), srv.url, ["cpu_limit_pct: 100", "max_inferences: 4", "ram_limit_pct: 99"]);
      }
      results = await finished;
    } finally {
      clearInterval(sampler);
    }
    const failed = results.filter((r) => r.code !== 0);
    expect(failed, failed.map((f) => f.stderr).join("\n")).toEqual([]);
    const rows = events(srv);
    const before = rows.filter((e) => e.at < killedAt).reduce((m, e) => Math.max(m, e.now), 0);
    const afterKill = rows.filter((e) => e.at >= killedAt).reduce((m, e) => Math.max(m, e.now), 0);
    // Hysteresis (coordinator amendment): the release branch only once the reading stayed 10 points under the limit, with
    // 2 or more CLIs still waiting, for one settle interval (100 ms here) plus one head poll delay (at most 250 ms), and
    // judged only on the server rows after that grace; the held branch only when every reading before the limit was
    // raised stayed 10 points over it.
    const heldSamples = samples.filter((s) => raisedAt === null || s.at < raisedAt);
    const graceMs = 100 + 250;
    let runStart: number | null = null;
    let releasedAt: number | null = null;
    for (const s of heldSamples) {
      if (s.cpu === null || s.cpu >= cpuLimit - 10 || s.waiting < 2) {
        runStart = null;
        continue;
      }
      runStart ??= s.at;
      if (s.at - runStart >= graceMs) {
        releasedAt = s.at;
        break;
      }
    }
    const stayedOver = raisedAt !== null && heldSamples.length > 0 && heldSamples.every((s) => s.cpu !== null && s.cpu > cpuLimit + 10);
    const branch = releasedAt !== null ? "release" : stayedOver ? "held" : "inconclusive";
    const readings = samples.map((s) => s.cpu).filter((c): c is number => c !== null);
    const afterRelease = releasedAt === null ? null : rows.filter((e) => e.at >= (releasedAt as number)).reduce((m, e) => Math.max(m, e.now), 0);
    process.stdout.write(`governor-burn: burn-direct ${N} CLIs, peak ${before} under the burners, ${afterKill} after the kill; branch ${branch}; ${samples.length} readings after the kill, CPU min ${readings.length ? Math.round(Math.min(...readings)) : "none"} max ${readings.length ? Math.round(Math.max(...readings)) : "none"}${afterRelease === null ? "" : `, peak ${afterRelease} after the release`}\n`);
    appendFileSync(join(SNAP_DIR, "burn-direct-branches.txt"), `${new Date().toISOString()} branch ${branch} before ${before} afterKill ${afterKill} afterRelease ${afterRelease}\n`);
    expect(before).toBe(0);
    expect(afterKill).toBeLessThanOrEqual(4);
    if (branch === "release") expect(afterRelease).toBeGreaterThan(1);
    if (branch === "held") expect(postsAtRaise, "no CPU floor: nothing was sent while every reading stayed over the limit").toBe(0);
    expect(posts(srv)).toBe(N);
    expect(snapshot().leases).toEqual([]);
  }, DEADLINE_MS * 2);

  it("ram-limit: under the reading nothing is sent and the waiter says why, server-status shows it, and raising ram_limit_pct in settings.yaml lets it finish", async () => {
    const limit = await ramLimitUnderReading();
    const srv = await standIn(0);
    const cfg = configDir("cfg", srv.url, [`ram_limit_pct: ${limit}`]);
    const run = runCli(cfg);
    let stderr = "";
    run.child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    await until("the CLI to say it waits for RAM", () => stderr.includes("local inference waiting: RAM is") || run.child.exitCode !== null);
    expect(run.child.exitCode).toBe(null);
    expect(snapshot().waiters.some((w) => w.holder.pid === run.child.pid)).toBe(true); // ubs:ignore unsafe_secret_compare pid comparison, not a secret
    expect(posts(srv)).toBe(0);
    const status = await serverStatusText(cfg);
    expect(status).toMatch(/governor: RAM \d+% used, limit 99%; CPU/);
    expect(status).toMatch(new RegExp(`governor: last denial \\d+ s ago, an inference of pid ${run.child.pid}: RAM is \\d+% used, limit ${limit}%`));
    // Review m6: the waiter is printed with its own limits (its settings.yaml), not those of this config dir (99 above).
    expect(status).toMatch(new RegExp(`governor: waiting \\d+ s, an inference of pid ${run.child.pid}: its limits RAM ${limit}%, CPU 80%, max_inferences 8`));
    writeSettings(cfg, srv.url, ["ram_limit_pct: 99"]);
    const { code, stderr: all } = await run.done;
    expect(code, all).toBe(0);
    expect(posts(srv)).toBe(1);
    expect(snapshot().waiters).toEqual([]);
  }, DEADLINE_MS);

  it("stop: --command_timeout 60 during a RAM wait exits 124, sends nothing, and leaves no waiter", async () => {
    const limit = await ramLimitUnderReading();
    const srv = await standIn(0);
    // WHY 60 s, not 3 s (TRDD-FC2TX9VU): the timeout must outlast the CLI start-up (settings migrations, backups; about 33 s on a loaded host)
    // so the RAM-wait line is printed before 124 ends the run. The RAM limit is below the reading, so the wait is unbounded and 124 still ends it.
    const run = runCli(configDir("cfg", srv.url, [`ram_limit_pct: ${limit}`]), ["--command_timeout", "60"]);
    const { code, stderr } = await run.done;
    expect(code, stderr).toBe(124);
    // Coordinator amendment 6: the wait was a RAM denial, not some other reason that also ends in 124.
    expect(stderr).toMatch(/local inference waiting: RAM is \d+% used, limit \d+%/);
    expect(posts(srv)).toBe(0);
    await until("no waiter of the stopped CLI", () => !snapshot().waiters.some((w) => w.holder.pid === run.child.pid)); // ubs:ignore unsafe_secret_compare pid comparison, not a secret
    expect(snapshot().leases).toEqual([]);
  }, DEADLINE_MS);

  it("crash: a SIGKILLed CLI holding the only lease is reclaimed within 2 s; a lease of a live pid with a wrong start time is reclaimed and that process is left alone", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const srv = await standIn(600_000);
    const run = runCli(configDir("cfg", srv.url, ["max_inferences: 1"]));
    await until("the CLI to hold the lease", () => snapshot().leases.some((l) => l.holder.pid === run.child.pid)); // ubs:ignore unsafe_secret_compare pid comparison, not a secret
    await until("its request to reach the server", () => posts(srv) === 1);
    const next = acquire({ timeoutMs: DEADLINE_MS });
    await until("this process to queue", () => snapshot().waiters.some((w) => w.holder.pid === process.pid));
    const killedAt = Date.now();
    process.kill(run.child.pid as number, "SIGKILL");
    const lease = await next;
    const reclaimMs = Date.now() - killedAt;
    release(lease);
    expect(reclaimMs).toBeLessThan(2_000);

    // A live process that is not the holder: same pid, another start. Only the start-time check can tell.
    const sleeper = track(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
    const sleeperPid = sleeper.pid as number;
    const startBefore = startOf(sleeperPid);
    const dir = process.env.LLM_EXT_GOVERNOR_DIR as string;
    const now = Date.now();
    withStateLock(dir, (state) => {
      state.leases.push({ id: "wrong-start", kind: "inference", weight: 1, threads: 0, serverPid: null, bytes: 0, holder: { pid: sleeperPid, start: "not its start" }, at: now, expiresAt: now + 3_600_000 });
      state.pidCheckAt = 0;
    });
    const t0 = Date.now();
    held.push(await acquire({ timeoutMs: DEADLINE_MS }));
    process.stdout.write(`governor-burn: crash reclaim ${reclaimMs} ms after SIGKILL, ${Date.now() - t0} ms for a wrong start time\n`);
    expect(snapshot().leases.map((l) => l.id)).not.toContain("wrong-start");
    expect(alive(sleeperPid)).toBe(true);
    expect(startOf(sleeperPid)).toBe(startBefore);
  }, DEADLINE_MS);

  it("no-touch: a server the test started, and its child, keep their pids and start times, receive no signal, and are never booked", async () => {
    const srv = await standIn(200, true);
    const starts = [startOf(srv.pid), startOf(srv.child as number)];
    const runs = Array.from({ length: 3 }, (_, i) => runCli(configDir(`cfg-${i}`, srv.url, [])));
    const results = await Promise.all(runs.map((r) => r.done));
    expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual([]);
    expect(posts(srv)).toBe(3);
    expect([alive(srv.pid), alive(srv.child as number)]).toEqual([true, true]);
    expect([startOf(srv.pid), startOf(srv.child as number)]).toEqual(starts);
    expect(readFileSync(srv.sigLog, "utf8")).toBe("");
    expect(snapshot().servers.map((s) => s.pid)).not.toContain(srv.pid);
  }, DEADLINE_MS);

  it("fairness: 20 requesters with long queues take turns: after every grant the counts differ by at most 1", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    const count = 20;
    const k = 3;
    const out = join(root, "grants.txt");
    writeFileSync(out, "");
    // All queued before the first grant, so the order is set by the governor alone.
    const first = await gate();
    const procs = Array.from({ length: count }, () => track(spawn(process.execPath, [requesterJs, out, String(k)], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env } })));
    await until("20 requesters in the queue", () => snapshot().waiters.length === count);
    held.splice(held.indexOf(first), 1);
    release(first);
    const codes = await Promise.all(procs.map((p) => exited(p)));
    expect(codes.every((c) => c === 0)).toBe(true);
    const order = readFileSync(out, "utf8").split("\n").filter(Boolean);
    expect(order).toHaveLength(count * k);
    const grants = new Map<string, number>(procs.map((p) => [String(p.pid), 0]));
    let worst = 0;
    for (const pid of order) {
      grants.set(pid, (grants.get(pid) ?? 0) + 1);
      const values = [...grants.values()];
      worst = Math.max(worst, Math.max(...values) - Math.min(...values));
    }
    expect(worst).toBeLessThanOrEqual(1);
  }, DEADLINE_MS);

  it("enabled: false (D13): the CLI sends at once beside a full window, takes no place and no lease", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    await gate();
    const srv = await standIn(500);
    const run = runCli(configDir("cfg", srv.url, ["enabled: false", "max_inferences: 1"]));
    let seen = false;
    const sampler = setInterval(() => {
      const s = snapshot();
      if (s.waiters.some((w) => w.holder.pid === run.child.pid) || s.leases.some((l) => l.holder.pid === run.child.pid)) seen = true; // ubs:ignore unsafe_secret_compare pid comparison, not a secret
    }, 20);
    const { code, stderr } = await run.done.finally(() => clearInterval(sampler));
    expect(code, stderr).toBe(0);
    expect(posts(srv)).toBe(1);
    expect(seen).toBe(false);
    expect(snapshot().leases).toHaveLength(1);
  }, DEADLINE_MS);

  it("a settings.yaml edit reaches a running broker within 2 s: a new limit in its health, a malformed one in its log", async () => {
    const dir = mkdtempSync(join(root, "broker-"));
    brokerDirs.push(dir);
    const env: NodeJS.ProcessEnv = { ...process.env, LLM_EXT_CONFIG_DIR: dir };
    delete env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT;
    writeFileSync(join(dir, "settings.yaml"), "local_governor:\n  ram_limit_pct: 95\n");
    const ep = await ensureBroker({ dir, version: "t1", entry: brokerJs, env });
    started.add(ep.pid);
    const ramLimit = async (): Promise<number | undefined> => {
      const res = await fetch(`${ep.url}/v1/health`, { headers: { [TOKEN_HEADER]: ep.token } }); // ubs:ignore unsafe_secret_compare loopback test-server token, not a secret compare
      return ((await res.json()) as { governor?: { ramLimitPct?: number } }).governor?.ramLimitPct;
    };
    expect(await ramLimit()).toBe(95);
    const path = join(dir, "settings.yaml");
    writeFileSync(path, "local_governor:\n  ram_limit_pct: 93\n");
    const t0 = Date.now();
    await until("the broker to see ram_limit_pct 93", async () => (await ramLimit()) === 93, 2_000);
    const valid = Date.now() - t0;
    writeFileSync(path, "local_governor:\n  ram_limit_pct: 10\n");
    const t1 = Date.now();
    const log = join(dir, "broker-local.log");
    await until("the broker to log the malformed setting", () => existsSync(log) && readFileSync(log, "utf8").includes("the local inference governor settings are invalid"), 2_000);
    const malformed = Date.now() - t1;
    process.stdout.write(`governor-burn: settings edit seen by the broker in ${valid} ms, a malformed one logged in ${malformed} ms\n`);
    appendFileSync(join(SNAP_DIR, "broker-settings.txt"), `${new Date().toISOString()} valid ${valid} ms, malformed ${malformed} ms\n`);
  }, DEADLINE_MS);

  it("D2 (review M1): with the governor dir a regular file and enabled false, a CLI send, acquire({kind: load}), bookedBytesNow and unloadWanted work and touch nothing; enabled, the error is a GovernorDirError", async () => {
    const file = join(root, "gov-file");
    writeFileSync(file, "not a directory\n");
    process.env.LLM_EXT_GOVERNOR_DIR = file;
    process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
    try {
      const srv = await standIn(0);
      // The CLI inherits the dir (a file) and reads enabled: false from its own settings.yaml (runCli drops the env one).
      const run = runCli(configDir("cfg", srv.url, ["enabled: false"]));
      const lease = await acquire({ timeoutMs: 60_000, kind: "load", bytes: 2 ** 30 }, { signal: AbortSignal.timeout(15_000) });
      release(lease);
      expect(bookedBytesNow()).toBe(0);
      expect(unloadWanted(process.pid)).toBe(false);
      const { code, stderr } = await run.done;
      expect(code, stderr).toBe(0);
      expect(posts(srv)).toBe(1);
      expect(readFileSync(file, "utf8")).toBe("not a directory\n");
      // Coordinator amendment 4: enabled, the same directory is an error of its own class, which calibration keeps off its
      // crash path (runner.ts), never a failure of the model.
      process.env.LLM_EXT_GOVERNOR_ENABLED = "true";
      const err = await acquire({ timeoutMs: 60_000 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isGovernorDirError(err), String(err)).toBe(true);
    } finally {
      process.env.LLM_EXT_GOVERNOR_DIR = join(root, "gov");
    }
  }, DEADLINE_MS);

  it("M3: a server registered while enabled is removed on unregister after a flip to disabled", async () => {
    const pid = 999_991;
    registerServer(pid, { bookedBytes: 1, residentBytes: 1, engine: "llama", role: "main", threads: 0 });
    await until("the entry to be written", () => snapshot().servers.some((s) => s.pid === pid), 10_000);
    process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
    unregisterServer(pid);
    await until("the entry to be removed", () => !snapshot().servers.some((s) => s.pid === pid), 10_000);
  }, DEADLINE_MS);

  it("m1: a CLI disabled while queued below a live head proceeds at once, before the head is granted, and leaves the queue", async () => {
    process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "1";
    // The only inference place is held through the whole assertion window, so the head below cannot be granted in it.
    const first = await gate();
    const head = acquire({ timeoutMs: DEADLINE_MS });
    await until("this process to be the head waiter", () => snapshot().waiters[0]?.holder.pid === process.pid);
    const srv = await standIn(0);
    const cfg = configDir("cfg", srv.url, ["max_inferences: 1"]);
    const run = runCli(cfg);
    await until("the CLI to queue behind the head", () => snapshot().waiters.some((w) => w.holder.pid === run.child.pid)); // ubs:ignore unsafe_secret_compare pid comparison, not a secret
    writeSettings(cfg, srv.url, ["enabled: false", "max_inferences: 1"]);
    await until("the disabled CLI to finish", () => run.child.exitCode !== null, 15_000); // ubs:ignore unsafe_secret_compare exit-code check, not a secret
    const { code, stderr } = await run.done;
    expect(code, stderr).toBe(0);
    expect(posts(srv)).toBe(1);
    const s = snapshot();
    expect(s.waiters.map((w) => w.holder.pid)).toEqual([process.pid]);
    expect(s.leases.map((l) => l.id)).toEqual([first.id]);
    held.splice(held.indexOf(first), 1);
    release(first);
    held.push(await head);
  }, DEADLINE_MS);

  it("server-status prints the governor as off when this config dir is disabled, with the machine-wide figures", async () => {
    await gate();
    process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
    const dir = process.env.LLM_EXT_GOVERNOR_DIR as string;
    const statusDir = join(root, "status");
    mkdirSync(statusDir);
    const lines = (await serverStatusText(statusDir)).split("\n");
    expect(lines).toContain(`governor: off for this config dir (local_governor.enabled false or LLM_EXT_GOVERNOR_ENABLED=false): its sends take no lease and are not counted; machine-wide state (${dir}): 1 inference(s) running, 1 lease(s), 0 waiting`);
  }, DEADLINE_MS);
});
