import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { createMemoryAnchor, verifyAfterRestore } from "../src/audit/anchor.js";
import {
  RetentionService,
  DAY_MS,
  RETENTION_MONTH_MS,
  runRetentionCycle,
  pseudonymRetentionHorizonMs,
} from "../src/audit/retention.js";
import { createMemoryPseudonyms } from "../src/audit/pseudonym.js";
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

describe("runRetentionCycle — scheduled enforcement (A3 automatic)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates aged hot entries in a single pass", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
    ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "b1" });

    const { rotated, purged } = runRetentionCycle(retention, ledger, T0 + 100 * DAY_MS);

    expect(rotated).not.toBeNull();
    expect(rotated!.entry_count).toBe(2);
    expect(purged).toBe(0); // nothing archived long enough to purge yet
  });

  it("purges archive segments past archive_months on a later cycle", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });

    // First cycle archives the aged entry; second cycle, 13 months later, purges it.
    runRetentionCycle(retention, ledger, T0 + 100 * DAY_MS);
    const purgeTime = T0 + 100 * DAY_MS + 13 * RETENTION_MONTH_MS;
    const { purged } = runRetentionCycle(retention, ledger, purgeTime);

    expect(purged).toBe(1);
    expect(retention.allSegments()[0].entries).toBeNull(); // payload gone, head_hash kept
  });

  it("is a safe no-op on a fresh ledger with nothing aged", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });

    const { rotated, purged } = runRetentionCycle(retention, ledger, T0 + DAY_MS);

    expect(rotated).toBeNull();
    expect(purged).toBe(0);
    expect(ledger.size()).toBe(1);
  });
});

// F2 — pseudonym keystore retention wired into the single enforcement pass.
describe("runRetentionCycle — pseudonym key crypto-shred by inactivity (A3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const HORIZON = pseudonymRetentionHorizonMs(RETENTION); // 90d + 12*30d

  it("horizon = hot_days + archive_months (last recoverable-entry lifetime)", () => {
    expect(HORIZON).toBe(90 * DAY_MS + 12 * RETENTION_MONTH_MS);
  });

  it("shreds a key inactive beyond the horizon, keeps a recently active one", () => {
    const pseudonyms = createMemoryPseudonyms();
    const ledger = createMemoryLedger(pseudonyms);
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    // stale-buyer last seen at T0; fresh-buyer seen at the sweep time.
    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "stale-buyer" });

    const sweepTime = T0 + HORIZON + DAY_MS; // one day past the horizon for stale-buyer
    vi.setSystemTime(sweepTime);
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid" }, { buyer_id: "fresh-buyer" });

    const { shredded } = runRetentionCycle(retention, ledger, sweepTime, pseudonyms);

    expect(shredded).toBe(1);
    expect(pseudonyms.hasKey("stale-buyer")).toBe(false);
    expect(pseudonyms.hasKey("fresh-buyer")).toBe(true);
  });

  it("integration: horizon-lapsed keys are shredded alongside the ledger purge", () => {
    const pseudonyms = createMemoryPseudonyms();
    const ledger = createMemoryLedger(pseudonyms);
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    // A buyer active only at T0. Its key's last_used_at = T0.
    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b-old" });
    expect(pseudonyms.hasKey("b-old")).toBe(true);

    // First cycle at T0+100d: rotates the aged entry (segment closes at T0+100d),
    // nothing to purge or shred yet.
    const c1 = runRetentionCycle(retention, ledger, T0 + 100 * DAY_MS, pseudonyms);
    expect(c1.rotated).not.toBeNull();
    expect(c1.shredded).toBe(0); // 100d < horizon (90d + 360d)
    expect(pseudonyms.hasKey("b-old")).toBe(true);

    // Second cycle late enough for BOTH thresholds: past the key's inactivity horizon
    // (measured from last activity T0) AND past the segment's archive window (measured
    // from close T0+100d). The two clocks differ by design, so we pick a time beyond
    // both — the point of the test is that a single cycle enforces both.
    const sweepTime = T0 + 100 * DAY_MS + 13 * RETENTION_MONTH_MS;
    const c2 = runRetentionCycle(retention, ledger, sweepTime, pseudonyms);
    expect(c2.purged).toBe(1);
    expect(c2.shredded).toBe(1);
    expect(pseudonyms.hasKey("b-old")).toBe(false);
  });

  it("re-appearing buyer after inactivity shred gets a fresh, unlinkable key", () => {
    const pseudonyms = createMemoryPseudonyms();
    const ledger = createMemoryLedger(pseudonyms);
    const retention = new RetentionService(RETENTION, createMemoryAnchor());

    vi.setSystemTime(T0);
    const before = pseudonyms.pseudonymize("b-old");

    const sweepTime = T0 + HORIZON + DAY_MS;
    runRetentionCycle(retention, ledger, sweepTime, pseudonyms);
    expect(pseudonyms.hasKey("b-old")).toBe(false);

    vi.setSystemTime(sweepTime);
    const after = pseudonyms.pseudonymize("b-old");
    expect(after).not.toBe(before); // pre-shred history unrecoverable
  });

  it("without a PseudonymService, the cycle still runs and reports shredded = 0", () => {
    const ledger = createMemoryLedger();
    const retention = new RetentionService(RETENTION, createMemoryAnchor());
    vi.setSystemTime(T0);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
    const { shredded } = runRetentionCycle(retention, ledger, T0 + DAY_MS);
    expect(shredded).toBe(0);
  });
});
