// Rate limiter per buyer_id — blocker-resolution-#6-values-signoff.md §4 (RATIFIED)
// N=1 request / T=30s per buyer_id. In-memory for dev context (same pattern as denylist).
// soap-fault-redaction-signoff §2: RATE_LIMITED response must NOT reveal the exact quota.

export const RATE_LIMIT_WINDOW_MS = 30_000; // 30 seconds (RATIFIED)

export class RateLimiter {
  // buyer_id → unix ms of the last allowed request
  private readonly lastAllowed: Map<string, number>;
  private readonly windowMs: number;

  constructor(windowMs = RATE_LIMIT_WINDOW_MS) {
    this.lastAllowed = new Map();
    this.windowMs = windowMs;
  }

  // Returns true if the request is within quota and records the timestamp.
  // Returns false if the buyer is within the rate-limit window.
  check(buyer_id: string): boolean {
    const now = Date.now();
    const last = this.lastAllowed.get(buyer_id);
    if (last !== undefined && now - last < this.windowMs) {
      return false;
    }
    this.lastAllowed.set(buyer_id, now);
    return true;
  }

  reset(): void {
    this.lastAllowed.clear();
  }

  size(): number {
    return this.lastAllowed.size;
  }
}
