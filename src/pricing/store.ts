import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// Firm list price per product family — DP-AB-01 §5.2 (origin resolved 07/07/26).
// Publisher-declared, static config, same shape as catalog.json's families. This is
// deliberately NOT a live GAM rate-card fetch: under A′, execution is derived to a
// classic direct deal, so the "firm" price is already a list price negotiated outside
// GAM, not a real-time ad-server read. Keeps the GAM adapter avails-only under A′.
export interface FamilyPrice {
  family_id: string;
  currency: string;
  list_price: number;
  // ISO 8601 instant after which this firm price is stale and must not be served.
  // A stale firm price shown to an entitled buyer is worse than no price: it
  // compromises the publisher's word. So an expired price fails closed to
  // undefined (Default-Deny) rather than being served — see priceFor().
  valid_until: string;
}

interface PricingConfig {
  prices: FamilyPrice[];
}

// Break mode of the SEC-GATE-13 bisturí (DP-AB-01 §5.1): the firm-offer-price surface
// is only safe while the price is a SINGLE static LIST price, uniform across every
// entitled buyer. A per-buyer negotiated price would let a competitor with several
// seats reconstruct the publisher's discount curve from the observed firm offers —
// i.e. firm-offer-price collapses back into commercial intelligence. If pricing ever
// becomes per-buyer, that reopens SEC-GATE-13 and needs a fresh owner+security co-sign.
// This store only ever serves the uniform list price, and only while it is still valid.
//
// ponytail: not wired into server.ts/discover_products yet — the pricing_options surface
// requires the SEC-GATE-13 bisturí (EXACT_PRICING denylist split, DP-AB-01 §3/§5.1) to
// land first. This is the config seam only.
export class PricingStore {
  private readonly prices: Map<string, FamilyPrice>;

  constructor(config: PricingConfig) {
    // Fail closed on malformed config (same posture as the catalog/entitlements loaders):
    // a missing or unparseable valid_until means we cannot reason about staleness, so we
    // refuse to start rather than risk serving a price we can't age out.
    for (const p of config.prices) {
      if (typeof p.valid_until !== "string" || Number.isNaN(Date.parse(p.valid_until))) {
        throw new Error(
          `PricingStore: family "${p.family_id}" has a missing or invalid valid_until ` +
            `(expected an ISO 8601 timestamp)`
        );
      }
    }
    this.prices = new Map(config.prices.map((p) => [p.family_id, p]));
  }

  // Returns the firm price only if it is declared AND has not expired. An expired firm
  // price fails closed to undefined (Default-Deny). `now` is injectable for testing.
  priceFor(family_id: string, now: Date = new Date()): FamilyPrice | undefined {
    const price = this.prices.get(family_id);
    if (price === undefined) {
      return undefined;
    }
    if (Date.parse(price.valid_until) <= now.getTime()) {
      return undefined;
    }
    return price;
  }
}

export function loadPricingFromFile(configPath?: string): PricingStore {
  const path =
    configPath ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../config/pricing.json"
    );
  const raw = readFileSync(path, "utf-8");
  return new PricingStore(JSON.parse(raw) as PricingConfig);
}

// Test fixture — used in tests without disk I/O. Far-future valid_until so these prices
// are always current; expiry behaviour is exercised explicitly in the store's tests.
export const TEST_PRICING_CONFIG: PricingConfig = {
  prices: [
    { family_id: "display-ros", currency: "EUR", list_price: 4.5, valid_until: "2099-12-31T23:59:59Z" },
    { family_id: "video-pre-roll", currency: "EUR", list_price: 18, valid_until: "2099-12-31T23:59:59Z" },
    { family_id: "branded-content", currency: "EUR", list_price: 45, valid_until: "2099-12-31T23:59:59Z" },
  ],
};
