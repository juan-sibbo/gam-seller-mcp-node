import type { Entitlement } from "./types.js";
import { AllowedSurface } from "./types.js";

// Entitlements loaded from config — one entry per buyer_id.
// Production: replace with signed config file or DB read gated by policy.
// Dev: explicit list here; absence = DENY by engine (Default-Deny, KANON P5).
//
// ONBOARDING RULE — SIGNED A1 (s6-consent-hardening-acts-2026-07-05.md):
// buyer_id MUST identify an organization or automated system, never a natural person.
// Contact persons associated with a buyer_id are stored separately (onboarding record),
// minimized to professional contact data (Art. 19 LOPDGDD), and are never written to
// the audit ledger, JWTs, or any buyer-facing response. Under this rule buyer_id is
// outside GDPR scope (Recital 14) — see gdpr-analysis §Q1.
export interface EntitlementsConfig {
  entitlements: Entitlement[];
}

export class EntitlementStore {
  private readonly index: Map<string, Entitlement>;
  // Art. 18 GDPR restriction: entitlement is kept but not served — get() returns
  // undefined, so the Policy Engine produces DENY (Default-Deny does the rest).
  private readonly suspended: Map<string, Entitlement>;

  constructor(config: EntitlementsConfig) {
    this.index = new Map(config.entitlements.map((e) => [e.buyer_id, e]));
    this.suspended = new Map();
  }

  get(buyer_id: string): Entitlement | undefined {
    return this.index.get(buyer_id);
  }

  has(buyer_id: string): boolean {
    return this.index.has(buyer_id);
  }

  // DSR restriction (Art. 18): stop processing without deleting the record.
  suspend(buyer_id: string): boolean {
    const entitlement = this.index.get(buyer_id);
    if (!entitlement) return false;
    this.index.delete(buyer_id);
    this.suspended.set(buyer_id, entitlement);
    return true;
  }

  reinstate(buyer_id: string): boolean {
    const entitlement = this.suspended.get(buyer_id);
    if (!entitlement) return false;
    this.suspended.delete(buyer_id);
    this.index.set(buyer_id, entitlement);
    return true;
  }

  isSuspended(buyer_id: string): boolean {
    return this.suspended.has(buyer_id);
  }

  // DSR erasure (Art. 17): remove the record entirely (active or suspended).
  remove(buyer_id: string): boolean {
    return this.index.delete(buyer_id) || this.suspended.delete(buyer_id);
  }
}

// Default dev config — no buyer has any entitlement by default.
// Add entries here (or via config file) to grant access during testing.
export const DEFAULT_ENTITLEMENTS_CONFIG: EntitlementsConfig = {
  entitlements: [],
};

// Test fixture: a buyer with minimal allowed surfaces for S1 tests.
export const TEST_ENTITLEMENTS_CONFIG: EntitlementsConfig = {
  entitlements: [
    {
      buyer_id: "test-buyer-001",
      surfaces: [AllowedSurface.DISCOVERY, AllowedSurface.WELL_KNOWN],
      scopes: ["gam.readonly"],
      phase: "phase-1-readonly",
    },
  ],
};

// Test fixture: a buyer with PRODUCT_DISCOVERY surface for S4 catalog tests.
export const TEST_ENTITLEMENTS_WITH_PRODUCTS_CONFIG: EntitlementsConfig = {
  entitlements: [
    {
      buyer_id: "test-buyer-001",
      surfaces: [AllowedSurface.DISCOVERY, AllowedSurface.WELL_KNOWN, AllowedSurface.PRODUCT_DISCOVERY],
      scopes: ["gam.readonly"],
      phase: "phase-1-readonly",
    },
  ],
};

// Test fixture: full S5 demo entitlements including FORECAST surface.
export const TEST_ENTITLEMENTS_DEMO_CONFIG: EntitlementsConfig = {
  entitlements: [
    {
      buyer_id: "test-buyer-001",
      surfaces: [
        AllowedSurface.DISCOVERY,
        AllowedSurface.WELL_KNOWN,
        AllowedSurface.PRODUCT_DISCOVERY,
        AllowedSurface.FORECAST,
      ],
      scopes: ["gam.readonly"],
      phase: "phase-1-readonly",
    },
    {
      buyer_id: "pilot-buyer-001",
      surfaces: [
        AllowedSurface.DISCOVERY,
        AllowedSurface.WELL_KNOWN,
        AllowedSurface.PRODUCT_DISCOVERY,
        AllowedSurface.FORECAST,
      ],
      scopes: ["gam.readonly"],
      phase: "phase-1-readonly",
    },
  ],
};
