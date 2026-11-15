/**
 * Tests for the mlx-decision login-agent installer hook
 * (`scripts/hooks/install-decider-agent.sh`, TRDD-O93LFMF3 C4).
 *
 * The hook is POSIX `/bin/sh`, so every test spawns the real script with an
 * explicit env (HOME + PATH only, plus FAKE_* switches for the fakes). The fake
 * `uname`, `sysctl`, `launchctl`, `pgrep` and `mlx-decision` live in a temp
 * dir that comes first on PATH; HOME is a temp dir whose name contains a space,
 * so the real ~/Library is never touched and every $HOME expansion in the
 * script is proven quoted. Temp dirs are named WITHOUT "llm-ext" so a leaked
 * one is never blamed by src/test-tmpdir-guard.ts on a concurrent run.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECIDER_SINGLETON_PORT } from "./classifiers/l2/local-fallback.js";
import { SERVED_MODEL } from "./classifiers/l2/local-decider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = resolve(__dirname, "../../hooks/install-decider-agent.sh");
const HOOKS_JSON = resolve(__dirname, "../../../hooks/hooks.json");
const LABEL = "com.llm-externalizer.mlx-decision";
const UID = String(process.getuid?.() ?? 0);

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop() as string;
    try {
      chmodSync(join(root, "home dir", "Library", "LaunchAgents"), 0o755);
    } catch {
      /* dir may not exist in this test */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fx {
  root: string;
  home: string;
  fakeDir: string;
  mlxDir: string;
  log: string;
  agentsDir: string;
  plist: string;
}

interface FxOptions {
  withBinary?: boolean;
  cache?: boolean;
  mlxDirName?: string;
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function makeFx(opts: FxOptions = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), "dagent-"));
  roots.push(root);
  const home = join(root, "home dir");
  const fakeDir = join(root, "fake");
  const mlxDir = opts.mlxDirName ? join(root, opts.mlxDirName) : fakeDir;
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(mlxDir, { recursive: true });
  script(
    join(fakeDir, "uname"),
    'case "$1" in -s) echo "${FAKE_UNAME_S:-Darwin}" ;; -m) echo "${FAKE_UNAME_M:-arm64}" ;; *) echo Darwin ;; esac',
  );
  script(join(fakeDir, "sysctl"), 'echo "${FAKE_MEMSIZE:-68719476736}"');
  script(
    join(fakeDir, "launchctl"),
    [
      'echo "launchctl $*" >> "$FAKE_LOG"',
      'case "$1" in',
      '  print) [ -e "$FAKE_STATE" ] ;;',
      '  bootstrap) [ "${FAKE_BOOTSTRAP_RC:-0}" = 0 ] || exit 1; : > "$FAKE_STATE" ;;',
      '  bootout) rm -f "$FAKE_STATE" ;;',
      "esac",
    ].join("\n"),
  );
  script(join(fakeDir, "pgrep"), 'echo "pgrep $*" >> "$FAKE_LOG"; [ "${FAKE_SERVER:-0}" = 1 ]');
  if (opts.withBinary !== false) script(join(mlxDir, "mlx-decision"), "exit 0");
  if (opts.cache !== false) {
    mkdirSync(join(home, ".cache", "huggingface", "hub", "models--baselabs--elephant-1"), { recursive: true });
  }
  const agentsDir = join(home, "Library", "LaunchAgents");
  return {
    root,
    home,
    fakeDir,
    mlxDir,
    log: join(root, "launchctl.log"),
    agentsDir,
    plist: join(agentsDir, `${LABEL}.plist`),
  };
}

function run(fx: Fx, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    HOME: fx.home,
    PATH: `${fx.fakeDir}:${fx.mlxDir}:/usr/bin:/bin`,
    FAKE_LOG: fx.log,
    FAKE_STATE: join(fx.root, "loaded"),
    ...extra,
  };
  const r = spawnSync("/bin/sh", [HOOK_SRC], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function logLines(fx: Fx): string[] {
  return existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter((l) => l.length > 0) : [];
}

function launchctlCalls(fx: Fx): string[] {
  return logLines(fx).filter((l) => l.startsWith("launchctl "));
}

/** Asserts stdout is exactly one JSON line and returns its systemMessage. */
function systemMessage(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]) as { systemMessage: unknown };
  expect(typeof parsed.systemMessage).toBe("string");
  return parsed.systemMessage as string;
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The agent's `sh -c` string, XML-unescaped, as launchd would pass it. */
function guardOf(plistText: string): string {
  const m = /<string>-c<\/string>\s*<string>([\s\S]*?)<\/string>/.exec(plistText);
  expect(m).not.toBeNull();
  return xmlUnescape((m as RegExpExecArray)[1]);
}

