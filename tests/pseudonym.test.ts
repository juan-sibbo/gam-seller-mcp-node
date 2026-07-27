import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PseudonymService, createMemoryPseudonyms } from "../src/audit/pseudonym.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// S6 F2 — ledger pseudonymization + crypto-shredding (gdpr-analysis §Q1.2, act A1)

describe("PseudonymService", () => {
  let service: PseudonymService;

  beforeEach(() => {
    service = createMemoryPseudonyms();
  });

  it("same buyer always maps to the same pseudonym (correlation preserved)", () => {
    const p1 = service.pseudonymize("pilot-buyer-001");
    const p2 = service.pseudonymize("pilot-buyer-001");
    expect(p1).toBe(p2);
  });

  it("different buyers map to different pseudonyms", () => {
    expect(service.pseudonymize("buyer-a")).not.toBe(service.pseudonymize("buyer-b"));
  });

  it("pseudonym never contains the raw buyer_id", () => {
    const pseudonym = service.pseudonymize("pilot-buyer-001");
    expect(pseudonym).not.toContain("pilot");
    expect(pseudonym.startsWith("psn_")).toBe(true);
  });

  it("pseudonymizePayload returns a NEW object (immutability) with buyer_id transformed", () => {
    const original = { result: "ok", buyer_id: "buyer-a" };
    const safe = service.pseudonymizePayload(original);
    expect(safe).not.toBe(original);
    expect(original.buyer_id).toBe("buyer-a"); // input untouched
    expect(safe["buyer_id"]).toBe(service.pseudonymize("buyer-a"));
  });

  it("pseudonymizePayload leaves payloads without buyer_id unchanged in content", () => {
    const safe = service.pseudonymizePayload({ bucket: "mid" });
    expect(safe).toEqual({ bucket: "mid" });
  });

  it("does not double-pseudonymize an already-pseudonymous value", () => {
    const once = service.pseudonymize("buyer-a");
    const safe = service.pseudonymizePayload({ buyer_id: once });
    expect(safe["buyer_id"]).toBe(once);
  });

  describe("crypto-shredding (Art. 17 without breaking the chain)", () => {
    it("shred removes the key", () => {
      service.pseudonymize("buyer-a");
      expect(service.hasKey("buyer-a")).toBe(true);
      expect(service.shred("buyer-a")).toBe(true);
      expect(service.hasKey("buyer-a")).toBe(false);
    });

    it("shred of unknown buyer is a safe no-op", () => {
      expect(service.shred("nobody")).toBe(false);
    });

    it("after shred, a re-appearing buyer gets an UNLINKABLE new pseudonym", () => {
      const before = service.pseudonymize("buyer-a");
      service.shred("buyer-a");
      const after = service.pseudonymize("buyer-a");
      expect(after).not.toBe(before); // fresh key → pre-shred history unrecoverable
    });
  });

  // F2 — automatic crypto-shred by inactivity (A3-aligned keystore retention).
  describe("shredInactive (retention by inactivity)", () => {
    it("deletes keys older than the cutoff and KEEPS active ones", async () => {
      service.pseudonymize("stale");
      // Boundary between the two keys: stale was used before it, active after it.
      const cutoff = Date.now() + 1;
      await new Promise((r) => setTimeout(r, 5));
      service.pseudonymize("active"); // last_used_at > cutoff

      expect(service.shredInactive(cutoff)).toBe(1); // only "stale" is inactive
      expect(service.hasKey("stale")).toBe(false);
      expect(service.hasKey("active")).toBe(true);
    });

    it("re-pseudonymize refreshes last_used_at (active buyer does not expire)", async () => {
      const first = service.pseudonymize("buyer-a");
      const cutoffBefore = Date.now() + 1;
      await new Promise((r) => setTimeout(r, 5));
      const second = service.pseudonymize("buyer-a"); // touch → last_used_at advances
      expect(second).toBe(first); // same key, correlation preserved
      // A sweep at a cutoff BEFORE the refresh must not touch buyer-a.
      expect(service.shredInactive(cutoffBefore)).toBe(0);
      expect(service.hasKey("buyer-a")).toBe(true);
    });

    it("after shredInactive, a re-appearing buyer gets an UNLINKABLE fresh key", () => {
      const before = service.pseudonymize("buyer-a");
      service.shredInactive(Date.now() + DAY_MS); // sweep everything
      expect(service.hasKey("buyer-a")).toBe(false);
      const after = service.pseudonymize("buyer-a");
      expect(after).not.toBe(before); // fresh key → pre-shred history unrecoverable
    });

    it("is a no-op when no key is inactive", () => {
      service.pseudonymize("buyer-a");
      expect(service.shredInactive(Date.now() - DAY_MS)).toBe(0);
      expect(service.keyCount()).toBe(1);
    });
  });
});

