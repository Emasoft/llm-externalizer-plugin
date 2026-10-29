/**
 * local-locals-server.ts — the Locals engine of the local-model broker
 * (TRDD-ZGSGGHQG; design/specs/TRDD-ZGSGGHQG-locals-mlx-design.md L2 option B,
 * local-engine-broker-design.md point 9). Locals serves ONE MLX model per
 * server and answers many requests at once (its --slots), so the broker runs
 * one main Locals server at a time, like llama-server, and dispatches up to
 * LOCALS_MAIN_SLOTS jobs to it while memory allows.
 *
 * Hard rules (they exist because earlier runs broke the user's machine):
 * - the server is started ONLY as `<locals python> -I -m locals.server ...`,
 *   never `locals start` / `locals serve`: those rewrite ~/.locals/config.json
 *   (measured). The server module writes no config file.
 * - its cwd is a fresh empty temporary directory, and `-I` keeps the cwd and
 *   every PYTHON* variable off sys.path: a script named like a package
 *   (mlx.py) in the cwd once shadowed `mlx` and made every server start
 *   another one (reports/locals-mlx/20261028_203154+0100-self-spawn-cause.md).
 * - the interpreter is found from the `locals` tool's shebang (else
 *   `uv tool dir`), never a hard-coded path.
 * - `-X llm-ext-server=<marker>` marks the process as llm-ext's in its argv
 *   (Python accepts and ignores unknown -X options), so kill safety can tell
 *   it from a Locals server the user started (which never carries it).
 */

import { execFile, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnDetachedChild } from "./bench-spawn.js";
import { httpStatus, isPythonPath, LOCALS_MARKER_OPTION, ManagedServerError, pidState, sleep, STALL_MS, POLL_MS, type ManagedTarget } from "./local-llama-server.js";

/**
 * Parallel requests per Locals main server (its --slots): the broker
 * dispatches at most this many jobs at once (Locals exposes no slot count,
 * so the broker uses the value it passed). Provisional 4; measured on LFM3
 * 1.7B: 69, 242, 357, 399 tok/s at 1, 4, 8, 16 requests
 * (reports/locals-mlx/20261028_192216+0100-concurrency.md). Calibrated in P6.
 */
export const LOCALS_MAIN_SLOTS = 4;

/** A Hugging Face repo id `org/name`: what Locals downloads and what /stats.model reports back (measured). */
const LOCALS_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The model forms the broker accepts for Locals: a Hugging Face repo id (a short alias or a path would not match /stats.model). */
export function parseLocalsModel(model: string): { ok: true } | { error: string } {
  if (!LOCALS_MODEL_RE.test(model)) return { error: `Locals model '${model}' must be a Hugging Face repo id (org/name)` };
  if (/\.gguf$/i.test(model)) return { error: `Locals model '${model}' is a GGUF file; Locals runs MLX models` };
  return { ok: true };
}

function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0];
  } finally {
    closeSync(fd);
  }
}

function execText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * The Python interpreter of the installed Locals tool: the absolute path in
 * the shebang of the `locals` command on PATH (measured: `#!<uv tool
 * venv>/bin/python`), else `<uv tool dir>/locals/bin/python`. A missing
 * install is a clear error, never a guess.
 */
export async function localsPython(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    // A relative PATH entry would resolve against the broker's cwd: never trusted.
    if (!dir || !isAbsolute(dir)) continue;
    const cmd = join(dir, "locals");
    if (!existsSync(cmd)) continue;
    let line: string;
    try {
      line = firstLine(cmd);
    } catch {
      continue;
    }
    // Review F-5: only an absolute Python interpreter counts (a `#!/usr/bin/env python3`
    // shim names env, and a non-python basename could never be identified as ours
    // later by isLocalsServerArgv); anything else falls through to `uv tool dir`.
    const exe = line.startsWith("#!") ? line.slice(2).trim().split(/\s+/)[0] : "";
    if (exe && isAbsolute(exe) && isPythonPath(exe) && existsSync(exe)) return exe;
  }
  const toolDir = (await execText("uv", ["tool", "dir"]))?.trim();
  if (toolDir) {
    const exe = join(toolDir, "locals", "bin", "python");
    if (existsSync(exe)) return exe;
  }
  throw new ManagedServerError(
    "Locals is not installed (no `locals` command on PATH and no uv tool named locals); install it with: uv tool install https://github.com/Generated-Computers/Locals.git --python 3.12",
  );
}

