import { describe, it, expect } from "vitest";
import { AllowedSurface, DeniedSurface } from "../src/policy/types.js";
import { assertConsentFieldsEmpty } from "../src/catalog/consent-types.js";
import { TEST_CATALOG_CONFIG } from "../src/catalog/store.js";

// GOVERNANCE CONTRACT — the sovereign-governance invariants this node guarantees, consolidated
// into ONE named, drift-proof suite. The auditor-legible version is docs/GOVERNANCE-CONTRACT.md.
//
// These are the guarantees an operator sells to a regulated public entity (and that a
// public-procurement auditor reads): the node cannot auto-execute, cannot infer audiences,
// cannot leak exact pricing or raw ad-server objects, and records every decision. They are
// enforced today in scattered places (the allow/deny surface lists, the consent invariant, the
// pricing gate); this suite pins them as a single contract so weakening any one breaks the build
// ON PURPOSE — forcing an explicit governance amendment rather than a silent drift. It is
// substrate-agnostic: the same contract certifies this node or, later, a wrapped third-party
// engine (e.g. an open-source sales agent) operated under our governance layer.

const allowed = Object.values(AllowedSurface) as readonly string[];
const denied = Object.values(DeniedSurface) as readonly string[];

describe("Governance Contract — sovereign-governance invariants (drift-proof)", () => {
  it("G1 · No auto-execution (Z1): every order/buy/reserve surface is DENIED and never allowed", () => {
    // A commitment is a soft, buyer-scoped intent — it can never become an ad-server order or an
    // inventory hold. The human handoff to the ad server is the product, not a missing feature.
    for (const s of ["order_create", "deal_create", "media_buy", "inventory_reserve", "deal_mutate"]) {
      expect(denied, `${s} must be on the denylist (no auto-execution)`).toContain(s);
      expect(allowed, `${s} must NEVER be an allowed surface`).not.toContain(s);
    }
  });

  it("G2 · Audience-blind (Z2/Z3): consent/legal-basis fields are forced null; cross-buyer state denied", () => {
    // Populating a consent field without the separate PATH B governance gate breaks the build.
    expect(() =>
      assertConsentFieldsEmpty({ consent_context: { any: 1 }, legal_basis_provenance: null })
    ).toThrow(/Z3\/PATH A/);
    expect(() =>
      assertConsentFieldsEmpty({ consent_context: null, legal_basis_provenance: { legal_basis: "consent" } })
    ).toThrow(/Z3\/PATH A/);
    // The shipped catalog honors it: every family carries null consent fields.
    for (const family of TEST_CATALOG_CONFIG.families) {
      expect(() => assertConsentFieldsEmpty(family), `${family.family_id} must have null consent fields`).not.toThrow();
    }
    expect(denied, "cross-buyer state must be denied").toContain("cross_buyer_state");
  });

  it("G3 · List-price-only: exact pricing and raw avails are DENIED (only firm list price is exposed)", () => {
    expect(denied).toContain("exact_pricing");
    expect(denied).toContain("raw_avails");
  });

  it("G4 · No raw ad-server exposure: GAM ids/objects/admin, SOAP faults and credentials are DENIED", () => {
    for (const s of ["gam_ids", "gam_objects", "gam_admin", "soap_faults", "credential_internals"]) {
      expect(denied, `${s} must be denied`).toContain(s);
    }
  });

  it("G5 · The allowlist is CLOSED and disjoint from the denylist (a new surface must be classified)", () => {
    const overlap = allowed.filter((s) => denied.includes(s));
    expect(overlap, "no surface may be both allowed and denied").toEqual([]);
    // Frozen allowed set — adding a surface requires amending the signed allowlist (and this test).
    expect([...allowed].sort()).toEqual(
      ["auth_context", "discovery", "error_envelope", "forecast", "intent", "product_discovery", "well_known"].sort()
    );
  });
});
