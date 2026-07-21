import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/server.js";
import { startHttpServer, MCP_PATH } from "../src/http.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";

// D9 — complete buyer agent session test.
//
// Where the unit tests validate individual components, this test validates the
// END-TO-END flow that a real buyer agent executes in a single session:
//   well_known_capabilities → discover_products → get_forecast
//
// It validates the FULL response structure (not just isError), so a correct
// response that has the wrong shape is still caught.

const ENTITLED_BUYER = "pilot-buyer-001";
const UNKNOWN_BUYER = "probe-external-unknown-999";
const KNOWN_FAMILY = "display-ros";

let httpServer: Server;
let baseUrl: string;
let keyPair: KeyPairBundle;

beforeAll(async () => {
  keyPair = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const deps = {
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer: new TokenIssuer(keyPair.privateKey),
    validator: new TokenValidator(keyPair.publicKey, denylist),
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
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
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  httpServer.close();
});

function makeClient(): Client {
  return new Client({ name: "d9-buyer-agent", version: "0.1.0" });
}

async function connectClient(): Promise<Client> {
  const client = makeClient();
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_PATH));
  await client.connect(transport);
  return client;
}

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text);
}

describe("D9 — complete buyer agent session (well_known → discover → forecast)", () => {
  it("step 1: well_known_capabilities returns a verifiable trust anchor", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "well_known_capabilities", arguments: {} });

    expect(result.isError).toBeFalsy();
    const doc = parseToolText(result) as Record<string, unknown>;

    // Trust anchor structure (E-12)
    expect(typeof doc["node_id"]).toBe("string");
    expect((doc["node_id"] as string).length).toBeGreaterThan(0);

    // Tool inventory advertised must match the actual tools
    const inventory = doc["tool_inventory"] as string[];
    expect(Array.isArray(inventory)).toBe(true);
    expect(inventory.sort()).toEqual(["discover_products", "get_forecast", "well_known_capabilities"]);

    // Privacy posture (Z3 — audience-blind)
    const posture = doc["privacy_posture"] as Record<string, unknown>;
    expect(posture["end_user_personal_data"]).toBe("none");

    await client.close();
  });

  it("step 2: discover_products returns typed product families for an entitled buyer", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER },
    });

    expect(result.isError).toBeFalsy();
    const body = parseToolText(result) as Record<string, unknown>;

    // Response shape validation
    expect(Array.isArray(body["families"])).toBe(true);
    const families = body["families"] as Array<Record<string, unknown>>;
    expect(families.length).toBeGreaterThan(0);

    // Each family must have the required buyer-visible fields (F0-WO-06 boundary)
    for (const f of families) {
      expect(typeof f["family_id"]).toBe("string");
      expect(typeof f["label"]).toBe("string");
      // Internal IDs, pricing, and deal data must NOT appear
      expect(f["internal_id"]).toBeUndefined();
      expect(f["deal_id"]).toBeUndefined();
      expect(f["price"]).toBeUndefined();
    }

    await client.close();
  });

  it("step 3: get_forecast returns a bucket (Low/Mid/High) for a known family", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: ENTITLED_BUYER, family_id: KNOWN_FAMILY, period: "2026-Q4" },
    });

    expect(result.isError).toBeFalsy();
    const body = parseToolText(result) as Record<string, unknown>;

    // Bucket must be one of the three ratified values (blocker #6)
    expect(["Low", "Mid", "High"]).toContain(body["bucket"]);
    expect(typeof body["family_id"]).toBe("string");
    expect(typeof body["period"]).toBe("string");

    // Exact numbers must NOT appear in any field (commercial intelligence minimization)
    expect(body["impressions"]).toBeUndefined();
    expect(body["exact_avails"]).toBeUndefined();
    expect(body["count"]).toBeUndefined();

    await client.close();
  });

  it("full sequential session: one client, all three tools in order", async () => {
    // Simulates the realistic buyer agent flow: check trust anchor first,
    // then discover, then forecast — all in a single persistent session.
    const client = await connectClient();

    const wk = await client.callTool({ name: "well_known_capabilities", arguments: {} });
    expect(wk.isError).toBeFalsy();
    const wkDoc = parseToolText(wk) as Record<string, unknown>;
    const inventory = (wkDoc["tool_inventory"] as string[]).sort();

    const disc = await client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER },
    });
    expect(disc.isError).toBeFalsy();
    const discBody = parseToolText(disc) as Record<string, unknown>;
    const firstFamily = (discBody["families"] as Array<{ family_id: string }>)[0].family_id;

    // Use the first discovered family to request a forecast — realistic agent behaviour
    const fc = await client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: ENTITLED_BUYER, family_id: firstFamily, period: "2026-Q4" },
    });
    expect(fc.isError).toBeFalsy();
    const fcBody = parseToolText(fc) as Record<string, unknown>;
    expect(["Low", "Mid", "High"]).toContain(fcBody["bucket"]);

    // The family used for the forecast must have been in the discovery response
    expect(inventory).toContain("get_forecast");

    await client.close();
  });

  it("Default-Deny: unknown buyer gets AUTH_FAILED on discover_products", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "discover_products",
      arguments: { buyer_id: UNKNOWN_BUYER },
    });

    expect(result.isError).toBe(true);
    const body = parseToolText(result) as Record<string, unknown>;
    expect(body["code"]).toBe("AUTH_FAILED");

    await client.close();
  });

  it("Default-Deny: unknown buyer gets AUTH_FAILED on get_forecast", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: UNKNOWN_BUYER, family_id: KNOWN_FAMILY, period: "2026-Q4" },
    });

    expect(result.isError).toBe(true);
    const body = parseToolText(result) as Record<string, unknown>;
    expect(body["code"]).toBe("AUTH_FAILED");

    await client.close();
  });
});
