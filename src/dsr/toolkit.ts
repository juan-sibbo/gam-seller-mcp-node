import type { AuditLedger } from "../audit/ledger.js";
import type { AuditEvent } from "../audit/event.js";
import type { RetentionService } from "../audit/retention.js";
import type { EntitlementStore } from "../policy/entitlements.js";
import type { Entitlement } from "../policy/types.js";
import type { IntentStore, Intent } from "../intent/store.js";

// DSR (Data Subject Rights) toolkit — gdpr-analysis §Q2, acts A1-A3 (05/07/26).
// Operates on the B2B data the node actually holds for a buyer_id:
// entitlement + pseudonymized ledger entries + archive segments.
//
// Rights mapping:
//   Art. 15/20 (access/portability)  → exportBuyer()
//   Art. 16 (rectification)          → onboarding record (external to the node, see docs)
//   Art. 17 (erasure)                → suppressBuyer(): crypto-shred + entitlement removal +
//                                      intent purge. Ledger entries become irreversibly
//                                      anonymous (hash-chain untouched); intents.json — the only
//                                      store holding a raw buyer_id — is purged explicitly.
//   Art. 18 (restriction)            → restrictBuyer(): suspend entitlement (DENY without delete)
//   Art. 21 (objection)              → manual weighing (Recital 49 security interest);
//                                      procedure in docs/dsr-procedure.md
//
// Response deadline: Art. 12.3 — one month. See docs/dsr-procedure.md.

export interface DsrExport {
  buyer_id: string;
  pseudonym: string;
  generated_at: string;
  entitlement: Entitlement | null;
  entitlement_suspended: boolean;
  hot_ledger_entries: AuditEvent[];
  archived_entries: AuditEvent[];
  active_intents: Intent[];
  note: string;
}

export interface DsrSuppressResult {
  buyer_id: string;
  key_shredded: boolean;
  entitlement_removed: boolean;
  anonymized_hot_entries: number;
  anonymized_archived_entries: number;
  intents_purged: number;
}

interface DsrDeps {
  store: EntitlementStore;
  ledger: AuditLedger;
  retention?: RetentionService;
  // Optional for back-compat: when present, export/erasure also reach intents.json — the only
  // store that holds a raw (non-pseudonymized) buyer_id. Absent → no intent surface to cover.
  intentStore?: IntentStore;
}

export class DsrToolkit {
  constructor(private readonly deps: DsrDeps) {}

  // Art. 15/20 — everything the node holds correlated to this buyer_id, portable JSON.
  exportBuyer(buyer_id: string): DsrExport {
    const { store, ledger, intentStore } = this.deps;
    const pseudonym = ledger.getPseudonyms().pseudonymize(buyer_id);

    return {
      buyer_id,
      pseudonym,
      generated_at: new Date().toISOString(),
      entitlement: store.get(buyer_id) ?? null,
      entitlement_suspended: store.isSuspended(buyer_id),
      hot_ledger_entries: this.matchEntries(ledger.allEntries(), pseudonym),
      archived_entries: this.matchArchived(pseudonym),
      active_intents: intentStore?.byBuyer(buyer_id) ?? [],
      note:
        "Ledger entries store a pseudonym, not the raw buyer_id. " +
        "JWT jtis appear in token_issuance/token_revocation entries. " +
        "The denylist holds jtis only and is not correlatable to a buyer by itself.",
    };
  }

  // Art. 18 — restriction: immediate DENY on all surfaces, record preserved.
  restrictBuyer(buyer_id: string): boolean {
    return this.deps.store.suspend(buyer_id);
  }

  unrestrictBuyer(buyer_id: string): boolean {
    return this.deps.store.reinstate(buyer_id);
  }

  // Art. 17 — erasure via crypto-shredding: destroy the buyer's pseudonym key and
  // remove the entitlement. All ledger entries (hot + archive) become irreversibly
  // anonymous without breaking the hash-chain. Counted BEFORE the shred, because
  // afterwards the pseudonym is no longer computable.
  suppressBuyer(buyer_id: string): DsrSuppressResult {
    const { store, ledger, intentStore } = this.deps;
    const pseudonyms = ledger.getPseudonyms();

    const hadKey = pseudonyms.hasKey(buyer_id);
    const pseudonym = hadKey ? pseudonyms.pseudonymize(buyer_id) : null;
    const hotCount = pseudonym ? this.matchEntries(ledger.allEntries(), pseudonym).length : 0;
    const archivedCount = pseudonym ? this.matchArchived(pseudonym).length : 0;

    // Order matters for crash safety: purge the raw-buyer_id surfaces (entitlement + intents)
    // to durable disk FIRST, then destroy the key. If the process dies between the two, the
    // legal record is already correct — the buyer is denied and their intents are gone on the
    // next boot — and only the key is left un-shredded (privacy-conservative). The reverse order
    // could shred the key yet leave a raw buyer_id on disk, re-granting or re-linking an erased
    // buyer after a restart. Counts are taken above, before any mutation, while the pseudonym is
    // still computable. intents.json is the only store with a RAW buyer_id, so erasure must
    // reach it explicitly — crypto-shredding the pseudonym never touches it.
    const entitlementRemoved = store.remove(buyer_id);
    const intentsPurged = intentStore?.purgeBuyer(buyer_id) ?? 0;
    const keyShredded = pseudonyms.shred(buyer_id);

    return {
      buyer_id,
      key_shredded: keyShredded,
      entitlement_removed: entitlementRemoved,
      anonymized_hot_entries: hotCount,
      anonymized_archived_entries: archivedCount,
      intents_purged: intentsPurged,
    };
  }

  private matchEntries(entries: readonly AuditEvent[], pseudonym: string): AuditEvent[] {
    return entries.filter(
      (e) => e.buyer_id === pseudonym || e.payload["buyer_id"] === pseudonym
    );
  }

  private matchArchived(pseudonym: string): AuditEvent[] {
    const { retention } = this.deps;
    if (!retention) return [];
    const matched: AuditEvent[] = [];
    for (const segment of retention.allSegments()) {
      if (segment.entries === null) continue; // purged — nothing personal remains
      matched.push(...this.matchEntries(segment.entries, pseudonym));
    }
    return matched;
  }
}
