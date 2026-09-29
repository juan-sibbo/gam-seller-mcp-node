import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { dirname } from "path";
import { dataPath } from "./config/paths.js";

// Single state owner (owner lease). Every file-backed store (ledger, anchor, denylist, pseudonym
// keys, intents, DSR overlay) loads its file once and then rewrites it from memory. Two processes
// holding the same stores — the running server and an operator CLI (issue/revoke token, DSR) —
// therefore silently lose each other's writes: a CLI's token issuance is overwritten and the next
// boot fails `head_hash_mismatch`, a revocation or an Art. 18 restriction is never seen by the
// server, and an Art. 17 erasure is undone by the server's next save. See
// tests/state-ownership-hazard.test.ts. The fix is structural: exactly one process owns the
// state directory at a time, and everyone else is refused (fail-closed).
//
// The lease is a file in DATA_DIR created with O_EXCL and kept alive by a heartbeat. A heartbeat
// (not a pid check) is used because the owner and the contender may live in different
// containers sharing only the volume, where a pid means nothing. A holder that dies without
// releasing (SIGKILL, host crash) leaves a lease whose heartbeat stops; after LEASE_STALE_MS it
// can be taken over, so a crashed node restarts without manual cleanup.

export const OWNER_LEASE_FILE = ".owner.lease";
export const LEASE_HEARTBEAT_MS = 5_000;
// Three missed heartbeats plus slack: long enough that a busy event loop never loses the lease,
// short enough that a crashed node is restartable within seconds.
export const LEASE_STALE_MS = 20_000;

export type LeaseHolderKind = "server" | "cli";

// Leases held by live OwnerLease instances in THIS process. A lease carrying this process's pid
// and host but a holder_id not in this set was written by a previous process that had the same
// pid — a container restarted after a crash (the node is pid 1 again, same hostname). That
// holder is provably dead, so the lease is taken over at once instead of after LEASE_STALE_MS.
const liveHolders = new Set<string>();

export interface LeaseRecord {
  holder_id: string;
  kind: LeaseHolderKind;
  pid: number;
  host: string;
  acquired_at: string;
  heartbeat_at: string;
}

export interface OwnerLeaseOptions {
  path?: string;
  now?: () => number;
  staleMs?: number;
}

export class OwnerLeaseHeldError extends Error {
  constructor(
    readonly holder: LeaseRecord,
    readonly heartbeatAgeMs: number
  ) {
    super(
      `state directory is owned by another process (${holder.kind} pid ${holder.pid} on ${holder.host}, ` +
        `last heartbeat ${Math.round(heartbeatAgeMs / 1000)}s ago). ` +
        (holder.kind === "server"
          ? "Stop the node before running operator commands (e.g. `docker compose stop`), then retry."
          : "Another operator command is running; retry when it finishes.") +
        ` A holder that crashed is taken over automatically after ${LEASE_STALE_MS / 1000}s without a heartbeat.`
    );
    this.name = "OwnerLeaseHeldError";
  }
}

function isDeadPredecessor(lease: LeaseRecord): boolean {
  return lease.pid === process.pid && lease.host === hostname() && !liveHolders.has(lease.holder_id);
}

