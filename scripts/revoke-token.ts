// Buyer token revocation CLI — v0.4 Bloque A. Adds a token's jti to the durable denylist,
// which PREVAILS over a valid signature (adapter-boundary §4, hard rule #1). A running
// server shares the same file-backed denylist in dev, so the revocation takes effect on
// its next validate() call.
//
// Usage:
//   npx tsx scripts/revoke-token.ts <token>                    → decode jti+exp from the token
//   npx tsx scripts/revoke-token.ts --jti <jti> <expiresAtUnixMs>
//
// The denylist keeps an entry only until the token would have naturally expired, so an
// accurate expiry (from the token's exp claim) avoids retaining dead entries.

import { decodeJwt } from "jose";
import { Denylist, DEV_DENYLIST_PATH } from "../src/identity/denylist.js";

function usage(): never {
  process.stderr.write(
    "Usage: npx tsx scripts/revoke-token.ts <token>\n" +
      "       npx tsx scripts/revoke-token.ts --jti <jti> <expiresAtUnixMs>\n"
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

let jti: string;
let expiresAtMs: number;

if (args[0] === "--jti") {
  const [, j, expStr] = args;
  if (!j || !expStr) usage();
  jti = j;
  expiresAtMs = Number(expStr);
  if (!Number.isFinite(expiresAtMs)) usage();
} else {
  const payload = decodeJwt(args[0]);
  if (typeof payload.jti !== "string" || typeof payload.exp !== "number") {
    process.stderr.write("[revoke] token has no jti/exp claim — cannot revoke\n");
    process.exit(1);
  }
  jti = payload.jti;
  expiresAtMs = payload.exp * 1000;
}

const denylist = new Denylist(DEV_DENYLIST_PATH);
denylist.add(jti, expiresAtMs);
process.stderr.write(
  `[revoke] jti=${jti} revoked until ${new Date(expiresAtMs).toISOString()} (denylist size=${denylist.size()})\n`
);
