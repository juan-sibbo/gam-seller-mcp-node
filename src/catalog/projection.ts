import type { ProductFamily } from "./store.js";
import type { FamilyPrice } from "../pricing/store.js";

// Buyer-facing discovery projection — output no-leak guard (C4, audit §5.4).
//
// The discovery response MUST expose ONLY the fields named here, regardless of what extra
// keys a (mis-)edited catalog.json carries. CatalogStore keeps the raw config objects, and
// the handler used to `...spread` them — so the no-leak guarantee depended on config-editing
// discipline. This projection makes it STRUCTURAL: fields are copied by explicit name, never
// spread, so a sensitive key added to config (an internal floor, a GAM line-item id, a deal
// ref) can never reach a buyer because it is never copied out.
//
// This is belt-and-suspenders with the policy denylist (exact_pricing, gam_ids, gam_objects,
// raw_avails…): the denylist governs surfaces, this projection guards the egress payload.

export interface BuyerPricingOptions {
  list_price: number;
  currency: string;
  valid_until: string;
}

export interface BuyerFacingFamily {
  family_id: string;
  label: string;
  // Pilar 3 reserved fields — always null in v1 (privacy-consent-layer §3, catalog/store.ts).
  // Forced to null here so the v1 "reserved, uninterpreted" invariant holds at the boundary
  // even if a config sets them to a non-null value.
  consent_context: null;
  legal_basis_provenance: null;
  // Present ONLY when a firm list price is available. Uniform list price only — per-buyer /
  // exact / deal pricing stays denied (SEC-GATE-13 / EXACT_PRICING denylist, DP-AB-01 §5.1).
  pricing_options?: BuyerPricingOptions;
}

// Project a catalog family (+ optional firm price) to the buyer-facing shape. Copies fields
// by explicit name — never spreads — so unknown keys are structurally dropped at egress.
export function projectFamily(family: ProductFamily, price?: FamilyPrice): BuyerFacingFamily {
  const projected: BuyerFacingFamily = {
    family_id: family.family_id,
    label: family.label,
    consent_context: null,
    legal_basis_provenance: null,
  };
  if (price) {
    projected.pricing_options = {
      list_price: price.list_price,
      currency: price.currency,
      valid_until: price.valid_until,
    };
  }
  return projected;
}
