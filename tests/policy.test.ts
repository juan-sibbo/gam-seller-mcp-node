import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine } from "../src/policy/engine.js";
import { EntitlementStore, DEFAULT_ENTITLEMENTS_CONFIG, TEST_ENTITLEMENTS_CONFIG } from "../src/policy/entitlements.js";
import { AllowedSurface, DeniedSurface } from "../src/policy/types.js";

const BASE_REQUEST = {
  scope: "gam.readonly",
  phase: "phase-1-readonly",
  request_id: "test-req-001",
};

// S1 done criterion: all requests without explicit entitlement → DENY
describe("PolicyEngine — Default-Deny (KANON P5)", () => {
  describe("empty entitlement store", () => {
    let engine: PolicyEngine;

    beforeEach(() => {
      engine = new PolicyEngine(new EntitlementStore(DEFAULT_ENTITLEMENTS_CONFIG));
    });

    it("denies any buyer with no entitlements", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "unknown-buyer", surface: AllowedSurface.DISCOVERY });
      expect(dec.outcome).toBe("DENY");
    });

    it("denies well-known surface without entitlement", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "any-buyer", surface: AllowedSurface.WELL_KNOWN });
      expect(dec.outcome).toBe("DENY");
    });

    it("denies product discovery without entitlement", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "any-buyer", surface: AllowedSurface.PRODUCT_DISCOVERY });
      expect(dec.outcome).toBe("DENY");
    });

    it("denies forecast surface without entitlement", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "any-buyer", surface: AllowedSurface.FORECAST });
      expect(dec.outcome).toBe("DENY");
    });
  });

  describe("denylist prevails over valid entitlement (hard rule #1)", () => {
    let engine: PolicyEngine;

    beforeEach(() => {
      // Give buyer explicit entitlements — denylist must still win
      engine = new PolicyEngine(new EntitlementStore(TEST_ENTITLEMENTS_CONFIG));
    });

    it.each(Object.values(DeniedSurface))(
      "denies denylist surface '%s' even for entitled buyer",
      (surface) => {
        const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "test-buyer-001", surface });
        expect(dec.outcome).toBe("DENY");
      }
    );
  });

  describe("with entitlements", () => {
    let engine: PolicyEngine;

    beforeEach(() => {
      engine = new PolicyEngine(new EntitlementStore(TEST_ENTITLEMENTS_CONFIG));
    });

    it("allows entitled buyer on authorized surface", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "test-buyer-001", surface: AllowedSurface.DISCOVERY });
      expect(dec.outcome).toBe("ALLOW");
    });

    it("denies entitled buyer on surface NOT in their entitlement", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "test-buyer-001", surface: AllowedSurface.FORECAST });
      expect(dec.outcome).toBe("DENY");
    });

    it("denies entitled buyer with wrong scope", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "test-buyer-001", surface: AllowedSurface.DISCOVERY, scope: "gam.write" });
      expect(dec.outcome).toBe("DENY");
    });

    it("denies entitled buyer in wrong phase", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "test-buyer-001", surface: AllowedSurface.DISCOVERY, phase: "phase-2" });
      expect(dec.outcome).toBe("DENY");
    });

    it("denies unknown buyer even when other buyers are entitled", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "unknown-buyer", surface: AllowedSurface.DISCOVERY });
      expect(dec.outcome).toBe("DENY");
    });
  });

  describe("decision fields are always populated", () => {
    let engine: PolicyEngine;

    beforeEach(() => {
      engine = new PolicyEngine(new EntitlementStore(DEFAULT_ENTITLEMENTS_CONFIG));
    });

    it("DENY decision includes all binding fields for audit", () => {
      const dec = engine.decide({ buyer_id: "x", surface: "discovery", scope: "gam.readonly", phase: "phase-1-readonly", request_id: "audit-test" });
      expect(dec.buyer_id).toBe("x");
      expect(dec.surface).toBe("discovery");
      expect(dec.scope).toBe("gam.readonly");
      expect(dec.phase).toBe("phase-1-readonly");
      expect(dec.request_id).toBe("audit-test");
      expect(dec.outcome).toBe("DENY");
    });

    it("reason field exists but is never empty on DENY", () => {
      const dec = engine.decide({ ...BASE_REQUEST, buyer_id: "unknown", surface: AllowedSurface.DISCOVERY });
      expect(dec.reason).toBeTruthy();
    });
  });
});
