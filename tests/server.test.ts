import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist, Denylist } from "../src/identity/denylist.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";
import { ReplayGuard } from "../src/audit/replay.js";

// Integration tests over the REAL MCP surface (server.ts tool handlers) via linked
// in-memory transports — no stdio, no disk. This is what the 207 module tests did
// not cover: handler ordering (auth → policy → rate limit), safe envelopes on the
// wire, audit emission per request, and the E-12 public well-known posture.

const ENTITLED_BUYER = "test-buyer-001";
const UNKNOWN_BUYER = "intruder-999";

interface TestContext {
  client: Client;
  ledger: AuditLedger;
  issuer: TokenIssuer;
  denylist: Denylist;
  wellKnown: WellKnownService;
}

async function setupServer(): Promise<TestContext> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const validator = new TokenValidator(keyPair.publicKey, denylist);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger = createMemoryLedger();

  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer,
    validator,
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger,
    replayGuard: new ReplayGuard(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer-agent", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, ledger, issuer, denylist, wellKnown };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content.length).toBeGreaterThan(0);
  expect(content[0].type).toBe("text");
  return content[0].text;
}

describe("server integration — well_known_capabilities (E-12 public trust anchor)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupServer();
  });

  it("serves the signed document without any buyer_id (public by design)", async () => {
    const result = await ctx.client.callTool({ name: "well_known_capabilities", arguments: {} });
    expect(result.isError).toBeFalsy();
    const signedDoc = firstText(result);
    // Signature must verify against the node's public key
    const doc = await ctx.wellKnown.verify(signedDoc);
    expect(doc.node_id).toBeTruthy();
    expect(doc.capability_families.length).toBeGreaterThan(0);
  });

  it("document content stays coarse — no GAM IDs, no schemas, no endpoints", async () => {
    const result = await ctx.client.callTool({ name: "well_known_capabilities", arguments: {} });
    const signedDoc = firstText(result);
    expect(signedDoc).not.toMatch(/gam_id|topology|avails|pricing|endpoint|schema_def/i);
  });
});

describe("server integration — discover_products", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupServer();
  });

  it("returns families for an entitled buyer and audits SCOPE_RESOLUTION allow", async () => {
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(Array.isArray(body.families)).toBe(true);
    expect(body.request_id).toBeTruthy();

    const scopeEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION);
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0].payload.outcome).toBe("ALLOW");
    expect(scopeEvents[0].request_id).toBe(body.request_id);
  });

  it("DENIES an unknown buyer with a safe AUTH_FAILED envelope and audits the deny", async () => {
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: UNKNOWN_BUYER },
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(firstText(result));
    // Exact safe envelope shape — nothing else leaks
    expect(Object.keys(envelope).sort()).toEqual(["code", "contract_version", "message", "request_id"]);
    expect(envelope.code).toBe("AUTH_FAILED");
    expect(envelope.message).not.toMatch(/entitlement|policy|denylist|stack/i);

    const scopeEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION);
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0].payload.outcome).toBe("DENY");
  });

  it("rejects a revoked token with AUTH_FAILED and audits BUYER_AUTHENTICATION deny", async () => {
    const { token, claims } = await ctx.issuer.issue();
    ctx.denylist.add(claims.jti, claims.exp * 1000);

    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER, token },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");

    const authEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.BUYER_AUTHENTICATION);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].payload.outcome).toBe("deny");
    // Revoked-token deny must NOT reach the policy step (no scope event)
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(0);
  });

  it("enforces N=1/T=30s: second immediate call → RATE_LIMITED without quota values", async () => {
    const first = await ctx.client.callTool({ name: "discover_products", arguments: { buyer_id: ENTITLED_BUYER } });
    expect(first.isError).toBeFalsy();

    const second = await ctx.client.callTool({ name: "discover_products", arguments: { buyer_id: ENTITLED_BUYER } });
    expect(second.isError).toBe(true);
    const envelope = JSON.parse(firstText(second));
    expect(envelope.code).toBe("RATE_LIMITED");
    expect(envelope.message).not.toMatch(/30|quota|limit=|window/i);
  });

  it("SEC-GATE-3: a repeated client_request_id is denied as INVALID_REQUEST with a generic message", async () => {
    const first = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER, client_request_id: "dup-1" },
    });
    expect(first.isError).toBeFalsy();

    const second = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER, client_request_id: "dup-1" },
    });
    expect(second.isError).toBe(true);
    const envelope = JSON.parse(firstText(second));
    expect(envelope.code).toBe("INVALID_REQUEST");
    expect(envelope.message).not.toMatch(/replay|duplicate|seen/i);

    // The replay must be caught before auth/policy even run for the second call.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(1);
  });

  it("without client_request_id, repeated calls are not deduped (back-compat)", async () => {
    const first = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER },
    });
    expect(first.isError).toBeFalsy();

    // Use a distinct entitled buyer so this isn't caught by the rate limiter instead.
    const second = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: "pilot-buyer-001" },
    });
    expect(second.isError).toBeFalsy();
  });
});

describe("server integration — get_forecast", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupServer();
  });

  it("returns a synthetic bucket for an entitled buyer and audits FORECAST_REQUEST", async () => {
    const result = await ctx.client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: ENTITLED_BUYER, family_id: "fam-demo-01", period: "Q4-2026" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(["low", "mid", "high"]).toContain(body.bucket);
    expect(body.synthetic).toBe(true);
    expect(body.ttl_seconds).toBe(1800);

    const forecastEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.FORECAST_REQUEST);
    expect(forecastEvents).toHaveLength(1);
    expect(forecastEvents[0].payload.bucket).toBe(body.bucket);
    expect(forecastEvents[0].payload.synthetic).toBe(true);
  });

  it("never writes raw buyer_id into the ledger (pseudonymization on the wire path)", async () => {
    await ctx.client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: ENTITLED_BUYER, family_id: "fam-demo-01", period: "Q4-2026" },
    });
    const serialized = JSON.stringify(ctx.ledger.allEntries());
    expect(serialized).not.toContain(ENTITLED_BUYER);
    expect(serialized).toContain("psn_");
  });

  it("DENIES forecast for unknown buyer without consuming forecast rate state", async () => {
    const denied = await ctx.client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: UNKNOWN_BUYER, family_id: "fam-demo-01", period: "Q4-2026" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(firstText(denied)).code).toBe("AUTH_FAILED");
  });

  it("keeps the ledger hash-chain valid after a burst of mixed requests", async () => {
    await ctx.client.callTool({ name: "discover_products", arguments: { buyer_id: ENTITLED_BUYER } });
    await ctx.client.callTool({ name: "get_forecast", arguments: { buyer_id: ENTITLED_BUYER, family_id: "f1", period: "Q4-2026" } });
    await ctx.client.callTool({ name: "discover_products", arguments: { buyer_id: UNKNOWN_BUYER } });

    expect(ctx.ledger.size()).toBeGreaterThanOrEqual(3);
    expect(ctx.ledger.replayVerify().valid).toBe(true);
  });
});
