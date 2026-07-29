import { createHmac, randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";

// Buyer pseudonymization for the audit ledger — gdpr-analysis §Q1.2 + acts A1 (05/07/26).
//
// Raw buyer_id never enters the ledger: every entry stores HMAC-SHA256(k_buyer, buyer_id)
// instead. One key PER BUYER, stored outside the ledger. Consequences:
//
// - The ledger is pseudonymous by construction (GDPR Art. 4(5)) — even if a buyer_id
//   were ever ruled personal data, the ledger itself already carries none in clear.
// - Same buyer → same pseudonym: internal correlation for audit/security is preserved
//   (Recital 49 legitimate interest intact).
// - CRYPTO-SHREDDING: destroying one buyer's key makes ALL its ledger entries
//   irreversibly anonymous WITHOUT touching the hash-chain — this resolves the
//   structural tension between Art. 17 (erasure) and an append-only immutable ledger.
//   After a shred, a re-appearing buyer_id gets a FRESH key, so new entries are
//   unlinkable to pre-shred history.
//
// The key store is a local gitignored file in dev (same pattern as denylist).
//
// RETENTION BY INACTIVITY (A3-aligned crypto-shred): the keystore is the ONLY place
// where the clear buyer_id survives, so it must obey the same storage-limitation
// principle as the ledger (GDPR Art. 5(1)(e)). Each key carries a `last_used_at`
// timestamp; `shredInactive()` destroys keys unused for the ledger retention horizon
// (past that point no recoverable ledger entry references the buyer, so the key is
// dead weight and the last clear buyer_id on disk). See src/audit/retention.ts.

const PSEUDONYM_PREFIX = "psn_";

// Per-buyer key record. `last_used_at` drives inactivity-based crypto-shredding;
// `created_at` is kept for audit/forensics only (never used to expire).
interface KeyRecord {
  key: string; // key hex
  created_at: number; // epoch ms — first use
  last_used_at: number; // epoch ms — most recent pseudonymize()/keyFor()
}

// Current on-disk schema. `load()` also accepts the LEGACY flat schema
// (buyer_id → hex string) and migrates it — see load().
interface KeyStore {
  version: 2;
  keys: Record<string, KeyRecord>; // buyer_id → record
}

export class PseudonymService {
  private readonly keys: Map<string, KeyRecord>;
  private readonly persistPath: string | null;

  constructor(persistPath: string | null = null) {
    this.keys = new Map();
    this.persistPath = persistPath;
    if (persistPath) {
      this.load();
    }
  }

  // Deterministic pseudonym for a buyer_id. Creates the buyer's key on first use.
  // Touches last_used_at IN MEMORY on every call (keyFor does this); persistence is
  // LAZY — we do not write to disk on every pseudonymize (that would amplify writes on
  // the hot append path). last_used_at is flushed on key creation, shred, and sweep.
  pseudonymize(buyer_id: string): string {
    const key = this.keyFor(buyer_id);
    const mac = createHmac("sha256", Buffer.from(key, "hex")).update(buyer_id, "utf8").digest("hex");
    return PSEUDONYM_PREFIX + mac;
  }

  // Returns a NEW payload object with any string `buyer_id` key pseudonymized.
  // Never mutates the input (immutability rule). Applied BEFORE hashing so the
  // chain is computed over pseudonymous data only.
  pseudonymizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const raw = payload["buyer_id"];
    if (typeof raw !== "string" || raw === "" || raw.startsWith(PSEUDONYM_PREFIX)) {
      return { ...payload };
    }
    return { ...payload, buyer_id: this.pseudonymize(raw) };
  }

  // Crypto-shred: destroy the buyer's key. Their ledger entries become irreversibly
  // anonymous; the hash-chain is untouched. Returns false if no key existed.
  shred(buyer_id: string): boolean {
    const existed = this.keys.delete(buyer_id);
    if (existed) this.save();
    return existed;
  }

  // Retention by inactivity (A3-aligned automatic crypto-shred). Destroy every key
  // whose last_used_at is strictly older than `cutoffMs`. Same semantics as shred():
  // the deleted buyers' ledger entries become irreversibly anonymous, the hash-chain
  // is untouched, and a re-appearing buyer gets a FRESH (unlinkable) key. Persists once
  // if anything was deleted. Returns the number of keys shredded.
  //
  // NOTE (governance): this automatic caducity is NOT logged in the ledger — doing so
  // would touch the RATIFIED event taxonomy (F3), which is out of scope here. If a
  // trace of the automatic shred is later deemed necessary, that is an owner decision.
  shredInactive(cutoffMs: number): number {
    let shredded = 0;
    for (const [buyerId, record] of this.keys) {
      if (record.last_used_at < cutoffMs) {
        this.keys.delete(buyerId);
        shredded++;
      }
    }
    if (shredded > 0) this.save();
    return shredded;
  }

  hasKey(buyer_id: string): boolean {
    return this.keys.has(buyer_id);
  }

  keyCount(): number {
    return this.keys.size;
  }

  private keyFor(buyer_id: string): string {
    const now = Date.now();
    const existing = this.keys.get(buyer_id);
    if (existing) {
      // Refresh inactivity clock in memory (lazy persistence — see pseudonymize()).
      existing.last_used_at = now;
      return existing.key;
    }
    const fresh = randomBytes(32).toString("hex");
    this.keys.set(buyer_id, { key: fresh, created_at: now, last_used_at: now });
    this.save();
    return fresh;
  }

  // Loads the keystore. Accepts BOTH the current v2 schema and the LEGACY flat schema
  // (buyer_id → hex string). On legacy migration, last_used_at/created_at are set to
  // NOW — never epoch 0 — so the first retention cycle does not immediately shred every
  // pre-existing key and destroy legitimate audit linkability (decision §2).
  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: number; keys: Record<string, unknown> };
      const now = Date.now();
      for (const [buyerId, value] of Object.entries(parsed.keys)) {
        if (typeof value === "string") {
          // Legacy schema: bare hex. Start the inactivity clock fresh at load time.
          this.keys.set(buyerId, { key: value, created_at: now, last_used_at: now });
        } else {
          const record = value as KeyRecord;
          this.keys.set(buyerId, {
            key: record.key,
            created_at: record.created_at ?? now,
            last_used_at: record.last_used_at ?? now,
          });
        }
      }
    } catch {
      // No key store yet — start fresh (keys are created lazily)
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const store: KeyStore = { version: 2, keys: Object.fromEntries(this.keys) };
      writeFileSync(this.persistPath, JSON.stringify(store, null, 2), "utf-8");
    } catch {
      process.stderr.write("[pseudonym] WARNING: could not persist key store to disk\n");
    }
  }
}

export const DEV_PSEUDONYM_KEYS_PATH = dataPath("pseudonym-keys.json");

export function createMemoryPseudonyms(): PseudonymService {
  return new PseudonymService(null);
}
