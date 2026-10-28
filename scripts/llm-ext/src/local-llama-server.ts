/**
 * local-llama-server.ts — the llama.cpp engine helpers of the per-engine
 * broker (TRDD-1OOAH3LD; design/specs/local-engine-broker-design.md).
 *
 * The broker (broker/server.ts) owns WHEN a llama-server runs and which model
 * it serves; this module owns HOW: the model-id parser, the argv and its
 * exact-token identity, download-aware readiness, the process-group stop, the
 * async mkdir lock and ManagedServerError. It never touches a process it did
 * not start: identity is the live argv (spec point 9), and the sweep matches
 * only the --log-file marker that names this config dir.
 *
 * Dropped from the paused P1 tree (spec point 13): the per-route, per-port
 * target with its llama-server-<port>.json state files; the broker picks a
 * free port and keeps one main server per engine in the registry instead.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { spawnDetachedChild } from "./bench-spawn.js";
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { STALE_MS } from "./mkdir-lock.js";
import { attachFailure } from "./provider/http.js";

/** Built-in sleep: the server unloads the model after this many idle seconds (USER ruling, TRDD-1OOAH3LD; 2.5 GB to 169 MB, 0.5 s wake, measured). */
export const SLEEP_IDLE_SECONDS = 1800;
/** Readiness stall limit: neither the log nor the model cache grew for this long (Revision 4: readiness only, never an in-flight request). */
export const STALL_MS = 120_000;
/** Readiness poll interval. */
export const POLL_MS = 500;
/** Total wait for the per-port lock. The work inside the lock is short (state, identity, probe, spawn); readiness runs OUTSIDE it. */
export const LOCK_WAIT_MS = 60_000;
/** server-stop: SIGTERM, then SIGKILL after this many ms (POSIX). */
export const STOP_GRACE_MS = 10_000;
/** The line the supervisor writes into llama-server-<port>.log before every spawn; tests count spawns by it. */
export const SPAWN_MARKER = "[llm-ext supervisor] spawn";

/**
 * A supervisor failure. Marked final "stop" at construction so
 * chatCompletionWithRetry neither retries it nor counts it toward the
 * circuit breaker (Revision 4): chatCompletionSimple calls resolveConnection
 * on every attempt, so an unmarked failure would run the start-up path up to
 * 4 times per chain entry. The profile walker classifies it as kind
 * "endpoint" (instanceof), so its base URL is dead for that walk only.
 */
export class ManagedServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedServerError";
    attachFailure(this, { final: "stop" });
  }
}

export interface ManagedTarget {
  port: number;
  /** The profile's model id: org/repo:quant, org/repo/file.gguf, or an absolute .gguf path. */
  model: string;
  /** Server context (-c); 0 = llama-server's own default (no -c). */
  ctx: number;
}

export type ManagedModelKind = "hf" | "hf-file" | "file";

const HF_PART = "[A-Za-z0-9][A-Za-z0-9._-]*";
const HF_RE = new RegExp(`^(${HF_PART})/(${HF_PART}):(${HF_PART})$`);
const HF_FILE_RE = new RegExp(`^(${HF_PART})/(${HF_PART})/(${HF_PART}\\.gguf)$`, "i");

/**
 * The llama-server model arguments for a model id, or an error message.
 * Three kinds: `org/repo:quant` → -hf; `org/repo/file.gguf` → --hf-repo +
 * --hf-file (P1: a repo whose quant tag is ambiguous names the file); an
 * absolute .gguf path with no whitespace that exists → -m.
 */
export function parseManagedModel(model: string): { kind: ManagedModelKind; argv: string[] } | { error: string } {
  if (HF_RE.test(model)) return { kind: "hf", argv: ["-hf", model] };
  const f = HF_FILE_RE.exec(model);
  if (f) return { kind: "hf-file", argv: ["--hf-repo", `${f[1]}/${f[2]}`, "--hf-file", f[3]] };
  if (isAbsolute(model) && /\.gguf$/i.test(model)) {
    // Whitespace is refused: the darwin identity check tokenises `ps` output on whitespace, so a path with a space could never be recognised as ours.
    if (/\s/.test(model)) return { error: `managed model path '${model}' contains whitespace; move or link the .gguf to a path without spaces` };
    if (!existsSync(model)) return { error: `managed model file '${model}' does not exist` };
    return { kind: "file", argv: ["-m", model] };
  }
  return {
    error: `model '${model}' cannot be served by a managed llama-server: use org/repo:quant, org/repo/file.gguf, or an absolute path to a .gguf file`,
  };
}

