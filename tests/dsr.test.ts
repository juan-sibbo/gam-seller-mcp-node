import { describe, it, expect, beforeEach } from "vitest";
import { DsrToolkit } from "../src/dsr/toolkit.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { createMemoryPseudonyms } from "../src/audit/pseudonym.js";
import { createMemoryAnchor } from "../src/audit/anchor.js";
import { RetentionService, DAY_MS } from "../src/audit/retention.js";
import { EventClass } from "../src/audit/event.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { AllowedSurface } from "../src/policy/types.js";

// S6 F4 — DSR toolkit (gdpr-analysis §Q2): access/portability, restriction, erasure

const BUYER = "test-buyer-001";
const POLICY_REQ = {
  buyer_id: BUYER,
  surface: AllowedSurface.DISCOVERY,
  scope: "gam.readonly",
  phase: "phase-1-readonly",
  request_id: "dsr-test",
};

function buildFixture() {
  const pseudonyms = createMemoryPseudonyms();
  const ledger = createMemoryLedger(pseudonyms);
  const store = new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG);
  const retention = new RetentionService({ hot_days: 90, archive_months: 12 }, createMemoryAnchor());
  const toolkit = new DsrToolkit({ store, ledger, retention });
  return { pseudonyms, ledger, store, retention, toolkit };
}

describe("DsrToolkit — exportBuyer (Art. 15/20)", () => {
  it("export locates entitlement and all ledger entries for the buyer", () => {
    const { ledger, toolkit } = buildFixture();
    ledger.append(EventClass.BUYER_AUTHENTICATION, { result: "ok" }, { buyer_id: BUYER });
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid", buyer_id: BUYER });
    ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "other-buyer" });

    const result = toolkit.exportBuyer(BUYER);

    expect(result.entitlement).not.toBeNull();
    expect(result.hot_ledger_entries).toHaveLength(2);
    expect(result.pseudonym.startsWith("psn_")).toBe(true);
    expect(result.generated_at).toBeTruthy();
  });

  it("export does not include other buyers' entries", () => {
    const { ledger, toolkit } = buildFixture();
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "other-buyer" });
    const result = toolkit.exportBuyer(BUYER);
    expect(result.hot_ledger_entries).toHaveLength(0);
  });

  it("export reaches archived (non-purged) segments", () => {
    const { ledger, retention, toolkit } = buildFixture();
    // Rotate with a cutoff in the future so the just-written entry archives immediately.
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: BUYER });
    retention.rotate(ledger, Date.now() + 100 * DAY_MS); // force-rotate everything current

    const result = toolkit.exportBuyer(BUYER);
    expect(result.archived_entries.length).toBeGreaterThanOrEqual(1);
    expect(result.hot_ledger_entries.filter((e) => e.event_class === EventClass.BUYER_AUTHENTICATION)).toHaveLength(0);
  });
});

describe("DsrToolkit — restrictBuyer (Art. 18)", () => {
  it("restriction produces immediate DENY on all surfaces (Default-Deny does the rest)", () => {
    const { store, toolkit } = buildFixture();
    const policy = new PolicyEngine(store);

    expect(policy.decide(POLICY_REQ).outcome).toBe("ALLOW");
    expect(toolkit.restrictBuyer(BUYER)).toBe(true);
    expect(policy.decide(POLICY_REQ).outcome).toBe("DENY");
  });

  it("restriction preserves the record — reinstatement restores access", () => {
    const { store, toolkit } = buildFixture();
    const policy = new PolicyEngine(store);

    toolkit.restrictBuyer(BUYER);
    expect(store.isSuspended(BUYER)).toBe(true);
    expect(toolkit.unrestrictBuyer(BUYER)).toBe(true);
    expect(policy.decide(POLICY_REQ).outcome).toBe("ALLOW");
  });

  it("restricting an unknown buyer is a safe no-op", () => {
    const { toolkit } = buildFixture();
    expect(toolkit.restrictBuyer("nobody")).toBe(false);
  });
});

describe("DsrToolkit — suppressBuyer (Art. 17 via crypto-shredding)", () => {
  it("suppress shreds the key, removes the entitlement and reports affected entries", () => {
    const { ledger, toolkit } = buildFixture();
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: BUYER });
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "low", buyer_id: BUYER });

    const result = toolkit.suppressBuyer(BUYER);

    expect(result.key_shredded).toBe(true);
    expect(result.entitlement_removed).toBe(true);
    expect(result.anonymized_hot_entries).toBe(2);
  });

  it("after suppress: chain intact, buyer denied, entries not correlatable", () => {
    const { pseudonyms, ledger, store, toolkit } = buildFixture();
    const policy = new PolicyEngine(store);
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: BUYER });

    toolkit.suppressBuyer(BUYER);

    expect(ledger.replayVerify().valid).toBe(true);           // hash-chain untouched
    expect(policy.decide(POLICY_REQ).outcome).toBe("DENY");   // no entitlement
    expect(pseudonyms.hasKey(BUYER)).toBe(false);             // key destroyed
    // A fresh export can no longer correlate: new key → new pseudonym → 0 matches
    expect(toolkit.exportBuyer(BUYER).hot_ledger_entries).toHaveLength(0);
  });

  it("suppress of an unknown buyer reports no-ops, throws nothing", () => {
    const { toolkit } = buildFixture();
    const result = toolkit.suppressBuyer("nobody");
    expect(result.key_shredded).toBe(false);
    expect(result.entitlement_removed).toBe(false);
    expect(result.anonymized_hot_entries).toBe(0);
  });
});
