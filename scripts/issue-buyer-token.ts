// Buyer token issuer CLI — v0.4 Bloque A (buyer→node identity axis).
// Mints an RS256 bearer token a buyer agent presents to the node: sub = buyer_id,
// aud = seller-mcp-node. Signed with the SAME persistent node keypair the server
// validates against (src/identity/keystore.ts), so a freshly issued token is accepted
// immediately. This is the intended way to obtain an identity — there is no anonymous
// buyer path (identity is derived only from the token's sub).
//
// Usage:
//   npx tsx scripts/issue-buyer-token.ts <buyer_id>
//
// Prints the token to stdout; prints jti + expiry to stderr (keep the jti to revoke later).

import { loadOrCreateKeyPair } from "../src/identity/keystore.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { BUYER_AUD } from "../src/identity/types.js";
import { AuditLedger, DEV_LEDGER_PATH } from "../src/audit/ledger.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../src/audit/anchor.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../src/audit/pseudonym.js";
import { recordTokenIssuance } from "../src/identity/token-audit.js";

const [, , buyerId] = process.argv;
if (!buyerId) {
  process.stderr.write("Usage: npx tsx scripts/issue-buyer-token.ts <buyer_id>\n");
  process.exit(1);
}

const keyPair = await loadOrCreateKeyPair();
const issuer = new TokenIssuer(keyPair.privateKey);
const { token, claims } = await issuer.issue(buyerId, BUYER_AUD);

// Audit the issuance (v0.6 hardening C) — same persistent ledger + pseudonym keys the server
// uses, so the event is pseudonymized consistently and joins the shared hash chain.
const ledger = new AuditLedger(DEV_LEDGER_PATH, new PseudonymService(DEV_PSEUDONYM_KEYS_PATH));
recordTokenIssuance(ledger, { buyer_id: buyerId, jti: claims.jti, aud: claims.aud, exp: claims.exp });

// Anchor the new head so the next server startup's fail-closed integrity check verifies clean.
// recordTokenIssuance leaves a non-empty ledger; without a matching anchor the server refuses
// to boot (no_anchor_but_non_empty_ledger). We anchor the head directly (no trailing ANCHORING
// event) so latestAnchor.head_hash === ledger.headHash() and verifyAfterRestore passes; the
// server's own anchorHead then no-ops on this head. See issue #73.
const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
anchor.anchor(ledger.headHash(), ledger.headSeq());

process.stdout.write(token + "\n");
process.stderr.write(
  `[issue] buyer_id=${buyerId} jti=${claims.jti} aud=${claims.aud} exp=${new Date(claims.exp * 1000).toISOString()}\n`
);