/** The full llama-server argv for a target (model args first). `--log-file` doubles as the stable marker the registry sweep finds an unrecorded llm-ext server by (spec point 8): it names THIS config dir, so a user-run llama-server never matches. */
export function buildServerArgv(target: ManagedTarget, modelArgv: string[], logFile: string): string[] {
  return [
    ...modelArgv,
    "--alias", target.model,
    "--host", "127.0.0.1",
    "--port", String(target.port),
    ...(target.ctx > 0 ? ["-c", String(target.ctx)] : []),
    "--jinja",
    "--sleep-idle-seconds", String(SLEEP_IDLE_SECONDS),
    "--log-file", logFile,
  ];
}

export interface ArgvIdentity {
  isLlamaServer: boolean;
  /** The llm-ext model id the argv serves (reconstructed), or null. */
  model: string | null;
  port: number | null;
  ctx: number;
  /** The --log-file value: the llm-ext marker (spec point 8), or null. */
  logFile: string | null;
}

/**
 * What a llama-server command line serves. EXACT token comparison only:
 * `--port 818` must never match 8181, so values are whole tokens, never
 * substrings of the joined command line.
 */
export function describeArgv(tokens: readonly string[]): ArgvIdentity {
  const exe = tokens[0] ? basename(tokens[0].replace(/\\/g, "/")) : "";
  const after = (flag: string): string | undefined => {
    const i = tokens.indexOf(flag, 1);
    return i > 0 ? tokens[i + 1] : undefined;
  };
  const repo = after("-hf") ?? after("--hf-repo");
  const file = after("--hf-file");
  const path = after("-m") ?? after("--model");
  const model = path ?? (repo !== undefined && file !== undefined ? `${repo}/${file}` : repo) ?? null;
  const portTok = after("--port");
  const ctxTok = after("-c") ?? after("--ctx-size");
  return {
    isLlamaServer: exe === "llama-server" || exe.toLowerCase() === "llama-server.exe",
    model,
    port: portTok !== undefined && /^\d+$/.test(portTok) ? Number(portTok) : null,
    ctx: ctxTok !== undefined && /^\d+$/.test(ctxTok) ? Number(ctxTok) : 0,
    logFile: after("--log-file") ?? null,
  };
}

/**
 * Split a Windows command line (Win32_Process.CommandLine) into argv. Quote
 * aware: whitespace inside double quotes does not split, `\"` is a literal
 * quote. Verified only on recorded strings until the live Windows check (2d).
 */
export function tokenizeWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === '"') {
      cur += '"';
      has = true;
      i++;
    } else if (ch === '"') {
      inQuote = !inQuote;
      has = true;
    } else if (!inQuote && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Run a command and return its stdout. A failure THROWS (review M6): every
 * caller uses the output to decide whether a process exists, and "ps failed"
 * read as "no process" made a live server look dead (a second main) and a stop
 * look done. maxBuffer is raised from execFile's 1 MB default: `ps -axww` on a
 * machine with long Chrome/Electron argv goes past it.
 */
function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // 30 s, not 10 s: a full `ps -axww` failed under the loaded parallel test run (measured 2026-10-28); the code,
    // signal and stderr ride on the error so a timeout is told apart from a real ps failure.
    execFile(cmd, args, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err
        ? reject(
            new ManagedServerError(
              `${cmd} ${args.join(" ")} failed (code ${String((err as NodeJS.ErrnoException & { code?: unknown }).code)}, signal ${String(err.signal)}${err.killed ? ", killed by the timeout" : ""}): ${String(stderr).trim() || err.message}`,
            ),
          )
        : resolve(String(stdout)),
    );
  });
}

/**
 * The live argv of `pid`, per platform (Revision 4), or null when the process
 * is gone. A read that fails while the pid is still alive THROWS (review M6):
 * "unreadable" must never count as "not our server".
 */
