// launcher.mjs — pre-flight check + self-install for the `llm-ext` CLI.
//
// The plugin's CLI has a native dependency (better-sqlite3) that
// esbuild marks external; it must be present in node_modules at runtime.
//
// Previous architecture (≤ v9.7.0): a SessionStart hook ran a bash script
// (`scripts/hooks/install-mcp-deps.sh`) that did `npm install` + symlink.
// That worked on macOS/Linux but broke on native Windows (no `bash` on PATH)
// and exposed a destructive-rm-rf-on-symlink race documented in the v9.8.0
// audit (SC-P1-001, SC-P1-002). Per the audit's option-3 recommendation,
// we now self-install from the launcher itself — the same Node binary that
// will run the CLI is the one that prepares its dependencies. This is
// cross-platform out of the box and has no rm-rf surface.
//
// The launcher runs every time the CLI boots; the install path is
// only taken when `import("better-sqlite3")` fails. On the warm path this
// adds a single try/catch around the import — negligible overhead.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync, symlinkSync, lstatSync, rmSync, cpSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nativeDepsDir } from "./data-dir.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_PKG = join(SCRIPT_DIR, "package.json");
const SRC_LOCK = join(SCRIPT_DIR, "package-lock.json");

function log(line) {
  process.stderr.write(`[llm-externalizer] ${line}\n`);
}

function isPlainObjectEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function packageJsonMatches(srcPath, dataDirPath) {
  if (!existsSync(srcPath) || !existsSync(dataDirPath)) return false;
  try {
    const a = JSON.parse(readFileSync(srcPath, "utf-8"));
    const b = JSON.parse(readFileSync(dataDirPath, "utf-8"));
    return isPlainObjectEqual(a, b);
  } catch {
    return false;
  }
}

function pickPackageManager() {
  // Try npm, then pnpm, then bun. Preserved from the previous bash hook's
  // ordering. Note: `npx --version` reports npm presence but is slower than
  // checking the binary directly; spawnSync with `--version` is cross-platform.
  const candidates = [
    ["npm", ["--version"], ["ci", "--omit=dev"], ["install", "--omit=dev", "--no-package-lock"]],
    ["pnpm", ["--version"], ["install", "--prod", "--prefer-offline"], ["install", "--prod"]],
    ["bun", ["--version"], ["install", "--production", "--no-progress"], ["install", "--production"]],
  ];
  for (const [bin, versionArgs, lockArgs, fallbackArgs] of candidates) {
    const probe = spawnSync(bin, versionArgs, { stdio: "ignore", timeout: 10_000 });
    if (probe.status === 0) {
      return { bin, lockArgs, fallbackArgs };
    }
  }
  return null;
}

/** True when the data dir already carries a usable better-sqlite3. A version
 *  bump gives the plugin a fresh cache dir with no node_modules, but the DATA
 *  dir is shared across versions — so the deps are usually already there and
 *  only the link is missing. Re-running the package manager in that case costs
 *  ~40s of network for nothing. */
function dataDirHasDeps(dataDir) {
  return existsSync(join(dataDir, "node_modules", "better-sqlite3", "package.json"));
}

