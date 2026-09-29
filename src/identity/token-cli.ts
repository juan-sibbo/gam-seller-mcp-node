// Buyer token issuance/revocation — the operator actions behind `gam-seller-admin issue-token`
// and `revoke-token` (and the dev wrappers scripts/issue-buyer-token.ts / revoke-token.ts).
// Lives in src/ (not scripts/) so it is compiled into dist/ and ships in the npm package and the
// container image: before this, the only implementation was a tsx script that the image does not
// contain, so a containerised node had no way to mint a token.
//
// Both actions write the persistent stores (ledger + anchor, and the denylist for revocation), so
// callers MUST hold the owner lease (src/owner-lease.ts) — see src/admin/cli.ts.

import { loadOrCreateKeyPair } from "./keystore.js";
import { TokenIssuer } from "./issuer.js";
import { BUYER_AUD } from "./types.js";
import { Denylist, DEV_DENYLIST_PATH } from "./denylist.js";
import { recordTokenIssuance, recordTokenRevocation } from "./token-audit.js";
import { AuditLedger, DEV_LEDGER_PATH } from "../audit/ledger.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../audit/anchor.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../audit/pseudonym.js";

export interface IssuedToken {
  token: string;
  jti: string;
  aud: string;
  exp: number;
}

export interface RevokedToken {
  jti: string;
  expiresAtMs: number;
  denylistSize: number;
}

function persistentLedger(): AuditLedger {
  return new AuditLedger(DEV_LEDGER_PATH, new PseudonymService(DEV_PSEUDONYM_KEYS_PATH));
}

// Anchor the new head so the server's fail-closed startup integrity check verifies clean. We
// anchor the head directly (no trailing ANCHORING event) so latestAnchor.head_hash ===
// ledger.headHash() and verifyAfterRestore passes; the server's own anchorHead then no-ops on
// this head. See issue #73.
function anchorHead(ledger: AuditLedger): void {
  new HeadHashAnchor(DEV_ANCHOR_PATH).anchor(ledger.headHash(), ledger.headSeq());
}

// Mint an RS256 buyer token (sub = buyer_id, aud = seller-mcp-node) with the node's persistent
// keypair, so the running node accepts it immediately, and audit the issuance (v0.6 hardening C).
export async function issueBuyerToken(buyerId: string): Promise<IssuedToken> {
  const keyPair = await loadOrCreateKeyPair();
  const { token, claims } = await new TokenIssuer(keyPair.privateKey).issue(buyerId, BUYER_AUD);
  const ledger = persistentLedger();
  recordTokenIssuance(ledger, { buyer_id: buyerId, jti: claims.jti, aud: claims.aud, exp: claims.exp });
  anchorHead(ledger);
  return { token, jti: claims.jti, aud: claims.aud, exp: claims.exp };
}

// Add a jti to the durable denylist, which prevails over a valid signature, and audit it. The
// entry is kept only until the token would have expired naturally. buyerId is known only when
// revoking from the token itself (its sub).
export function revokeBuyerToken(jti: string, expiresAtMs: number, buyerId?: string): RevokedToken {
  const denylist = new Denylist(DEV_DENYLIST_PATH);
  denylist.add(jti, expiresAtMs);
  const ledger = persistentLedger();
  recordTokenRevocation(ledger, { jti, expires_at_ms: expiresAtMs, buyer_id: buyerId });
  anchorHead(ledger);
  return { jti, expiresAtMs, denylistSize: denylist.size() };
}
