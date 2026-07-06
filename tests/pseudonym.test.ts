import { describe, it, expect, beforeEach } from "vitest";
import { PseudonymService, createMemoryPseudonyms } from "../src/audit/pseudonym.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";

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