describe("PseudonymService — persistence & schema migration", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "psn-"));
    path = join(dir, "keys.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates the LEGACY flat schema (buyer_id → hex) without breaking", () => {
    const legacyKey = "a".repeat(64);
    writeFileSync(path, JSON.stringify({ keys: { "buyer-a": legacyKey } }), "utf-8");

    const service = new PseudonymService(path);
    expect(service.hasKey("buyer-a")).toBe(true);
    // The legacy hex is preserved as the HMAC key, so the pseudonym is stable across
    // loads (a second instance re-reads the same legacy file and migrates identically).
    const svc2 = new PseudonymService(path);
    expect(svc2.pseudonymize("buyer-a")).toBe(service.pseudonymize("buyer-a"));
  });

  it("migration does NOT immediately shred (last_used_at set to load time, not epoch)", () => {
    const legacyKey = "b".repeat(64);
    writeFileSync(path, JSON.stringify({ keys: { "buyer-a": legacyKey } }), "utf-8");

    const service = new PseudonymService(path);
    // A sweep with a cutoff of 'a horizon ago' must NOT delete the freshly-loaded key.
    const oneYearAgo = Date.now() - 365 * DAY_MS;
    expect(service.shredInactive(oneYearAgo)).toBe(0);
    expect(service.hasKey("buyer-a")).toBe(true);
  });

  it("round-trips the v2 schema with timestamps", () => {
    const a = new PseudonymService(path);
    const p1 = a.pseudonymize("buyer-a");

    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.version).toBe(2);
    expect(typeof raw.keys["buyer-a"].last_used_at).toBe("number");
    expect(typeof raw.keys["buyer-a"].created_at).toBe("number");

    const b = new PseudonymService(path);
    expect(b.pseudonymize("buyer-a")).toBe(p1); // key survives reload
  });
});

describe("AuditLedger — pseudonymization invariant (raw buyer_id never in the ledger)", () => {
  it("options.buyer_id is stored pseudonymized", () => {
    const ledger = createMemoryLedger();
    const e = ledger.append(EventClass.BUYER_AUTHENTICATION, { result: "ok" }, { buyer_id: "pilot-buyer-001" });
    expect(e.buyer_id).toBeDefined();
    expect(e.buyer_id).not.toContain("pilot");
    expect(e.buyer_id!.startsWith("psn_")).toBe(true);
  });

  it("payload.buyer_id is pseudonymized BEFORE hashing", () => {
    const ledger = createMemoryLedger();
    const e = ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid", buyer_id: "pilot-buyer-001" });
    expect(JSON.stringify(e.payload)).not.toContain("pilot");
    // The hash covers the pseudonymized payload — replay must still verify
    expect(ledger.replayVerify().valid).toBe(true);
  });

  it("full ledger serialization contains no raw buyer_id anywhere", () => {
    const ledger = createMemoryLedger();
    ledger.append(EventClass.BUYER_AUTHENTICATION, { result: "ok", buyer_id: "raw-id-A" }, { buyer_id: "raw-id-A" });
    ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "raw-id-B" });
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "low", buyer_id: "raw-id-A" });
    const serialized = JSON.stringify(ledger.allEntries());
    expect(serialized).not.toContain("raw-id-A");
    expect(serialized).not.toContain("raw-id-B");
  });

  it("same buyer correlates across entries via the same pseudonym", () => {
    const pseudonyms = createMemoryPseudonyms();
    const ledger = createMemoryLedger(pseudonyms);
    const e1 = ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "buyer-a" });
    const e2 = ledger.append(EventClass.FORECAST_REQUEST, {}, { buyer_id: "buyer-a" });
    expect(e1.buyer_id).toBe(e2.buyer_id);
  });

  it("after shred, the hash-chain remains fully valid (crypto-shredding core property)", () => {
    const pseudonyms = createMemoryPseudonyms();
    const ledger = createMemoryLedger(pseudonyms);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "buyer-a" });
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid", buyer_id: "buyer-a" });
    ledger.append(EventClass.TOKEN_ISSUANCE, { jti: "tok-1" }, { buyer_id: "buyer-a" });

    pseudonyms.shred("buyer-a");

    // The ledger is untouched: every hash and linkage still verifies
    expect(ledger.replayVerify().valid).toBe(true);
    // But the pseudonym is no longer resolvable to the buyer
    expect(pseudonyms.hasKey("buyer-a")).toBe(false);
  });
});
