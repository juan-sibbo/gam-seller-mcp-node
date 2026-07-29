import type { AuditLedger } from "../audit/ledger.js";
import { EventClass } from "../audit/event.js";

// Token-lifecycle audit emission — v0.6 hardening (item C).
//
// Issuing and revoking a buyer token are security-critical operator acts. The ratified
// taxonomy already declared TOKEN_ISSUANCE / TOKEN_REVOCATION (audit/event.ts) but left them
// without an emitter, so today the CLIs populate the keystore/denylist leaving NO ledger
// trail — a revocation, in particular, is an untraceable security act. These helpers wire the
// emitters so both acts land on the append-only, hash-chained ledger.
//
// Payload minimization (KANON §Logs-y-Audit): the token itself is NEVER logged. buyer_id
// (pseudonymized by the ledger before hashing) and jti are allowed operator identity
// (audit/event.ts §payload — B2B, not user-level data). jti rides in request_id so the act
// is correlatable to the exact token without adding a bespoke field.

export function recordTokenIssuance(
  ledger: AuditLedger,
  params: { buyer_id: string; jti: string; aud: string; exp: number }
): void {
  ledger.append(
    EventClass.TOKEN_ISSUANCE,
    { aud: params.aud, exp: params.exp },
    { buyer_id: params.buyer_id, request_id: params.jti }
  );
}

export function recordTokenRevocation(
  ledger: AuditLedger,
  params: { jti: string; expires_at_ms: number; buyer_id?: string }
): void {
  // buyer_id is known only when the caller revokes by presenting the token (its sub); the
  // --jti path has none, and ledger.append drops a falsy buyer_id.
  ledger.append(
    EventClass.TOKEN_REVOCATION,
    { revoked_until: new Date(params.expires_at_ms).toISOString() },
    { buyer_id: params.buyer_id, request_id: params.jti }
  );
}
