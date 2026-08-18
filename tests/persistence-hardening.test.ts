import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { AuditLedger, createMemoryLedger, DEV_LEDGER_PATH } from "../src/audit/ledger.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "../src/audit/pseudonym.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH } from "../src/audit/anchor.js";
import { RetentionService, DEV_ARCHIVE_PATH } from "../src/audit/retention.js";
import { Denylist, DEV_DENYLIST_PATH } from "../src/identity/denylist.js";
import { IntentStore } from "../src/intent/store.js";
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

// E1 (extended, issue #51) — the OTHER file-backed stores must surface a failed persist the
// same way the ledger does (health flag + ERROR), instead of swallowing it as a benign WARNING.
// Blocking technique: point the store at <dir>/sub/<file> while <dir>/sub does not exist yet
// (constructor load() → ENOENT → healthy empty), then drop a FILE at <dir>/sub so the next
// save()'s mkdirSync/writeFileSync fails (EEXIST/ENOTDIR) and is caught.
describe("E1 (issue #51) — every file-backed store surfaces a failed persist, not just the ledger", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function blockedStorePath(prefix: string): string {
    dir = mkdtempSync(join(tmpdir(), prefix));
    return join(dir, "sub", "store.json");
  }

  function blockWrites(): void {
    // Turn the missing "sub" dir into a FILE so the store's next mkdirSync/writeFileSync throws.
    writeFileSync(join(dir!, "sub"), "x");
  }

  it("denylist flips to unhealthy when its write is blocked", () => {
    const denylist = new Denylist(blockedStorePath("denylist-health-"));
    expect(denylist.isPersistenceHealthy()).toBe(true);
    blockWrites();
    denylist.add("jti-1", Date.now() + 60_000);
    expect(denylist.isPersistenceHealthy()).toBe(false);
  });

  it("intent store flips to unhealthy when its write is blocked", () => {
    const intents = new IntentStore(undefined, blockedStorePath("intent-health-"));
    expect(intents.isPersistenceHealthy()).toBe(true);
    blockWrites();
    intents.create({
      buyer_id: "b1",
      family_id: "f1",
      period: "2026-Q1",
      firm_price: 1.5,
      currency: "EUR",
      price_valid_until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(intents.isPersistenceHealthy()).toBe(false);
  });

  it("pseudonym key store flips to unhealthy when its write is blocked", () => {
    const pseudonyms = new PseudonymService(blockedStorePath("pseudonym-health-"));
    expect(pseudonyms.isPersistenceHealthy()).toBe(true);
    blockWrites();
    pseudonyms.pseudonymize("buyer-1"); // first use mints + persists a per-buyer key
    expect(pseudonyms.isPersistenceHealthy()).toBe(false);
  });

  it("anchor flips to unhealthy when its write is blocked", () => {
    const anchor = new HeadHashAnchor(blockedStorePath("anchor-health-"));
    expect(anchor.isPersistenceHealthy()).toBe(true);
    blockWrites();
    anchor.anchor("deadbeef", 0);
    expect(anchor.isPersistenceHealthy()).toBe(false);
  });

  it("retention archive flips to unhealthy when its write is blocked", () => {
    const path = blockedStorePath("retention-health-");
    const anchor = new HeadHashAnchor(null); // in-memory anchor, stays healthy
    const ledger = createMemoryLedger();
    ledger.append(EventClass.BUYER_AUTHENTICATION, { outcome: "allow" });
    const retention = new RetentionService({ hot_days: 90, archive_months: 12 }, anchor, path);
    expect(retention.isPersistenceHealthy()).toBe(true);
    blockWrites();
    // Rotate with "now" 200 days ahead so the single entry is past the 90-day hot window.
    const future = Date.now() + 200 * 24 * 60 * 60 * 1000;
    const segment = retention.rotate(ledger, future);
    expect(segment).not.toBeNull();
    expect(retention.isPersistenceHealthy()).toBe(false);
  });

  it("all five stores start healthy in-memory (nothing to persist)", () => {
    expect(new Denylist(null).isPersistenceHealthy()).toBe(true);
    expect(new IntentStore(undefined, null).isPersistenceHealthy()).toBe(true);
    expect(new PseudonymService(null).isPersistenceHealthy()).toBe(true);
    expect(new HeadHashAnchor(null).isPersistenceHealthy()).toBe(true);
    expect(
      new RetentionService({ hot_days: 90, archive_months: 12 }, new HeadHashAnchor(null), null)
        .isPersistenceHealthy()
    ).toBe(true);
  });
});
