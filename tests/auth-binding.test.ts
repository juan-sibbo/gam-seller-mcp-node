import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type ServerDeps } from "../src/server.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist, Denylist } from "../src/identity/denylist.js";
import { BUYER_AUD, DOMAIN2_ISS } from "../src/identity/types.js";
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

// BLOQUEANTE 1 — identidad por-buyer (plan-core-v04 Bloque A).
// El eje buyer→nodo (aud=seller-mcp-node, sub=buyer_id) es SEPARADO del Domain-2
// nodo↔adaptador (aud=gam-adapter). Con require_auth:true el token es obligatorio y
// authenticate() ata el principal (token.sub) al recurso (buyer_id) — sin binding,
// cualquiera suplanta a cualquier buyer.

const ENTITLED_BUYER = "test-buyer-001";
const OTHER_ENTITLED_BUYER = "pilot-buyer-001"; // también en el demo config → el deny es del binding, no de policy

interface AuthTestContext {
  client: Client;
  ledger: AuditLedger;
  issuer: TokenIssuer;
  denylist: Denylist;
  keyPair: KeyPairBundle;
}

// Server con enforcement de identidad activo (require_auth:true) y validador de eje buyer.
async function setupAuthServer(): Promise<AuthTestContext> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const validator = new TokenValidator(keyPair.publicKey, denylist); // Domain-2 (adaptador)
  const buyerValidator = new TokenValidator(keyPair.publicKey, denylist, DOMAIN2_ISS, BUYER_AUD);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger = createMemoryLedger();

  const deps: ServerDeps = {
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer,
    validator,
    buyerValidator,
    requireAuth: true,
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger,
    replayGuard: new ReplayGuard(),
  };

  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer-agent", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, ledger, issuer, denylist, keyPair };
}

// Emite un token del eje buyer (aud=seller-mcp-node, sub=buyer_id).
async function issueBuyerToken(issuer: TokenIssuer, buyerId: string) {
  return issuer.issue(buyerId, BUYER_AUD);
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

describe("auth-binding — BLOQUEANTE 1 (identidad por-buyer)", () => {
  let ctx: AuthTestContext;
  beforeEach(async () => {
    ctx = await setupAuthServer();
  });

  it("1. sin token + require_auth → deny (AUTH_FAILED)", async () => {
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
    // No debe alcanzar la resolución de scope: se corta en identidad.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(0);
  });

  it("2. token válido, sub ≠ buyer_id pedido → deny (suplantación)", async () => {
    const { token } = await issueBuyerToken(ctx.issuer, ENTITLED_BUYER);
    // Ambos buyers están entitled: si esto pasara, sería un allow. El deny prueba el binding.
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: OTHER_ENTITLED_BUYER, token },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
    const authEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.BUYER_AUTHENTICATION);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].payload.outcome).toBe("deny");
  });

  it("3. token válido, sub correcto → allow, respuesta scoped al sub", async () => {
    const { token } = await issueBuyerToken(ctx.issuer, ENTITLED_BUYER);
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER, token },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(Array.isArray(body.families)).toBe(true);
    expect(body.request_id).toBeTruthy();
    const authEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.BUYER_AUTHENTICATION);
    expect(authEvents[0].payload.outcome).toBe("allow");
  });

  it("4. token Domain-2 (aud=gam-adapter) en superficie buyer → deny (aud mismatch)", async () => {
    const { token } = await ctx.issuer.issue(); // default: sub=seller-mcp-node, aud=gam-adapter
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER, token },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
  });

  it("5. jti revocado → deny", async () => {
    const { token, claims } = await issueBuyerToken(ctx.issuer, ENTITLED_BUYER);
    ctx.denylist.add(claims.jti, claims.exp * 1000);
    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { buyer_id: ENTITLED_BUYER, token },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
  });

  it("get_forecast también exige token con require_auth (identidad uniforme)", async () => {
    const noToken = await ctx.client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: ENTITLED_BUYER, family_id: "fam-demo-01", period: "Q4-2026" },
    });
    expect(noToken.isError).toBe(true);
    expect(JSON.parse(firstText(noToken)).code).toBe("AUTH_FAILED");

    const { token } = await issueBuyerToken(ctx.issuer, ENTITLED_BUYER);
    const ok = await ctx.client.callTool({
      name: "get_forecast",
      arguments: { buyer_id: ENTITLED_BUYER, family_id: "fam-demo-01", period: "Q4-2026", token },
    });
    expect(ok.isError).toBeFalsy();
  });
});
