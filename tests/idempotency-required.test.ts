import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { BUYER_ISS, BUYER_AUD } from "../src/identity/types.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";
import { requiresIdempotencyKey, REQUIRE_IDEMPOTENCY_KEY_ENV } from "../src/config/resolve.js";

// #82 — client_request_id drives SEC-GATE-3 (replay). It is optional by default (back-compat),
// so omitting it bypasses replay detection. MCP_REQUIRE_IDEMPOTENCY_KEY makes it mandatory on
// every authenticated surface (fail-closed production posture, same shape as C-02). Default off.

const BUYER = "test-buyer-001";

async function setup(requireIdempotencyKey: boolean) {
  const keyPair = await generateDevKeyPair();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer,
    validator: new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD),
    wellKnown: new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG),
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger: createMemoryLedger(),
    replayGuard: new ReplayGuard(),
    requireIdempotencyKey,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer", version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const token = (await issuer.issue(BUYER, BUYER_AUD)).token;
  return { client, token };
}

describe("requiresIdempotencyKey — env flag", () => {
  it("is false by default and true only for truthy spellings", () => {
    expect(requiresIdempotencyKey({})).toBe(false);
    for (const v of ["1", "true", "YES", "True"]) {
      expect(requiresIdempotencyKey({ [REQUIRE_IDEMPOTENCY_KEY_ENV]: v })).toBe(true);
    }
    for (const v of ["0", "false", "", "off"]) {
      expect(requiresIdempotencyKey({ [REQUIRE_IDEMPOTENCY_KEY_ENV]: v })).toBe(false);
    }
  });
});

describe("MCP_REQUIRE_IDEMPOTENCY_KEY — SEC-GATE-3 cannot be bypassed by omission (#82)", () => {
  it("rejects an authenticated request that omits client_request_id when required", async () => {
    const { client, token } = await setup(true);
    const res = await client.callTool({ name: "discover_products", arguments: { token } });
    expect(res.isError).toBe(true);
  });

  it("accepts the same request when a client_request_id is supplied", async () => {
    const { client, token } = await setup(true);
    const res = await client.callTool({
      name: "discover_products",
      arguments: { token, client_request_id: "req-1" },
    });
    expect(res.isError).toBeFalsy();
  });

  it("default posture (flag off) still accepts a request without client_request_id (back-compat)", async () => {
    const { client, token } = await setup(false);
    const res = await client.callTool({ name: "discover_products", arguments: { token } });
    expect(res.isError).toBeFalsy();
  });
});
