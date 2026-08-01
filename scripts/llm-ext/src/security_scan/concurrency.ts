/**
 * Tiny worker-pool runner — N parallel workers pull from a shared index.
 * Re-implemented locally (≤15 LOC of logic) per TRDD §2 so this module does
 * NOT import scout.ts. Same contract as scout.ts::runWithLimit: failures
 * inside `fn` are the caller's concern (judge.ts never lets `fn` throw).
 */
export async function runWithLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const total = items.length;
  let idx = 0;
  const workerCount = Math.max(1, Math.min(limit, total));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async (): Promise<void> => {
        while (true) {
          const myIdx = idx++;
          if (myIdx >= total) break;
          await fn(items[myIdx]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
