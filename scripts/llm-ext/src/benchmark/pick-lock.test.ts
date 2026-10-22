// Real, multi-process tests for withSettingsWriteLock (pick.ts's mkdir
// spin-lock over <cfg>/settings.write.lock). No mocks: every scenario either
// spawns a REAL child process (bundled from the CURRENT source with esbuild —
// dist/ may be stale, and this suite must never regenerate it) or manipulates
// the real lock directory on disk, exactly as a crashed/live holder would.
//
// Why bundle instead of importing pick.ts directly in a spawned `node`: this
// project has no ts-node/tsx, and plain node cannot resolve pick.ts's own
// "./config.js"-style imports back to their .ts files. esbuild (already a
// devDependency, used by esbuild.config.mjs) bundles the real source into one
// self-contained ESM file that spawned `node` can run as-is.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "../test-tmp-root.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { parseDocument } from "yaml";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));

const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

// Same shim esbuild.config.mjs injects for the real build: bundled CJS deps
// (yaml) call require("process") internally, which ESM output has no
// require() for unless we provide one.
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";
const require = __cjsCreateRequire(import.meta.url);
`;

/** Bundle a tiny standalone entry (given as source text) against the REAL,
 *  current pick.ts into a single runnable ESM file. */
async function bundleEntry(contents: string, outfile: string): Promise<void> {
  await build({
    stdin: { contents, resolveDir: BENCHMARK_DIR, sourcefile: "entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: REQUIRE_SHIM },
    external: nodeExternals,
    outfile,
  });
}

// Writes ONE dynamic profile via the real, exported writeDynamicProfileSection
// (which internally takes withSettingsWriteLock) and reports the outcome as
// JSON on stdout so the parent test can assert on it without racing a shared
// file. Exit code mirrors success/failure so spawnSync's `status` is enough
// for a quick check too.
const WRITE_ENTRY = `
import { writeDynamicProfileSection } from "./pick.js";
const [settingsPath, name, model] = process.argv.slice(2);
try {
  const result = writeDynamicProfileSection(
    settingsPath,
    name,
    () => ({
      mode: "remote",
      api: "openrouter-remote",
      api_key: "$OPENROUTER_API_KEY",
      free_only: true,
      model,
      free_models: [model],
      tool_models: {},
    }),
    { notify: () => {} },
  );
  process.stdout.write(JSON.stringify({ ok: true, changed: result.changed }));
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
  process.exitCode = 1;
}
`;

// P6b-fix3 R-1: every assertion on a child's exit code carries BOTH of the
// child's streams, because the two failure shapes land on different ones — the
// entry catches its own throw and reports it as JSON on STDOUT, while anything
// that breaks before/around that (a module-level failure, a bundle error)
// reaches STDERR only. The regression this repairs was invisible for exactly
// that reason: fix2 changed writeDynamicProfileSection's third parameter from a
// Profile to a `(current) => Profile` patch function, this entry is a STRING
// that neither tsc nor `tldr impact` can see, and the whole diagnosis the suite
// offered was `expected 1 to be +0`. The real cause was
// `TypeError: patch is not a function`.
const childDiag = (r: { stdout?: string | null; stderr?: string | null }): string =>
  `child stdout: ${r.stdout ?? ""}\nchild stderr: ${r.stderr ?? ""}`;

// Holds the RAW lock directory (mkdir + a pid file) for holdMs, then releases
// it — a stand-in for a real live writer mid-flight, used to prove test (b)'s
// wait-then-proceed behaviour without touching pick.ts's internals.
const HOLD_LOCK_ENTRY = `
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
const [dir, holdMs] = process.argv.slice(2);
mkdirSync(dir);
writeFileSync(dir + "/pid", String(process.pid));
setTimeout(() => {
  rmSync(dir, { recursive: true, force: true });
}, Number(holdMs));
`;

describe("withSettingsWriteLock — real concurrency, real processes (TRDD P5 review finding 5)", () => {
  let cfg = "";
  let dynPath = "";
  let bundleDir = "";
  let writeBundle = "";
  let holdBundle = "";

  const INITIAL_SETTINGS = ["profiles:", "  sibling:", "    mode: remote", ""].join("\n");

  beforeEach(async () => {
    cfg = mkdtempSync(join(tmpdir(), "lock-test-cfg-"));
    dynPath = join(cfg, "settings.yaml");
    writeFileSync(dynPath, INITIAL_SETTINGS, "utf-8");
    bundleDir = mkdtempSync(join(tmpdir(), "lock-test-bundle-"));
    writeBundle = join(bundleDir, "write-entry.mjs");
    holdBundle = join(bundleDir, "hold-entry.mjs");
    await bundleEntry(WRITE_ENTRY, writeBundle);
    await bundleEntry(HOLD_LOCK_ENTRY, holdBundle);
  });

  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it("(a) two concurrent writers both land their writes — settings.yaml stays valid YAML containing both", async () => {
    const run = (name: string, model: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [writeBundle, dynPath, name, model], {
          env: { ...process.env, LLM_EXT_CONFIG_DIR: cfg },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += String(d);
        });
        // P6b-fix3 R-1: stderr is collected, not discarded — see childDiag.
        child.stderr.on("data", (d) => {
          stderr += String(d);
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    // "free" and "paid" are the two DYNAMIC_PROFILE_NAMES — both real target
    // keys writeDynamicProfileSection can write, so this is a genuine race
    // over the SAME settings.yaml, not two writers touching disjoint files.
    const [r1, r2] = await Promise.all([run("free", "v/one:free"), run("paid", "v/two:paid")]);
    expect(r1.code, childDiag(r1)).toBe(0);
    expect(r2.code, childDiag(r2)).toBe(0);

    const text = readFileSync(dynPath, "utf-8");
    const doc = parseDocument(text);
    expect(doc.errors).toHaveLength(0); // still valid YAML after the race
    const profiles = doc.toJS().profiles as Record<string, { model?: string }>;
    expect(profiles.free?.model).toBe("v/one:free");
    expect(profiles.paid?.model).toBe("v/two:paid");
    expect(profiles.sibling).toBeDefined(); // untouched third key survives too
  });

  it("(b) a lock held by a live process makes the writer wait, and it proceeds only after release", () => {
    const lockDir = join(cfg, "settings.write.lock");
    const holder = spawn(process.execPath, [holdBundle, lockDir, "500"]);
    try {
      const pollDeadline = Date.now() + 2000;
      while (!existsSync(lockDir) && Date.now() < pollDeadline) {
        // busy-wait briefly for the holder to actually take the lock before
        // racing it — see the test-tmpdir-guard style comment elsewhere.
      }
      expect(existsSync(lockDir)).toBe(true);

      const start = Date.now();
      const r = spawnSync(process.execPath, [writeBundle, dynPath, "free", "v/waited:free"], {
        env: { ...process.env, LLM_EXT_CONFIG_DIR: cfg },
        encoding: "utf-8",
      });
      const elapsed = Date.now() - start;

      expect(r.status, childDiag(r)).toBe(0);
      // Proves it actually WAITED for the holder to release (not an instant
      // takeover) — the holder releases at ~500ms.
      expect(elapsed).toBeGreaterThanOrEqual(350);
      // Proves it succeeded via the release path, not the 30s throw path.
      expect(elapsed).toBeLessThan(5000);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
    } finally {
      holder.kill();
    }
  });

  it("(c) a lock whose recorded pid is dead is taken over at once", () => {
    const lockDir = join(cfg, "settings.write.lock");
    mkdirSync(lockDir);
    // PID 2^22 is above every real pid_max on macOS/Linux — cannot exist.
    writeFileSync(join(lockDir, "pid"), "4194304");

    const start = Date.now();
    const r = spawnSync(process.execPath, [writeBundle, dynPath, "free", "v/takeover:free"], {
      env: { ...process.env, LLM_EXT_CONFIG_DIR: cfg },
      encoding: "utf-8",
    });
    const elapsed = Date.now() - start;

    expect(r.status, childDiag(r)).toBe(0);
    // Fast takeover (dead pid), never the 30s wait bound.
    expect(elapsed).toBeLessThan(3000);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
  });

  it(
    "(d) a lock held past the wait bound makes the writer throw, and the file is unchanged",
    () => {
      const lockDir = join(cfg, "settings.write.lock");
      mkdirSync(lockDir);
      // The recorded pid is THIS test process's own pid: always alive (a
      // child can signal its real, running parent), and the dir is freshly
      // created so it is never stale either — the writer has no way to take
      // it over and must wait the FULL bound, then refuse to write unlocked.
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      const before = readFileSync(dynPath, "utf-8");

      // Shrink the wait bound for the spawned writer via the test-only env
      // knob (pick.ts::resolveLockWaitMs) instead of waiting out the real
      // 30s production default — the lock itself is still real and unmocked.
      const WAIT_MS = 2000;
      const start = Date.now();
      const r = spawnSync(process.execPath, [writeBundle, dynPath, "free", "v/never:free"], {
        env: { ...process.env, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_SETTINGS_LOCK_WAIT_MS: String(WAIT_MS) },
        encoding: "utf-8",
        timeout: WAIT_MS * 4,
      });
      const elapsed = Date.now() - start;

      expect(r.status, childDiag(r)).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok, childDiag(r)).toBe(false);
      expect(parsed.error).toMatch(/settings\.write\.lock/);
      // Proves it actually waited out the (shrunk) bound rather than
      // throwing instantly, and that it used the shrunk bound rather than
      // the old 30s production default.
      expect(elapsed).toBeGreaterThanOrEqual(WAIT_MS);
      expect(elapsed).toBeLessThan(15_000);
      // Never wrote unlocked: the file is byte-identical to before the call.
      expect(readFileSync(dynPath, "utf-8")).toBe(before);
    },
    10_000, // 3x+ the 2s wait bound — plenty of headroom, no more 45s tax
  );

  // process.getuid() === 0 (root) bypasses the write-permission check
  // chmod relies on below, so this scenario cannot be reproduced under root
  // — skip rather than report a false pass or hang the suite.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)(
    "(e) an unwritable config dir (ENOENT/EACCES on both mkdir and the stat that follows it) throws after the wait bound instead of spinning forever (row 76, TRDD-90DM5YHO)",
    () => {
      const unwritableCfg = mkdtempSync(join(tmpdir(), "lock-test-unwritable-"));
      const settingsPath = join(unwritableCfg, "settings.yaml");
      writeFileSync(settingsPath, INITIAL_SETTINGS, "utf-8");
      chmodSync(unwritableCfg, 0o500); // read+execute, no write: mkdirSync(<cfg>/settings.write.lock) fails
      try {
        const WAIT_MS = 2000;
        const start = Date.now();
        const r = spawnSync(process.execPath, [writeBundle, settingsPath, "free", "v/never:free"], {
          env: { ...process.env, LLM_EXT_CONFIG_DIR: unwritableCfg, LLM_EXT_SETTINGS_LOCK_WAIT_MS: String(WAIT_MS) },
          encoding: "utf-8",
          timeout: WAIT_MS * 6, // hard kill if the bug still spins, so the suite fails fast instead of hanging
        });
        const elapsed = Date.now() - start;

        expect(r.status, childDiag(r)).toBe(1);
        const parsed = JSON.parse(r.stdout);
        expect(parsed.ok, childDiag(r)).toBe(false);
        expect(parsed.error).toMatch(/settings\.write\.lock/);
        // Proves it actually waited out the (shrunk) bound rather than
        // throwing instantly or spinning past it.
        expect(elapsed).toBeGreaterThanOrEqual(WAIT_MS);
        expect(elapsed).toBeLessThan(WAIT_MS * 4);
      } finally {
        chmodSync(unwritableCfg, 0o700);
        rmSync(unwritableCfg, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("resolveLockWaitMs falls back to the 30s default on a non-integer or negative env value", async () => {
    const { resolveLockWaitMs } = await import("./pick.js");
    const prev = process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS;
    try {
      for (const bad of [undefined, "", "abc", "-5", "0", "12.5"]) {
        if (bad === undefined) delete process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS;
        else process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS = bad;
        expect(resolveLockWaitMs()).toBe(30_000);
      }
      process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS = "2500";
      expect(resolveLockWaitMs()).toBe(2500);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS;
      else process.env.LLM_EXT_SETTINGS_LOCK_WAIT_MS = prev;
    }
  });
});
