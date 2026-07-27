import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { buildServer } from "../src/server.js";
import { startHttpServer } from "../src/http.js";
import { SellerMcpBuyerClient } from "../examples/buyer-client-ts/client.js";

// Drives the example buyer client against a real ephemeral-port node — keeps the example
// honest (no bit-rot) and doubles as the buyer-flow integration for the client.

const ENTITLED_BUYER = "test-buyer-001";
const UNKNOWN_BUYER = "intruder-999";

describe("examples/buyer-client-ts — SellerMcpBuyerClient against a live node", () => {
  let httpServer: Server;
  let buyer: SellerMcpBuyerClient;

  beforeAll(async () => {
    const keyPair = await generateDevKeyPair();
    const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
    const deps = {
      store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
      issuer: new TokenIssuer(keyPair.privateKey),
      validator: new TokenValidator(keyPair.publicKey, createMemoryDenylist()),
      wellKnown,
      catalog: new CatalogStore(TEST_CATALOG_CONFIG),
      pricingStore: new PricingStore(TEST_PRICING_CONFIG),
      rateLimiter: new RateLimiter(),
      forecastEngine: new ForecastEngine(),
      forecastRateLimiter: new RateLimiter(),
      ledger: createMemoryLedger(),
    };
    httpServer = await startHttpServer(
      { makeServer: () => buildServer(deps), wellKnown },
      { host: "127.0.0.1", port: 0 }
    );
    const { port } = httpServer.address() as AddressInfo;
    buyer = new SellerMcpBuyerClient(`http://127.0.0.1:${port}`, { name: "buyer-client-test" });
    await buyer.connect();
  });

  afterAll(async () => {
    await buyer.close();
    httpServer.close();
  });

  it("reads the signed capability document (node_id + audience-blind posture)", async () => {
    const caps = await buyer.capabilities();
    expect(caps.node_id).toBeTruthy();
    expect(caps.privacy_posture.end_user_personal_data).toBe("none");
  });

  it("discovers product families for an entitled buyer", async () => {
    const families = await buyer.discoverProducts(ENTITLED_BUYER);
    expect(families.length).toBeGreaterThan(0);
    expect(families[0]!.family_id).toBeTruthy();
  });

  it("throws a typed BuyerAccessError (AUTH_FAILED) for an unknown buyer (Default-Deny)", async () => {
    await expect(buyer.discoverProducts(UNKNOWN_BUYER)).rejects.toMatchObject({
      name: "BuyerAccessError",
      code: "AUTH_FAILED",
    });
  });

  it("returns a coarse, synthetic forecast bucket", async () => {
    const [family] = await buyer.discoverProducts(ENTITLED_BUYER);
    const forecast = await buyer.getForecast(ENTITLED_BUYER, family!.family_id, "Q4-2026");
    expect(forecast.synthetic).toBe(true);
    expect(["low", "mid", "high"]).toContain(forecast.bucket);
  });
});
