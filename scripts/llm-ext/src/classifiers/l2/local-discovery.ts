/**
 * classifiers/l2/local-discovery.ts — find an mlx-decision server that is ALREADY RUNNING on this machine.
 *
 * WHY this module exists at all: the USER directive of 2026-11-10 is "only one mlx-decision server can run at
 * every time ... you must check if there are already server instances running and use it. do not instance a new
 * server unless there are no server running". Increment 1 keyed adoption on the CONFIGURED port, so a server on
 * any other port read as absent and the spawn path produced the second server the directive forbids. A port is
 * not an identity: the running server is found by its ARGV (`ps`), and the port it serves on is read from the
 * sockets that process LISTENS on (`lsof`), never from its argv: argv names the port the server was asked for, not
 * the one it bound (a config-file port, a fallback port).
 *
 * WHAT IS NOT COVERED: a socket held by a pid other than the argv match; `ps` and `lsof` are two snapshots, so a
 * restart between them reads as "no listener llm-ext can reach on 127.0.0.1" (retryable); a residual phantom (a vim-style process whose
 * argv merely names the command) holds no listener and so yields the retryable "no listener llm-ext can reach on 127.0.0.1"
 * refusal naming its pid; side ports of a matched server are each probed once, and adoption still needs the
 * /health decider answer.
 *
 * WHAT IS DELIBERATELY NOT HERE: no killing, no signalling, no lease. This module only looks.
 */

import { execFile } from "node:child_process";

/** A running mlx-decision server process and the loopback urls it listens on (empty = no usable listener). */
export interface DiscoveredDecider {
  pid: number;
  urls: string[];
}

const tokenBaseName = (t: string): string => t.split("/").pop() ?? "";
/** A python interpreter's basename; case-insensitive because a macOS framework build shows `…/Python.app/Contents/MacOS/Python`. */
const PYTHON_BASENAME = /^python[\d.]*$/i;

/**
 * True when `parts` (whitespace-split tokens) can be ONE filesystem path that `ps` split at its spaces.
 * A lone token is a path as-is. Several tokens are one path only when the first is absolute, no later token starts a
 * new path (`/`) or a flag (`-`), and the last contains a `/` (a space inside the executable's own file name would
 * mean its basename is not the one just matched).
 */
function isSplitPath(parts: string[]): boolean {
  if (parts.length === 1) return !parts[0]!.startsWith("-");
  return (
    parts[0]!.startsWith("/") &&
    parts.slice(1).every((p) => !p.startsWith("/") && !p.startsWith("-")) &&
    parts[parts.length - 1]!.includes("/")
  );
}

/**
 * True when `tokens` (everything up to and including the `mlx-decision` token) is a launch of that command itself:
 * the executable path alone, or a python interpreter path, then stand-alone interpreter flags, then the script path.
 */
function isServerLauncher(tokens: string[]): boolean {
  if (isSplitPath(tokens)) return true;
  // Try every token that could end the interpreter path: a path with a space may hold more than one python-named token.
  for (let k = 0; k < tokens.length - 1; k++) {
    if (!PYTHON_BASENAME.test(tokenBaseName(tokens[k]!)) || !isSplitPath(tokens.slice(0, k + 1))) continue;
    let scriptStart = k + 1;
    while (scriptStart < tokens.length - 1 && tokens[scriptStart]!.startsWith("-")) scriptStart++;
    if (isSplitPath(tokens.slice(scriptStart))) return true;
  }
  return false;
}

