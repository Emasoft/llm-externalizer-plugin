/**
 * Tests for the global `llm-ext` PATH shim (TRDD-VV0INGRT): the SessionStart
 * installer hook (`hooks/install-path-shim.sh`) that copies the wrapper into
 * `~/.local/bin/llm-ext`, and the wrapper itself (`path-shim/llm-ext`) that
 * resolves the real plugin CLI at runtime.
 *
 * Both scripts are POSIX `/bin/sh` — no TypeScript surface to unit-test, so
 * every test here spawns the real script as a subprocess. Temp dirs are named
 * WITHOUT "llm-ext"/"llm_ext" (unlike test-helpers.ts's mkdtemp prefixes) so a
 * leaked one — created by the spawned `sh`/`cp`, not by fs.mkdtemp, so the
 * tracker in test-tmpdir-tracker.ts cannot auto-clean it — is never mistaken
 * by src/test-tmpdir-guard.ts for this suite's own marker and blamed on a
 * concurrent worker's run. Every fixture root is still removed in afterEach.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Real source scripts this task just created — resolved from this test
// file's own location, not a copy, so the tests exercise the exact bytes
// that ship.
const WRAPPER_SRC = resolve(__dirname, "../../path-shim/llm-ext");
const HOOK_SRC = resolve(__dirname, "../../hooks/install-path-shim.sh");

// The node binary running this test suite — put on PATH so the wrapper's
// `command -v node` / registry-parsing step can find it without depending on
// the test machine's own PATH (which vitest already stripped to its env).
const NODE_DIR = dirname(process.execPath);

const roots: string[] = [];
/** A fresh scratch dir per test, named to avoid the project's tmpdir-leak marker. */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pshim-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) {
    const root = roots.pop() as string;
    // I12 leaves ~/.local/bin read-only; restore write access or the
    // recursive removal itself fails.
    try {
      chmodSync(join(root, "home", ".local", "bin"), 0o755);
    } catch {
      /* dir may not exist in this test — fine */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSh(scriptPath: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync("/bin/sh", [scriptPath, ...args], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function stripNode(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Installer (hooks/install-path-shim.sh) — fixture plugin layout: both
// scripts copied into <tmp>/root/scripts/{hooks,path-shim}, matching the
// real plugin tree so the hook's own `dirname "$0"/../path-shim` resolution
// finds our fixture wrapper, not the repo's.
// ---------------------------------------------------------------------------

interface InstallerFixture {
  root: string;
  home: string;
  hookScript: string;
  wrapperCopy: string;
}

function setupInstallerFixture(): InstallerFixture {
  const root = freshRoot();
  const scriptsDir = join(root, "scripts");
  mkdirSync(join(scriptsDir, "path-shim"), { recursive: true });
  mkdirSync(join(scriptsDir, "hooks"), { recursive: true });
  const wrapperCopy = join(scriptsDir, "path-shim", "llm-ext");
  copyFileSync(WRAPPER_SRC, wrapperCopy);
  chmodSync(wrapperCopy, 0o755);
  const hookScript = join(scriptsDir, "hooks", "install-path-shim.sh");
  copyFileSync(HOOK_SRC, hookScript);
  chmodSync(hookScript, 0o755);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home, hookScript, wrapperCopy };
}

function dstOf(home: string): string {
  return join(home, ".local", "bin", "llm-ext");
}

/** Runs the installer with a PATH that includes the target dir (so the
 * "not on this session's PATH" clause never fires unless a test wants it). */
function runInstaller(fx: InstallerFixture, extraEnv: Record<string, string> = {}): RunResult {
  const dir = join(fx.home, ".local", "bin");
  return runSh(
    fx.hookScript,
    [],
    stripNode({
      HOME: fx.home,
      PATH: `${dir}:/usr/bin:/bin`,
      ...extraEnv,
    }),
  );
}

/** Asserts stdout is exactly one line and returns its parsed systemMessage. */
function parseOneLineSystemMessage(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]);
  expect(typeof parsed.systemMessage).toBe("string");
  return parsed.systemMessage as string;
}

describe("installer: hooks/install-path-shim.sh", () => {
  const hasShellcheck = spawnSync("which", ["shellcheck"], { encoding: "utf8" }).status === 0;

  it("I1: sh -n passes on both the wrapper and the installer hook", () => {
    const wrapperCheck = spawnSync("/bin/sh", ["-n", WRAPPER_SRC], { encoding: "utf8" });
    expect(wrapperCheck.status).toBe(0);
    const hookCheck = spawnSync("/bin/sh", ["-n", HOOK_SRC], { encoding: "utf8" });
    expect(hookCheck.status).toBe(0);
  });

  it.skipIf(!hasShellcheck)(
    "I2: shellcheck -s sh passes on both scripts (skipped when shellcheck is not installed)",
    () => {
      const wrapperCheck = spawnSync("shellcheck", ["-s", "sh", WRAPPER_SRC], { encoding: "utf8" });
      expect(wrapperCheck.status, wrapperCheck.stdout + wrapperCheck.stderr).toBe(0);
      const hookCheck = spawnSync("shellcheck", ["-s", "sh", HOOK_SRC], { encoding: "utf8" });
      expect(hookCheck.status, hookCheck.stdout + hookCheck.stderr).toBe(0);
    },
  );

  it("I3: the wrapper's line 2 is the installer identity marker", () => {
    const lines = readFileSync(WRAPPER_SRC, "utf8").split("\n");
    expect(lines[1]).toMatch(/^# llm-externalizer-path-shim/);
  });

  it("I4: fresh install writes the shim, exits 0, and reports it in one JSON line", () => {
    const fx = setupInstallerFixture();
    const res = runInstaller(fx);
    expect(res.status).toBe(0);
    const dst = dstOf(fx.home);
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst).equals(readFileSync(fx.wrapperCopy))).toBe(true);
    expect(statSync(dst).mode & 0o777).toBe(0o755);
    const msg = parseOneLineSystemMessage(res.stdout);
    expect(msg).toContain("installed");
    expect(msg).toContain("LLM_EXT_NO_PATH_SHIM");
  });

  it("I5: a second run with unchanged bytes is a silent no-op", () => {
    const fx = setupInstallerFixture();
    expect(runInstaller(fx).status).toBe(0);
    const dst = dstOf(fx.home);
    const before = statSync(dst);
    const res = runInstaller(fx);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    const after = statSync(dst);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("I6: an older own shim (marker kept, bytes changed) is refreshed to the source bytes", () => {
    const fx = setupInstallerFixture();
    const dir = join(fx.home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const dst = dstOf(fx.home);
    // Marker on line 2, like the real wrapper, but stale content after it —
    // the head-5-lines marker check is what makes the hook trust this file
    // is "ours" and safe to overwrite.
    writeFileSync(dst, "#!/bin/sh\n# llm-externalizer-path-shim\necho old\n");
    chmodSync(dst, 0o755);
    const res = runInstaller(fx);
    expect(res.status).toBe(0);
    expect(readFileSync(dst).equals(readFileSync(fx.wrapperCopy))).toBe(true);
  });

  it("I7: a foreign regular file at the target is left untouched", () => {
    const fx = setupInstallerFixture();
    const dir = join(fx.home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const dst = dstOf(fx.home);
    const foreignContent = "#!/bin/sh\necho not-ours\n";
    writeFileSync(dst, foreignContent);
    chmodSync(dst, 0o755);
    const res = runInstaller(fx);
    expect(res.status).toBe(0);
    expect(readFileSync(dst, "utf8")).toBe(foreignContent);
    const msg = parseOneLineSystemMessage(res.stdout);
    expect(msg).toContain("left untouched");
  });

  it("I8: a dangling symlink at the target is left untouched", () => {
    const fx = setupInstallerFixture();
    const dir = join(fx.home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const dst = dstOf(fx.home);
    const target = join(dir, "nowhere");
    symlinkSync(target, dst);
    const res = runInstaller(fx);
    expect(res.status).toBe(0);
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dst)).toBe(target);
    parseOneLineSystemMessage(res.stdout);
  });

  it("I9: a directory at the target is left untouched", () => {
    const fx = setupInstallerFixture();
    const dir = join(fx.home, ".local", "bin");
    mkdirSync(dir, { recursive: true });
    const dst = dstOf(fx.home);
    mkdirSync(dst);
    const res = runInstaller(fx);
    expect(res.status).toBe(0);
    expect(statSync(dst).isDirectory()).toBe(true);
    parseOneLineSystemMessage(res.stdout);
  });

  it("I10: installing to a dir not on PATH mentions it in the message", () => {
    const fx = setupInstallerFixture();
    // PATH deliberately excludes ~/.local/bin, unlike runInstaller()'s default.
    const res = runSh(fx.hookScript, [], stripNode({ HOME: fx.home, PATH: "/usr/bin:/bin" }));
    expect(res.status).toBe(0);
    const msg = parseOneLineSystemMessage(res.stdout);
    expect(msg).toContain("not on this session's PATH");
  });

  it("I11: LLM_EXT_NO_PATH_SHIM=1 disables the hook entirely", () => {
    const fx = setupInstallerFixture();
    const res = runSh(
      fx.hookScript,
      [],
      stripNode({ HOME: fx.home, PATH: "/usr/bin:/bin", LLM_EXT_NO_PATH_SHIM: "1" }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(existsSync(dstOf(fx.home))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "I12: a read-only ~/.local/bin fails loudly on the first stderr line",
    () => {
      const fx = setupInstallerFixture();
      const dir = join(fx.home, ".local", "bin");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o555);
      try {
        const res = runInstaller(fx);
        expect(res.status).toBe(1);
        expect(res.stderr.split("\n")[0]).toMatch(/^llm-ext: could not install/);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it("I13: a HOME path containing a double quote still yields valid one-line JSON", () => {
    const fx = setupInstallerFixture();
    const home = join(fx.root, 'ho"me');
    mkdirSync(home, { recursive: true });
    const dir = join(home, ".local", "bin");
    const res = runSh(fx.hookScript, [], stripNode({ HOME: home, PATH: `${dir}:/usr/bin:/bin` }));
    expect(res.status).toBe(0);
    const msg = parseOneLineSystemMessage(res.stdout);
    expect(msg).toContain("installed");
  });

  it("I14: a missing source script fails with an `llm-ext:`-prefixed error", () => {
    const fx = setupInstallerFixture();
    unlinkSync(fx.wrapperCopy);
    const res = runInstaller(fx);
    expect(res.status).toBe(1);
    expect(res.stderr.split("\n")[0]).toMatch(/^llm-ext:/);
  });
});

// ---------------------------------------------------------------------------
// Wrapper runtime (path-shim/llm-ext) — a fixture registry at
// <tmp>/cfg/plugins/installed_plugins.json plus fake installs whose
// bin/llm-ext is `#!/bin/sh` printing a unique marker then `[%s]` per arg,
// so a test can tell which install actually ran from stdout alone.
// ---------------------------------------------------------------------------

const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin`;

/** Creates <root>/installs/<name>/bin/llm-ext and returns the install root
 * (what the registry's `installPath` field points at). */
function makeFakeCli(root: string, name: string, marker: string, executable = true): string {
  const installRoot = join(root, "installs", name);
  const binDir = join(installRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const cli = join(binDir, "llm-ext");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s' '${marker}'\nfor a in "$@"; do printf '[%s]' "$a"; done\n`);
  chmodSync(cli, executable ? 0o755 : 0o644);
  return installRoot;
}

/** Writes installed_plugins.json under <dir>/plugins/installed_plugins.json. */
function writeRegistry(dir: string, plugins: unknown): void {
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins }));
}

describe("wrapper: path-shim/llm-ext", () => {
  it("W1 (V4): the registry-recorded install wins over an unrecorded, executable one", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const recordedRoot = makeFakeCli(root, "recorded", "MARK136");
    // Unrecorded on disk — never referenced by the registry — must be ignored.
    makeFakeCli(root, "unrecorded", "MARK1310");
    writeRegistry(join(home, ".claude"), {
      "llm-externalizer@13.6.0": [{ scope: "user", installPath: recordedRoot }],
    });
    const res = runSh(WRAPPER_SRC, ["a b", "c"], stripNode({ HOME: home, PATH: BASE_PATH }));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("MARK136[a b][c]");
  });

  it("W2 (V5): no llm-externalizer key in the registry fails with found 0 of 0", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeRegistry(join(home, ".claude"), {});
    const res = runSh(WRAPPER_SRC, [], stripNode({ HOME: home, PATH: BASE_PATH }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("found 0 (of 0");
  });

  it("W3 (V6): two user-scope records fails with found 2", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const a = makeFakeCli(root, "a", "MARK-A");
    const b = makeFakeCli(root, "b", "MARK-B");
    writeRegistry(join(home, ".claude"), {
      "llm-externalizer@13.6.0": [
        { scope: "user", installPath: a },
        { scope: "user", installPath: b },
      ],
    });
    const res = runSh(WRAPPER_SRC, [], stripNode({ HOME: home, PATH: BASE_PATH }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("found 2");
  });

  it("W4 (V7): a recorded but non-executable bin fails with no runnable CLI", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const notExecRoot = makeFakeCli(root, "notexec", "MARK1310", false);
    writeRegistry(join(home, ".claude"), {
      "llm-externalizer@13.6.0": [{ scope: "user", installPath: notExecRoot }],
    });
    const res = runSh(WRAPPER_SRC, [], stripNode({ HOME: home, PATH: BASE_PATH }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no runnable CLI");
    expect(res.stdout).not.toContain("MARK1310");
  });

  it("W5 (V8): node missing from PATH fails with status 127", () => {
    const root = freshRoot();
    const emptyDir = join(root, "empty-path-dir");
    mkdirSync(emptyDir, { recursive: true });
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const res = runSh(WRAPPER_SRC, [], stripNode({ HOME: home, PATH: emptyDir }));
    expect(res.status).toBe(127);
    expect(res.stderr).toContain("node is not on PATH");
  });

  it("W6 (V9): CLAUDE_CONFIG_DIR is preferred over HOME for the registry lookup", () => {
    const root = freshRoot();
    const configDir = join(root, "cfgdir");
    mkdirSync(configDir, { recursive: true });
    const fixtureRoot = makeFakeCli(root, "fixture", "MARK-FIXTURE");
    writeRegistry(configDir, {
      "llm-externalizer@13.6.0": [{ scope: "user", installPath: fixtureRoot }],
    });
    // HOME points elsewhere, with no .claude dir at all — if the wrapper
    // ignored CLAUDE_CONFIG_DIR it would fail to even find a registry file.
    const otherHome = join(root, "elsewhere");
    mkdirSync(otherHome, { recursive: true });
    const res = runSh(
      WRAPPER_SRC,
      [],
      stripNode({ HOME: otherHome, CLAUDE_CONFIG_DIR: configDir, PATH: BASE_PATH }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("MARK-FIXTURE");
  });

  it("W7 (V10): a session PATH match wins over the registry without ever reading it", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const registryRoot = makeFakeCli(root, "registry-install", "MARK-REGISTRY");
    writeRegistry(join(home, ".claude"), {
      "llm-externalizer@13.6.0": [{ scope: "user", installPath: registryRoot }],
    });
    // Matches the wrapper's `*/plugins/cache/*/llm-externalizer/*/bin` case pattern.
    const sessionBinDir = join(root, "x", "plugins", "cache", "fx", "llm-externalizer", "9.9.9", "bin");
    mkdirSync(sessionBinDir, { recursive: true });
    const sessionCli = join(sessionBinDir, "llm-ext");
    writeFileSync(sessionCli, "#!/bin/sh\nprintf '%s' 'MARK-SESSION'\n");
    chmodSync(sessionCli, 0o755);
    const res = runSh(
      WRAPPER_SRC,
      [],
      stripNode({ HOME: home, PATH: `${sessionBinDir}:${BASE_PATH}` }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("MARK-SESSION");
    expect(res.stdout).not.toContain("MARK-REGISTRY");
  });

  it("W8 (V11): a non-executable session bin fails without ever reading the registry", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const registryRoot = makeFakeCli(root, "registry-install", "MARK-REGISTRY");
    writeRegistry(join(home, ".claude"), {
      "llm-externalizer@13.6.0": [{ scope: "user", installPath: registryRoot }],
    });
    const sessionBinDir = join(root, "x", "plugins", "cache", "fx", "llm-externalizer", "9.9.9", "bin");
    mkdirSync(sessionBinDir, { recursive: true });
    const sessionCli = join(sessionBinDir, "llm-ext");
    writeFileSync(sessionCli, "#!/bin/sh\nprintf '%s' 'MARK-SESSION'\n");
    chmodSync(sessionCli, 0o644);
    const res = runSh(
      WRAPPER_SRC,
      [],
      stripNode({ HOME: home, PATH: `${sessionBinDir}:${BASE_PATH}` }),
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("session's plugin bin dir has no runnable CLI");
    expect(res.stdout).not.toContain("MARK-REGISTRY");
  });

  it("W9 (V13): a v1-shaped registry record fails with unexpected format, no raw TypeError", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const someRoot = makeFakeCli(root, "v1", "MARK-V1");
    // v1 shape: a single object, not an array of install records.
    writeRegistry(join(home, ".claude"), {
      "llm-externalizer@13.6.0": { scope: "user", installPath: someRoot },
    });
    const res = runSh(WRAPPER_SRC, [], stripNode({ HOME: home, PATH: BASE_PATH }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("unexpected format");
    expect(res.stderr).not.toContain("TypeError");
  });

  it("W10: a missing registry file fails with cannot read", () => {
    const root = freshRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    // No installed_plugins.json written at all.
    const res = runSh(WRAPPER_SRC, [], stripNode({ HOME: home, PATH: BASE_PATH }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cannot read");
  });
});
