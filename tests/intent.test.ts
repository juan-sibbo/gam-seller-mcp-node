import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
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
import { EntitlementStore, TEST_ENTITLEMENTS_INTENT_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";
import { ReplayGuard } from "../src/audit/replay.js";
import { IntentStore } from "../src/intent/store.js";

// v0.5 Bloque B — commitment primitive (create_intent). plan-core-v04 §3/§4.
// A buyer authenticated by token (Bloque A) turns a firm offer into a recorded, per-buyer
// commitment at the CURRENT firm price. Not a GAM order; no inventory hold. Contract:
//   - inherits Bloque A auth: no/invalid token → AUTH_FAILED.
//   - fail-closed on a stale or non-matching firm price → INVALID_REQUEST.
//   - a valid intent emits INTENT_CREATED (pseudonymized buyer) and returns intent_id + expires_at.
//   - a replayed client_request_id never creates a second intent (idempotent write).
//   - a buyer can never read/affect another buyer's intent (cross-buyer denied).

const ENTITLED_BUYER = "test-buyer-001";
const FAMILY = "display-ros";       // firm list price 4.5 (TEST_PRICING_CONFIG)
const FIRM_PRICE = 4.5;

interface IntentCtx {
  client: Client;
  ledger: AuditLedger;
  intentStore: IntentStore;
  buyerIssuer: TokenIssuer;
}

// Build a server wired for intent tests. An optional pricingStore lets a test inject an
// expired firm price to exercise the fail-closed path.
async function setupIntentServer(pricingStore?: PricingStore): Promise<IntentCtx> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const validator = new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD);
  const buyerIssuer = new TokenIssuer(keyPair.privateKey);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger = createMemoryLedger();
  const intentStore = new IntentStore();

  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_INTENT_CONFIG),
    issuer: buyerIssuer,
    validator,
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: pricingStore ?? new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger,
    replayGuard: new ReplayGuard(),
    intentStore,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer-agent", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, ledger, intentStore, buyerIssuer };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content.length).toBeGreaterThan(0);
  expect(content[0].type).toBe("text");
  return content[0].text;
}

async function buyerToken(ctx: IntentCtx, sub: string): Promise<string> {
  const { token } = await ctx.buyerIssuer.issue(sub, BUYER_AUD);
  return token;
}

function countClass(ctx: IntentCtx, cls: EventClass): number {
  return ctx.ledger.allEntries().filter((e) => e.event_class === cls).length;
}

