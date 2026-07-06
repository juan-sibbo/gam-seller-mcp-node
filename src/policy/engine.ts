import type { PolicyRequest, PolicyDecision, AllowedSurface } from "./types.js";
import { DeniedSurface } from "./types.js";
import type { EntitlementStore } from "./entitlements.js";

// DENIED_SURFACES is the exhaustive denylist from adapter-boundary-allowed-surfaces-signoff.md §4.
// This set PREVAILS over any valid token or entitlement — hard rule #1.
const DENIED_SURFACES: ReadonlySet<string> = new Set(Object.values(DeniedSurface));

// PolicyEngine implements Default-Deny (KANON P5).
// Every request starts as DENY and must satisfy ALL of:
//   1. surface NOT in denylist
//   2. buyer_id has an explicit entitlement
//   3. surface is in the entitlement's surface list
//   4. scope is in the entitlement's scope list
//   5. phase matches
//
// Any failure at any step = DENY. No fallbacks, no exceptions.
export class PolicyEngine {
  constructor(private readonly store: EntitlementStore) {}

  decide(req: PolicyRequest): PolicyDecision {
    const base = {
      buyer_id: req.buyer_id,
      surface: req.surface,
      scope: req.scope,
      phase: req.phase,
      request_id: req.request_id,
    };

    // Step 1: denylist check — prevails over any credential (hard rule #1)
    if (DENIED_SURFACES.has(req.surface)) {
      return { ...base, outcome: "DENY", reason: "surface_in_denylist" };
    }

    // Step 2: entitlement existence check
    const entitlement = this.store.get(req.buyer_id);
    if (!entitlement) {
      return { ...base, outcome: "DENY", reason: "no_entitlement_for_buyer" };
    }

    // Step 3: surface authorization
    if (!entitlement.surfaces.includes(req.surface as AllowedSurface)) {
      return { ...base, outcome: "DENY", reason: "surface_not_in_entitlement" };
    }

    // Step 4: scope authorization
    if (!entitlement.scopes.includes(req.scope)) {
      return { ...base, outcome: "DENY", reason: "scope_not_in_entitlement" };
    }

    // Step 5: phase check
    if (entitlement.phase !== req.phase) {
      return { ...base, outcome: "DENY", reason: "phase_mismatch" };
    }

    return { ...base, outcome: "ALLOW", reason: "entitlement_match" };
  }
}
