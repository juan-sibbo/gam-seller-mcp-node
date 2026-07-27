// DSR operator CLI — dev deployment (file-backed stores).
// Usage:
//   npx tsx scripts/dsr.ts export <buyer_id>       → portable JSON to stdout (Art. 15/20)
//   npx tsx scripts/dsr.ts restrict <buyer_id>     → suspend entitlement: DENY, record kept (Art. 18)
//   npx tsx scripts/dsr.ts unrestrict <buyer_id>   → lift a restriction (Art. 18)
//   npx tsx scripts/dsr.ts suppress <buyer_id>     → crypto-shred + erase entitlement (Art. 17)
//
// All mutating actions persist to the DSR overlay (data/dsr-state.json), so they survive a
// restart and are re-applied by the server on its next boot. Entitlements are read from the
// real config/entitlements.json — the same source the server uses — so `export` reflects the
// buyer's actual grants (not an empty in-code fixture).
//
// A running server picks up overlay changes on its next restart. Art. 21 (objection) is a
// manual weighing (Recital 49) — see docs/dsr-procedure.md.

import { AuditLedger, DEV_LEDGER_PATH } from "../src/audit/ledger.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../src/audit/pseudonym.js";
import { RetentionService, DEV_ARCHIVE_PATH } from "../src/audit/retention.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../src/audit/anchor.js";
import { EntitlementStore, loadEntitlementsFromFile } from "../src/policy/entitlements.js";
import { DEV_DSR_STATE_PATH } from "../src/policy/dsr-state.js";
import { loadDeploymentConfigFromFile } from "../src/config/deployment.js";
import { DsrToolkit } from "../src/dsr/toolkit.js";

function usage(): never {
  process.stderr.write("Usage: npx tsx scripts/dsr.ts <export|restrict|unrestrict|suppress> <buyer_id>\n");
  process.exit(1);
}

const [, , command, buyerId] = process.argv;
if (!command || !buyerId) usage();

const deployment = loadDeploymentConfigFromFile();
const pseudonyms = new PseudonymService(DEV_PSEUDONYM_KEYS_PATH);
const ledger = new AuditLedger(DEV_LEDGER_PATH, pseudonyms);
const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
const retention = new RetentionService(deployment.retention, anchor, DEV_ARCHIVE_PATH);
// Real entitlements + persistent DSR overlay: restrict/unrestrict/suppress now survive restart.
const store = new EntitlementStore(loadEntitlementsFromFile(), DEV_DSR_STATE_PATH);
const toolkit = new DsrToolkit({ store, ledger, retention });

switch (command) {
  case "export": {
    const result = toolkit.exportBuyer(buyerId);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    break;
  }
  case "restrict": {
    const applied = toolkit.restrictBuyer(buyerId);
    process.stderr.write(
      applied
        ? `[dsr] restricted ${buyerId} — entitlement suspended (Art. 18), persisted to overlay\n`
        : `[dsr] NO-OP — ${buyerId} has no active entitlement to restrict (check the buyer_id)\n`
    );
    break;
  }
  case "unrestrict": {
    const lifted = toolkit.unrestrictBuyer(buyerId);
    process.stderr.write(
      lifted
        ? `[dsr] unrestricted ${buyerId} — entitlement reinstated (Art. 18)\n`
        : `[dsr] NO-OP — ${buyerId} was not under restriction\n`
    );
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
