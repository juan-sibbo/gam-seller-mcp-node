import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist, Denylist } from "../src/identity/denylist.js";
import { BUYER_ISS, BUYER_AUD, DOMAIN2_AUD } from "../src/identity/types.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";
import { ReplayGuard } from "../src/audit/replay.js";

// Bloque A (v0.4) — buyer→node identity binding.
// The vulnerability these tests close: pre-v0.4 the token was optional and buyer_id
// arrived as free input, so any caller could act as any buyer. The fix: identity is
// derived ONLY from a validated buyer token's `sub`; there is no buyer_id input to spoof.
//
// Contract under test:
//   - buyer surfaces (discover_products/get_forecast) require a valid buyer token
//     (aud=seller-mcp-node). No token → AUTH_FAILED.
//   - the served buyer_id is token.sub; a client cannot supply/override it.
//   - a Domain-2 token (aud=gam-adapter) is NOT accepted on a buyer surface.
//   - a revoked jti is denied even with a valid signature.

const ENTITLED_BUYER = "test-buyer-001";
const UNKNOWN_BUYER = "intruder-999";

interface AuthCtx {
  client: Client;
  ledger: AuditLedger;
  buyerIssuer: TokenIssuer;
  domain2Issuer: TokenIssuer;
  denylist: Denylist;
}

async function setupAuthServer(): Promise<AuthCtx> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  // Buyer-audience validator — the axis that guards buyer surfaces.
  const validator = new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD);
  // A buyer token: sub = buyer_id, aud = seller-mcp-node.
  const buyerIssuer = new TokenIssuer(keyPair.privateKey);
  // A Domain-2 token: the default sub/aud (aud = gam-adapter) — must be rejected on buyer surfaces.
  const domain2Issuer = new TokenIssuer(keyPair.privateKey);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger = createMemoryLedger();

  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer: buyerIssuer,
    validator,
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger,
    replayGuard: new ReplayGuard(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer-agent", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, ledger, buyerIssuer, domain2Issuer, denylist };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content.length).toBeGreaterThan(0);
  expect(content[0].type).toBe("text");
  return content[0].text;
}

async function buyerToken(ctx: AuthCtx, sub: string): Promise<string> {
  const { token } = await ctx.buyerIssuer.issue(sub, BUYER_AUD);
  return token;
}

describe("Bloque A — buyer identity binding (discover_products)", () => {
  let ctx: AuthCtx;
  beforeEach(async () => {
    ctx = await setupAuthServer();
  });

  // #1 — no token + require_auth → deny.
  it("denies a request with no token (require_auth)", async () => {
    const result = await ctx.client.callTool({ name: "discover_products", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
    // No identity → policy step must never run.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(0);
  });

  // #2 — identity is token.sub; a client cannot spoof buyer_id via input.
  it("ignores any client-supplied buyer_id and serves the token's sub", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    // Attempt to impersonate the unknown buyer via input — must be ignored.
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { token, buyer_id: UNKNOWN_BUYER },
    });
    // Served as ENTITLED_BUYER (token.sub), so it succeeds — the injected buyer_id had no effect.
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(Array.isArray(body.families)).toBe(true);
  });

  // #2b — you can only ever be your own sub; an unentitled sub is policy-denied.
  it("denies when the token's sub is not an entitled buyer", async () => {
    const token = await buyerToken(ctx, UNKNOWN_BUYER);
    const result = await ctx.client.callTool({ name: "discover_products", arguments: { token } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
    const scope = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION);
    expect(scope).toHaveLength(1);
    expect(scope[0].payload.outcome).toBe("DENY");
  });

  // #3 — valid token, entitled sub → allow, and the audit reflects that sub.
  it("allows an entitled buyer authenticated by token and audits SCOPE_RESOLUTION allow", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    const result = await ctx.client.callTool({ name: "discover_products", arguments: { token } });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(Array.isArray(body.families)).toBe(true);

    const scope = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION);
    expect(scope).toHaveLength(1);
    expect(scope[0].payload.outcome).toBe("ALLOW");
    // Ledger pseudonymizes the buyer — the clear sub never appears.
    expect(JSON.stringify(ctx.ledger.allEntries())).not.toContain(ENTITLED_BUYER);
  });

  // #4 — a Domain-2 token (aud=gam-adapter) must not be accepted on a buyer surface.
  it("rejects a Domain-2 token (wrong audience) on a buyer surface", async () => {
    const { token } = await ctx.domain2Issuer.issue(ENTITLED_BUYER, DOMAIN2_AUD);
    const result = await ctx.client.callTool({ name: "discover_products", arguments: { token } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
    // Wrong-audience token is an auth failure, not a policy denial.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(0);
  });

  // #5 — a revoked jti is denied even with a valid signature.
  it("denies a revoked buyer token (jti on denylist)", async () => {
    const { token, claims } = await ctx.buyerIssuer.issue(ENTITLED_BUYER, BUYER_AUD);
    ctx.denylist.add(claims.jti, claims.exp * 1000);
    const result = await ctx.client.callTool({ name: "discover_products", arguments: { token } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");

    const authEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.BUYER_AUTHENTICATION);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].payload.outcome).toBe("deny");
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(0);
  });
});

describe("Bloque A — buyer identity binding (get_forecast)", () => {
  let ctx: AuthCtx;
  beforeEach(async () => {
    ctx = await setupAuthServer();
  });

  it("denies forecast with no token", async () => {
    const result = await ctx.client.callTool({
      name: "get_forecast",
      arguments: { family_id: "fam-demo-01", period: "Q4-2026" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
  });

  it("returns a bucket for an entitled buyer authenticated by token", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    const result = await ctx.client.callTool({
      name: "get_forecast",
      arguments: { token, family_id: "fam-demo-01", period: "Q4-2026" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(["low", "mid", "high"]).toContain(body.bucket);
  });
});
