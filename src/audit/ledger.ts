import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
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
  // Durability health (v0.6 hardening E1). A failed disk write means an appended entry
  // lives only in memory and is lost on restart — a silent integrity loss for a
  // tamper-evident ledger. save() used to swallow that as a benign WARNING; now it flips
  // this flag so the degradation is observable (e.g. by a health probe) instead of hidden.
  private persistenceHealthy = true;

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

  // True while every disk write has succeeded; false once a persist has failed (see save()).
  // In-memory ledgers (no persistPath) are always healthy — there is nothing to fail.
  isPersistenceHealthy(): boolean {
    return this.persistenceHealthy;
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
    } catch (err) {
      // ENOENT on first run → initialize empty chain (normal path, not an error).
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = [];
        return;
      }
      // Any other failure (corrupt JSON, permission error, EISDIR, …) → fail-closed.
      // Silently resetting to an empty chain would present fabricated history as valid
      // and discard audit records — worse than refusing to start. Same pattern as
      // IntentStore, Denylist, DsrState (hardening E, v0.6).
      throw new Error(
        `[audit] FATAL: ledger at ${this.persistPath} could not be loaded — ` +
        `refusing to start with an empty chain. Investigate or remove the file to start fresh. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    // Atomic write: write to .tmp then rename over the target.
    // On POSIX, rename(2) is atomic at the FS level — a crash mid-write leaves
    // either the old file or the new file intact, never a partial file.
    const tmpPath = `${this.persistPath}.tmp`;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), "utf-8");
      renameSync(tmpPath, this.persistPath);
      this.persistenceHealthy = true;
    } catch (err) {
      // Do NOT swallow: a lost audit write is an integrity event, not a benign warning.
      // Flip the health flag (observable) and emit at ERROR severity with the cause.
      this.persistenceHealthy = false;
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[audit] ERROR: could not persist ledger to disk — durability DEGRADED (${reason})\n`);
    }
  }
}

export function createMemoryLedger(pseudonyms?: PseudonymService): AuditLedger {
  return new AuditLedger(null, pseudonyms);
}

export const DEV_LEDGER_PATH = dataPath("audit-ledger.json");
