#!/usr/bin/env -S npx tsx
// DSR operator CLI — dev entry (runs the TypeScript source via tsx, for a checkout of the
// repo). The shipped equivalent is the `gam-seller-dsr` bin (dist/dsr/cli.js). Both delegate
// to the same runDsrCli in src/dsr/cli.ts, so there is a single implementation — no drift.
//
//   npx tsx scripts/dsr.ts <export|restrict|unrestrict|suppress> <buyer_id>
//
// See src/dsr/cli.ts for the command semantics and the GDPR articles each one serves.

import { runDsrCli } from "../src/dsr/cli.js";

process.exit(runDsrCli(process.argv.slice(2)));
