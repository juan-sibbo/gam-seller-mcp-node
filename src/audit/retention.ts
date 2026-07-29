import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import type { AuditEvent } from "./event.js";
import { EventClass } from "./event.js";
import type { AuditLedger } from "./ledger.js";
import type { HeadHashAnchor } from "./anchor.js";
import type { RetentionConfig } from "../config/deployment.js";
import type { PseudonymService } from "./pseudonym.js";

// Ledger retention — SIGNED A3 (s6-consent-hardening-acts-2026-07-05.md):
//   hot 90 days → archive 12 months → automatic purge.
//   Head-hash anchors survive purge INDEFINITELY: a hash without its ledger is not
//   personal data, and keeping it preserves historical verifiability of the chain.
//
// Design: segment-based archiving. rotate() closes the aged prefix of the hot ledger
// into an ArchivedSegment, anchors the segment's head hash, and logs the act in the
// ledger itself — the expiry of data is itself traceable, which is exactly what the
// AEPD guidance asks for (log caducity + traceability, gdpr-analysis §Q4/§Q6).
//
// Taxonomy note: rotation is logged under the RATIFIED `anchoring` class — semantically
// legitimate because rotation IS an anchoring act (the closed segment's head hash is
// anchored externally). No 17th event class is introduced (taxonomy is RATIFIED,
// decision-package Bloque 2 — expanding it would require a signed governance act).

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MONTH_MS = 30 * DAY_MS;

export interface ArchivedSegment {
  from_seq: number;
  to_seq: number;
  head_hash: string;      // survives purge indefinitely
  closed_at: string;      // ISO 8601
  entry_count: number;    // survives purge (aggregate, not personal data)
  entries: AuditEvent[] | null; // null after purge
}

export class RetentionService {
  private segments: ArchivedSegment[] = [];
  private readonly persistPath: string | null;

  constructor(
    private readonly config: RetentionConfig,
    private readonly anchor: HeadHashAnchor,
    persistPath: string | null = null
  ) {
    this.persistPath = persistPath;
    if (persistPath) {
      this.load();
    }
  }

  // Move entries older than hot_days out of the hot ledger into a closed, anchored
  // segment. Returns the segment, or null if nothing was old enough to rotate.
  rotate(ledger: AuditLedger, nowMs = Date.now()): ArchivedSegment | null {
    const cutoff = nowMs - this.config.hot_days * DAY_MS;
    const removed = ledger.rotateOut(cutoff);
    if (removed.length === 0) return null;

    const segment: ArchivedSegment = {
      from_seq: removed[0].seq,
      to_seq: removed[removed.length - 1].seq,
      head_hash: removed[removed.length - 1].hash,
      closed_at: new Date(nowMs).toISOString(),
      entry_count: removed.length,
      entries: removed,
    };

    // Anchor the closed segment's head hash externally (Object Lock in production).
    this.anchor.anchor(segment.head_hash, segment.to_seq);

    // The rotation itself is audited — data expiry leaves a trace in the chain.
    ledger.append(EventClass.ANCHORING, {
      anchored_head_hash: segment.head_hash,
      retention_rotation: true,
      from_seq: segment.from_seq,
      to_seq: segment.to_seq,
      segment_closed_at: segment.closed_at,
    });

    this.segments.push(segment);
    this.save();
    return segment;
  }

  // Delete entry payloads of segments older than archive_months. The segment's
  // head_hash, seq range and entry_count are RETAINED indefinitely (A3) — they are
  // not personal data and keep the historical chain verifiable.
  purge(nowMs = Date.now()): number {
    const cutoff = nowMs - this.config.archive_months * RETENTION_MONTH_MS;
    let purged = 0;
    this.segments = this.segments.map((seg) => {
      if (seg.entries !== null && Date.parse(seg.closed_at) < cutoff) {
        purged++;
        return { ...seg, entries: null };
      }
      return seg;
    });
    if (purged > 0) this.save();
    return purged;
  }

  // Read-only access to the signed retention values (used to derive the pseudonym
  // key retention horizon in runRetentionCycle).
  get retentionConfig(): RetentionConfig {
    return this.config;
  }

  allSegments(): readonly ArchivedSegment[] {
    return this.segments;
  }

  segmentCount(): number {
    return this.segments.length;
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      this.segments = JSON.parse(raw) as ArchivedSegment[];
    } catch {
      this.segments = [];
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.segments, null, 2), "utf-8");
    } catch {
      process.stderr.write("[retention] WARNING: could not persist archive to disk\n");
    }
  }
}

export const DEV_ARCHIVE_PATH = dataPath("ledger-archive.json");

// Full lifetime of a recoverable ledger entry: while it is hot (hot_days) plus while
// it sits in the archive with its payload intact (archive_months). Past this horizon
// no recoverable entry references the buyer anymore. It is the natural, A3-aligned
// cutoff for retiring the pseudonym key — the last place a clear buyer_id survives.
export function pseudonymRetentionHorizonMs(config: RetentionConfig): number {
  return config.hot_days * DAY_MS + config.archive_months * RETENTION_MONTH_MS;
}

// Enforce the full retention policy in one pass: rotate aged hot entries into an
// anchored archive segment, purge archive segments past archive_months, and — if a
// PseudonymService is supplied — crypto-shred pseudonym keys inactive beyond the
// retention horizon. A single enforcement pass keeps storage limitation
// (GDPR Art. 5(1)(e)) coherent across the ledger AND the keystore. This is what makes
// A3's "automatic purge" actually automatic — main() schedules it. Without a scheduled
// caller, rotate()/purge()/shredInactive() are dead code.
//
// pseudonyms is OPTIONAL so existing callers/tests keep working; when omitted, only
// the ledger side runs and `shredded` is 0.
export function runRetentionCycle(
  retention: RetentionService,
  ledger: AuditLedger,
  nowMs = Date.now(),
  pseudonyms?: PseudonymService
): { rotated: ArchivedSegment | null; purged: number; shredded: number } {
  const rotated = retention.rotate(ledger, nowMs);
  const purged = retention.purge(nowMs);
  const shredded = pseudonyms
    ? pseudonyms.shredInactive(nowMs - pseudonymRetentionHorizonMs(retention.retentionConfig))
    : 0;
  return { rotated, purged, shredded };
}

// Cadence for the scheduled retention cycle. Retention resolution is days/months,
// so a sub-daily tick is prompt enough without cost. Named to avoid a magic number.
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
