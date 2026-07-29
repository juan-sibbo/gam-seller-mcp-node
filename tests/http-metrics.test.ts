import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/server.js";
import { startHttpServer, isLoopback, MCP_PATH, METRICS_PATH } from "../src/http.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
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
import { MetricsRegistry } from "../src/metrics/registry.js";

// Integration test over the real HTTP transport: /metrics served on loopback,
// scraped end-to-end, and reflecting activity driven through the MCP client.

const ENTITLED_BUYER = "pilot-buyer-001";

let httpServer: Server;
let baseUrl: string;
let keyPair: KeyPairBundle;
let metrics: MetricsRegistry;
let issuer: TokenIssuer;

beforeAll(async () => {
  keyPair = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  metrics = new MetricsRegistry();
  issuer = new TokenIssuer(keyPair.privateKey);
  const deps = {
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer,
    validator: new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD),
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger: createMemoryLedger(),
    replayGuard: new ReplayGuard(),
    metricsRegistry: metrics,
  };
  httpServer = await startHttpServer(
    { makeServer: () => buildServer(deps), wellKnown, metricsRegistry: metrics },
    { host: "127.0.0.1", port: 0 }
  );
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  httpServer.close();
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: "metrics-http-buyer", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_PATH));
  await client.connect(transport);
  return client;
}

describe("HTTP /metrics — loopback scrape target", () => {
  it("serves Prometheus text on GET /metrics from loopback", async () => {
    const res = await fetch(baseUrl + METRICS_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("mcp_tool_calls_total");
    expect(body).toContain("# TYPE mcp_active_sessions gauge");
  });

  it("reflects a tool call driven through the MCP client", async () => {
    const client = await connectClient();
    await client.callTool({ name: "discover_products", arguments: { token: (await issuer.issue(ENTITLED_BUYER, BUYER_AUD)).token } });
    await client.close();

    const body = await (await fetch(baseUrl + METRICS_PATH)).text();
    // At least one successful discover_products call is now recorded.
    const match = body.match(/^mcp_tool_calls_total\{tool="discover_products",outcome="success"\} (\d+)$/m);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
    // The scrape must never carry the buyer id.
    expect(body).not.toContain(ENTITLED_BUYER);
  });

  it("exposes mcp_active_sessions as a live gauge at scrape time", async () => {
    const body = await (await fetch(baseUrl + METRICS_PATH)).text();
    expect(body).toMatch(/^mcp_active_sessions \d+$/m);
  });
});

describe("isLoopback — the /metrics exposure guard", () => {
  it("accepts IPv4, IPv6 and IPv4-mapped-IPv6 loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects off-host and empty remote addresses (403 path)", () => {
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback("203.0.113.7")).toBe(false);
    expect(isLoopback("192.168.1.20")).toBe(false);
    expect(isLoopback("")).toBe(false);
  });
});
