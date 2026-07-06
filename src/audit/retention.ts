import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { AuditEvent } from "./event.js";
import { EventClass } from "./event.js";
import type { AuditLedger } from "./ledger.js";
import type { HeadHashAnchor } from "./anchor.js";
import type { RetentionConfig } from "../config/deployment.js";

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

export const DEV_ARCHIVE_PATH = "./data/ledger-archive.json";
