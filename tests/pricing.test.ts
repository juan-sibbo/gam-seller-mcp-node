import { describe, it, expect } from "vitest";
import { PricingStore, loadPricingFromFile, TEST_PRICING_CONFIG } from "../src/pricing/store.js";

// DP-AB-01 §5.2 — firm price origin: publisher-declared static config, not GAM rate cards.
describe("PricingStore — static publisher price config (zero GAM)", () => {
  it("returns the declared price for a known family", () => {
    const store = new PricingStore(TEST_PRICING_CONFIG);
    expect(store.priceFor("display-ros")).toEqual({
      family_id: "display-ros",
      currency: "EUR",
      list_price: 4.5,
      valid_until: "2099-12-31T23:59:59Z",
    });
  });

  it("returns undefined for a family with no declared price (Default-Deny posture)", () => {
    const store = new PricingStore(TEST_PRICING_CONFIG);
    expect(store.priceFor("unknown-family")).toBeUndefined();
  });

  it("loads the real config/pricing.json without throwing", () => {
    const store = loadPricingFromFile();
    // Pin `now` before the config's valid_until so this test does not silently start
    // failing once the demo prices expire.
    const beforeExpiry = new Date("2026-01-01T00:00:00Z");
    expect(store.priceFor("display-ros", beforeExpiry)).toBeDefined();
  });
});

// D7 — stale firm price must fail closed rather than compromise the publisher's word.
describe("PricingStore — valid_until fail-closed", () => {
  const config = {
    prices: [
      { family_id: "display-ros", currency: "EUR", list_price: 4.5, valid_until: "2026-06-30T00:00:00Z" },
    ],
  };

  it("serves a firm price while it is still valid", () => {
    const store = new PricingStore(config);
    const before = new Date("2026-06-29T23:59:59Z");
    expect(store.priceFor("display-ros", before)).toBeDefined();
  });

  it("fails closed to undefined once the price has expired", () => {
    const store = new PricingStore(config);
    const after = new Date("2026-07-01T00:00:00Z");
    expect(store.priceFor("display-ros", after)).toBeUndefined();
  });

  it("treats valid_until as exclusive: not served at the exact expiry instant", () => {
    const store = new PricingStore(config);
    const atExpiry = new Date("2026-06-30T00:00:00Z");
    expect(store.priceFor("display-ros", atExpiry)).toBeUndefined();
  });

  it("throws on a missing valid_until (fail closed on malformed config)", () => {
    const bad = { prices: [{ family_id: "x", currency: "EUR", list_price: 1 }] } as unknown as {
      prices: { family_id: string; currency: string; list_price: number; valid_until: string }[];
    };
    expect(() => new PricingStore(bad)).toThrow(/valid_until/);
  });

  it("throws on an unparseable valid_until (fail closed on malformed config)", () => {
    const bad = {
      prices: [{ family_id: "x", currency: "EUR", list_price: 1, valid_until: "not-a-date" }],
    };
    expect(() => new PricingStore(bad)).toThrow(/valid_until/);
  });
});
