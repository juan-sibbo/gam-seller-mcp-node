import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { hashBuyerId } from "../src/policy/dsr-state.js";

// #83 — the DSR overlay must NOT retain a raw buyer_id after an Art. 17 erasure. The suppression
// (erasure) list stores a one-way hash instead: enforcement (deny a re-appearing erased buyer)
// only needs to RECOGNISE the same id, not retain it. Restriction (Art. 18, reversible) stays raw.

const BUYER = "test-buyer-001"; // entitled in TEST_ENTITLEMENTS_DEMO_CONFIG

describe("DSR overlay — erasure stores a hash, not the raw buyer_id (#83)", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsr-hash-"));
    path = join(dir, "dsr-state.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the hash (not the raw id) to `suppressed`, tagged schema_version 1", () => {
    const store = new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG, path);
    expect(store.has(BUYER)).toBe(true);
    store.remove(BUYER); // Art. 17 erasure

    const overlay = JSON.parse(readFileSync(path, "utf-8"));
    expect(overlay.schema_version).toBe(1);
    expect(overlay.suppressed).toContain(hashBuyerId(BUYER));
    expect(overlay.suppressed).not.toContain(BUYER); // the raw id must be gone
    // The whole file must not contain the raw id anywhere.
    expect(readFileSync(path, "utf-8")).not.toContain(BUYER);
  });

  it("still denies the erased buyer across a restart (enforcement survives)", () => {
    new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG, path).remove(BUYER);

    const reloaded = new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG, path);
    expect(reloaded.has(BUYER)).toBe(false);
    expect(reloaded.get(BUYER)).toBeUndefined();
  });

  it("migrates a legacy overlay (raw id in `suppressed`, no schema_version) to a hash on load", () => {
    // Simulate a pre-#83 overlay written with the raw buyer_id.
    writeFileSync(path, JSON.stringify({ suppressed: [BUYER], restricted: [] }, null, 2), "utf-8");

    const store = new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG, path);
    // Enforcement holds through the migration.
    expect(store.has(BUYER)).toBe(false);
    expect(store.get(BUYER)).toBeUndefined();

    // And the file has been rewritten with the hash — the raw id no longer persists.
    const overlay = JSON.parse(readFileSync(path, "utf-8"));
    expect(overlay.schema_version).toBe(1);
    expect(overlay.suppressed).toEqual([hashBuyerId(BUYER)]);
    expect(readFileSync(path, "utf-8")).not.toContain(BUYER);
  });

  it("keeps `restricted` as the raw buyer_id (Art. 18 is a reversible limitation)", () => {
    const store = new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG, path);
    store.suspend(BUYER); // Art. 18 restriction

    const overlay = JSON.parse(readFileSync(path, "utf-8"));
    expect(overlay.restricted).toContain(BUYER);
    expect(store.isSuspended(BUYER)).toBe(true);

    // Reinstatement works (needs the raw id) and survives a reload.
    expect(store.reinstate(BUYER)).toBe(true);
    expect(new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG, path).has(BUYER)).toBe(true);
  });
});