function installDeps(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Copy package.json (+ lock) into the data dir so npm/pnpm/bun can resolve
  // dependencies there. Same convention the bash hook used.
  copyFileSync(SRC_PKG, join(dataDir, "package.json"));
  if (existsSync(SRC_LOCK)) {
    copyFileSync(SRC_LOCK, join(dataDir, "package-lock.json"));
  }

  // Force the prebuild fast-path even when the user has ignore-scripts=true
  // in ~/.npmrc — better-sqlite3 ships prebuilt binaries via prebuild-install
  // which runs from the install lifecycle script.
  const env = {
    ...process.env,
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FETCH_TIMEOUT: "120000",
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "60000",
  };

  const pm = pickPackageManager();
  if (!pm) {
    throw new Error(
      "No package manager (npm / pnpm / bun) on PATH. Install Node.js + npm and retry.",
    );
  }
  log(`installing native deps with ${pm.bin} (this is a one-time setup)...`);
  // Use lock path if present, otherwise the fallback (install without lockfile).
  const hasLock = existsSync(join(dataDir, "package-lock.json"));
  const args = hasLock ? pm.lockArgs : pm.fallbackArgs;
  const result = spawnSync(pm.bin, args, {
    cwd: dataDir,
    stdio: "inherit",
    timeout: 300_000,
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${pm.bin} ${args.join(" ")} exited with ${result.status}. See output above.`,
    );
  }
  log(`deps installed via ${pm.bin}`);
}

// Replace ${PLUGIN_ROOT}/scripts/llm-ext/node_modules with a link/copy pointing at
// the freshly-installed ${DATA_DIR}/node_modules. We refuse to operate on
// destinations whose resolved-realpath leaves the plugin's own scripts/llm-ext
// directory — defense in depth against accidental `rm -rf` outside the
// expected tree (the previous bash hook hit this concern, audit SC-P1-002).
function linkNodeModules(dataDir) {
  const src = join(dataDir, "node_modules");
  const dst = join(SCRIPT_DIR, "node_modules");

  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`node_modules missing from ${dataDir} — install did not produce it`);
  }

  // Confine the destination realpath to a path under SCRIPT_DIR. If the
  // existing dst is a misconfigured symlink pointing elsewhere, removing it
  // would be destructive. We unlink only when the destination is a SYMLINK
  // (atomic remove, can never recurse) OR a real directory whose absolute
  // path equals the expected location.
  let canReplace = true;
  if (existsSync(dst)) {
    try {
      const lst = lstatSync(dst);
      if (lst.isSymbolicLink()) {
        rmSync(dst, { force: true, maxRetries: 1 });
      } else if (lst.isDirectory()) {
        // Only rm if dst is the canonical path under the script dir AND
        // its realpath is also under the script dir. Both checks must hold.
        // Normalise via resolve() on both ends and compare with the
        // platform's path.sep (audit SR-P1-006: a Windows env-var-derived
        // SCRIPT_DIR ending in `\` would otherwise double-slash on concat).
        const dstAbs = resolve(dst);
        const scriptAbs = resolve(SCRIPT_DIR);
        if (dstAbs === scriptAbs || dstAbs.startsWith(scriptAbs + sep)) {
          rmSync(dst, { recursive: true, force: true, maxRetries: 1 });
        } else {
          canReplace = false;
        }
      } else {
        rmSync(dst, { force: true });
      }
    } catch {
      canReplace = false;
    }
  }

  if (!canReplace) {
    throw new Error(
      `refusing to replace ${dst} — its identity is not under ${SCRIPT_DIR}. Remove it manually and retry.`,
    );
  }

  // Try symlink first (fast, no disk overhead). Fall back to copy when
  // symlink fails — most often on Windows without Developer Mode, where
  // unprivileged symlinks are rejected.
  try {
    symlinkSync(src, dst, "dir");
  } catch {
    log("symlink failed (likely Windows without Developer Mode), falling back to copy");
    cpSync(src, dst, { recursive: true });
  }
}

async function tryImport() {
  return import("better-sqlite3");
}

// v9.10.0 audit T2.24 — startup migration hook. Cleans up artifacts left
// behind by v9.5.x → v9.8.x upgrades: stale .publish.lock, settings.yml
// (renamed to .yaml in v9.6.0), and dangling mcp-server/node_modules
// symlinks left by the deprecated bash SessionStart hook. Idempotent;
// the second run is a no-op. Runs BEFORE linkNodeModules() so a dangling
// symlink is removed and rebuilt cleanly on the same launcher invocation.
//
// Synchronous spawn (not dynamic import): migrate.py is stdlib-only Python,
// not Node. It must complete before the import() fast-path check, so we
// block on it. The script is bounded — every check short-circuits on
// missing inputs — so the wall-time cost on the warm path is <100 ms on
// any reasonable machine.
function runMigrate() {
  const migrateScript = resolve(SCRIPT_DIR, "..", "setup", "migrate.py");
  if (!existsSync(migrateScript)) {
    // Defensive: don't block server start if migrate.py is missing from a
    // partial install. The user can run it manually if they hit issues.
    log(`migrate.py not found at ${migrateScript} — skipping startup migration.`);
    return;
  }
  // Pass the plugin root so the broken-symlink check looks at the right
  // mcp-server/node_modules location, even if migrate.py is run from a
  // dev checkout where the relative-path heuristic would land elsewhere.
  const pluginRoot = resolve(SCRIPT_DIR, "..", "..");
  const env = { ...process.env, LLM_EXT_PLUGIN_ROOT: pluginRoot };
  // Prefer python3, fall back to python. spawnSync timeout 10 s — the script
  // is tiny but a corrupted FS could hang stat().
  for (const pyBin of ["python3", "python"]) {
    const probe = spawnSync(pyBin, ["--version"], { stdio: "ignore", timeout: 5_000 });
    if (probe.status !== 0) continue;
    const result = spawnSync(pyBin, [migrateScript, "--quiet"], {
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 10_000,
      env,
    });
    if (result.status !== 0) {
      // Migration failure is NOT fatal — the server can still boot.
      log(`startup migration (${pyBin} migrate.py) exited ${result.status}; continuing.`);
    } else if (result.stdout && result.stdout.toString().trim()) {
      // --quiet only prints when an action was taken; surface it.
      log(`startup migration: ${result.stdout.toString().trim()}`);
    }
    return;
  }
  log("no python3/python interpreter found on PATH — skipping startup migration.");
}

try { runMigrate(); } catch (e) {
  log(`startup migration crashed: ${e instanceof Error ? e.message : String(e)}; continuing.`);
}

let installed = false;

try {
  await tryImport();
} catch (err) {
  // One fixed location, identical for every caller — an interactive session, a
  // skill, a cron job, a detached daemon. Nothing to derive, nothing to inherit
  // from the environment, so there is no "unresolvable data dir" state to fail
  // on and no way for two callers to install into two different directories.
  const dataDir = nativeDepsDir();

  // Self-install path. The previous SessionStart-bash-hook architecture was
  // replaced with this in-launcher path so the install works on Windows too.
  try {
    if (dataDirHasDeps(dataDir)) {
      // The deps are already in the data dir and only this version's link is
      // missing — the normal case right after a plugin upgrade, since the cache
      // dir is per-version and the data dir is not.
      log("native deps already present in the data dir — linking them into this version.");
      linkNodeModules(dataDir);
    } else {
      log("better-sqlite3 not found — running one-time self-install...");
      installDeps(dataDir);
      linkNodeModules(dataDir);
    }
    installed = true;
  } catch (installErr) {
    process.stderr.write(
      `[llm-externalizer] FATAL: self-install failed.\n\n` +
        `Cause: ${installErr instanceof Error ? installErr.message : String(installErr)}\n\n` +
        `Manual recovery:\n` +
        `  mkdir -p "${dataDir}"\n` +
        `  cp "${SRC_PKG}" "${dataDir}/"\n` +
        `  cd "${dataDir}" && npm install --omit=dev --no-ignore-scripts\n` +
        `  ln -sfn "${dataDir}/node_modules" "${SCRIPT_DIR}/node_modules"\n\n` +
        `Original import error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Persist the installed package.json so the next launch's fast-path check
  // (compare-vs-cached) succeeds immediately instead of probing the import.
  // The previous bash hook did this same thing — preserved here.
  if (!packageJsonMatches(SRC_PKG, join(dataDir, "package.json"))) {
    try {
      copyFileSync(SRC_PKG, join(dataDir, "package.json"));
    } catch {
      // Non-fatal — the cached copy was already written by installDeps.
    }
  }

  // Retry the import now that node_modules is in place.
  try {
    await tryImport();
  } catch (retryErr) {
    process.stderr.write(
      `[llm-externalizer] FATAL: better-sqlite3 still cannot be loaded after self-install.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}\n` +
        `Retry error:    ${retryErr instanceof Error ? retryErr.message : String(retryErr)}\n` +
        `If you are on Windows without Developer Mode, the symlink fallback may have failed.\n`,
    );
    process.exit(1);
  }
}

if (installed) {
  // Quick sanity log so the first-run user sees something positive after the
  // (slow) install completes. Subsequent runs hit the fast path and are silent.
  log("self-install complete; starting.");
}

// Hand off to the bundled CLI. Use a URL-based dynamic import so esbuild
// leaves the path alone if this file ever passes through it.
//
// This file is NOT dead weight after the MCP removal — it is the only thing
// that guarantees the native `better-sqlite3` binding is present before
// mass-scout touches its SQLite registry, and the plugin ships with
// node_modules gitignored. It just launches a CLI now instead of a server.
//
// (The `process.argv[1] = …` line that used to sit here is gone with the
// entry-point guard it existed to satisfy. dist/llm-ext.js reads its command
// from argv.slice(2) and does not care how it was reached.)
const cliUrl = pathToFileURL(join(SCRIPT_DIR, "dist", "llm-ext.js")).href;
await import(cliUrl);
