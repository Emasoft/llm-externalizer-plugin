import { describe, it, expect } from 'vitest';
import { createDeadline, DeadlineError } from './deadline.js';

describe('createDeadline', () => {
  it('E10: abort during a wait rejects at once with reason aborted', async () => {
    const ac = new AbortController();
    const d = createDeadline({ timeoutMs: 60_000, signal: ac.signal });
    const t0 = Date.now();
    const p = d.sleep(30_000);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'DeadlineError', reason: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    d.dispose();
  });

  it('an already-aborted caller signal fails the first wait immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const d = createDeadline({ signal: ac.signal });
    await expect(d.sleep(10)).rejects.toBeInstanceOf(DeadlineError);
    expect(d.signal.aborted).toBe(true);
    d.dispose();
  });

  it('one deadline spans all attempts: waits share one budget and are cut at it', async () => {
    const d = createDeadline({ timeoutMs: 120 });
    await d.sleep(60); // attempt 1 backoff
    expect(d.remainingMs()).toBeLessThan(100);
    await expect(d.sleep(5_000)).rejects.toMatchObject({ reason: 'timeout' }); // attempt 2 wait hits the shared deadline
    expect(d.reason).toBe('timeout');
    expect(() => d.throwIfDone()).toThrow(DeadlineError);
    d.dispose();
  });

  it('a normal wait resolves and leaves the deadline live', async () => {
    const d = createDeadline({ timeoutMs: 5_000 });
    await d.sleep(10);
    expect(d.reason).toBeUndefined();
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });

  it('after dispose the deadline never fires, even past its timeout', async () => {
    const d = createDeadline({ timeoutMs: 30 });
    d.dispose();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(d.signal.aborted).toBe(false);
    expect(d.reason).toBeUndefined();
  });

  it('rejects a non-positive timeout', () => {
    expect(() => createDeadline({ timeoutMs: 0 })).toThrow(RangeError);
  });
});
