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
import { ForecastEngine, type ForecastResult } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";
import { MetricsRegistry } from "../src/metrics/registry.js";
import {
  conformsToDisclosure,
  DiscoverProductsDisclosure,
  ForecastDisclosure,
} from "../src/policy/disclosure.js";

// Disclosure gate — the policy denylist decides on the surface LABEL a tool declares, not on
// what it returns. guardedTool therefore validates every response against the tool's strict
// disclosure schema (src/policy/disclosure.ts) and withholds anything with an undeclared field.

const BUYER = "test-buyer-001";

// A forecast engine that leaks an internal field — the shape of a future regression (e.g. a
// real GAM source whose raw result gets merged in). get_forecast spreads the engine result, so
// without the gate this key would reach the buyer.
class LeakyForecastEngine extends ForecastEngine {
  override async forecast(family_id: string, period: string): Promise<ForecastResult> {
    const base = await super.forecast(family_id, period);
    return { ...base, gam_line_item_id: "li-4242", raw_avails: 2_800_000 } as unknown as ForecastResult;
  }
}

async function setup(forecastEngine: ForecastEngine, metricsRegistry?: MetricsRegistry) {
  const keyPair = await generateDevKeyPair();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer,
    validator: new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD),
    wellKnown: new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG),
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(0),
    forecastEngine,
    forecastRateLimiter: new RateLimiter(0),
    ledger: createMemoryLedger(),
    replayGuard: new ReplayGuard(),
    metricsRegistry,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer", version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const token = (await issuer.issue(BUYER, BUYER_AUD)).token;
  return { client, token };
}

function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ text: string }>)[0]!.text;
}

describe("disclosure gate — responses are checked against the tool's declared schema", () => {
  it("withholds a response carrying an undeclared field and returns a generic INTERNAL_ERROR", async () => {
    const metrics = new MetricsRegistry();
    const { client, token } = await setup(new LeakyForecastEngine(), metrics);
    const res = await client.callTool({
      name: "get_forecast",
      arguments: { token, family_id: "display-ros", period: "2026-10", client_request_id: "r-1" },
    });

    expect(res.isError).toBe(true);
    const raw = text(res);
    expect(JSON.parse(raw).code).toBe("INTERNAL_ERROR");
    expect(raw).not.toContain("li-4242");
    expect(raw).not.toContain("gam_line_item_id");
    expect(raw).not.toContain("2800000");
    expect(metrics.render()).toContain('mcp_disclosure_rejected_total{tool="get_forecast"} 1');
  });

  it("lets a conforming response through unchanged", async () => {
    const { client, token } = await setup(new ForecastEngine());
    const res = await client.callTool({
      name: "get_forecast",
      arguments: { token, family_id: "display-ros", period: "2026-10", client_request_id: "r-2" },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).synthetic).toBe(true);
  });
});

describe("conformsToDisclosure", () => {
  const ok = (body: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }], isError });

  it("rejects an extra key nested inside a discovered family", () => {
    const body = {
      families: [{ family_id: "f", label: "F", consent_context: null, legal_basis_provenance: null, deal_id: "PMP-1" }],
      request_id: "r",
    };
    expect(conformsToDisclosure(ok(body), DiscoverProductsDisclosure)).toBe(false);
  });

  it("accepts a well-formed discovery response", () => {
    const body = {
      families: [{ family_id: "f", label: "F", consent_context: null, legal_basis_provenance: null,
        pricing_options: { list_price: 4.5, currency: "EUR", valid_until: "2099-01-01T00:00:00Z" } }],
      request_id: "r",
    };
    expect(conformsToDisclosure(ok(body), DiscoverProductsDisclosure)).toBe(true);
  });

  it("checks error results against the safe envelope, not the success schema", () => {
    const envelope = { code: "INVALID_REQUEST", message: "Invalid request.", request_id: "r", contract_version: "0.2.0" };
    expect(conformsToDisclosure(ok(envelope, true), ForecastDisclosure)).toBe(true);
    expect(conformsToDisclosure(ok({ ...envelope, soap_fault: "ApiException" }, true), ForecastDisclosure)).toBe(false);
  });

  it("rejects non-JSON and empty content", () => {
    expect(conformsToDisclosure({ content: [{ type: "text", text: "not json" }] }, ForecastDisclosure)).toBe(false);
    expect(conformsToDisclosure({ content: [] }, ForecastDisclosure)).toBe(false);
  });
});
