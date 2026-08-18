#!/usr/bin/env node
// DSR operator CLI — GDPR Art. 15/17/18/20 for buyer audit data.
//
// Shipped as the `gam-seller-dsr` bin (DRIFT-REPORT D6) so a publisher who installs the node
// via npm/Docker can service a data-subject request WITHOUT cloning the source repo. The dev
// entry `scripts/dsr.ts` (source, via tsx) delegates to the same `runDsrCli`, so there is one
// implementation, not two that can drift.
//
// Usage:
//   gam-seller-dsr export <buyer_id>       → portable JSON to stdout (Art. 15/20)
//   gam-seller-dsr restrict <buyer_id>     → suspend entitlement: DENY, record kept (Art. 18)
//   gam-seller-dsr unrestrict <buyer_id>   → lift a restriction (Art. 18)
//   gam-seller-dsr suppress <buyer_id>     → crypto-shred + erase entitlement (Art. 17)
//
// It operates on the same file-backed stores the server persists — paths honor MCP_DATA_DIR
// via config/paths — so an erasure here is the same erasure the running node reflects on its
// next restart. This is not a separate copy of the data.

import { AuditLedger, DEV_LEDGER_PATH } from "../audit/ledger.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../audit/pseudonym.js";
import { RetentionService, DEV_ARCHIVE_PATH } from "../audit/retention.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../audit/anchor.js";
import { EntitlementStore, loadEntitlementsFromFile } from "../policy/entitlements.js";
import { DEV_DSR_STATE_PATH } from "../policy/dsr-state.js";
import { loadDeploymentConfigFromFile } from "../config/deployment.js";
import { DsrToolkit } from "./toolkit.js";
import { IntentStore, DEV_INTENT_PATH } from "../intent/store.js";
import { isEntrypoint } from "../entrypoint.js";

// Narrow seam over the toolkit: exactly the methods the CLI drives. A test injects a fake so
// it can exercise command dispatch without wiring the file-backed stores (their paths are
// resolved once at module load, so they cannot be redirected in-process — see config/paths).
export type DsrToolkitLike = Pick<
  DsrToolkit,
  "exportBuyer" | "restrictBuyer" | "unrestrictBuyer" | "suppressBuyer"
>;

export interface DsrCliOptions {
  // Defaults to the real, file-backed wiring. Overridden in tests.
  makeToolkit?: () => DsrToolkitLike;
  // Default to the process streams; injectable so a test can capture without spying globals.
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const COMMANDS = ["export", "restrict", "unrestrict", "suppress"] as const;
type DsrCommand = (typeof COMMANDS)[number];

// Wire the real, file-backed stores — identical to what the server constructs (server.ts),
// so the CLI reads and writes the very state the node serves. Deferred until after argument
// validation so a usage error never touches the disk.
function defaultToolkit(): DsrToolkit {
  const deployment = loadDeploymentConfigFromFile();
  const pseudonyms = new PseudonymService(DEV_PSEUDONYM_KEYS_PATH);
  const ledger = new AuditLedger(DEV_LEDGER_PATH, pseudonyms);
  const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
  const retention = new RetentionService(deployment.retention, anchor, DEV_ARCHIVE_PATH);
  // Real entitlements + persistent DSR overlay: restrict/unrestrict/suppress survive restart.
  const store = new EntitlementStore(loadEntitlementsFromFile(), DEV_DSR_STATE_PATH);
  // intents.json is the only store holding a raw buyer_id, so export/suppress must reach it
  // (Art. 15/20 completeness + Art. 17 erasure).
  const intentStore = new IntentStore(undefined, DEV_INTENT_PATH);
  return new DsrToolkit({ store, ledger, retention, intentStore });
}

// Returns a process exit code (0 = ok, 1 = usage error). Deliberately does NOT call
// process.exit itself so it stays unit-testable; the bin entry maps the return value to the
// process exit code.
export function runDsrCli(argv: string[], options: DsrCliOptions = {}): number {
  const out = options.out ?? ((line) => void process.stdout.write(line));
  const err = options.err ?? ((line) => void process.stderr.write(line));
  const [command, buyerId] = argv;

  if (!command || !buyerId || !COMMANDS.includes(command as DsrCommand)) {
    err(`Usage: gam-seller-dsr <${COMMANDS.join("|")}> <buyer_id>\n`);
    return 1;
  }

  const toolkit = (options.makeToolkit ?? defaultToolkit)();

  switch (command as DsrCommand) {
    case "export":
      out(JSON.stringify(toolkit.exportBuyer(buyerId), null, 2) + "\n");
      return 0;
    case "restrict":
      err(
        toolkit.restrictBuyer(buyerId)
          ? `[dsr] restricted ${buyerId} — entitlement suspended (Art. 18), persisted to overlay\n`
          : `[dsr] NO-OP — ${buyerId} has no active entitlement to restrict (check the buyer_id)\n`
      );
      return 0;
    case "unrestrict":
      err(
        toolkit.unrestrictBuyer(buyerId)
          ? `[dsr] unrestricted ${buyerId} — entitlement reinstated (Art. 18)\n`
          : `[dsr] NO-OP — ${buyerId} was not under restriction\n`
      );
      return 0;
    case "suppress": {
      const result = toolkit.suppressBuyer(buyerId);
      out(JSON.stringify(result, null, 2) + "\n");
      err(
        `[dsr] crypto-shred ${result.key_shredded ? "done" : "no-op (no key)"} — ` +
          `${result.anonymized_hot_entries + result.anonymized_archived_entries} entries now irreversibly anonymous\n`
      );
      return 0;
    }
  }
}

// Run only when invoked directly (as the bin), not when imported by a test. isEntrypoint is
// symlink-aware — the npx bin is a node_modules/.bin symlink (see src/entrypoint.ts, #60).
if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exit(runDsrCli(process.argv.slice(2)));
}