describe("Bloque B — create_intent commitment primitive", () => {
  let ctx: IntentCtx;
  beforeEach(async () => {
    ctx = await setupIntentServer();
  });

  // #1 — inherits Bloque A: no token → deny, and no commitment is written.
  it("denies create_intent with no token (require_auth)", async () => {
    const result = await ctx.client.callTool({
      name: "create_intent",
      arguments: { family_id: FAMILY, period: "Q4-2026", price_ref: FIRM_PRICE },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("AUTH_FAILED");
    // No identity → policy never runs and nothing is committed.
    expect(countClass(ctx, EventClass.SCOPE_RESOLUTION)).toBe(0);
    expect(countClass(ctx, EventClass.INTENT_CREATED)).toBe(0);
    expect(ctx.intentStore.size()).toBe(0);
  });

  // #2a — fail-closed on a non-matching firm price.
  it("denies (fail-closed) when price_ref does not match the firm price", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    const result = await ctx.client.callTool({
      name: "create_intent",
      arguments: { token, family_id: FAMILY, period: "Q4-2026", price_ref: 9.99 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("INVALID_REQUEST");
    expect(countClass(ctx, EventClass.INTENT_CREATED)).toBe(0);
    expect(ctx.intentStore.size()).toBe(0);
  });

  // #2b — fail-closed on an unknown family (priceFor → undefined).
  it("denies (fail-closed) when the family has no firm price", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    const result = await ctx.client.callTool({
      name: "create_intent",
      arguments: { token, family_id: "does-not-exist", period: "Q4-2026", price_ref: FIRM_PRICE },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("INVALID_REQUEST");
    expect(ctx.intentStore.size()).toBe(0);
  });

  // #2c — fail-closed on an EXPIRED firm price (stale offer must never be committable).
  it("denies (fail-closed) when the firm price has expired", async () => {
    const expired = new PricingStore({
      prices: [{ family_id: FAMILY, currency: "EUR", list_price: FIRM_PRICE, valid_until: "2000-01-01T00:00:00Z" }],
    });
    const staleCtx = await setupIntentServer(expired);
    const token = await buyerToken(staleCtx, ENTITLED_BUYER);
    const result = await staleCtx.client.callTool({
      name: "create_intent",
      arguments: { token, family_id: FAMILY, period: "Q4-2026", price_ref: FIRM_PRICE },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result)).code).toBe("INVALID_REQUEST");
    expect(staleCtx.intentStore.size()).toBe(0);
  });

  // #3 — a valid intent emits INTENT_CREATED, returns intent_id + expires_at, pseudonymizes buyer.
  it("creates an intent on a matching firm price and audits INTENT_CREATED", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    const result = await ctx.client.callTool({
      name: "create_intent",
      arguments: { token, family_id: FAMILY, period: "Q4-2026", price_ref: FIRM_PRICE },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(typeof body.intent_id).toBe("string");
    expect(body.intent_id.length).toBeGreaterThan(0);
    expect(body.status).toBe("active");
    expect(body.firm_price).toBe(FIRM_PRICE);
    expect(typeof body.expires_at).toBe("string");

    expect(countClass(ctx, EventClass.INTENT_CREATED)).toBe(1);
    expect(ctx.intentStore.size()).toBe(1);
    // The ledger pseudonymizes the buyer — the clear sub never appears, nor does exact price.
    const dump = JSON.stringify(ctx.ledger.allEntries());
    expect(dump).not.toContain(ENTITLED_BUYER);
    const created = ctx.ledger.allEntries().find((e) => e.event_class === EventClass.INTENT_CREATED)!;
    expect(created.payload).not.toHaveProperty("firm_price");
    expect(created.payload.intent_id).toBe(body.intent_id);
  });

  // #4 — a replayed client_request_id is idempotent: it never creates a second intent.
  it("does not create a second intent for a replayed client_request_id", async () => {
    const token = await buyerToken(ctx, ENTITLED_BUYER);
    const args = { token, family_id: FAMILY, period: "Q4-2026", price_ref: FIRM_PRICE, client_request_id: "cr-1" };

    const first = await ctx.client.callTool({ name: "create_intent", arguments: args });
    expect(first.isError).toBeFalsy();

    const second = await ctx.client.callTool({ name: "create_intent", arguments: args });
    // Replayed write is rejected generically; crucially, no duplicate commitment is recorded.
    expect(second.isError).toBe(true);
    expect(JSON.parse(firstText(second)).code).toBe("INVALID_REQUEST");

    expect(countClass(ctx, EventClass.INTENT_CREATED)).toBe(1);
    expect(ctx.intentStore.size()).toBe(1);
  });
});

describe("Bloque B — IntentStore cross-buyer isolation", () => {
  // #5 — a buyer can never read another buyer's intent (cross_buyer_state denied at the store).
  it("scopes reads by buyer: a foreign buyer_id resolves to undefined", () => {
    const store = new IntentStore();
    const intent = store.create({
      buyer_id: "buyer-A",
      family_id: FAMILY,
      period: "Q4-2026",
      firm_price: FIRM_PRICE,
      currency: "EUR",
      price_valid_until: "2099-12-31T23:59:59Z",
    });

    // The owning buyer can read it back...
    expect(store.get(intent.intent_id, "buyer-A")?.intent_id).toBe(intent.intent_id);
    // ...but another buyer cannot see it at all.
    expect(store.get(intent.intent_id, "buyer-B")).toBeUndefined();
  });
});
