// install-lock.test.ts — proves the launcher's cross-process install mutex
// actually EXCLUDES a concurrent caller while the lock is held, and that a
// stale (crashed-holder) lock is recovered — deterministically, in-process,
// with no real sleeping and no spawned processes.
//
// Primitive under test: atomic `mkdirSync` (no `recursive`) as an O_EXCL-style
// exclusive create. flock(2)/native addons are ruled out on this machine, so
// mkdirSync's POSIX+Windows atomicity is the only portable option available —
// see install-lock.mjs's own header comment for the same reasoning.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — .mjs sibling, no types
import { withInstallLock } from '../install-lock.mjs';

afterEach(() => {
  vi.useRealTimers();
});

describe('withInstallLock', () => {
  it('excludes a concurrent caller while the lock is held, then admits it once released', async () => {
    // Fake only the timer (not Date) so the poll loop's 1s wait is advanced
    // deterministically instead of actually elapsing — the stale-lock age
    // math still reads the real filesystem clock unaffected.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const dataDir = mkdtempSync(join(tmpdir(), 'llm-ext-lock-'));
    const lockPath = join(dataDir, '.install.lock');
    try {
      // Simulate another process already holding the lock.
      mkdirSync(lockPath);

      let contenderRan = false;
      const contender = withInstallLock(dataDir, 5_000, () => {
        contenderRan = true;
        return 'contender-result';
      });

      // Flush microtasks without advancing real or fake time: the contender
      // must have hit EEXIST and be parked in its poll wait, NOT run its body.
      await vi.advanceTimersByTimeAsync(0);
      // THE LOAD-BEARING ASSERTION: if the lock were a no-op, the contender's
      // body would already have run here.
      expect(contenderRan).toBe(false);

      // Release the lock (the "other process" finishes) and advance the fake
      // clock past the ~1s poll interval so the contender retries.
      rmSync(lockPath, { recursive: true, force: true });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(contender).resolves.toBe('contender-result');
      expect(contenderRan).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('recovers a stale lock (mtime older than the timeout) instead of waiting on a dead holder', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'llm-ext-lock-stale-'));
    const lockPath = join(dataDir, '.install.lock');
    const timeoutMs = 300_000;
    try {
      mkdirSync(lockPath);
      // Back-date the lock dir's mtime past the timeout — no waiting, just
      // rewrite the timestamp the staleness check reads.
      const stale = new Date(Date.now() - (timeoutMs + 60_000));
      utimesSync(lockPath, stale, stale);
      expect(Date.now() - statSync(lockPath).mtimeMs).toBeGreaterThan(timeoutMs);

      const result = await withInstallLock(dataDir, timeoutMs, () => 'recovered');
      expect(result).toBe('recovered');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