const lockfOk = existsSync("/usr/bin/lockf") && existsSync("/usr/bin/pgrep") && process.platform === "darwin";
const realServerRunning = lockfOk && spawnSync("/usr/bin/pgrep", ["-qf", "[m]lx-decision server"]).status === 0;
describe.skipIf(process.platform === "win32")("installer: hooks/install-decider-agent.sh", () => {
  it("D1: sh -n passes, and shellcheck -s sh passes when installed", () => {
    expect(spawnSync("/bin/sh", ["-n", HOOK_SRC]).status).toBe(0);
    if (spawnSync("which", ["shellcheck"]).status === 0) {
      const r = spawnSync("shellcheck", ["-s", "sh", HOOK_SRC], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });

  it("D2: hooks.json runs the hook on the startup|resume SessionStart matcher with timeout 10", () => {
    const json = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
      hooks: { SessionStart: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
    };
    const entry = json.hooks.SessionStart.find((e) => e.matcher === "startup|resume");
    const hook = entry?.hooks.find((h) => h.command.includes("install-decider-agent.sh"));
    expect(hook?.command).toBe('sh "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/install-decider-agent.sh"');
    expect(hook?.timeout).toBe(10);
  });

  it("D3: no mlx-decision binary anywhere -> silent exit 0, no plist", () => {
    const fx = makeFx({ withBinary: false });
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(existsSync(fx.plist)).toBe(false);
    expect(launchctlCalls(fx)).toEqual([]);
  });

  it("D4: binary found under $HOME/.local/bin (not on PATH) still installs", () => {
    const fx = makeFx({ withBinary: false });
    mkdirSync(join(fx.home, ".local", "bin"), { recursive: true });
    script(join(fx.home, ".local", "bin", "mlx-decision"), "exit 0");
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(readFileSync(fx.plist, "utf8")).toContain(join(fx.home, ".local", "bin", "mlx-decision"));
  });

  it("D5: fresh install writes a valid plist, bootstraps once, and says plainly what it did", () => {
    const fx = makeFx();
    const res = run(fx);
    expect(res.status).toBe(0);
    const text = readFileSync(fx.plist, "utf8");
    // The agent must serve exactly what the local decider adopts.
    expect(text).toContain(`--port ${DECIDER_SINGLETON_PORT}`);
    expect(text).toContain(`--default-model ${SERVED_MODEL}`);
    expect(text).toContain(join(fx.mlxDir, "mlx-decision"));
    expect(text).toContain("/usr/bin/lockf");
    expect(text).toContain('"[m]lx-decision server"');
    expect(text).toContain("<key>ThrottleInterval</key><integer>60</integer>");
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>KeepAlive</key><true/>");
    expect(text).toContain("<key>HF_HUB_OFFLINE</key><string>1</string>");
    expect(text).not.toContain("<key>HF_HOME</key>");
    expect(text).toContain(`<key>WorkingDirectory</key><string>${join(fx.home, "Library", "Caches", "mlx-decision")}</string>`);
    expect(text).toContain(`<string>${join(fx.home, "Library", "Logs", "mlx-decision", "server.log")}</string>`);
    expect(text).toContain(`<key>PATH</key><string>${fx.mlxDir}:/opt/homebrew/bin:/usr/bin:/bin</string>`);
    expect(launchctlCalls(fx).filter((l) => l.startsWith("launchctl bootstrap"))).toEqual([
      `launchctl bootstrap gui/${UID} ${fx.plist}`,
    ]);
    const msg = systemMessage(res.stdout);
    expect(msg).toContain("~15 GB");
    expect(msg).toContain("mlx-decision server resident");
    expect(msg).toContain("LLM_EXT_NO_DECIDER_AGENT=1");
    // The dirs the agent needs at run time exist.
    expect(existsSync(join(fx.home, "Library", "Caches", "mlx-decision"))).toBe(true);
    expect(existsSync(join(fx.home, "Library", "Logs", "mlx-decision"))).toBe(true);
  });

  it("D6: the plist passes plutil -lint (required on macOS; run when plutil exists elsewhere)", () => {
    const fx = makeFx();
    expect(run(fx).status).toBe(0);
    const hasPlutil = spawnSync("which", ["plutil"]).status === 0;
    if (process.platform === "darwin") expect(hasPlutil).toBe(true);
    if (hasPlutil) {
      const r = spawnSync("plutil", ["-lint", fx.plist], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });

  it("D7: XML special characters in the binary path are escaped and the sh -c guard survives unescaping", () => {
    const fx = makeFx({ mlxDirName: "a&b<c>d" });
    const res = run(fx);
    expect(res.status).toBe(0);
    const text = readFileSync(fx.plist, "utf8");
    expect(text).toContain("a&amp;b&lt;c&gt;d");
    expect(text).not.toContain("a&b<c>d");
    // The guard's own `>&2` redirect is escaped too.
    expect(text).toContain("&gt;&amp;2");
    const guard = guardOf(text);
    expect(guard).toContain(`"${join(fx.mlxDir, "mlx-decision")}" server -m baselabs/elephant-1`);
    expect(guard).toContain('"$HOME/Library/Caches/mlx-decision/server.lock"');
    expect(guard).toContain(">&2");
    expect(spawnSync("/bin/sh", ["-n", "-c", guard]).status).toBe(0);
    if (spawnSync("which", ["plutil"]).status === 0) {
      const r = spawnSync("plutil", ["-lint", fx.plist], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });

  it("D8: another agent plist that mentions mlx-decision -> silent exit 0, ours not written", () => {
    const fx = makeFx();
    mkdirSync(fx.agentsDir, { recursive: true });
    writeFileSync(join(fx.agentsDir, "com.example.other.plist"), "<plist>/x/mlx-decision server</plist>\n");
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(existsSync(fx.plist)).toBe(false);
    expect(launchctlCalls(fx)).toEqual([]);
  });

  it("D9: a second run with identical content does not rewrite or bootstrap again", () => {
    const fx = makeFx();
    expect(run(fx).status).toBe(0);
    const before = statSync(fx.plist);
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    const after = statSync(fx.plist);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(launchctlCalls(fx).filter((l) => l.startsWith("launchctl bootstrap"))).toHaveLength(1);
  });

  it("D10: LLM_EXT_NO_DECIDER_AGENT=1 does nothing", () => {
    const fx = makeFx();
    const res = run(fx, { LLM_EXT_NO_DECIDER_AGENT: "1" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(existsSync(fx.plist)).toBe(false);
  });

  it("D11: not Darwin, or not arm64 -> nothing", () => {
    const cases: Record<string, string>[] = [{ FAKE_UNAME_S: "Linux" }, { FAKE_UNAME_M: "x86_64" }];
    for (const extra of cases) {
      const fx = makeFx();
      const res = run(fx, extra);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(existsSync(fx.plist)).toBe(false);
    }
  });

  it("D12: below 32 GiB of RAM -> exit 0 with a too-small message, nothing installed", () => {
    const fx = makeFx();
    const res = run(fx, { FAKE_MEMSIZE: "17179869184" });
    expect(res.status).toBe(0);
    expect(systemMessage(res.stdout)).toContain("less than 32 GiB");
    expect(existsSync(fx.plist)).toBe(false);
    // Exactly 32 GiB is allowed.
    const ok = makeFx();
    expect(run(ok, { FAKE_MEMSIZE: "34359738368" }).status).toBe(0);
    expect(existsSync(ok.plist)).toBe(true);
  });

  it("D13: model not cached -> exit 0 with the download command, nothing installed", () => {
    const fx = makeFx({ cache: false });
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(systemMessage(res.stdout)).toContain("mlx-decision download baselabs/elephant-1");
    expect(existsSync(fx.plist)).toBe(false);
  });

  it("D14: HF_HOME decides where the cache is looked up and is forwarded into the plist", () => {
    const fx = makeFx();
    const hf = join(fx.root, "hf cache");
    // Default cache exists, HF_HOME does not hold the model: refuse.
    mkdirSync(hf, { recursive: true });
    const refused = run(fx, { HF_HOME: hf });
    expect(refused.status).toBe(0);
    expect(systemMessage(refused.stdout)).toContain("mlx-decision download baselabs/elephant-1");
    expect(existsSync(fx.plist)).toBe(false);
    // HF_HOME holds the model: install, with HF_HOME and HF_HUB_OFFLINE in the plist.
    mkdirSync(join(hf, "hub", "models--baselabs--elephant-1"), { recursive: true });
    expect(run(fx, { HF_HOME: hf }).status).toBe(0);
    const text = readFileSync(fx.plist, "utf8");
    expect(text).toContain(`<key>HF_HOME</key><string>${hf}</string>`);
    expect(text).toContain("<key>HF_HUB_OFFLINE</key><string>1</string>");
  });

  // The hook calls /usr/bin/pgrep by absolute path (TRDD-O93LFMF3), so the fake pgrep on PATH is never
  // consulted: "a server is running" needs a real process whose argv contains "mlx-decision server".
  it.skipIf(!lockfOk)(
    "D15: already loaded + changed content + a server running -> rewritten, not reloaded, message says next login",
    async () => {
      const fx = makeFx();
      expect(run(fx).status).toBe(0);
      const original = readFileSync(fx.plist, "utf8");
      writeFileSync(fx.plist, "stale\n");
      // No exec: the sh must stay alive so its argv keeps "mlx-decision server" visible to pgrep -f.
      const decoy = spawn("/bin/sh", ["-c", "/bin/sleep 60; true", "mlx-decision server"], { stdio: "ignore" });
      try {
        await new Promise((r) => setTimeout(r, 300));
        const res = run(fx);
        expect(res.status).toBe(0);
        expect(readFileSync(fx.plist, "utf8")).toBe(original);
        expect(launchctlCalls(fx).filter((l) => /bootout|bootstrap/.test(l))).toHaveLength(1); // the first install only
        expect(systemMessage(res.stdout)).toContain("next login");
      } finally {
        decoy.kill("SIGKILL");
      }
    },
  );

  it("D30: pgrep is called by absolute path: a fake pgrep first on PATH is never run", () => {
    const fx = makeFx();
    expect(run(fx).status).toBe(0);
    writeFileSync(fx.plist, "stale\n");
    // Loaded + changed content is the only path that calls pgrep. FAKE_SERVER=1 would make a PATH-resolved fake answer "running".
    expect(run(fx, { FAKE_SERVER: "1" }).status).toBe(0);
    expect(logLines(fx).filter((l) => l.startsWith("pgrep "))).toEqual([]);
  });

  it.skipIf(!lockfOk || realServerRunning)("D16: already loaded + changed content + no server running -> bootout then bootstrap", () => {
    const fx = makeFx();
    expect(run(fx).status).toBe(0);
    writeFileSync(fx.plist, "stale\n");
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(launchctlCalls(fx).slice(-3)).toEqual([
      `launchctl print gui/${UID}/${LABEL}`,
      `launchctl bootout gui/${UID}/${LABEL}`,
      `launchctl bootstrap gui/${UID} ${fx.plist}`,
    ]);
    expect(systemMessage(res.stdout)).toContain("reloaded");
  });

  it("D17: a failed bootstrap exits 0 with a message (the agent still loads at next login)", () => {
    const fx = makeFx();
    const res = run(fx, { FAKE_BOOTSTRAP_RC: "1" });
    expect(res.status).toBe(0);
    expect(existsSync(fx.plist)).toBe(true);
    expect(systemMessage(res.stdout)).toContain("bootstrap failed");
  });

  it.skipIf(process.getuid?.() === 0)("D18: a plist that cannot be written exits 1 with one llm-ext: stderr line", () => {
    const fx = makeFx();
    mkdirSync(fx.agentsDir, { recursive: true });
    chmodSync(fx.agentsDir, 0o555);
    const res = run(fx);
    expect(res.status).toBe(1);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toMatch(/^llm-ext: could not write the mlx-decision login agent/);
    expect(existsSync(fx.plist)).toBe(false);
  });

  const stampOf = (fx: Fx, reason: string, configDir?: string) =>
    join(configDir ?? join(fx.home, ".llm-externalizer"), "state", `decider-agent-refused-${reason}.stamp`);

  it.each([
    ["double quote", 'a"b'],
    ["dollar sign", "a$b"],
    ["backtick", "a`b"],
    ["backslash", "a\\b"],
    ["tab", "a\tb"],
  ])("D21: a binary path containing a %s is refused with one systemMessage (once per path), exit 0, no plist", (_name, dirName) => {
    const fx = makeFx({ mlxDirName: dirName });
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(systemMessage(res.stdout)).toContain("binary path contains");
    expect(systemMessage(res.stdout)).toContain("control character");
    expect(res.stderr).toBe("");
    expect(existsSync(fx.plist)).toBe(false);
    expect(launchctlCalls(fx)).toEqual([]);
    expect(existsSync(stampOf(fx, "badpath"))).toBe(true);
    const again = run(fx);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe("");
    expect(again.stderr).toBe("");
    expect(existsSync(stampOf(fx, "badpath"))).toBe(true);
    expect(readFileSync(stampOf(fx, "badpath"), "utf8")).toBe(join(fx.mlxDir, "mlx-decision"));
  });

  it("D22: the RAM refusal is shown on the first run only; a stamp file records it", () => {
    const fx = makeFx();
    const extra = { FAKE_MEMSIZE: "17179869184" };
    expect(existsSync(stampOf(fx, "ram"))).toBe(false);
    const first = run(fx, extra);
    expect(first.status).toBe(0);
    expect(systemMessage(first.stdout)).toContain("less than 32 GiB");
    expect(existsSync(stampOf(fx, "ram"))).toBe(true);
    const second = run(fx, extra);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
    expect(existsSync(stampOf(fx, "ram"))).toBe(true);
    expect(existsSync(fx.plist)).toBe(false);
  });

  it("D23: stamps are per reason: a RAM refusal does not silence the later missing-cache refusal, which is then shown once", () => {
    const fx = makeFx({ cache: false });
    const ram = run(fx, { FAKE_MEMSIZE: "17179869184" });
    expect(ram.status).toBe(0);
    expect(systemMessage(ram.stdout)).toContain("less than 32 GiB");
    expect(existsSync(stampOf(fx, "ram"))).toBe(true);
    expect(existsSync(stampOf(fx, "cache"))).toBe(false);
    const first = run(fx);
    expect(first.status).toBe(0);
    expect(systemMessage(first.stdout)).toContain("mlx-decision download baselabs/elephant-1");
    expect(existsSync(stampOf(fx, "cache"))).toBe(true);
    expect(existsSync(stampOf(fx, "ram"))).toBe(true);
    const second = run(fx);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
    expect(existsSync(fx.plist)).toBe(false);
  });

  it("D27: the cache stamp records the refused cache path: the same path is shown once, a different path shows the message again", () => {
    const fx = makeFx({ cache: false });
    const hfA = join(fx.root, "hf a");
    const hfB = join(fx.root, "hf b");
    const first = run(fx, { HF_HOME: hfA });
    expect(first.status).toBe(0);
    expect(systemMessage(first.stdout)).toContain(`(${hfA})`);
    expect(readFileSync(stampOf(fx, "cache"), "utf8")).toBe(hfA);
    const same = run(fx, { HF_HOME: hfA });
    expect(same.status).toBe(0);
    expect(same.stdout).toBe("");
    const other = run(fx, { HF_HOME: hfB });
    expect(other.status).toBe(0);
    expect(systemMessage(other.stdout)).toContain(`(${hfB})`);
    expect(readFileSync(stampOf(fx, "cache"), "utf8")).toBe(hfB);
    expect(existsSync(fx.plist)).toBe(false);
  });

  it("D28: a stamp that cannot be written never fails the hook: exit 0, the message is shown on every run", () => {
    const fx = makeFx({ cache: false });
    // The state dir is real; a DIRECTORY sits at the cache stamp path. `cat` of it yields "",
    // which differs from the HF path, so the message is shown and the stamp write is attempted
    // and fails. (The RAM stamp would not do: its empty content matches and returns before writing.)
    const stamp = join(fx.home, ".llm-externalizer", "state", "decider-agent-refused-cache.stamp");
    mkdirSync(stamp, { recursive: true });
    const first = run(fx);
    expect(first.status).toBe(0);
    expect(systemMessage(first.stdout)).toContain("mlx-decision download");
    expect(first.stderr).toBe("");
    expect(statSync(stamp).isDirectory()).toBe(true);
    const second = run(fx);
    expect(second.status).toBe(0);
    expect(systemMessage(second.stdout)).toContain("mlx-decision download");
    expect(second.stderr).toBe("");
    expect(statSync(stamp).isDirectory()).toBe(true);
  });

  it("D29: a bad-character binary path stays silent when another agent already provides a singleton", () => {
    const fx = makeFx({ mlxDirName: "a\"b" });
    mkdirSync(fx.agentsDir, { recursive: true });
    writeFileSync(join(fx.agentsDir, "com.example.other.plist"), "<plist>/x/mlx-decision server</plist>\n");
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(existsSync(fx.plist)).toBe(false);
    expect(launchctlCalls(fx)).toEqual([]);
  });

  it("D24: LLM_EXT_CONFIG_DIR decides where the refusal stamp is written", () => {
    const fx = makeFx();
    const cfg = join(fx.root, "cfg dir");
    expect(run(fx, { FAKE_MEMSIZE: "17179869184", LLM_EXT_CONFIG_DIR: cfg }).status).toBe(0);
    expect(existsSync(stampOf(fx, "ram", cfg))).toBe(true);
    expect(existsSync(stampOf(fx, "ram"))).toBe(false);
  });

  it("D25: a successful install removes pre-existing refusal stamps, on a fresh write and on an unchanged re-run", () => {
    const fx = makeFx();
    const plant = () => {
      mkdirSync(dirname(stampOf(fx, "ram")), { recursive: true });
      writeFileSync(stampOf(fx, "ram"), "");
      writeFileSync(stampOf(fx, "cache"), "");
      writeFileSync(stampOf(fx, "badpath"), "");
    };
    plant();
    expect(run(fx).status).toBe(0);
    expect(existsSync(fx.plist)).toBe(true);
    expect(existsSync(stampOf(fx, "ram"))).toBe(false);
    expect(existsSync(stampOf(fx, "cache"))).toBe(false);
    expect(existsSync(stampOf(fx, "badpath"))).toBe(false);
    // Unchanged plist: the early-exit path clears them too.
    plant();
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(existsSync(stampOf(fx, "ram"))).toBe(false);
    expect(existsSync(stampOf(fx, "cache"))).toBe(false);
    expect(existsSync(stampOf(fx, "badpath"))).toBe(false);
  });

  it("D26: the cache refusal tells the user to set HF_HOME for Claude Code", () => {
    const fx = makeFx({ cache: false });
    const res = run(fx);
    expect(res.status).toBe(0);
    expect(systemMessage(res.stdout)).toContain("set HF_HOME for Claude Code");
  });

  it.skipIf(!lockfOk || realServerRunning)(
    "D19: the guard does not match itself: with no server running it starts the binary under lockf",
    () => {
      const fx = makeFx();
      expect(run(fx).status).toBe(0);
      const guard = guardOf(readFileSync(fx.plist, "utf8"));
      const argsFile = join(fx.root, "args");
      script(join(fx.mlxDir, "mlx-decision"), `echo "$@" > "${argsFile}"`);
      const r = spawnSync("/bin/sh", ["-c", guard], {
        env: { HOME: fx.home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toContain("another mlx-decision singleton");
      expect(readFileSync(argsFile, "utf8").trim()).toBe(
        `server -m baselabs/elephant-1 --default-model ${SERVED_MODEL} --host 127.0.0.1 --port ${DECIDER_SINGLETON_PORT}`,
      );
      expect(existsSync(join(fx.home, "Library", "Caches", "mlx-decision", "server.lock"))).toBe(true);
    },
  );

  it.skipIf(!lockfOk)(
    "D20: the guard logs and stands down when another mlx-decision server process runs",
    async () => {
      const fx = makeFx();
      expect(run(fx).status).toBe(0);
      const guard = guardOf(readFileSync(fx.plist, "utf8"));
      // Decoy whose argv contains "mlx-decision server".
      const decoy = spawn("/bin/sh", ["-c", "exec /bin/sleep 60", "mlx-decision server"], { stdio: "ignore" });
      let child: ReturnType<typeof spawn> | undefined;
      try {
        // Give the decoy a moment to exec so pgrep sees it.
        await new Promise((r) => setTimeout(r, 300));
        child = spawn("/bin/sh", ["-c", guard], {
          env: { HOME: fx.home, PATH: "/usr/bin:/bin" },
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        const seen = await new Promise<string>((resolveSeen) => {
          let buf = "";
          const timer = setTimeout(() => resolveSeen(buf), 8_000);
          child?.stderr?.on("data", (d: Buffer) => {
            buf += d.toString();
            if (buf.includes("another mlx-decision singleton")) {
              clearTimeout(timer);
              resolveSeen(buf);
            }
          });
        });
        expect(seen).toContain("another mlx-decision singleton is already running; not starting a second one");
      } finally {
        // The guard sleeps 120 s after the message: kill its whole process group.
        if (child?.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        decoy.kill("SIGKILL");
      }
    },
  );
});
