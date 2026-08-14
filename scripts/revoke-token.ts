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
import { AuditLedger, DEV_LEDGER_PATH } from "../src/audit/ledger.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../src/audit/pseudonym.js";
import { recordTokenRevocation } from "../src/identity/token-audit.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../src/audit/anchor.js";

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
// Known only on the token path (from the token's sub); the --jti path has no buyer identity.
let buyerId: string | undefined;

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
  buyerId = typeof payload.sub === "string" ? payload.sub : undefined;
}

const denylist = new Denylist(DEV_DENYLIST_PATH);
denylist.add(jti, expiresAtMs);

// Audit the revocation (v0.6 hardening C) — a security-critical act that previously left no
// ledger trail. Same persistent ledger + pseudonym keys as the server.
const ledger = new AuditLedger(DEV_LEDGER_PATH, new PseudonymService(DEV_PSEUDONYM_KEYS_PATH));
recordTokenRevocation(ledger, { jti, expires_at_ms: expiresAtMs, buyer_id: buyerId });

// Anchor the ledger head after writing to prevent no_anchor_but_non_empty_ledger on next startup
// (fix for #73/#74 class of bug: CLI writes to ledger without anchoring).
const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
anchor.anchor(ledger.headHash(), ledger.headSeq());

process.stderr.write(
  `[revoke] jti=${jti} revoked until ${new Date(expiresAtMs).toISOString()} (denylist size=${denylist.size()})\n`
);
