import { createHash } from "crypto";

// 16 read-only audit event classes — decision-package-mcp-consolidated.md Bloque 2 §2.4
// RATIFIED 15/06/26 (owner+security JJ). "Configuration change" is deferrable per §9 and excluded.
// Do not add or remove classes without a signed governance act.
export const EventClass = {
  BUYER_AUTHENTICATION:   "buyer_authentication",
  SCOPE_RESOLUTION:       "scope_resolution",
  FORECAST_REQUEST:       "forecast_request",
  FORECAST_CACHE_FILL:    "forecast_cache_fill",
  INTENT_CREATED:         "intent_created",
  INTENT_EXPIRED:         "intent_expired",
  INTENT_REVOKED:         "intent_revoked",
  SOFT_LOCK_SET:          "soft_lock_set",
  SOFT_LOCK_EXPIRED:      "soft_lock_expired",
  SOFT_LOCK_REVOKED:      "soft_lock_revoked",
  OPERATOR_GATE_APPROVAL: "operator_gate_approval",
  OPERATOR_GATE_REJECTION:"operator_gate_rejection",
  TOKEN_ISSUANCE:         "token_issuance",
  TOKEN_REVOCATION:       "token_revocation",
  ANCHORING:              "anchoring",
  RESTORE:                "restore",
} as const;

export type EventClass = (typeof EventClass)[keyof typeof EventClass];

// Ledger entry — append-only, hash-chained.
// payload: MUST be minimized (no secrets, tokens, SOAP faults, stack traces, GAM IDs,
// raw avails, exact pricing, or unminimized commercial intelligence — KANON §Logs-y-Audit).
// buyer_id and jti are allowed (B2B operator identity, not user-level data).
export interface AuditEvent {
  seq: number;
  event_class: EventClass;
  buyer_id?: string;     // optional; scoped to the actor (P8)
  request_id?: string;   // correlatable by the buyer (safe per soap-redaction §2)
  payload: Record<string, unknown>;
  timestamp: string;     // ISO 8601
  prev_hash: string;     // hash of previous entry ("" for genesis)
  hash: string;          // SHA-256 over canonical fields
}

// Canonical serialization for hashing — field order is deterministic.
export function hashEntry(
  seq: number,
  event_class: EventClass,
  payload: Record<string, unknown>,
  prev_hash: string,
  timestamp: string
): string {
  const canonical = JSON.stringify({ seq, event_class, payload, prev_hash, timestamp });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// Verify a single entry's hash is consistent with its fields.
export function verifyEntryHash(entry: AuditEvent): boolean {
  const expected = hashEntry(entry.seq, entry.event_class, entry.payload, entry.prev_hash, entry.timestamp);
  return expected === entry.hash;
}
