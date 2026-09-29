// Buyer token revocation — dev entry (runs the TypeScript source via tsx, for a checkout of the
// repo). The shipped equivalent is `gam-seller-admin revoke-token` (dist/admin/cli.js); both run
// the same code in src/identity/token-cli.ts, as the single state owner (refused while the node
// runs — a live node would not see the revocation until restart).
//
// Usage:
//   npx tsx scripts/revoke-token.ts <token>                    → decode jti+exp from the token
//   npx tsx scripts/revoke-token.ts --jti <jti> <expiresAtUnixMs>

import { runAdminCli } from "../src/admin/cli.js";

process.exit(await runAdminCli(["revoke-token", ...process.argv.slice(2)]));
