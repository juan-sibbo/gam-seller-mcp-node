import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";

// File-backed store of buyer commitments — v0.5 Bloque B (plan-core-v04 §3).
// An Intent records that an AUTHENTICATED buyer expressed firm intent over a product
// at its current firm price, with a TTL. It is NOT a GAM order nor a real inventory
// hold (SOFT_LOCK_* is deferred to Tier 2) — it is the A′-compatible handoff artifact
// the classic rails pick up.
//
// Per-buyer boundary (hard rule): an intent is write-your-own + read-your-own state.
// get() is buyer-scoped, so a buyer can never read or affect another buyer's intent —
// this is the store-level enforcement of the cross_buyer_state denylist (policy/types.ts).

export type IntentStatus = "active" | "expired" | "revoked";

export interface Intent {
  intent_id: string;
  buyer_id: string;
  family_id: string;
  period: string;
  firm_price: number;
  currency: string;
  status: IntentStatus;
  created_at: string; // ISO 8601
  expires_at: string; // ISO 8601
}

export interface CreateIntentInput {
  buyer_id: string;
  family_id: string;
  period: string;
  firm_price: number;
  currency: string;
  // ISO 8601 instant the underlying firm price goes stale. The intent must NOT outlive
  // the offer it pins, so expires_at is capped at this instant (fail-closed on staleness).
  price_valid_until: string;
  now?: Date; // injectable for testing
}

// Default commitment lifetime — aligns with the replay window and buyer token TTL.
// The effective expiry is min(now + this, price_valid_until): an intent can never
// outlive the firm price it commits to.
export const DEFAULT_INTENT_TTL_MS = 15 * 60 * 1000;

// On-disk shape. Only live (active) intents are ever held in memory — revoke/expiry evict —
// so the persisted set is exactly the active set, and a reload restores every revocable
// commitment. Terminal events already live in the ledger (the record of record).
interface IntentStoreFile {
  intents: Intent[];
}

export class IntentStore {
  private readonly byId = new Map<string, Intent>();
  private readonly ttlMs: number;
  private readonly persistPath: string | null;

  // persistPath: when set, active intents are file-backed and survive a restart (issue #50 —
  // a v0.7 revoke_intent handle is only durable if the state behind it is). null → in-memory
  // only (tests / dev without a data dir), same opt-in shape as the denylist.
  constructor(ttlMs: number = DEFAULT_INTENT_TTL_MS, persistPath: string | null = null) {
    this.ttlMs = ttlMs;
    this.persistPath = persistPath;
    if (persistPath) {
      this.load();
    }
  }

  create(input: CreateIntentInput): Intent {
    const now = input.now ?? new Date();
    // Cap the TTL at the firm price's own validity — never commit past a stale offer.
    const ttlExpiry = now.getTime() + this.ttlMs;
    const priceExpiry = Date.parse(input.price_valid_until);
    const expiresAt = new Date(Math.min(ttlExpiry, priceExpiry));

    const intent: Intent = {
      intent_id: randomUUID(),
      buyer_id: input.buyer_id,
      family_id: input.family_id,
      period: input.period,
      firm_price: input.firm_price,
      currency: input.currency,
      status: "active",
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    this.byId.set(intent.intent_id, intent);
    this.save();
    return intent;
  }

  // Buyer-scoped read. Returns the intent ONLY if it belongs to the asking buyer —
  // a cross-buyer read resolves to undefined (never leak another buyer's state).
  get(intent_id: string, buyer_id: string): Intent | undefined {
    const intent = this.byId.get(intent_id);
    if (!intent || intent.buyer_id !== buyer_id) return undefined;
    return intent;
  }

  // Revoke a buyer's own active, non-expired intent (v0.6+ lifecycle). Returns the revoked
  // intent (status "revoked") so the caller can emit INTENT_REVOKED, or undefined if it is
  // absent, owned by another buyer (cross-buyer denied), already terminal, or past its TTL.
  // The intent is evicted — the ledger event is the record of record (no read surface yet).
  revoke(intent_id: string, buyer_id: string, now: Date = new Date()): Intent | undefined {
    const intent = this.byId.get(intent_id);
    if (!intent || intent.buyer_id !== buyer_id) return undefined; // absent or cross-buyer
    if (intent.status !== "active" || Date.parse(intent.expires_at) <= now.getTime()) {
      return undefined; // already terminal, or lapsed (a sweep will emit its expiry)
    }
    this.byId.delete(intent_id);
    this.save();
    return { ...intent, status: "revoked" };
  }

  // Age out intents whose TTL has passed: evict each active intent past its expiry and return
  // it with status "expired" so the caller can emit INTENT_EXPIRED. Idempotent — an intent is
  // only returned the first time it lapses (it is removed), so the event fires exactly once.
  sweepExpired(now: Date = new Date()): Intent[] {
    const expired: Intent[] = [];
    for (const [id, intent] of this.byId) {
      if (intent.status === "active" && Date.parse(intent.expires_at) <= now.getTime()) {
        expired.push({ ...intent, status: "expired" });
        this.byId.delete(id);
      }
    }
    if (expired.length > 0) this.save();
    return expired;
  }

  // Count of live (non-terminal) intents held. Terminal ones are evicted on revoke/expiry.
  size(): number {
    return this.byId.size;
  }

  // Restore active intents from disk. Intents that lapsed while the node was down are loaded
  // AS-IS (still "active") so the boot expiry sweep emits their INTENT_EXPIRED — the ledger
  // must not end with a dangling INTENT_CREATED and no terminal event (issue #50).
  private load(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, "utf-8");
    } catch {
      return; // No file yet — a fresh start is legitimate (first boot).
    }
    // A corrupt overlay MUST NOT fail open: silently starting empty would drop every live
    // commitment (a buyer's revoke_intent would fail on a valid handle, and the TTL sweep
    // would never emit INTENT_EXPIRED). Fail-closed: refuse to start until an operator
    // inspects/removes the file — same rule as the denylist/DSR overlay.
    let file: IntentStoreFile;
    try {
      file = JSON.parse(raw);
      if (!Array.isArray(file.intents)) throw new Error("missing intents array");
    } catch (err) {
      throw new Error(
        `[intent] Corrupt intent store at ${this.persistPath} — refusing to start with an empty store (fail-closed). Inspect or remove the file. Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    for (const intent of file.intents) {
      if (intent.status === "active") this.byId.set(intent.intent_id, intent);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const file: IntentStoreFile = { intents: Array.from(this.byId.values()) };
      writeFileSync(this.persistPath, JSON.stringify(file, null, 2), "utf-8");
    } catch {
      // Non-fatal: the store still works in-memory this run — same degradation as the denylist.
      process.stderr.write("[intent] WARNING: could not persist intent store to disk\n");
    }
  }
}

// Default path for dev — gitignored data/ directory (via MCP_DATA_DIR).
export const DEV_INTENT_PATH = dataPath("intents.json");

// In-memory-only store (for tests — no disk I/O).
export function createMemoryIntentStore(ttlMs: number = DEFAULT_INTENT_TTL_MS): IntentStore {
  return new IntentStore(ttlMs, null);
}
