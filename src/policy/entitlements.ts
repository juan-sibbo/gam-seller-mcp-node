import { readFileSync } from "fs";
import { resolveConfigPath } from "../config/resolve.js";
import type { Entitlement } from "./types.js";
import { AllowedSurface } from "./types.js";
import { loadDsrState, saveDsrState, hashBuyerId, DSR_STATE_SCHEMA_VERSION, type DsrState } from "./dsr-state.js";

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
  // Art. 17 GDPR erasure: buyer_ids removed by a data-subject request. Tracked so the
  // erasure is durable across restarts and survives a later config re-grant.
  private readonly erased: Set<string>;
  // When set, DSR overrides (restrict/reinstate/erase) are persisted to this overlay file
  // and re-applied on construction. Null = pure in-memory store (unchanged legacy behavior).
  private readonly persistPath: string | null;

  constructor(config: EntitlementsConfig, persistPath: string | null = null) {
    this.index = new Map(config.entitlements.map((e) => [e.buyer_id, e]));
    this.suspended = new Map();
    this.erased = new Set();
    this.persistPath = persistPath;
    if (persistPath) {
      const migrated = this.applyOverlay(loadDsrState(persistPath));
      // A legacy overlay stored raw buyer_ids in `suppressed`; applyOverlay hashed them into
      // `erased`. Re-persist once so the raw ids are replaced on disk by their hashes (#83).
      if (migrated) this.persist();
    }
  }

  // Re-apply persisted DSR overrides on top of the config-derived index. Erasure takes precedence
  // over restriction. `erased` holds HASHES (#83); a v1 overlay stores hashes, a legacy overlay
  // stores raw ids that are hashed here on load. Returns true if a legacy overlay was migrated.
  private applyOverlay(state: DsrState): boolean {
    const legacy = state.schema_version !== DSR_STATE_SCHEMA_VERSION;
    for (const entry of state.suppressed) {
      // v1 entries are already hashes; legacy entries are raw and must be hashed now.
      this.erased.add(legacy ? hashBuyerId(entry) : entry);
    }
    // `restricted` is always the raw buyer_id (a reversible Art. 18 restriction). Move the
    // config-granted entitlement into `suspended`, skipping any buyer whose id is erased.
    for (const buyer_id of state.restricted) {
      if (this.erased.has(hashBuyerId(buyer_id))) continue;
      const entitlement = this.index.get(buyer_id);
      if (entitlement) {
        this.index.delete(buyer_id);
        this.suspended.set(buyer_id, entitlement);
      }
    }
    return legacy && state.suppressed.length > 0;
  }

  // Write the current DSR override set to the overlay file. No-op for in-memory stores.
  private persist(): void {
    if (!this.persistPath) return;
    saveDsrState(this.persistPath, {
      schema_version: DSR_STATE_SCHEMA_VERSION,
      suppressed: [...this.erased], // hashes (#83)
      restricted: [...this.suspended.keys()], // raw (reversible Art. 18)
    });
  }

  get(buyer_id: string): Entitlement | undefined {
    // An erased buyer must never be served, even if a later config re-grant put them back in the
    // index — `erased` (hashed) is the authoritative "must never be served" set (#83).
    if (this.erased.has(hashBuyerId(buyer_id))) return undefined;
    return this.index.get(buyer_id);
  }

  has(buyer_id: string): boolean {
    return this.index.has(buyer_id) && !this.erased.has(hashBuyerId(buyer_id));
  }

  // DSR restriction (Art. 18): stop processing without deleting the record.
  suspend(buyer_id: string): boolean {
    const entitlement = this.index.get(buyer_id);
    if (!entitlement) return false;
    this.index.delete(buyer_id);
    this.suspended.set(buyer_id, entitlement);
    this.persist();
    return true;
  }

  reinstate(buyer_id: string): boolean {
    const entitlement = this.suspended.get(buyer_id);
    if (!entitlement) return false;
    this.suspended.delete(buyer_id);
    this.index.set(buyer_id, entitlement);
    this.persist();
    return true;
  }

  isSuspended(buyer_id: string): boolean {
    return this.suspended.has(buyer_id);
  }

  // DSR erasure (Art. 17): remove the record entirely (active or suspended) and record the
  // erasure durably, so it persists across restarts and is not undone by a later config re-grant.
  remove(buyer_id: string): boolean {
    const removed = this.index.delete(buyer_id) || this.suspended.delete(buyer_id);
    this.erased.add(hashBuyerId(buyer_id)); // store the hash, never the raw id (#83)
    this.persist();
    return removed;
  }
}

// Default dev config — no buyer has any entitlement by default.
// Add entries here (or via config file) to grant access during testing.
export const DEFAULT_ENTITLEMENTS_CONFIG: EntitlementsConfig = {
  entitlements: [],
};

const VALID_SURFACES: ReadonlySet<string> = new Set(Object.values(AllowedSurface));

// Fail-closed validation: a node with an invalid entitlements config must not start
// (same criterion as config/deployment.ts) — silently ignoring a malformed entry would
// mean serving with a different access set than whoever wrote the file intended.
// An explicitly empty `entitlements: []` is a valid deployment state (Default-Deny already
// covers it), not an error.
export function validateEntitlementsConfig(raw: unknown): EntitlementsConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("entitlements config: not an object");
  }
  const entitlements = (raw as Record<string, unknown>)["entitlements"];
  if (!Array.isArray(entitlements)) {
    throw new Error("entitlements config: entitlements must be an array");
  }

  return {
    entitlements: entitlements.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`entitlements config: entitlements[${i}] is not an object`);
      }
      const e = entry as Record<string, unknown>;

      const buyerId = e["buyer_id"];
      if (typeof buyerId !== "string" || buyerId.trim() === "") {
        throw new Error(`entitlements config: entitlements[${i}].buyer_id must be a non-empty string`);
      }

      const surfaces = e["surfaces"];
      if (!Array.isArray(surfaces) || !surfaces.every((s) => typeof s === "string" && VALID_SURFACES.has(s))) {
        throw new Error(
          `entitlements config: entitlements[${i}].surfaces must only contain ${[...VALID_SURFACES].join(", ")}`
        );
      }

      const scopes = e["scopes"];
      if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
        throw new Error(`entitlements config: entitlements[${i}].scopes must be a non-empty string array`);
      }

      const phase = e["phase"];
      if (typeof phase !== "string" || phase.trim() === "") {
        throw new Error(`entitlements config: entitlements[${i}].phase must be a non-empty string`);
      }

      return { buyer_id: buyerId, surfaces: surfaces as AllowedSurface[], scopes, phase };
    }),
  };
}

export function loadEntitlementsFromFile(configPath?: string): EntitlementsConfig {
  const path = configPath ?? resolveConfigPath("entitlements.json");
  const raw = readFileSync(path, "utf-8");
  return validateEntitlementsConfig(JSON.parse(raw));
}

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

// Test fixture: v0.5 Bloque B — buyers entitled to the INTENT commitment surface.
// Two buyers so cross-buyer isolation (a buyer can't revoke another's intent) is testable.
export const TEST_ENTITLEMENTS_INTENT_CONFIG: EntitlementsConfig = {
  entitlements: [
    {
      buyer_id: "test-buyer-001",
      surfaces: [
        AllowedSurface.DISCOVERY,
        AllowedSurface.WELL_KNOWN,
        AllowedSurface.PRODUCT_DISCOVERY,
        AllowedSurface.INTENT,
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
        AllowedSurface.INTENT,
      ],
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