/** The argv of a main Locals server (argv[0] is the interpreter). */
export function buildLocalsArgv(python: string, target: ManagedTarget, marker: string): string[] {
  return [
    python,
    "-I",
    "-X",
    `${LOCALS_MARKER_OPTION}=${marker}`,
    "-m",
    "locals.server",
    "--host",
    "127.0.0.1",
    "--port",
    String(target.port),
    "--model",
    target.model,
    "--slots",
    String(target.slots ?? LOCALS_MAIN_SLOTS),
    // --max-context = prompt + reply tokens per request, the profile's context_window (Locals' default: what fits in memory).
    ...(target.ctx > 0 ? ["--max-context", String(target.ctx)] : []),
  ];
}

/** Does a raw `ps` command line carry `-X llm-ext-server=<marker>` (unsplit, like hasLogFileMarker: a marker path may contain spaces)? */
export function hasLocalsMarker(command: string, marker: string): boolean {
  const needle = ` -X ${LOCALS_MARKER_OPTION}=${marker}`;
  for (let i = command.indexOf(needle); i >= 0; i = command.indexOf(needle, i + 1)) {
    const after = command[i + needle.length];
    if (after === undefined || after === " ") return true;
  }
  return false;
}

/**
 * The environment of a Locals server: an allow-list (the client carries every
 * provider key, none of it is Locals' business). Kept: what a process needs
 * to run, the Hugging Face cache and endpoint settings its download reads
 * (HF_TOKEN for a gated repo), and Locals' own LOCALS_* and MLX/Metal knobs.
 * PYTHON* is irrelevant: -I ignores it.
 */
export function localsServerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (LOCALS_ENV_KEEP.has(k) || /^(LC_|LOCALS_|MLX_|METAL_|HF_)/.test(k)) out[k] = v;
  }
  return out;
}
// Review F-9: proxy and CA settings too, or a model download behind a proxy fails.
const LOCALS_ENV_KEEP = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR", "XDG_CACHE_HOME", "HUGGINGFACE_HUB_CACHE",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
]);

/**
 * Start a Locals server detached in its own process group (pgid === pid), its
 * stdout and stderr appended to `logFile` (the previous run's log is kept as
 * .1), its cwd a fresh empty temporary directory.
 */
export async function spawnLocalsServer(
  target: ManagedTarget,
  logFile: string,
  marker: string,
): Promise<{ pid: number; argv: string[]; child: ChildProcess; cwd: string }> {
  const python = await localsPython();
  if (existsSync(logFile)) renameSync(logFile, `${logFile}.1`);
  const argv = buildLocalsArgv(python, target, marker);
  const cwd = mkdtempSync(join(tmpdir(), "llm-ext-locals-"));
  try {
    let rejectSpawn: (err: Error) => void = () => undefined;
    const child = spawnDetachedChild({
      command: python,
      args: argv.slice(1),
      logPath: logFile,
      env: localsServerEnv(process.env),
      cwd,
      onError: (err) => rejectSpawn(new ManagedServerError(`could not start the Locals server (${python}): ${err.message}`)),
    });
    const pid = await new Promise<number>((resolve, reject) => {
      rejectSpawn = reject;
      child.once("spawn", () => resolve(child.pid as number));
    });
    return { pid, argv, child, cwd };
  } catch (err) {
    // Review F-6: a spawn that never started leaves no process in the cwd; remove it (rmdir, never recursive).
    rmdirSync(cwd);
    throw err;
  }
}

/** The Hugging Face hub cache in huggingface_hub's lookup order (Locals downloads through snapshot_download). */
function hubCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HUGGINGFACE_HUB_CACHE) return env.HUGGINGFACE_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, "hub");
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "huggingface", "hub");
  return join(homedir(), ".cache", "huggingface", "hub");
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

/** The process's cumulative CPU time as `ps` prints it (e.g. 0:05.53), "" when unreadable. */
async function cpuTime(pid: number): Promise<string> {
  return (await execText("ps", ["-o", "time=", "-p", String(pid)]))?.trim() ?? "";
}

/**
 * Changes whenever the server makes progress: its log or the model's cache
 * folder grows (a download), or its CPU time grows. Review F-3, measured on
 * a 2.9 GB cached model (reports/locals-mlx P2 fix report): during the load
 * the port is closed and the log is silent for seconds at a time while the
 * process reads the weights (RSS +200 MB per 0.27 s, CPU time rising), so a
 * silent load still counts as progress; only a process that does nothing at
 * all (no CPU, no log, no download) is stalled.
 */
