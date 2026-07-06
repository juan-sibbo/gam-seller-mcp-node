import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { EventClass } from "./event.js";
import { hashEntry, verifyEntryHash, type AuditEvent } from "./event.js";
import { PseudonymService, createMemoryPseudonyms } from "./pseudonym.js";

// Append-only audit ledger with SHA-256 hash-chain.
// KANON P25 + E-03: hash-chain mandatory; external head-hash anchoring mandatory
// (see anchor.ts — hash-chain alone is NOT sufficient, T-LOG-03).
// Ledger MUST NOT contain secrets, tokens, credentials, SOAP faults, stack traces,
// or unminimized commercial intelligence (KANON §Logs-y-Audit).
//
// S6 hardening (acts 05/07/26):
// - buyer_id is pseudonymized (HMAC per buyer) BEFORE hashing — the chain is computed
//   over pseudonymous data only; raw buyer_id never enters the ledger (see pseudonym.ts).
// - Rotation support (retention A3): baseSeq + carryPrevHash let a contiguous prefix be
//   archived without breaking replayVerify — the first retained entry verifies against
//   the hash carried over from the last archived entry.

export class AuditLedger {
  private entries: AuditEvent[] = [];
  private readonly persistPath: string | null;
  private readonly pseudonyms: PseudonymService;
  private baseSeq = 0;
  private carryPrevHash = "";

  constructor(persistPath: string | null = null, pseudonyms?: PseudonymService) {
    this.persistPath = persistPath;
    this.pseudonyms = pseudonyms ?? createMemoryPseudonyms();
    if (persistPath) {
      this.load();
    }
  }

  append(
    event_class: EventClass,
    payload: Record<string, unknown>,
    options: { buyer_id?: string; request_id?: string } = {}
  ): AuditEvent {
    // Pseudonymize before hashing — the chain must never cover raw buyer_id.
    const safePayload = this.pseudonyms.pseudonymizePayload(payload);
    const safeBuyerId = options.buyer_id ? this.pseudonyms.pseudonymize(options.buyer_id) : undefined;

    const seq = this.baseSeq + this.entries.length;
    const prev_hash = this.entries.length === 0 ? this.carryPrevHash : this.entries[this.entries.length - 1].hash;
    const timestamp = new Date().toISOString();
    const hash = hashEntry(seq, event_class, safePayload, prev_hash, timestamp);

    const entry: AuditEvent = {
      seq,
      event_class,
      buyer_id: safeBuyerId,
      request_id: options.request_id,
      payload: safePayload,
      timestamp,
      prev_hash,
      hash,
    };

    this.entries.push(entry);
    this.save();
    return entry;
  }

  // Remove and return the contiguous prefix of entries older than beforeMs (retention
  // rotation). The hash of the last removed entry is carried over so the remaining
  // chain still verifies. Only a PREFIX can rotate — entries are chronological.
  rotateOut(beforeMs: number): AuditEvent[] {
    let count = 0;
    while (count < this.entries.length && Date.parse(this.entries[count].timestamp) < beforeMs) {
      count++;
    }
    if (count === 0) return [];

    const removed = this.entries.slice(0, count);
    this.entries = this.entries.slice(count);
    this.baseSeq += count;
    this.carryPrevHash = removed[removed.length - 1].hash;
    this.save();
    return removed;
  }

  // Pseudonym service accessor — used by the DSR toolkit to correlate/export/shred.
  getPseudonyms(): PseudonymService {
    return this.pseudonyms;
  }

  headHash(): string {
    if (this.entries.length === 0) return "";
    return this.entries[this.entries.length - 1].hash;
  }

  size(): number {
    return this.entries.length;
  }

  // Full chain replay — verifies every entry hash and prev_hash linkage.
  // Returns true only if the entire chain is internally consistent.
  // decision-package Bloque 2 §2.3: head-hash-first, then full replay.
  // After rotation, the first entry verifies against carryPrevHash (the hash of the
  // last archived entry) instead of "" — the chain of custody survives archiving.
  replayVerify(): { valid: boolean; failedAt?: number; error?: string } {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Verify this entry's hash
      if (!verifyEntryHash(entry)) {
        return { valid: false, failedAt: i, error: "hash_mismatch" };
      }

      // Verify chain linkage: prev_hash must match previous entry's hash
      const expectedPrev = i === 0 ? this.carryPrevHash : this.entries[i - 1].hash;
      if (entry.prev_hash !== expectedPrev) {
        return { valid: false, failedAt: i, error: "chain_break" };
      }
    }
    return { valid: true };
  }

  // Read-only access for anchor and restore. seq is the GLOBAL sequence number —
  // after rotation, archived seqs are no longer resolvable here (they live in the archive).
  getEntry(seq: number): AuditEvent | undefined {
    return this.entries[seq - this.baseSeq];
  }

  allEntries(): readonly AuditEvent[] {
    return this.entries;
  }

  // Highest global seq in the hot ledger (baseSeq + hot count - 1), or -1 if empty.
  headSeq(): number {
    return this.baseSeq + this.entries.length - 1;
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      this.entries = JSON.parse(raw) as AuditEvent[];
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch {
      process.stderr.write("[audit] WARNING: could not persist ledger to disk\n");
    }
  }
}

export function createMemoryLedger(pseudonyms?: PseudonymService): AuditLedger {
  return new AuditLedger(null, pseudonyms);
}

export const DEV_LEDGER_PATH = "./data/audit-ledger.json";
