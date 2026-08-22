import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuditLedger } from "../src/audit/ledger.js";
import { createMemoryPseudonyms } from "../src/audit/pseudonym.js";
import { EventClass } from "../src/audit/event.js";

// C-07 / C-18 — rotation state (baseSeq + carryPrevHash) MUST survive a restart.
// Before the fix, save() serialized only `entries`; after a retention rotation + reload the
// chain verified against carryPrevHash="" instead of the real carried hash → a false
// chain_break, which the fail-closed startup verify turns into a refusal to boot. These tests
// pin the durable-rotation-state invariant AND the migration from the legacy bare-array format.

describe("AuditLedger — rotation state persists across restart (C-07)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-rotation-"));
    path = join(dir, "audit-ledger.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedRotatedLedger(): { headHash: string; headSeq: number; size: number } {
    const l = new AuditLedger(path, createMemoryPseudonyms());
    l.append(EventClass.BUYER_AUTHENTICATION, { outcome: "allow" });
    l.append(EventClass.SCOPE_RESOLUTION, { outcome: "ALLOW" });
    l.append(EventClass.INTENT_CREATED, { family_id: "f1" });
    // Rotate out the whole prefix so far → baseSeq advances, carryPrevHash = hash of last removed.
    l.rotateOut(Date.now() + 60_000);
    // Append AFTER rotation so the retained set is non-empty and chains on carryPrevHash.
    l.append(EventClass.INTENT_REVOKED, { intent_id: "i1" });
    l.append(EventClass.ANCHORING, { seq: 4 });
    return { headHash: l.headHash(), headSeq: l.headSeq(), size: l.size() };
  }

  it("a rotated chain still verifies after reload from disk", () => {
    const before = seedRotatedLedger();
    expect(before.headSeq).toBe(4); // baseSeq(3) + 2 retained - 1

    const reloaded = new AuditLedger(path, createMemoryPseudonyms());
    // The core defect: replayVerify must hold across the rotate→restart boundary.
    expect(reloaded.replayVerify().valid).toBe(true);
    // And the global sequence numbering must be preserved, not reset to 0.
    expect(reloaded.headSeq()).toBe(before.headSeq);
    expect(reloaded.headHash()).toBe(before.headHash);
    expect(reloaded.size()).toBe(before.size);
  });

  it("appending after reload continues the chain from the persisted head", () => {
    seedRotatedLedger();
    const reloaded = new AuditLedger(path, createMemoryPseudonyms());
    reloaded.append(EventClass.SCOPE_RESOLUTION, { outcome: "ALLOW" });
    expect(reloaded.replayVerify().valid).toBe(true);
    expect(reloaded.headSeq()).toBe(5); // next global seq after the persisted head (4)
  });

  it("migrates a legacy bare-array ledger file (no schema wrapper) without breaking", () => {
    // An un-rotated legacy ledger persisted as a bare array must still load and verify.
    const legacy = new AuditLedger(path, createMemoryPseudonyms());
    legacy.append(EventClass.BUYER_AUTHENTICATION, { outcome: "allow" });
    legacy.append(EventClass.SCOPE_RESOLUTION, { outcome: "ALLOW" });
    // Rewrite the file in the OLD on-disk shape (bare entries array).
    writeFileSync(path, JSON.stringify(legacy.allEntries(), null, 2), "utf-8");

    const reloaded = new AuditLedger(path, createMemoryPseudonyms());
    expect(reloaded.replayVerify().valid).toBe(true);
    expect(reloaded.headSeq()).toBe(1); // baseSeq 0, two entries
  });
});