export async function readCommandLine(pid: number): Promise<string[] | null> {
  if (pidState(pid) === "dead") return null;
  try {
    if (process.platform === "linux") {
      const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (parts[parts.length - 1] === "") parts.pop();
      return parts.length > 0 ? parts : null;
    }
    if (process.platform === "win32") {
      const out = await execText("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ]);
      const line = out.trim();
      return line ? tokenizeWindowsCommandLine(line) : null;
    }
    // darwin and other POSIX: -ww so a long argv is never truncated (the model token is near the end).
    const line = (await execText("ps", ["-ww", "-o", "command=", "-p", String(pid)])).trim();
    return line ? line.split(/\s+/) : null;
  } catch (err) {
    // `ps -p` exits 1 for a pid that exited meanwhile: only that case is "gone".
    if (pidState(pid) === "dead") return null;
    throw err instanceof ManagedServerError ? err : new ManagedServerError(`cannot read the command line of pid ${pid}: ${(err as Error).message}`);
  }
}

/** kill(pid, 0): "alive", "dead", or "eperm" (alive but owned by someone else: never ours). */
export function pidState(pid: number): "alive" | "dead" | "eperm" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "eperm" : "dead";
  }
}

/**
 * Async mkdir lock (the broker spawn lock, the server registry lock). Unlike
 * mkdir-lock.ts it NEVER fails open: the one-broker and the server-count
 * guarantees are only as strong as this lock, so a timeout is a
 * ManagedServerError, never an unlocked run. Same stale rule as mkdir-lock.ts
 * (a lock dir older than STALE_MS is taken over).
 */
export async function withAsyncLock<T>(dir: string, fn: () => Promise<T>, refreshMs = Math.floor(STALE_MS / 3)): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ManagedServerError(`could not create the lock ${dir}: ${(err as Error).message}`);
      }
      try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_MS) {
          rmSync(dir, { recursive: true, force: true });
          process.stderr.write(`[llm-externalizer] took over a stale lock (older than ${STALE_MS} ms): ${dir}\n`);
          continue;
        }
      } catch {
        continue; // released between mkdir and stat: retry at once
      }
      if (Date.now() > deadline) {
        throw new ManagedServerError(`timed out after ${LOCK_WAIT_MS / 1000} s waiting for the lock ${dir}`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  // Review M12: a holder can legitimately keep the lock past STALE_MS (two
  // group stops under the registry lock take 10 s grace + verification each),
  // and a waiter would then take it over as stale and spawn a second server.
  // Touching the lock dir while held keeps its mtime fresh; unref'd so it
  // never keeps a process alive.
  const refresh = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(dir, now, now);
    } catch {
      /* taken over or removed: the holder finds out at release */
    }
  }, refreshMs);
  refresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    try {
      rmdirSync(dir);
    } catch {
      /* already removed (stale takeover by another process) */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** true when something accepts TCP connections on 127.0.0.1:port. Only ECONNREFUSED counts as closed; any other outcome is treated as occupied, so an unclear probe never leads to a spawn onto someone's port. */
export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean): void => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(2000, () => done(true));
    sock.once("connect", () => done(true));
    sock.once("error", (err: NodeJS.ErrnoException) => done(err.code !== "ECONNREFUSED"));
  });
}

/** The Hugging Face hub cache folder, in llama.cpp's own lookup order (measured). */
export function hfCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LLAMA_CACHE) return env.LLAMA_CACHE;
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

/** A value that changes whenever the log or the model's cache folder grows (download progress lands in blobs/<sha>.downloadInProgress, measured). */
function progressSignature(target: ManagedTarget, log: string): string {
  let sig = String(sizeOf(log));
  const repo = HF_RE.exec(target.model) ?? HF_FILE_RE.exec(target.model);
  if (repo) {
    const blobs = join(hfCacheDir(), `models--${repo[1]}--${repo[2]}`, "blobs");
    try {
      for (const name of readdirSync(blobs).sort()) sig += `|${name}:${sizeOf(join(blobs, name))}`;
    } catch {
      /* not created yet */
    }
  }
  return sig;
}

function lastLines(file: string, n: number): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").slice(-n);
  } catch {
    return [];
  }
}

