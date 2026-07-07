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
    });
  });

  it("returns undefined for a family with no declared price (Default-Deny posture)", () => {
    const store = new PricingStore(TEST_PRICING_CONFIG);
    expect(store.priceFor("unknown-family")).toBeUndefined();
  });

  it("loads the real config/pricing.json without throwing", () => {
    const store = loadPricingFromFile();
    expect(store.priceFor("display-ros")).toBeDefined();
  });
});
