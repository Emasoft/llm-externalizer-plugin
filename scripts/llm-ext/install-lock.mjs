// install-lock.mjs — cross-process mutex around the native-deps self-install.
//
// launcher.mjs runs on every `llm-ext` invocation and self-installs
// better-sqlite3 into a shared data dir on first run. Nothing serialized that
// path, so two processes starting at once on a fresh machine raced: two `npm`
// runs in the same cwd, a TOCTOU symlink-vs-EEXIST collision, and a loser
// reading "deps present" mid-write. `mkdirSync` without `recursive` is an
// atomic exclusive-create on POSIX and Windows alike (throws EEXIST if the
// dir exists) — that single property is the whole mutex, no extra dependency
// needed.
//
// ponytail: one global install lock, not per-package — this plugin installs
// exactly one native dep (better-sqlite3), so there is nothing to shard.

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Acquire the install lock, run `fn`, release it. Waits (polling every
 * ~1s) while another process holds the lock, up to `timeoutMs`. A lock dir
 * older than `timeoutMs` is treated as abandoned (the holder crashed) and is
 * removed so a stale lock can never brick every future run — worse than the
 * race this exists to fix.
 *
 * @template T
 * @param {string} dataDir
 * @param {number} timeoutMs
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withInstallLock(dataDir, timeoutMs, fn) {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, ".install.lock");
  const start = Date.now();
  let staleRetried = false;

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (!staleRetried) {
        staleRetried = true;
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > timeoutMs) {
            rmSync(lockPath, { recursive: true, force: true });
            continue; // retry the mkdirSync immediately, no wait
          }
        } catch {
          // Lock vanished between the failed mkdir and the stat — another
          // process just released it. Fall through to the normal retry loop.
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for install lock at ${lockPath} ` +
            `(another process is installing; remove the dir manually if it is stale)`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
