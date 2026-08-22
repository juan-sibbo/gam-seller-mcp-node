import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import { DurabilityHealth } from "../durability.js";

// Durable denylist for JWT jti revocation — domain2-identity-signoff §4b + §6.
// Domain-2 revocation SLO ≤ 15 min: denylist must propagate within that window.
// Durability: entries survive process restart (file-backed in dev; S3 migrates to SQLite audit DB).
//
// Denylist PREVAILS over a valid token — adapter-boundary-signoff §4 (hard rule #1).

interface DenylistEntry {
  jti: string;
  expiresAt: number; // unix ms — prune after this point
}

interface DenylistStore {
  entries: DenylistEntry[];
}

export class Denylist {
  // In-memory index: jti → expiresAt (unix ms)
  private readonly mem: Map<string, number>;
  private readonly persistPath: string | null;
  private readonly durability = new DurabilityHealth("denylist", "denylist");

  constructor(persistPath: string | null = null) {
    this.mem = new Map();
    this.persistPath = persistPath;

    if (persistPath) {
      this.load();
    }
  }

  add(jti: string, tokenExpiresAt: number): void {
    // Keep entry until token would have naturally expired (no point keeping longer)
    this.mem.set(jti, tokenExpiresAt);
    this.save();
  }

  has(jti: string): boolean {
    const exp = this.mem.get(jti);
    if (exp === undefined) return false;
    // Entry still valid (token not naturally expired yet)
    if (Date.now() < exp) return true;
    // Natural expiry passed — clean up lazily
    this.mem.delete(jti);
    return false;
  }

  // Remove entries whose tokens have naturally expired (they can no longer be presented)
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [jti, exp] of this.mem) {
      if (now >= exp) {
        this.mem.delete(jti);
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  size(): number {
    return this.mem.size;
  }

  private load(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, "utf-8");
    } catch {
      return; // File doesn't exist yet — fresh start is legitimate
    }
    // A corrupt denylist MUST NOT fail open: silently starting empty would make
    // every revoked token valid again ("denylist prevails" — adapter-boundary §4).
    // Fail-closed: refuse to start until the operator inspects/removes the file.
    let store: DenylistStore;
    try {
      store = JSON.parse(raw);
      if (!Array.isArray(store.entries)) throw new Error("missing entries array");
    } catch (err) {
      throw new Error(
        `[denylist] Corrupt denylist file at ${this.persistPath} — refusing to start with an empty denylist (fail-closed). Inspect or remove the file. Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const now = Date.now();
    for (const e of store.entries) {
      // Only load non-expired entries
      if (e.expiresAt > now) {
        this.mem.set(e.jti, e.expiresAt);
      }
    }
  }

  // True while every disk write has succeeded; false once a persist has failed (see save()).
  // In-memory denylists (no persistPath) are always healthy. Aggregated at /health (issue #51).
  isPersistenceHealthy(): boolean {
    return this.durability.isHealthy();
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const store: DenylistStore = {
        entries: Array.from(this.mem.entries()).map(([jti, expiresAt]) => ({ jti, expiresAt })),
      };
      writeFileSync(this.persistPath, JSON.stringify(store, null, 2), "utf-8");
      this.durability.markHealthy();
    } catch (err) {
      // Do NOT swallow: a lost denylist write means a revoked jti silently un-revokes on
      // restart (a token PREVAILS again) — a security regression, not a benign WARNING.
      this.durability.markDegraded(err);
    }
  }
}

// Default paths for dev — gitignored directories
export const DEV_DENYLIST_PATH = dataPath("denylist.json");

// In-memory-only denylist (for tests — no disk I/O)
export function createMemoryDenylist(): Denylist {
  return new Denylist(null);
}
