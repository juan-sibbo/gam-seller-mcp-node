// Request-level replay guard — SEC-GATE-3 (replay/dedupe validation).
// Prevents replaying the same request_id within a dedupe window.
// Combined with jti denylist (S2), covers both token-level and request-level replay.
//
// Each accepted request_id is tracked with its expiry. If the same request_id arrives
// again within the window → DENY (replay attack). After expiry, the slot is pruned.

interface ReplayEntry {
  request_id: string;
  expiresAt: number; // unix ms
}

export class ReplayGuard {
  private readonly seen: Map<string, number>; // request_id → expiresAt
  private readonly windowMs: number;

  // Default window: 15 min — aligns with domain-2 SLO and token TTL.
  // Any request replayed within this window is detected.
  constructor(windowMs = 15 * 60 * 1000) {
    this.seen = new Map();
    this.windowMs = windowMs;
  }

  // Returns true if this request_id is a known replay within the window.
  isReplay(request_id: string): boolean {
    const exp = this.seen.get(request_id);
    if (exp === undefined) return false;
    if (Date.now() >= exp) {
      this.seen.delete(request_id);
      return false;
    }
    return true;
  }

  // Record a new request_id as seen. Must be called after isReplay returns false.
  record(request_id: string): void {
    this.seen.set(request_id, Date.now() + this.windowMs);
  }

  // Prune expired entries.
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, exp] of this.seen) {
      if (now >= exp) {
        this.seen.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.seen.size;
  }

  getWindowMs(): number {
    return this.windowMs;
  }
}