/** Hints for a failed start, read from the server log. */
export function failureHints(log: string): string {
  const lines = lastLines(log, 400);
  const text = lines.join("\n");
  const hints: string[] = [];
  if (/unknown (model )?architecture|error loading model architecture/i.test(text)) {
    const brew = process.platform === "darwin" && (existsSync("/opt/homebrew/bin/brew") || existsSync("/usr/local/bin/brew"));
    hints.push(
      brew
        ? "this llama.cpp build does not know the model; update it: brew upgrade --fetch-HEAD llama.cpp"
        : "this llama.cpp build does not know the model; upgrade llama.cpp",
    );
  }
  if (/couldn't bind|address already in use/i.test(text)) hints.push("port conflict: another process holds the port");
  const tail = lines.slice(-20);
  return `${hints.length ? `${hints.join("; ")}. ` : ""}Last log lines (${log}):\n${tail.join("\n")}`;
}

async function httpStatus(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return null; // refused or not answering yet
  }
}

/**
 * Wait until the server answers 200 and serves the expected model. Not bounded
 * by the request timeout (a first-run download can take many minutes); the
 * only limit is the progress stall rule.
 */
export async function waitReady(target: ManagedTarget, pid: number, isDead: () => boolean, log: string): Promise<void> {
  const base = `http://127.0.0.1:${target.port}`;
  let sig = progressSignature(target, log);
  let lastProgress = Date.now();
  for (;;) {
    if (isDead() || pidState(pid) !== "alive") {
      throw new ManagedServerError(
        `llama-server for '${target.model}' on port ${target.port} (pid ${pid}) exited before it was ready. ${failureHints(log)}`,
      );
    }
    const health = await httpStatus(`${base}/health`);
    if (health?.status === 200) {
      const models = await httpStatus(`${base}/v1/models`);
      let served: unknown;
      try {
        served = (JSON.parse(models?.body ?? "") as { data?: Array<{ id?: unknown }> }).data?.[0]?.id;
      } catch {
        served = undefined;
      }
      if (served === target.model) return;
      throw new ManagedServerError(
        `llama-server on port ${target.port} serves '${String(served)}', expected '${target.model}'`,
      );
    }
    // Refused with the pid alive = downloading or starting (the port stays closed for the whole download, measured); 503 = loading.
    const now = Date.now();
    const next = progressSignature(target, log);
    if (next !== sig) {
      sig = next;
      lastProgress = now;
    } else if (now - lastProgress > STALL_MS) {
      throw new ManagedServerError(
        `llama-server for '${target.model}' on port ${target.port} (pid ${pid}) made no progress for ${STALL_MS / 1000} s (neither its log nor the model cache grew). ${failureHints(log)}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** A free TCP port on 127.0.0.1, chosen by the OS. The broker binds its main server here instead of a profile port, so it can never collide with a server the user runs on a fixed port (8181, Locals 8321, ...). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Start llama-server detached in its OWN process group (detached: true makes
 * the child a group leader, so pgid === pid on POSIX): a swap or an orphan
 * sweep stops the whole group with one signal. stdio is ignored because
 * --log-file mirrors everything llama-server prints (measured) and TRUNCATES
 * the file on open (measured), so a second writer on it would lose its lines;
 * the previous run's log is kept as .1.
 */
export async function spawnLlamaServer(
  target: ManagedTarget,
  modelArgv: string[],
  logFile: string,
): Promise<{ pid: number; argv: string[]; child: ChildProcess }> {
  if (existsSync(logFile)) renameSync(logFile, `${logFile}.1`);
  const argv = buildServerArgv(target, modelArgv, logFile);
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  // Assigned synchronously below, before any spawn event can be emitted (events arrive on a later tick).
  let rejectSpawn: (err: Error) => void = () => undefined;
  const child = spawnDetachedChild({
    command: exe,
    args: argv,
    logPath: null,
    env: process.env,
    onError: (err) =>
      rejectSpawn(
        new ManagedServerError(
          err.code === "ENOENT"
            ? `llama-server is not on PATH; install llama.cpp (macOS: brew install llama.cpp) to use a managed local profile`
            : `could not start llama-server: ${err.message}`,
        ),
      ),
  });
  const pid = await new Promise<number>((resolve, reject) => {
    rejectSpawn = reject;
    child.once("spawn", () => resolve(child.pid as number));
  });
  return { pid, argv: [exe, ...argv], child };
}

export interface ProcessRow {
  pid: number;
  pgid: number;
  argv: string[];
}

/**
 * One snapshot of the process table (POSIX: `ps -axww -o pid=,pgid=,command=`).
 * A snapshot, never a live pattern match: a `pgrep -f` would also match the
 * shell running it. Windows has no process groups and no `ps`; it returns []
 * (the registry still works there through recorded pids; the marker sweep is
 * POSIX-only until the live Windows check, 2d).
 */
export async function processSnapshot(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return [];
  const out = await execText("ps", ["-axww", "-o", "pid=,pgid=,command="]);
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), argv: m[3].trim().split(/\s+/) });
  }
  // A snapshot always lists at least this process: an empty one is a failed read, never "no process" (review M6).
  if (rows.length === 0) throw new ManagedServerError("ps returned no process rows");
  return rows;
}

/** The live members of process group `pgid` in a fresh snapshot. */
export async function groupMembers(pgid: number): Promise<number[]> {
  return (await processSnapshot()).filter((r) => r.pgid === pgid).map((r) => r.pid);
}

/** true when an argv[0] names a llama-server executable (any directory). */
export function isLlamaServerArgv0(token: string | undefined): boolean {
  const b = token ? basename(token.replace(/\\/g, "/")) : "";
  return b === "llama-server" || b.toLowerCase() === "llama-server.exe";
}

/**
 * Stop a whole process group: SIGTERM to -pgid, SIGKILL after STOP_GRACE_MS,
 * then a process snapshot must show no member left (spec point 7), else a
 * ManagedServerError: a server we could not stop must never be counted as
 * gone, or the next spawn would make two. Windows has no groups: the pid is
 * ended at once.
 *
 * Kill safety (review M7), checked HERE so every caller inherits it: the
 * group must be > 1 (kill(-0) is our own group, kill(-1) every process the
 * user owns), and its leader (pid === pgid) must be a llama-server. Anything
 * else is refused: llm-ext never signals a process it did not start.
 */
export async function stopProcessGroup(pgid: number, graceMs = STOP_GRACE_MS): Promise<string> {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new ManagedServerError(`refusing to stop process group ${pgid}: not a valid llama-server group`);
  if (process.platform === "win32") {
    const argv = await readCommandLine(pgid);
    if (argv === null) return "already gone";
    if (!isLlamaServerArgv0(argv[0])) throw new ManagedServerError(`refusing to stop pid ${pgid}: it is not a llama-server (${argv[0]})`);
    process.kill(pgid);
    return "ended at once (Windows)";
  }
  const members = (await processSnapshot()).filter((r) => r.pgid === pgid);
  if (members.length === 0) return "already gone";
  const leader = members.find((r) => r.pid === pgid);
  if (!leader || !isLlamaServerArgv0(leader.argv[0])) {
    throw new ManagedServerError(
      `refusing to signal process group ${pgid}: its leader is not a llama-server (${leader ? leader.argv[0] : "no leader"}); llm-ext never touches a process it did not start`,
    );
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, sig);
    } catch {
      /* ESRCH: the group is already gone */
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  let how = "SIGTERM";
  while ((await groupMembers(pgid)).length > 0) {
    if (Date.now() >= deadline) {
      signal("SIGKILL");
      how = `SIGKILL after ${graceMs / 1000} s`;
      break;
    }
    await sleep(100);
  }
  for (let i = 0; i < 50 && (await groupMembers(pgid)).length > 0; i++) await sleep(100);
  const left = await groupMembers(pgid);
  if (left.length > 0) throw new ManagedServerError(`process group ${pgid} still has members after ${how}: ${left.join(", ")}`);
  return how;
}

/** GET /props total_slots (llama-server's parallel slots; -np defaults to auto, 4 measured), or 1 when unreadable. */
export async function totalSlots(port: number): Promise<number> {
  const r = await httpStatus(`http://127.0.0.1:${port}/props`);
  try {
    const n = (JSON.parse(r?.body ?? "") as { total_slots?: unknown }).total_slots;
    return typeof n === "number" && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}
