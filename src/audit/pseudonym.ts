import { createHmac, randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

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

const PSEUDONYM_PREFIX = "psn_";

interface KeyStore {
  keys: Record<string, string>; // buyer_id → key hex
}

export class PseudonymService {
  private readonly keys: Map<string, string>;
  private readonly persistPath: string | null;

  constructor(persistPath: string | null = null) {
    this.keys = new Map();
    this.persistPath = persistPath;
    if (persistPath) {
      this.load();
    }
  }

  // Deterministic pseudonym for a buyer_id. Creates the buyer's key on first use.
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

  hasKey(buyer_id: string): boolean {
    return this.keys.has(buyer_id);
  }

  keyCount(): number {
    return this.keys.size;
  }

  private keyFor(buyer_id: string): string {
    const existing = this.keys.get(buyer_id);
    if (existing) return existing;
    const fresh = randomBytes(32).toString("hex");
    this.keys.set(buyer_id, fresh);
    this.save();
    return fresh;
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const store: KeyStore = JSON.parse(raw);
      for (const [buyerId, key] of Object.entries(store.keys)) {
        this.keys.set(buyerId, key);
      }
    } catch {
      // No key store yet — start fresh (keys are created lazily)
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const store: KeyStore = { keys: Object.fromEntries(this.keys) };
      writeFileSync(this.persistPath, JSON.stringify(store, null, 2), "utf-8");
    } catch {
      process.stderr.write("[pseudonym] WARNING: could not persist key store to disk\n");
    }
  }
}

export const DEV_PSEUDONYM_KEYS_PATH = "./data/pseudonym-keys.json";

export function createMemoryPseudonyms(): PseudonymService {
  return new PseudonymService(null);
}