export class OwnerLease {
  private readonly path: string;
  private readonly now: () => number;
  private readonly staleMs: number;
  private record: LeaseRecord | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: OwnerLeaseOptions = {}) {
    this.path = options.path ?? dataPath(OWNER_LEASE_FILE);
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? LEASE_STALE_MS;
  }

  // Take ownership or throw OwnerLeaseHeldError. A stale lease (holder stopped heartbeating, or a
  // dead predecessor with our own pid — see liveHolders) is removed and replaced; the O_EXCL create is the single arbitration point, so of two
  // contenders racing for a stale lease exactly one wins.
  acquire(kind: LeaseHolderKind): LeaseRecord {
    mkdirSync(dirname(this.path), { recursive: true });
    const nowIso = new Date(this.now()).toISOString();
    const record: LeaseRecord = {
      holder_id: randomUUID(),
      kind,
      pid: process.pid,
      host: hostname(),
      acquired_at: nowIso,
      heartbeat_at: nowIso,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.path, JSON.stringify(record), { flag: "wx" });
        this.record = record;
        liveHolders.add(record.holder_id);
        return record;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const current = this.read();
      if (current === null) continue; // released between our create and read — retry
      const age = this.now() - Date.parse(current.heartbeat_at);
      if (!(age > this.staleMs) && !isDeadPredecessor(current)) throw new OwnerLeaseHeldError(current, age);
      this.removeStale(current);
    }
    const holder = this.read();
    if (holder) throw new OwnerLeaseHeldError(holder, this.now() - Date.parse(holder.heartbeat_at));
    throw new Error(`[lease] could not acquire ${this.path}`);
  }

  // Refresh the heartbeat. Returns false if the lease is no longer ours (removed or replaced by a
  // takeover) — the caller must stop writing state immediately.
  renew(): boolean {
    if (!this.record) return false;
    const current = this.read();
    if (!current || current.holder_id !== this.record.holder_id) return false;
    const renewed = { ...this.record, heartbeat_at: new Date(this.now()).toISOString() };
    const tmp = `${this.path}.${this.record.holder_id}.tmp`;
    writeFileSync(tmp, JSON.stringify(renewed));
    renameSync(tmp, this.path);
    this.record = renewed;
    return true;
  }

  // Renew on a timer; onLost fires (once) if ownership is gone. unref'd: the heartbeat alone must
  // never keep a finished process alive.
  startHeartbeat(onLost: () => void, intervalMs: number = LEASE_HEARTBEAT_MS): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      let owned = false;
      try {
        owned = this.renew();
      } catch (err) {
        process.stderr.write(`[lease] heartbeat write failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return; // transient disk error: keep trying until the lease goes stale
      }
      if (!owned) {
        this.stopHeartbeat();
        onLost();
      }
    }, intervalMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Remove the lease only if it is still ours — never delete another holder's lease.
  release(): void {
    this.stopHeartbeat();
    if (!this.record) return;
    liveHolders.delete(this.record.holder_id);
    const current = this.read();
    if (current && current.holder_id === this.record.holder_id) {
      try {
        unlinkSync(this.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    this.record = null;
  }

  holds(): boolean {
    return this.record !== null;
  }

  private read(): LeaseRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as LeaseRecord;
    } catch {
      // A torn/corrupt lease cannot prove a live owner: treat it as stale so a restart recovers.
      return { holder_id: "corrupt", kind: "server", pid: 0, host: "unknown", acquired_at: "", heartbeat_at: new Date(0).toISOString() };
    }
  }

  // Remove a stale lease so the O_EXCL create can arbitrate. Re-check right before the unlink
  // that the file still holds the record judged stale, so a lease freshly taken by a concurrent
  // contender is not removed (the remaining window is a few microseconds between read and unlink).
  private removeStale(stale: LeaseRecord): void {
    const current = this.read();
    if (!current || current.holder_id !== stale.holder_id || current.heartbeat_at !== stale.heartbeat_at) return;
    try {
      unlinkSync(this.path);
      process.stderr.write(
        `[lease] took over a stale lease (${stale.kind} pid ${stale.pid} on ${stale.host}, last heartbeat ${stale.heartbeat_at}).\n`
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

// Run an operator command as the state owner: acquire, run, always release. Throws
// OwnerLeaseHeldError (before touching any store) if the node or another command owns the state.
export async function withOwnerLease<T>(fn: () => T | Promise<T>, options: OwnerLeaseOptions = {}): Promise<T> {
  const lease = new OwnerLease(options);
  lease.acquire("cli");
  lease.startHeartbeat(() => {
    process.stderr.write("[lease] FATAL: lost ownership of the state directory mid-command — aborting.\n");
    process.exit(1);
  });
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

export const EXIT_STATE_OWNED = 3;

// CLI entry helper: run `action` as the state owner and map a refusal to EXIT_STATE_OWNED with an
// actionable message. Shared by every operator bin so they refuse identically.
export async function runAsStateOwner(
  action: () => number | Promise<number>,
  err: (line: string) => void = (line) => void process.stderr.write(line)
): Promise<number> {
  try {
    return await withOwnerLease(action);
  } catch (e) {
    if (e instanceof OwnerLeaseHeldError) {
      err(`[admin] REFUSED — ${e.message}\n`);
      return EXIT_STATE_OWNED;
    }
    throw e;
  }
}
