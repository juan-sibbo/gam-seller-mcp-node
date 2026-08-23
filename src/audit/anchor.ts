import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import { DurabilityHealth } from "../durability.js";

// External head-hash anchoring — decision-package Bloque 2 §2.1 + §2.2.
// Ratified: cloud-immutable (Object Lock) destination; 60-min batch; head-hash-first verify.
//
// T-LOG-03: hash-chain alone is NOT tamper-evident without external anchoring. An adversary
// with write access to the ledger can recompute an internally-consistent chain; the externally
// anchored head hash is what exposes that. For the anchor to hold against the OPERATOR (T-1,
// issue #85) — not merely a third party — two properties matter:
//   1. It is APPEND-ONLY: a record, once written, is never rewritten or deleted. The default
//      sink writes one JSONL line per record (never re-serializing the file), so the code has
//      no path that rewrites anchor history — unlike the previous whole-file overwrite, which
//      contradicted this module's own "append-only" claim.
//   2. In production it lives in a WRITE-ONCE destination the operator cannot rewrite (S3 Object
//      Lock, GCS Bucket Lock, a notary/timestamping service). That destination is what actually
//      closes T-1; a local append-only file is the dev simulation and the WORM-ready precondition,
//      NOT itself tamper-proof against someone with disk access. The AnchorSink seam below makes
//      wiring a real WORM store an operator config act, not a code change.

export interface AnchorRecord {
  seq: number;           // highest ledger seq anchored
  head_hash: string;
  timestamp: string;     // ISO 8601
}

// The persistence destination for anchor records. Implementations MUST be append-only: append()
// may never rewrite or delete a previously-appended record. The default (AppendOnlyFileAnchorSink)
// writes a local JSONL file; a production deployment injects a sink that writes to a cloud WORM
// store — that external immutability is what makes the anchor tamper-evident against the operator.
export interface AnchorSink {
  // Record an anchor synchronously and durably. MUST be append-only and MUST NOT block on the
  // network — a network-backed sink writes a local durability line here and defers the external
  // submission to reconcile() (local-first, externalize-async).
  append(record: AnchorRecord): void;
  readAll(): AnchorRecord[];
  isHealthy(): boolean;
  // Optional: push any not-yet-externalized records to the external store (e.g. POST to a TSA,
  // PUT to S3 Object Lock). Called on boot and on the periodic anchor cycle. Idempotent; a
  // failure re-queues the record for the next cycle. Sinks with no external store omit it.
  reconcile?(): Promise<void>;
}

// Default sink: an append-only local JSONL file. Each anchor() writes exactly one line via
// appendFileSync — the file is only ever extended, never re-serialized. A legacy JSON-array file
// (the previous format) is migrated to JSONL once on first read. A torn trailing line (an append
// interrupted by a crash) is tolerated: readAll returns the longest valid prefix.
export class AppendOnlyFileAnchorSink implements AnchorSink {
  private readonly durability = new DurabilityHealth("anchor", "anchor");

  constructor(private readonly persistPath: string) {}

  append(record: AnchorRecord): void {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      appendFileSync(this.persistPath, JSON.stringify(record) + "\n", "utf-8");
      this.durability.markHealthy();
    } catch (err) {
      // Do NOT swallow: a lost anchor write means the external tamper-evidence for the ledger
      // head is not persisted — surface it (health flag + ERROR), never a WARNING.
      this.durability.markDegraded(err);
    }
  }

  readAll(): AnchorRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, "utf-8");
    } catch {
      return []; // ENOENT (first run) or unreadable → empty; verifyAfterRestore fails closed if
                 // the ledger is non-empty, so a missing/unreadable anchor cannot pass silently.
    }
    const trimmed = raw.trim();
    if (trimmed === "") return [];

    // Legacy v0 format: a single JSON array. Migrate to append-only JSONL once (the records are
    // preserved identically — a container-format upgrade, not a history rewrite).
    if (trimmed[0] === "[") {
      let records: AnchorRecord[];
      try {
        records = JSON.parse(trimmed) as AnchorRecord[];
      } catch {
        return [];
      }
      this.migrateToJsonl(records);
      return records;
    }

    // v1 format: JSONL, one record per line. Parse the longest valid prefix — a failed line is a
    // torn append (only ever the last line, since we only append), so we stop and keep the rest.
    const records: AnchorRecord[] = [];
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        records.push(JSON.parse(t) as AnchorRecord);
      } catch {
        break;
      }
    }
    return records;
  }

  isHealthy(): boolean {
    return this.durability.isHealthy();
  }

  // One-time upgrade of a legacy JSON-array file to JSONL. Best-effort: on failure the records are
  // still in memory this run and the durability flag surfaces the degradation.
  private migrateToJsonl(records: AnchorRecord[]): void {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // Rewrite is safe here precisely because the on-disk CONTENT is unchanged (same records,
      // same order) — this is a format migration, not a mutation of anchor history. Write the
      // JSONL rendering to a temp file and rename it over the legacy array atomically.
      const tmpPath = `${this.persistPath}.tmp`;
      writeFileSync(tmpPath, records.map((r) => JSON.stringify(r) + "\n").join(""), "utf-8");
      renameSync(tmpPath, this.persistPath);
      this.durability.markHealthy();
    } catch (err) {
      this.durability.markDegraded(err);
    }
  }
}

export class HeadHashAnchor {
  private records: AnchorRecord[] = [];
  private readonly sink: AnchorSink | null;

  // Accepts a sink (production WORM store or a custom impl), a file path (wrapped in the default
  // append-only file sink — the back-compatible dev/CLI path), or null (in-memory only).
  constructor(dest: AnchorSink | string | null = null) {
    if (dest === null) {
      this.sink = null;
    } else if (typeof dest === "string") {
      this.sink = new AppendOnlyFileAnchorSink(dest);
    } else {
      this.sink = dest;
    }
    if (this.sink) {
      this.records = this.sink.readAll();
    }
  }

  // Anchor the current head hash. Append-only — the sink never deletes or overwrites.
  anchor(headHash: string, highestSeq: number): AnchorRecord {
    const record: AnchorRecord = {
      seq: highestSeq,
      head_hash: headHash,
      timestamp: new Date().toISOString(),
    };
    this.records.push(record);
    this.sink?.append(record);
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

  // True while every anchor write has succeeded; false once one has failed. In-memory anchors
  // (no sink) are always healthy. Aggregated at /health (issue #51).
  isPersistenceHealthy(): boolean {
    return this.sink ? this.sink.isHealthy() : true;
  }

  // Externalize any pending records to the sink's write-once store (no-op for the local file
  // sink and in-memory anchors). Called on boot and on the periodic anchor cycle.
  async reconcile(): Promise<void> {
    await this.sink?.reconcile?.();
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
