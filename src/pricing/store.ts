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
}

interface PricingConfig {
  prices: FamilyPrice[];
}

// PricingStore — read-only, static config, zero GAM.
// ponytail: not wired into server.ts/discover_products yet — pricing_options requires
// the SEC-GATE-13 bisturí (EXACT_PRICING denylist split into commercial-intelligence vs.
// firm-offer-price, DP-AB-01 §3/§5.1) to land first. This is the config seam only.
export class PricingStore {
  private readonly prices: Map<string, FamilyPrice>;

  constructor(config: PricingConfig) {
    this.prices = new Map(config.prices.map((p) => [p.family_id, p]));
  }

  priceFor(family_id: string): FamilyPrice | undefined {
    return this.prices.get(family_id);
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

// Test fixture — used in tests without disk I/O.
export const TEST_PRICING_CONFIG: PricingConfig = {
  prices: [
    { family_id: "display-ros", currency: "EUR", list_price: 4.5 },
    { family_id: "video-pre-roll", currency: "EUR", list_price: 18 },
    { family_id: "branded-content", currency: "EUR", list_price: 45 },
  ],
};
