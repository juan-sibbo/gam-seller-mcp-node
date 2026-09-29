// Buyer token issuer — dev entry (runs the TypeScript source via tsx, for a checkout of the repo).
// The shipped equivalent is `gam-seller-admin issue-token` (dist/admin/cli.js); both run the same
// code in src/identity/token-cli.ts, as the single state owner (refused while the node runs).
//
// Usage:
//   npx tsx scripts/issue-buyer-token.ts <buyer_id>
//
// Prints the token to stdout; prints jti + expiry to stderr (keep the jti to revoke later).

import { runAdminCli } from "../src/admin/cli.js";

process.exit(await runAdminCli(["issue-token", ...process.argv.slice(2)]));
