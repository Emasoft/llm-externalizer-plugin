// Adaptive rate limiter (AIMD) — extracted from index.ts (B1 Phase 2,
// TRDD-63314265). Self-contained: depends only on Date/setTimeout/Math/stderr,
// so it imports without index.ts's main()-on-import side effect. index.ts owns
// the module-level singleton + the getAdaptiveRateLimiter() factory; this module
// owns only the class.
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
