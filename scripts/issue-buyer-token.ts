// Buyer token issuer CLI — BLOQUEANTE 1 / Bloque A2 (dev deployment, persistent key).
// Usage:
//   npx tsx scripts/issue-buyer-token.ts <buyer_id>
//
// Prints a signed buyer→node JWT to stdout (aud=seller-mcp-node, sub=buyer_id). The buyer
// presents this token on discover_products / get_forecast; authenticate() binds token.sub
// to the requested buyer_id, so the token IS the buyer's identity. MVP self-issued with the
// node's persistent RS256 key (keys/ gitignored); Decisión 2 migrates toward bearer/JWKS.

import { loadOrCreateKeyPair } from "../src/identity/keystore.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { BUYER_AUD } from "../src/identity/types.js";

async function main(): Promise<void> {
  const [, , buyerId] = process.argv;
  if (!buyerId) {
    process.stderr.write("Usage: npx tsx scripts/issue-buyer-token.ts <buyer_id>\n");
    process.exit(1);
  }

  const keyPair = await loadOrCreateKeyPair();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const { token, claims } = await issuer.issue(buyerId, BUYER_AUD);

  // Diagnostics to stderr, token to stdout — so `... | tr -d '\n'` captures only the token.
  process.stderr.write(
    `[issue] buyer_id=${buyerId} jti=${claims.jti} aud=${claims.aud} exp=${new Date(claims.exp * 1000).toISOString()}\n`
  );
  process.stdout.write(token + "\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