/**
 * True when `command` (one `ps` command line) is a launch of `mlx-decision server` itself. It says nothing about
 * WHERE the server listens: that is read from the process's sockets (listenersOf), never from its argv.
 *
 * WHY the launcher is anchored at the START of the argv (TRDD-O93LFMF3, fixes 3 and 3b): the old rule accepted any
 * token anywhere in the line that ended in `mlx-decision` followed by `server`, so a long-lived process that merely
 * NAMES the command (`grep -rn mlx-decision server docs/`, `watch mlx-decision server`, an editor given an absolute path,
 * `docker run … mlx-decision server`, `sh -c "… mlx-decision server …"`) became a phantom candidate: a misleading
 * retryable refusal and a wasted probe (never a wrong adoption, adoption needs /health).
 * Measured real shapes of the one singleton: the server process is `<python> <…/bin/mlx-decision> server …` (the
 * uv-tool python runs the console script) and is the only process that binds the port; its `/usr/bin/lockf …`
 * parent carries the same --host/--port but is NOT a server and must not match, nor must the `/bin/sh -c` guard of
 * the login agent (it execs lockf).
 * THE RULE: find a token whose basename is `mlx-decision` and whose next token is exactly `server`; the tokens up to
 * and including it must be either (1) one path, or (2) a python interpreter path (basename matched
 * case-insensitively, /^python[\d.]*$/i), then ZERO OR MORE single tokens starting with `-` (interpreter flags
 * that take no separate value), then the script path. WHY "one path" is tested on tokens: `ps` joins argv with
 * single spaces, so `/Users/a b/.local/bin/mlx-decision` arrives as `/Users/a` `b/.local/bin/mlx-decision`, and a
 * miss is worse than a phantom (llm-ext would refuse "no server" while the singleton runs). Tokens form one split
 * path iff the first is absolute, no later one starts with `/` or `-`, and the last contains `/`; that is exactly
 * what separates it from a wrapper, whose own arguments are flags (`lockf -t 0 …`, `sh -c …`), a second absolute
 * path (`lockf … <lock> /…/mlx-decision`, `env FOO=1 /…/mlx-decision`) or a bare name (`watch`, `grep`, `docker`).
 * Residual: a wrapper given only plain words and a relative path (`/usr/bin/x y ./mlx-decision server`) still
 * reads as a spaced path, and an executable given a relative path ending in `/mlx-decision` then `server`
 * (`/usr/bin/vim notes/mlx-decision server`, `/usr/bin/python3 tool.py ../mlx-decision server`) passes isSplitPath:
 * both still match here, but such a process (a vim-style phantom) holds no listening socket, so it yields the
 * retryable "no listener llm-ext can reach on 127.0.0.1" refusal naming its pid, never an adoption (adoption needs /health to
 * answer as a decider).
 * STAYS UNSUPPORTED, on purpose, and rejected: `python -m mlx_decision server`; any flag between the executable and
 * `server` (`mlx-decision --log-level debug server`); an interpreter flag with a separate value (`python -X utf8
 * script`). WHY basename: the path differs per install (`~/.local/bin`, `/opt/homebrew/bin`).
 */
export function isDeciderServerCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  return tokens.some(
    (t, i) => tokenBaseName(t) === "mlx-decision" && tokens[i + 1] === "server" && isServerLauncher(tokens.slice(0, i + 1)),
  );
}

/** `ps -ax -o pid=,command=`: every process, one per line, in the form `<pid> <command>`. */
function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,command="], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Parse `lsof -F ptn` output into pid -> the loopback urls that process LISTENS on.
 *
 * The -F form is one field per line: `p<pid>` starts a process, `f<fd>` starts a file (ignored), then `t<type>`
 * (IPv4/IPv6) and `n<addr>` for that file. An address becomes `http://127.0.0.1:P` only when it is `127.0.0.1:P`
 * (tIPv4), `*:P` (tIPv4) or `*:P` (tIPv6). WHY a tIPv6 wildcard counts: a `*:P` IPv6 socket may be dual-stack and
 * so reachable over 127.0.0.1; it is probed, never refused (a miss here would read as "no usable listener"). WHY every
 * other address is skipped: the local sender carries no credential (local-transport.ts) and config.ts refuses a
 * non-loopback url for the same reason, so a socket bound only to a LAN address or to ::1 is never sent to.
 * Urls are deduped per pid (a dual-stack server shows one IPv4 and one IPv6 socket for the same port).
 */
