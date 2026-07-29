// Token revocation CLI — BLOQUEANTE 1 / Bloque A2 (dev deployment, file-backed denylist).
// Usage:
//   npx tsx scripts/revoke-token.ts <token>
//
// Decodes the JWT (no signature check needed — we only need jti + exp) and adds its jti to
// the durable denylist. The denylist PREVAILS over a valid signature (adapter-boundary §4,
// hard rule #1); revocation SLO ≤ 15 min. The entry is kept until the token would have
// naturally expired — after that it can no longer be presented, so pruning it is safe.

import { decodeJwt } from "jose";
import { Denylist, DEV_DENYLIST_PATH } from "../src/identity/denylist.js";
import { DOMAIN2_TTL_SECONDS } from "../src/identity/types.js";

const [, , token] = process.argv;
if (!token) {
  process.stderr.write("Usage: npx tsx scripts/revoke-token.ts <token>\n");
  process.exit(1);
}

let payload: ReturnType<typeof decodeJwt>;
try {
  payload = decodeJwt(token);
} catch {
  process.stderr.write("[revoke] not a decodable JWT — nothing to revoke\n");
  process.exit(1);
}

const jti = payload.jti;
if (typeof jti !== "string" || !jti) {
  process.stderr.write("[revoke] token has no jti — cannot revoke (would denylist nothing)\n");
  process.exit(1);
}

// Fall back to max TTL when exp is absent, so the entry outlives any presentable token.
const expSeconds =
  typeof payload.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + DOMAIN2_TTL_SECONDS;

const denylist = new Denylist(DEV_DENYLIST_PATH);
denylist.add(jti, expSeconds * 1000);
process.stderr.write(
  `[revoke] jti=${jti} revoked, denylisted until ${new Date(expSeconds * 1000).toISOString()} (SLO ≤15min)\n`
);
