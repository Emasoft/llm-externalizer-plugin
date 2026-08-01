// Rate limiting — extracted from index.ts (B1 Phases 2 + 2b, TRDD-63314265).
// Self-contained: depends only on Date/setTimeout/Math/stderr, so it imports
// without index.ts's main()-on-import side effect. This module owns the whole
// rate-limiting surface: the AIMD limiter class, the shared module-level
// singleton + getAdaptiveRateLimiter() factory, the signalSuccess() /
// signalRateLimitHit() accessors, and the rateLimitedParallel() executor (with
// its ProgressFn callback type). index.ts imports rateLimitedParallel + the
// accessors instead of holding any rate-limiting state of its own.
//
// Token-bucket rate limiter with Additive Increase / Multiplicative Decrease:
//   - On 429 (rate limit hit): halve RPS immediately
//   - On success streak (10 consecutive): increase RPS by 1 (up to initial max)

export class AdaptiveRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private currentRps: number;
  private initialRps: number;
  private readonly minRps: number = 1;
  private refillPerMs: number;
  private consecutiveSuccesses: number = 0;

  constructor(rps: number) {
    this.initialRps = Math.max(1, rps);
    this.currentRps = this.initialRps;
    this.tokens = this.currentRps;
    this.refillPerMs = this.currentRps / 1000;
    this.lastRefill = Date.now();
  }

  get rps(): number {
    return this.currentRps;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.currentRps, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
  }

  private updateRate(newRps: number): void {
    this.currentRps = Math.max(this.minRps, Math.min(this.initialRps, newRps));
    this.refillPerMs = this.currentRps / 1000;
    // Don't reset tokens — let existing tokens drain naturally
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, Math.max(1, waitMs)));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Call after a successful request — additive increase */
  onSuccess(): void {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= 10 && this.currentRps < this.initialRps) {
      this.updateRate(this.currentRps + 1);
      this.consecutiveSuccesses = 0;
      process.stderr.write(`[llm-externalizer] AIMD: RPS increased to ${this.currentRps}\n`);
    }
  }

  /** Call after a 429 rate-limit error — multiplicative decrease */
  onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    const newRps = Math.floor(this.currentRps / 2);
    if (newRps !== this.currentRps) {
      this.updateRate(newRps);
      process.stderr.write(`[llm-externalizer] AIMD: 429 detected, RPS halved to ${this.currentRps}\n`);
    }
  }

  /** Reset to initial RPS (e.g., after profile switch) */
  reset(newInitialRps?: number): void {
    if (newInitialRps !== undefined) {
      this.initialRps = Math.max(1, newInitialRps);
    }
    this.currentRps = this.initialRps;
    this.refillPerMs = this.currentRps / 1000;
    this.tokens = this.currentRps;
    this.consecutiveSuccesses = 0;
    this.lastRefill = Date.now();
  }
}

// ── ProgressFn — progress-notification callback ──────────────────────
// (progress, total, message?) — used by the parallel executor's heartbeat
// and by every batch tool to report incremental progress to the MCP client.
export type ProgressFn = (progress: number, total: number, message?: string) => void;

// ── Module-level singleton — shared across ALL tool calls ────────────
// One AIMD limiter per server process so every concurrent tool call shares
// the same RPS budget (a 429 from any call backs off all of them).
let adaptiveRateLimiter: AdaptiveRateLimiter | null = null;

function getAdaptiveRateLimiter(rps: number): AdaptiveRateLimiter {
  if (!adaptiveRateLimiter || adaptiveRateLimiter.rps !== rps) {
    adaptiveRateLimiter = new AdaptiveRateLimiter(rps);
  }
  return adaptiveRateLimiter;
}

// Accessors so callers outside this module can signal the shared singleton
// without reaching into its binding. No-op until the singleton is created
// (first rateLimitedParallel call) — preserves the prior `if (limiter)` guards.
export function signalRateLimitHit(): void {
  if (adaptiveRateLimiter) adaptiveRateLimiter.onRateLimit();
}

export function signalSuccess(): void {
  if (adaptiveRateLimiter) adaptiveRateLimiter.onSuccess();
}

// ── Rate-limited parallel executor ───────────────────────────────────
// Dispatches tasks respecting two independent limits:
//   1. RPS (rate): max N new tasks started per second (adaptive token bucket)
//   2. maxInFlight: max N tasks running simultaneously (safety cap)
// Workers grab the next task, wait for a rate-limit token, then execute.
// Results are returned in original order.
//
// No wall-clock deadline: Claude Code's MCP timeout is an INACTIVITY timeout
// (no progress for 1800s), not a hard deadline. As long as progress notifications
// keep flowing, the tool call can run indefinitely. A heartbeat timer sends
// progress every 30s to keep the connection alive even during slow LLM calls.

const DEFAULT_MAX_IN_FLIGHT = 200;
// Exported: chatCompletionSimple()'s per-request heartbeat in index.ts reuses
// the SAME interval (single source of truth for the MCP keep-alive cadence).
export const HEARTBEAT_INTERVAL_MS = 30_000; // 30s — well under 1800s inactivity timeout

export async function rateLimitedParallel<T>(
  tasks: (() => Promise<T>)[],
  rps: number,
  maxInFlight: number = DEFAULT_MAX_IN_FLIGHT,
  onProgress?: ProgressFn,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  const limiter = getAdaptiveRateLimiter(rps);
  let nextIndex = 0;
  let completedCount = 0;

  // Heartbeat: send progress notifications every 30s to prevent inactivity timeout
  const heartbeat = onProgress
    ? setInterval(() => {
        onProgress(completedCount, tasks.length, `Processing: ${completedCount}/${tasks.length} done (${limiter.rps} RPS)`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  try {
    async function worker() {
      while (true) {
        const i = nextIndex;
        if (i >= tasks.length) return;
        nextIndex++;
        await limiter.acquire();
        results[i] = await tasks[i]();
        completedCount++;
        // Notify on each completion too (supplements heartbeat)
        if (onProgress) {
          onProgress(completedCount, tasks.length, `Done: ${completedCount}/${tasks.length}`);
        }
      }
    }

    const workerCount = Math.min(Math.max(1, maxInFlight), tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  return results;
}