export function parseLsofListeners(stdout: string): Map<number, string[]> {
  const result = new Map<number, string[]>();
  let pid: number | null = null;
  let type = "";
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const n = Number(value);
      pid = Number.isInteger(n) && n > 0 ? n : null;
      type = "";
      if (pid !== null && !result.has(pid)) result.set(pid, []);
    } else if (tag === "f") {
      type = "";
    } else if (tag === "t") {
      type = value;
    } else if (tag === "n" && pid !== null) {
      const m = /^(127\.0\.0\.1|\*):(\d+)$/.exec(value);
      if (m === null) continue;
      if (m[1] === "127.0.0.1" && type !== "IPv4") continue;
      if (type !== "IPv4" && type !== "IPv6") continue;
      const port = Number(m[2]);
      if (port < 1 || port > 65535) continue;
      const url = `http://127.0.0.1:${port}`;
      const urls = result.get(pid)!;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  return result;
}

/**
 * The loopback urls each of `pids` is LISTENING on, via `lsof`. Empty `pids` -> empty map, nothing executed.
 *
 * WHY a failed look THROWS: it must never read as "none running", because the caller would then report "no server"
 * for a singleton that is up. Only exit 0 (parse; stderr ignored) and exit 1 with BOTH stdout and stderr empty
 * (lsof's own "nothing matched", e.g. a pid with no TCP listener or already gone) are answers; a spawn error, a
 * timeout or signal, any other exit code, and exit 1 WITH stderr all throw, carrying the exit/signal and stderr.
 * The none-rule trusts lsof's exit-1 semantics; a harmless lsof warning on exit 1 therefore becomes a retryable
 * "cannot list" (accepted trade-off: retryable, never a wrong adoption or a second server).
 *
 * WHY the default `lsofPath` is the macOS one (TRDD-36L97JC9): the only caller, discoverDeciders, runs only on darwin
 * (local-decider.ts refuses every other platform before it scans), and macOS ships lsof at /usr/sbin/lsof. Linux has it
 * at /usr/bin/lsof, or not at all, and no Linux caller exists, so no lookup is written for it.
 */
export function listenersOf(pids: number[], lsofPath = "/usr/sbin/lsof"): Promise<Map<number, string[]>> {
  if (pids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    execFile(
      lsofPath,
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-F", "ptn"],
      { maxBuffer: 8 * 1024 * 1024, timeout: 5000 },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(parseLsofListeners(stdout));
          return;
        }
        const { code, signal } = err as { code?: unknown; signal?: unknown };
        // WHY signal is read next to code: a timeout kill has code null and a signal, a real exit 1 has no signal.
        if (code === 1 && signal == null && stdout === "" && stderr === "") {
          resolve(new Map());
          return;
        }
        // WHY a string code is a spawn error, not an exit status, unless ERR_CHILD_PROCESS_* (maxBuffer: the child ran).
        const how =
          signal != null
            ? `signal ${String(signal)}`
            : typeof code === "string"
              ? code.startsWith("ERR_CHILD_PROCESS")
                ? `${code}: ${err.message}`
                : `spawn error ${code}: ${err.message}`
              : `exit ${String(code)}`;
        reject(new Error(`lsof failed (${how})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`));
      },
    );
  });
}

/**
 * Every mlx-decision server running on this machine with the loopback urls it LISTENS on, newest match last
 * (urls empty = no usable listener). A FAILING `ps` or `lsof` THROWS on purpose: the caller must not read "could
 * not look" as "none is running" and report no server, which would hide a singleton that is up.
 */
export async function discoverDeciders(): Promise<DiscoveredDecider[]> {
  const output = await runPs();
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const space = trimmed.indexOf(" ");
    if (space === -1) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isDeciderServerCommand(trimmed.slice(space + 1))) pids.push(pid);
  }
  const listeners = await listenersOf([...new Set(pids)]);
  return pids.map((pid) => ({ pid, urls: listeners.get(pid) ?? [] }));
}