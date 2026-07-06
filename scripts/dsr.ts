// DSR operator CLI — dev deployment (file-backed stores).
// Usage:
//   npx tsx scripts/dsr.ts export <buyer_id>     → portable JSON to stdout (Art. 15/20)
//   npx tsx scripts/dsr.ts suppress <buyer_id>   → crypto-shred + report (Art. 17)
//
// Scope note: this CLI operates on the FILE-BACKED stores of a dev deployment
// (ledger, pseudonym keys, archive). Entitlements in dev live in code fixtures and
// are managed in-session; a production deployment moves them to a config file and
// this CLI extends naturally. restrict/reinstate (Art. 18) are runtime operations —
// see DsrToolkit and docs/dsr-procedure.md.

import { AuditLedger, DEV_LEDGER_PATH } from "../src/audit/ledger.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../src/audit/pseudonym.js";
import { RetentionService, DEV_ARCHIVE_PATH } from "../src/audit/retention.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../src/audit/anchor.js";
import { EntitlementStore, DEFAULT_ENTITLEMENTS_CONFIG } from "../src/policy/entitlements.js";
import { loadDeploymentConfigFromFile } from "../src/config/deployment.js";
import { DsrToolkit } from "../src/dsr/toolkit.js";

function usage(): never {
  process.stderr.write("Usage: npx tsx scripts/dsr.ts <export|suppress> <buyer_id>\n");
  process.exit(1);
}

const [, , command, buyerId] = process.argv;
if (!command || !buyerId) usage();

const deployment = loadDeploymentConfigFromFile();
const pseudonyms = new PseudonymService(DEV_PSEUDONYM_KEYS_PATH);
const ledger = new AuditLedger(DEV_LEDGER_PATH, pseudonyms);
const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
const retention = new RetentionService(deployment.retention, anchor, DEV_ARCHIVE_PATH);
const store = new EntitlementStore(DEFAULT_ENTITLEMENTS_CONFIG);
const toolkit = new DsrToolkit({ store, ledger, retention });

switch (command) {
  case "export": {
    const result = toolkit.exportBuyer(buyerId);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    break;
  }
  case "suppress": {
    const result = toolkit.suppressBuyer(buyerId);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.stderr.write(
      `[dsr] crypto-shred ${result.key_shredded ? "done" : "no-op (no key)"} — ` +
        `${result.anonymized_hot_entries + result.anonymized_archived_entries} entries now irreversibly anonymous\n`
    );
    break;
  }
  default:
    usage();
}
