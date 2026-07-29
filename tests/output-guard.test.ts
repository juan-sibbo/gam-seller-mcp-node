import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { projectFamily } from "../src/catalog/projection.js";
import type { ProductFamily } from "../src/catalog/store.js";
import { CatalogStore } from "../src/catalog/store.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { BUYER_ISS, BUYER_AUD } from "../src/identity/types.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_WITH_PRODUCTS_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";

// Discovery output guard (C4, audit §5.4). The no-leak of discover_products must be
// STRUCTURAL — a function of the code's egress projection, not of catalog-editing discipline.
// projectFamily copies only buyer-facing fields by name; a sensitive key added to config
// (internal floor, GAM line-item id, deal ref) must never reach a buyer.

const ENTITLED_BUYER = "test-buyer-001";

describe("projectFamily — buyer-facing discovery projection", () => {
  const base: ProductFamily = {
    family_id: "display-ros",
    label: "Run of Site — Display",
    consent_context: null,
    legal_basis_provenance: null,
  };

  it("drops fields that are not in the buyer-facing whitelist", () => {
    // A family carrying rogue/sensitive keys (as a mis-edited config would).
    const rogue = {
      ...base,
      internal_floor: 12.5,
      gam_line_item_id: "li-99",
      deal_id: "PMP-secret",
    } as unknown as ProductFamily;

    const projected = projectFamily(rogue);
    expect(Object.keys(projected).sort()).toEqual([
      "consent_context",
      "family_id",
      "label",
      "legal_basis_provenance",
    ]);
    expect(JSON.stringify(projected)).not.toContain("internal_floor");
    expect(JSON.stringify(projected)).not.toContain("gam_line_item_id");
    expect(JSON.stringify(projected)).not.toContain("PMP-secret");
  });

  it("includes pricing_options only when a firm price is provided", () => {
    expect(projectFamily(base)).not.toHaveProperty("pricing_options");
    const priced = projectFamily(base, { family_id: "display-ros", currency: "EUR", list_price: 4.5, valid_until: "2099-12-31T23:59:59Z" });
    expect(priced.pricing_options).toEqual({ list_price: 4.5, currency: "EUR", valid_until: "2099-12-31T23:59:59Z" });
  });

  it("forces the Pilar 3 reserved fields to null even if config sets them", () => {
    const tampered = { ...base, consent_context: "leaked", legal_basis_provenance: "leaked" } as unknown as ProductFamily;
    const projected = projectFamily(tampered);
    expect(projected.consent_context).toBeNull();
    expect(projected.legal_basis_provenance).toBeNull();
  });
});

describe("discover_products egress — structural no-leak", () => {
  let client: Client;
  let token: string;

  beforeEach(async () => {
    const keyPair: KeyPairBundle = await generateDevKeyPair();
    const validator = new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD);
    const issuer = new TokenIssuer(keyPair.privateKey);
    const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);

    // A catalog whose config carries sensitive keys the buyer must never see.
    const rogueCatalog = new CatalogStore({
      families: [
        { family_id: "display-ros", label: "Run of Site — Display", consent_context: null, legal_basis_provenance: null, internal_floor: 12.5, gam_line_item_id: "li-99" } as unknown as ProductFamily,
      ],
      buyer_access: { [ENTITLED_BUYER]: ["display-ros"] },
    });

    const server = buildServer({
      store: new EntitlementStore(TEST_ENTITLEMENTS_WITH_PRODUCTS_CONFIG),
      issuer,
      validator,
      wellKnown,
      catalog: rogueCatalog,
      pricingStore: new PricingStore(TEST_PRICING_CONFIG),
      rateLimiter: new RateLimiter(),
      forecastEngine: new ForecastEngine(),
      forecastRateLimiter: new RateLimiter(),
      ledger: createMemoryLedger(),
      replayGuard: new ReplayGuard(),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-buyer-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    token = (await issuer.issue(ENTITLED_BUYER, BUYER_AUD)).token;
  });

  it("never returns a sensitive field that leaked into catalog config", async () => {
    const result = await client.callTool({ name: "discover_products", arguments: { token } });
    expect(result.isError).toBeFalsy();
    const raw = (result.content as Array<{ type: string; text: string }>)[0].text;

    // The rogue keys/values must be absent from the entire serialized response...
    expect(raw).not.toContain("internal_floor");
    expect(raw).not.toContain("gam_line_item_id");
    expect(raw).not.toContain("li-99");
    expect(raw).not.toContain("12.5");

    // ...while the legitimate buyer-facing fields are still present.
    const body = JSON.parse(raw);
    expect(body.families).toHaveLength(1);
    expect(body.families[0].family_id).toBe("display-ros");
    expect(body.families[0].pricing_options.list_price).toBe(4.5);
    expect(Object.keys(body.families[0]).sort()).toEqual([
      "consent_context",
      "family_id",
      "label",
      "legal_basis_provenance",
      "pricing_options",
    ]);
  });
});
