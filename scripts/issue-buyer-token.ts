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

const [, , buyerId] = process.argv;
if (!buyerId) {
  process.stderr.write("Usage: npx tsx scripts/issue-buyer-token.ts <buyer_id>\n");
  process.exit(1);
}

const keyPair = await loadOrCreateKeyPair();
const issuer = new TokenIssuer(keyPair.privateKey);
const { token, claims } = await issuer.issue(buyerId, BUYER_AUD);

process.stdout.write(token + "\n");
process.stderr.write(
  `[issue] buyer_id=${buyerId} jti=${claims.jti} aud=${claims.aud} exp=${new Date(claims.exp * 1000).toISOString()}\n`
);
