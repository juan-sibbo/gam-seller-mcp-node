import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { createMemoryAnchor, verifyAfterRestore } from "../src/audit/anchor.js";
import { RetentionService, DAY_MS, RETENTION_MONTH_MS } from "../src/audit/retention.js";
import { EventClass } from "../src/audit/event.js";

// S6 F3 — retention SIGNED A3: 90d hot / 12m archive / anchors indefinite

const RETENTION = { hot_days: 90, archive_months: 12 };
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

describe("RetentionService — rotation (hot → archive)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates only entries older than hot_days", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();
    const retention = new RetentionService(RETENTION, anchor);

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
    ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "b1" });

    // 40 days later: a fresh entry
    vi.setSystemTime(T0 + 40 * DAY_MS);
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid" }, { buyer_id: "b1" });

    // 100 days after T0: the first two entries aged out (>90d), the third did not
    const now = T0 + 100 * DAY_MS;
    vi.setSystemTime(now);
    const segment = retention.rotate(ledger, now);

    expect(segment).not.toBeNull();
    expect(segment!.entry_count).toBe(2);
    expect(segment!.from_seq).toBe(0);
    expect(segment!.to_seq).toBe(1);
  });

  it("no-op when nothing is old enough", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    expect(retention.rotate(ledger, T0 + DAY_MS)).toBeNull();
    expect(ledger.size()).toBe(1);
  });

  it("hot ledger chain still verifies after rotation (carryPrevHash)", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    ledger.append(EventClass.SCOPE_RESOLUTION, {});
    vi.setSystemTime(T0 + 95 * DAY_MS);
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "low" });

    retention.rotate(ledger, T0 + 100 * DAY_MS);

    expect(ledger.replayVerify().valid).toBe(true);
  });

  it("the rotation is itself audited under the ratified ANCHORING class", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    vi.setSystemTime(T0 + 100 * DAY_MS);
    retention.rotate(ledger, T0 + 100 * DAY_MS);

    const entries = ledger.allEntries();
    const rotationEvent = entries[entries.length - 1];
    expect(rotationEvent.event_class).toBe(EventClass.ANCHORING);
    expect(rotationEvent.payload["retention_rotation"]).toBe(true);
  });

  it("the closed segment's head hash is anchored externally", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();
    const retention = new RetentionService(RETENTION, anchor);

    vi.setSystemTime(T0);
    const oldEntry = ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    vi.setSystemTime(T0 + 100 * DAY_MS);
    retention.rotate(ledger, T0 + 100 * DAY_MS);

    expect(anchor.count()).toBe(1);
    expect(anchor.all()[0].head_hash).toBe(oldEntry.hash);
  });

  it("global seq numbering continues across rotation", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}); // seq 0
    vi.setSystemTime(T0 + 100 * DAY_MS);
    retention.rotate(ledger, T0 + 100 * DAY_MS);        // rotation logs seq 1
    const next = ledger.append(EventClass.SCOPE_RESOLUTION, {});
    expect(next.seq).toBe(2);
  });

  it("post-rotation ledger passes head-hash-first restore verification after re-anchoring", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();
    const retention = new RetentionService(RETENTION, anchor);

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    vi.setSystemTime(T0 + 100 * DAY_MS);
    retention.rotate(ledger, T0 + 100 * DAY_MS);

    // Standard periodic anchoring of the current head (60-min cycle in production)
    anchor.anchor(ledger.headHash(), ledger.headSeq());

    const result = verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);
    expect(result.valid).toBe(true);
  });
});

describe("RetentionService — purge (archive → anonymous aggregate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildArchivedSegment(retention: RetentionService, atMs: number) {
    const ledger = createMemoryLedger();
    vi.setSystemTime(atMs);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
    retention.rotate(ledger, atMs + 91 * DAY_MS);
  }

  it("purges only segments older than archive_months", () => {
    const anchor = createMemoryAnchor();
    const retention = new RetentionService(RETENTION, anchor);

    buildArchivedSegment(retention, T0);                          // closed at T0+91d
    buildArchivedSegment(retention, T0 + 6 * RETENTION_MONTH_MS); // closed ~6 months later

    // 13 months after the FIRST segment closed: only that one purges
    const purgeTime = T0 + 91 * DAY_MS + 13 * RETENTION_MONTH_MS;
    const purged = retention.purge(purgeTime);

    expect(purged).toBe(1);
    const segments = retention.allSegments();
    expect(segments[0].entries).toBeNull();
    expect(segments[1].entries).not.toBeNull();
  });

  it("purged segments RETAIN head_hash and entry_count (A3: anchors indefinite)", () => {
    const retention = new RetentionService(RETENTION, createMemoryAnchor());
    buildArchivedSegment(retention, T0);

    retention.purge(T0 + 91 * DAY_MS + 13 * RETENTION_MONTH_MS);

    const seg = retention.allSegments()[0];
    expect(seg.entries).toBeNull();          // personal-data payload gone
    expect(seg.head_hash).toBeTruthy();      // verifiability preserved
    expect(seg.entry_count).toBe(1);         // aggregate, not personal data
    expect(seg.closed_at).toBeTruthy();
  });

  it("purge is idempotent", () => {
    const retention = new RetentionService(RETENTION, createMemoryAnchor());
    buildArchivedSegment(retention, T0);
    const late = T0 + 91 * DAY_MS + 13 * RETENTION_MONTH_MS;
    expect(retention.purge(late)).toBe(1);
    expect(retention.purge(late)).toBe(0);
  });
});
