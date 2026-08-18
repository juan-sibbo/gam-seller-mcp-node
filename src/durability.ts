// Shared durability-health signal for the file-backed stores (v0.6 hardening E1, extended
// per issue #51). A failed disk write means the store's latest mutation lives only in memory
// and is lost on restart — a silent integrity loss. save() used to swallow this as a benign
// WARNING; each store now delegates to this helper so the degradation is OBSERVABLE (aggregated
// at /health and logged at ERROR severity with the cause) instead of hidden.
//
// The AuditLedger keeps its own inlined flag rather than this helper: it predates #51 and lives
// in the tamper-evident core, so it stays untouched here. The two share the same contract
// (isHealthy()) so /health can aggregate them uniformly.

export class DurabilityHealth {
  private healthy = true;

  // `subsystem` tags the log line (e.g. "intent"); `what` names the artifact persisted
  // (e.g. "intent store") so the ERROR message reads naturally.
  constructor(
    private readonly subsystem: string,
    private readonly what: string
  ) {}

  // Call after a successful persist. A store can recover once the disk is writable again,
  // so a later success clears an earlier failure — matching the ledger's per-save flag.
  markHealthy(): void {
    this.healthy = true;
  }

  // Call from a save() catch block. Records the failure and emits it at ERROR severity with
  // the cause. Never throws: the store still serves in-memory this run; we surface, not crash.
  markDegraded(err: unknown): void {
    this.healthy = false;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[${this.subsystem}] ERROR: could not persist ${this.what} to disk — durability DEGRADED (${reason})\n`
    );
  }

  // True while every disk write has succeeded; false once a persist has failed. Stores with no
  // persistPath never write, so they stay healthy (nothing to fail) — same as an in-memory ledger.
  isHealthy(): boolean {
    return this.healthy;
  }
}
