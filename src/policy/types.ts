// Surfaces authorized by adapter-boundary-allowed-surfaces-signoff.md §3 (allowlist MVP).
// Adding a surface here requires an amendment to the allowlist signoff.
export const AllowedSurface = {
  DISCOVERY: "discovery",
  PRODUCT_DISCOVERY: "product_discovery",
  FORECAST: "forecast",
  WELL_KNOWN: "well_known",
  AUTH_CONTEXT: "auth_context",
  ERROR_ENVELOPE: "error_envelope",
} as const;

export type AllowedSurface = (typeof AllowedSurface)[keyof typeof AllowedSurface];

// Denied surfaces — adapter-boundary-allowed-surfaces-signoff.md §4.
// Denylist PREVAILS over a valid token (hard rule #1).
// This list is exhaustive for MVP. Expansion requires a signed governance act.
export const DeniedSurface = {
  ORDER_CREATE: "order_create",
  DEAL_CREATE: "deal_create",
  MEDIA_BUY: "media_buy",
  INVENTORY_RESERVE: "inventory_reserve",
  DEAL_MUTATE: "deal_mutate",
  RAW_AVAILS: "raw_avails",
  GAM_IDS: "gam_ids",
  GAM_OBJECTS: "gam_objects",
  EXACT_PRICING: "exact_pricing",
  CROSS_BUYER_STATE: "cross_buyer_state",
  GAM_ADMIN: "gam_admin",
  SOAP_FAULTS: "soap_faults",
  CREDENTIAL_INTERNALS: "credential_internals",
  SOFT_LOCK_STATE: "soft_lock_state",
} as const;

export type DeniedSurface = (typeof DeniedSurface)[keyof typeof DeniedSurface];

// A policy request carries all inputs the engine needs to decide — KANON P5 + g4-phase1 §5.
// Every decision is bound to: actor, buyer_id, scope, phase, resource.
export interface PolicyRequest {
  buyer_id: string;
  surface: string;
  scope: string;
  phase: string;
  request_id: string;
}

export type PolicyOutcome = "ALLOW" | "DENY";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  buyer_id: string;
  surface: string;
  scope: string;
  phase: string;
  request_id: string;
  // reason is INTERNAL ONLY — never buyer-facing (soap-fault-redaction-signoff.md §2)
  reason: string;
}

// An entitlement grants a buyer_id explicit access to a surface+scope combination.
// Absence of entitlement = DENY (Default-Deny, KANON P5).
export interface Entitlement {
  buyer_id: string;
  surfaces: AllowedSurface[];
  scopes: string[];
  phase: string;
}
