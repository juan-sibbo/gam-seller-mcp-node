import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { AuditLedger, createMemoryLedger, DEV_LEDGER_PATH } from "../src/audit/ledger.js";
import { DEV_PSEUDONYM_KEYS_PATH } from "../src/audit/pseudonym.js";
import { DEV_ANCHOR_PATH } from "../src/audit/anchor.js";
import { DEV_ARCHIVE_PATH } from "../src/audit/retention.js";
import { DEV_DENYLIST_PATH } from "../src/identity/denylist.js";
import { DEV_KEYSTORE_PATH } from "../src/identity/keystore.js";
import { DEV_DSR_STATE_PATH } from "../src/policy/dsr-state.js";
import { EventClass } from "../src/audit/event.js";

// v0.6 hardening E — persistence must not fail silently or fail-open.

describe("E2 — store paths are CWD-independent (anchored to the module, not the launch dir)", () => {
  it("resolves every persistence path to an absolute location", () => {
    for (const p of [
      DEV_LEDGER_PATH,
      DEV_PSEUDONYM_KEYS_PATH,
      DEV_ANCHOR_PATH,
      DEV_ARCHIVE_PATH,
      DEV_DENYLIST_PATH,
      DEV_KEYSTORE_PATH,
      DEV_DSR_STATE_PATH,
    ]) {
      expect(isAbsolute(p)).toBe(true);
    }
    // The data/keys layout is preserved under the anchored base.
    expect(DEV_LEDGER_PATH.endsWith(join("data", "audit-ledger.json"))).toBe(true);
    expect(DEV_KEYSTORE_PATH.endsWith(join("keys", "node-rs256.private.jwk.json"))).toBe(true);
  });
});

describe("E3 — ledger fails closed on a corrupt on-disk file (does not silently reset to empty)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("throws on corrupt JSON (not ENOENT) instead of resetting to an empty chain", () => {
    dir = mkdtempSync(join(tmpdir(), "ledger-corrupt-"));
    const path = join(dir, "audit-ledger.json");
    writeFileSync(path, "this is not json");
    expect(() => new AuditLedger(path)).toThrow(/fail-closed|FATAL|could not be loaded/i);
  });

  it("initializes an empty chain when the file does not exist yet (first run)", () => {
    dir = mkdtempSync(join(tmpdir(), "ledger-new-"));
    const path = join(dir, "audit-ledger.json");
    // File does not exist — should succeed and start with empty chain.
    const ledger = new AuditLedger(path);
    expect(ledger.size()).toBe(0);
  });
});

describe("E1 — ledger surfaces a failed persist instead of swallowing it", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("flips persistence health to unhealthy on a write failure, without throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "ledger-health-"));
    const ledgerPath = join(dir, "audit-ledger.json");
    // Block save() by creating a DIRECTORY at the .tmp path that the atomic writer uses.
    // writeFileSync on an existing directory fails (EISDIR), so save() will catch and flip
    // the health flag. load() is unaffected: the ledger file itself does not exist yet
    // (ENOENT → normal first-run empty chain). The old approach of placing a file where
    // the parent dir should be caused ENOTDIR in load(), which now fails closed (E3).
    mkdirSync(`${ledgerPath}.tmp`);

    const ledger = new AuditLedger(ledgerPath);
    expect(ledger.isPersistenceHealthy()).toBe(true);

    // The in-memory append still succeeds (we do not drop the entry)...
    const entry = ledger.append(EventClass.BUYER_AUTHENTICATION, { outcome: "allow" });
    expect(entry.seq).toBe(0);
    // ...but the failed disk write is now observable, not hidden.
    expect(ledger.isPersistenceHealthy()).toBe(false);
  });

  it("stays healthy for an in-memory ledger (nothing to persist)", () => {
    const ledger = createMemoryLedger();
    ledger.append(EventClass.BUYER_AUTHENTICATION, { outcome: "allow" });
    expect(ledger.isPersistenceHealthy()).toBe(true);
  });
});