async function progressSignature(model: string, log: string, pid: number): Promise<string> {
  let sig = `${String(sizeOf(log))}|cpu ${await cpuTime(pid)}`;
  const [org, name] = model.split("/");
  const blobs = join(hubCacheDir(), `models--${org}--${name}`, "blobs");
  try {
    for (const f of readdirSync(blobs).sort()) sig += `|${f}:${sizeOf(join(blobs, f))}`;
  } catch {
    /* not created yet */
  }
  return sig;
}

function logTail(log: string): string {
  try {
    const lines = readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    return `Last log lines (${log}):\n${lines.slice(-20).join("\n")}`;
  } catch {
    return `no log at ${log}`;
  }
}

/**
 * Wait until the Locals server answers /health 200 and its /stats.model is the
 * expected model (measured: the full Hugging Face id; the listener opens only
 * after the model loaded, so a closed port with the pid alive is loading or
 * downloading). Not bounded by a request timeout: waiting is never an error.
 * The only limit is the stall rule: `stallMs` with no progress at all
 * (progressSignature: log, model cache and CPU time all unchanged).
 */
export async function waitLocalsReady(target: ManagedTarget, pid: number, isDead: () => boolean, log: string, stallMs = STALL_MS): Promise<void> {
  const base = `http://127.0.0.1:${target.port}`;
  let sig = await progressSignature(target.model, log, pid);
  let lastProgress = Date.now();
  for (;;) {
    if (isDead() || pidState(pid) !== "alive") {
      throw new ManagedServerError(`the Locals server for '${target.model}' on port ${target.port} (pid ${pid}) exited before it was ready. ${logTail(log)}`);
    }
    const health = await httpStatus(`${base}/health`, "");
    if (health?.status === 200) {
      const stats = await httpStatus(`${base}/stats`, "");
      let served: unknown;
      try {
        served = (JSON.parse(stats?.body ?? "") as { model?: unknown }).model;
      } catch {
        served = undefined;
      }
      if (served === target.model) return;
      // Review F-4: an unanswered or unreadable /stats is not a verdict: ask again on the next poll.
      if (typeof served === "string") throw new ManagedServerError(`the Locals server on port ${target.port} serves '${served}', expected '${target.model}'`);
    }
    const now = Date.now();
    const next = await progressSignature(target.model, log, pid);
    if (next !== sig) {
      sig = next;
      lastProgress = now;
    } else if (now - lastProgress > stallMs) {
      throw new ManagedServerError(
        `the Locals server for '${target.model}' on port ${target.port} (pid ${pid}) made no progress for ${Math.round(stallMs / 1000)} s (no CPU time, no log output, no download). ${logTail(log)}`,
      );
    }
    await sleep(POLL_MS);
  }
}
/** The ids the Locals server lists on /v1/models (measured: `locals/<short>` and, for a thinking model, `locals/<short>-thinking`). */
export async function localsModelIds(port: number): Promise<string[]> {
  const r = await httpStatus(`http://127.0.0.1:${port}/v1/models`, "");
  try {
    const data = (JSON.parse(r?.body ?? "") as { data?: Array<{ id?: unknown }> }).data ?? [];
    return data.map((d) => d.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * The model field the broker sends to Locals. Locals serves any unknown id
 * with its loaded model (measured), so the field only selects the variant:
 * the `-thinking` id when the request asks for thinking
 * (chat_template_kwargs.enable_thinking true) and the server lists one
 * (thinking MLX models need it, reports/locals-mlx), else the base id.
 */
export function localsOutgoingModel(ids: readonly string[], body: Record<string, unknown>): string | null {
  const base = ids.find((id) => !id.endsWith("-thinking"));
  if (base === undefined) return null;
  const kwargs = body.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
  const thinking = `${base}-thinking`;
  return kwargs?.enable_thinking === true && ids.includes(thinking) ? thinking : base;
}

/**
 * macOS `memory_pressure`: the system-wide free memory percentage (it already
 * counts inactive, purgeable and compressed memory; Locals itself guards only
 * its own GPU working set, not other processes). null when it cannot be read.
 */
export async function memoryFreePercent(): Promise<number | null> {
  const out = await execText("memory_pressure", []);
  const m = out === null ? null : /free percentage:\s*(\d+)%/.exec(out);
  return m ? Number(m[1]) : null;
}
