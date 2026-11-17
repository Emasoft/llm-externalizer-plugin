/**
 * vitest `globalSetup` — FAILS the run if the suite leaves temp dirs behind.
 *
 * Second layer over test-tmpdir-tracker.ts. The tracker prevents the leak for
 * anything that goes through fs.mkdtemp*; this guard DETECTS a leak through any
 * other route (mkdirSync with a hand-rolled name, a spawned CLI writing its own
 * temp dir, a future helper) so it is noticed on the first run instead of after
 * /tmp holds 2,400 orphan dirs again. It snapshots the top-level entries of the
 * two temp roots before the run and, at teardown, lists the entries that are
 * NEW and still present; any whose name carries the project's `llm-ext` /
 * `__llm_ext` marker fails the run — and with it `npm test` and the publish
 * gate. Only project-named entries are checked because other sessions create
 * temp dirs concurrently; name your test temp dirs with an `llm-ext-` prefix so
 * this guard can see them.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOTS = ["/tmp", tmpdir()].filter((r, i, a) => existsSync(r) && a.indexOf(r) === i);
const PROJECT_MARKER = /llm[-_]?ext/i;

// WHY PERSISTENT_CACHES exists (TRDD-36L97JC9): the broker and governor tests keep this llama model cache on
// purpose, across runs (broker.test.ts, broker-governor.test.ts, governor/governor-load.test.ts,
// governor/governor-threads.test.ts, local-fallback-e2e.test.ts). CI caches it with actions/cache in
// .github/workflows/ci.yml, keyed by a hash of broker.test.ts. On a cache miss (Linux CI run 43983678292) the
// tests create it during the run, so this check reported it as a leak. Only the exact full path is exempt:
// a prefix or pattern would also hide real leaks.
const PERSISTENT_CACHES = ["/tmp/llm-ext-llama-cache"];

function snapshot(): Map<string, Set<string>> {
  return new Map(ROOTS.map((r) => [r, new Set(readdirSync(r))]));
}

// WHY a machine-wide single-run lock (TRDD-VCEX28LN): the leak check below blames
// EVERY new llm-ext-named temp entry, whoever made it, so a second vitest run on
// the same host (another worktree, an agent, a publish stage, or a CLI child
// that run spawned) made an innocent run fail with the other run's in-flight
// temp dirs. A per-run claims registry was tried and REJECTED: it can mask a
// real leak (a claimed name that is never removed) and cannot see the dirs of
// spawned CLI children. So instead only ONE llm-ext test run may exist per
// machine at a time, and a second one fails fast instead of waiting. The lock
// file name must NOT match PROJECT_MARKER, or the guard would report its own
// lock as a leak. The `npm test` script chains several vitest runs with &&;
// each takes and releases the lock in turn, so they never overlap.
// Fixed /tmp (ROOTS[0]), NOT os.tmpdir(): on macOS tmpdir() is a per-user /var/folders
// path, so two runs with different TMPDIR would not see each other's lock while
// both scan /tmp.
const LOCK_PATH = join("/tmp", "vitest-llmx-run.lock");

interface LockHolder {
  pid: number;
  cwd: string;
  startedAt: string;
}

function holderActive(holder: LockHolder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (e) {
    // EPERM = the process exists but belongs to another user: still alive.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  // A live pid alone is not proof: pids are reused, so a lock left by a crashed
  // run can name an unrelated live process. The real holder started BEFORE it
  // wrote startedAt; a process that started AFTER that moment is a pid reuse and
  // the lock is stale. If the start time cannot be read, treat the pid as the holder.
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(holder.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    const procStart = Date.parse(out.trim());
    const lockStart = Date.parse(holder.startedAt);
    if (Number.isNaN(procStart) || Number.isNaN(lockStart)) return true;
    return procStart <= lockStart;
  } catch {
    return true;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reads the lock for ~1 s until it parses: an empty/half-written file is either
// a run writing it right now or the leftover of a crash between open and write.
// holder is null when it never parsed; undefined = the file is gone.
function readHolder(): { raw: string; holder: LockHolder | null } | undefined {
  let raw = "";
  for (let i = 0; i < 4; i++) {
    try {
      raw = readFileSync(LOCK_PATH, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      return { raw, holder: JSON.parse(raw) as LockHolder };
    } catch {
      sleepMs(250); // not JSON yet: retry
    }
  }
  return { raw, holder: null };
}

function acquireRunLock(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(LOCK_PATH, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const seen = readHolder();
      if (seen === undefined) continue; // holder just released it
      const { raw, holder } = seen;
      if (holder === null) {
        let ageMs: number;
        try {
          ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
        } catch (se) {
          if ((se as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw se;
        }
        if (ageMs <= 10_000) {
          throw new Error(
            `llm-ext test-run lock ${LOCK_PATH} exists but is unreadable (a run may be writing it): ` +
              `retry, or if no llm-ext test run is active remove that file`,
            { cause: e },
          );
        }
      } else if (holderActive(holder)) {
        throw new Error(
          `another llm-ext test run is active (pid ${holder.pid}, cwd ${holder.cwd}, started ${holder.startedAt}): ` +
            `wait for it to finish; two runs at once make the temp-dir guard blame each other ` +
            `(lock file ${LOCK_PATH}: if no llm-ext test run is active, remove that file)`,
          { cause: e },
        );
      }
      // Stale takeover by RENAME, not unlink: of several runs that judged the same
      // lock stale only one rename succeeds; the others get ENOENT and retry the
      // exclusive create. If the renamed file is not the one we judged, a faster
      // run replaced it meanwhile and we moved ITS live lock: put it back.
      const claimed = `${LOCK_PATH}.stale.${process.pid}`;
      try {
        renameSync(LOCK_PATH, claimed);
      } catch (re) {
        if ((re as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw re;
      }
      if (readFileSync(claimed, "utf8") !== raw) {
        try {
          linkSync(claimed, LOCK_PATH);
        } catch (le) {
          if ((le as NodeJS.ErrnoException).code !== "EEXIST") throw le;
        }
        unlinkSync(claimed);
        continue;
      }
      unlinkSync(claimed);
      process.stderr.write(
        holder === null
          ? `llm-ext test-run lock: unreadable lock older than 10 s replaced\n`
          : `llm-ext test-run lock: stale lock of pid ${holder.pid} (dead, or reused by a later process) replaced\n`,
      );
      continue;
    }
    try {
      const holder: LockHolder = { pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() };
      writeSync(fd, JSON.stringify(holder));
    } catch (we) {
      closeSync(fd);
      unlinkSync(LOCK_PATH);
      throw we;
    }
    closeSync(fd);
    return;
  }
  throw new Error(`could not take the llm-ext test-run lock ${LOCK_PATH}: it keeps changing under us`);
}

function releaseRunLock(): void {
  try {
    const holder = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as LockHolder;
    if (holder.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export default function setup(): () => void {
  acquireRunLock();
  let before: Map<string, Set<string>>;
  try {
    before = snapshot();
  } catch (e) {
    releaseRunLock();
    throw e;
  }
  return () => {
    // finally: a leak failure below must still release the lock.
    try {
      const leaked: string[] = [];
      for (const [root, names] of snapshot()) {
        for (const name of names) {
          const entry = join(root, name);
          if (!before.get(root)?.has(name) && PROJECT_MARKER.test(name) && !PERSISTENT_CACHES.includes(entry)) leaked.push(entry);
        }
      }
      if (leaked.length > 0) {
        // A throw alone is only REPORTED ("error during close") — vitest still
        // exits 0, so the gate would be decoration. exitCode is what `npm test`
        // and the publish gate actually see.
        process.exitCode = 1;
        throw new Error(
          `TEMP-DIR LEAK: ${leaked.length} project temp entr${leaked.length === 1 ? "y" : "ies"} left behind by this run — ` +
            `every test must remove what it creates (mkdtempSync is auto-cleaned by src/test-tmpdir-tracker.ts; ` +
            `anything else needs an explicit rmSync in afterEach/afterAll):\n  ${leaked.join("\n  ")}`,
        );
      }
    } finally {
      releaseRunLock();
    }
  };
}
