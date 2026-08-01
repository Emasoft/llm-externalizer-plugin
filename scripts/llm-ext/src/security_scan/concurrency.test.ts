/**
 * Real unit tests for runWithLimit — the bounded worker-pool primitive.
 *
 * No mocks of the unit under test. Concurrency is exercised with real
 * deferred promises whose resolution the test controls, so the in-flight
 * count is observed against the actual scheduler — no fake timers.
 */
import { describe, it, expect } from "vitest";
import { runWithLimit } from "./concurrency.js";

/** A promise plus its resolver, so a task can be held open and released on demand. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Yield to the microtask queue enough times for pending continuations to run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("runWithLimit", () => {
  it("never exceeds the concurrency limit while tasks are in flight", async () => {
    const total = 12;
    const limit = 3;
    const items = Array.from({ length: total }, (_, i) => i);
    const gates = items.map(() => defer());
    let inFlight = 0;
    let maxInFlight = 0;

    const run = runWithLimit(items, limit, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[item]!.promise;
      inFlight--;
    });

    // Release tasks one at a time; at no point should more than `limit` be running.
    for (let i = 0; i < total; i++) {
      await flush();
      expect(inFlight).toBeLessThanOrEqual(limit);
      gates[i]!.resolve();
    }
    await run;
    expect(maxInFlight).toBe(limit);
  });

  it("processes every item exactly once", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const seen: string[] = [];
    await runWithLimit(items, 2, async (item) => {
      seen.push(item);
    });
    expect(seen.slice().sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(seen).toHaveLength(items.length);
  });

  it("returns immediately for empty input without invoking fn", async () => {
    let calls = 0;
    await runWithLimit([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("caps worker count at the item count when limit exceeds it", async () => {
    const total = 2;
    const items = Array.from({ length: total }, (_, i) => i);
    const gates = items.map(() => defer());
    let maxInFlight = 0;
    let inFlight = 0;

    const run = runWithLimit(items, 100, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[item]!.promise;
      inFlight--;
    });

    await flush();
    // Only `total` workers can exist, so in-flight saturates at `total`, not 100.
    expect(maxInFlight).toBe(total);
    gates.forEach((g) => g.resolve());
    await run;
  });

  it("propagates a rejection thrown inside fn", async () => {
    const items = [1, 2, 3];
    await expect(
      runWithLimit(items, 2, async (item) => {
        if (item === 2) throw new Error("boom on 2");
      }),
    ).rejects.toThrow("boom on 2");
  });

  it("runs serially when limit is 1, preserving start order", async () => {
    const items = [0, 1, 2, 3];
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithLimit(items, 1, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(item);
      await Promise.resolve();
      inFlight--;
    });
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]);
  });
});
