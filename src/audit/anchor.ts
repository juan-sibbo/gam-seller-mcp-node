import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import { DurabilityHealth } from "../durability.js";

// External head-hash anchoring — decision-package Bloque 2 §2.1 + §2.2.
// Ratified: cloud-immutable (Object Lock) destination; 60-min batch; head-hash-first verify.
//
// In dev: head hashes are written to a local file in append-only mode.
// This simulates Object Lock immutability: the file is only appended (never overwritten).
// Production: replace with cloud-immutable write (S3 Object Lock, GCS Bucket Lock, etc.)
//
// T-LOG-03: hash-chain alone is NOT tamper-evident without external anchoring.
// An adversary with write access to the ledger can recompute an internally-consistent chain.
// The externally anchored head hash provides the tamper-evident guarantee.

export interface AnchorRecord {
  seq: number;           // highest ledger seq anchored
  head_hash: string;
  timestamp: string;     // ISO 8601
}

export class HeadHashAnchor {
  private records: AnchorRecord[] = [];
  private readonly persistPath: string | null;
  private readonly durability = new DurabilityHealth("anchor", "anchor");

  constructor(persistPath: string | null = null) {
    this.persistPath = persistPath;
    if (persistPath) {
      this.load();
    }
  }

  // Anchor the current head hash. Append-only — never deletes or overwrites.
  anchor(headHash: string, highestSeq: number): AnchorRecord {
    const record: AnchorRecord = {
      seq: highestSeq,
      head_hash: headHash,
      timestamp: new Date().toISOString(),
    };
    this.records.push(record);
    this.save();
    return record;
  }

  // Returns the most recently anchored record, or undefined if none.
  latest(): AnchorRecord | undefined {
    return this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
  }

  all(): readonly AnchorRecord[] {
    return this.records;
  }

  count(): number {
    return this.records.length;
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      this.records = JSON.parse(raw) as AnchorRecord[];
    } catch {
      this.records = [];
    }
  }

  // True while every disk write has succeeded; false once a persist has failed (see save()).
  // In-memory anchors (no persistPath) are always healthy. Aggregated at /health (issue #51).
  isPersistenceHealthy(): boolean {
    return this.durability.isHealthy();
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // Append semantics: load existing + push new record + overwrite.
      // Production: use cloud-immutable write instead (never overwrite).
      writeFileSync(this.persistPath, JSON.stringify(this.records, null, 2), "utf-8");
      this.durability.markHealthy();
    } catch (err) {
      // Do NOT swallow: a lost anchor write means the external tamper-evidence for the
      // ledger head is not persisted — surface it (health flag + ERROR), never a WARNING.
      this.durability.markDegraded(err);
    }
  }
}

// Restore verification — decision-package Bloque 2 §2.3.
// Step 1 (head-hash-first): compare latest anchored hash against ledger head hash.
//   If mismatch: chain is suspect, do not proceed.
// Step 2 (full replay): verify every entry's hash and chain linkage.
//   If any entry fails: chain is tampered.
export interface RestoreVerifyResult {
  valid: boolean;
  headHashMatch: boolean;
  replayResult?: { valid: boolean; failedAt?: number; error?: string };
  error?: string;
}

export function verifyAfterRestore(
  ledgerHeadHash: string,
  replayVerify: () => { valid: boolean; failedAt?: number; error?: string },
  anchor: HeadHashAnchor
): RestoreVerifyResult {
  const latestAnchor = anchor.latest();

  if (!latestAnchor) {
    // No anchor exists yet — empty ledger or first run.
    // Only valid if the ledger is also empty.
    const headHashMatch = ledgerHeadHash === "";
    return { valid: headHashMatch, headHashMatch, error: headHashMatch ? undefined : "no_anchor_but_non_empty_ledger" };
  }

  // Step 1: head-hash-first check
  const headHashMatch = latestAnchor.head_hash === ledgerHeadHash;
  if (!headHashMatch) {
    return { valid: false, headHashMatch, error: "head_hash_mismatch" };
  }

  // Step 2: full replay
  const replayResult = replayVerify();
  return {
    valid: replayResult.valid,
    headHashMatch,
    replayResult,
    error: replayResult.valid ? undefined : `replay_failed_at_seq_${replayResult.failedAt}`,
  };
}

export function createMemoryAnchor(): HeadHashAnchor {
  return new HeadHashAnchor(null);
}

export const DEV_ANCHOR_PATH = dataPath("anchor-records.json");

// Anchoring interval in milliseconds — ratified as 60 min (decision-package §2.2).
export const ANCHOR_INTERVAL_MS = 60 * 60 * 1000;
