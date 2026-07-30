import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, sweepExpiredIntents } from "../src/server.js";
import { IntentStore } from "../src/intent/store.js";
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

// v0.6+ intent lifecycle (D) — the commitment loop closes: an intent can expire (TTL sweep →
// INTENT_EXPIRED) or be revoked by its owner (revoke_intent → INTENT_REVOKED). Both wire the
// remaining ratified INTENT_* classes and enforce the TTL that create_intent only recorded.

const BUYER_A = "test-buyer-001";
const BUYER_B = "pilot-buyer-001";
const FAMILY = "display-ros";
const FIRM_PRICE = 4.5;

// ── Store-level: revoke() and sweepExpired() ────────────────────────────────────────────
describe("IntentStore — revoke", () => {
  function seed(): { store: IntentStore; id: string } {
    const store = new IntentStore();
    const intent = store.create({ buyer_id: BUYER_A, family_id: FAMILY, period: "Q4-2026", firm_price: FIRM_PRICE, currency: "EUR", price_valid_until: "2099-12-31T23:59:59Z" });
    return { store, id: intent.intent_id };
  }

  it("revokes the owner's active intent and evicts it", () => {
    const { store, id } = seed();
    const revoked = store.revoke(id, BUYER_A);
    expect(revoked?.status).toBe("revoked");
    expect(store.size()).toBe(0);
    expect(store.get(id, BUYER_A)).toBeUndefined();
  });

  it("refuses a cross-buyer revoke and leaves the intent intact", () => {
    const { store, id } = seed();
    expect(store.revoke(id, BUYER_B)).toBeUndefined();
    expect(store.size()).toBe(1);
    expect(store.get(id, BUYER_A)?.intent_id).toBe(id);
  });

  it("returns undefined for an unknown intent id", () => {
    const { store } = seed();
    expect(store.revoke("nope", BUYER_A)).toBeUndefined();
  });

  it("returns undefined when the intent has already lapsed (past its TTL)", () => {
    const { store, id } = seed();
    // now is well past the 15-min TTL → treated as expired, not revocable.
    expect(store.revoke(id, BUYER_A, new Date(Date.now() + 60 * 60 * 1000))).toBeUndefined();
  });
});

describe("IntentStore — sweepExpired", () => {
  it("evicts and returns intents past their TTL, and is idempotent", () => {
    const store = new IntentStore();
    const intent = store.create({ buyer_id: BUYER_A, family_id: FAMILY, period: "Q4-2026", firm_price: FIRM_PRICE, currency: "EUR", price_valid_until: "2099-12-31T23:59:59Z" });
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const first = store.sweepExpired(future);
    expect(first.map((i) => i.intent_id)).toEqual([intent.intent_id]);
    expect(first[0].status).toBe("expired");
    expect(store.size()).toBe(0);
    // Second sweep has nothing left — the event fires exactly once.
    expect(store.sweepExpired(future)).toEqual([]);
  });

  it("leaves intents that have not yet expired", () => {
    const store = new IntentStore();
    store.create({ buyer_id: BUYER_A, family_id: FAMILY, period: "Q4-2026", firm_price: FIRM_PRICE, currency: "EUR", price_valid_until: "2099-12-31T23:59:59Z" });
    expect(store.sweepExpired(new Date())).toEqual([]);
    expect(store.size()).toBe(1);
  });
});

// ── sweepExpiredIntents helper: emits INTENT_EXPIRED to the ledger ───────────────────────
describe("sweepExpiredIntents — emits INTENT_EXPIRED", () => {
  it("appends one INTENT_EXPIRED per lapsed intent, buyer pseudonymized", () => {
    const store = new IntentStore();
    const ledger = createMemoryLedger();
    const intent = store.create({ buyer_id: BUYER_A, family_id: FAMILY, period: "Q4-2026", firm_price: FIRM_PRICE, currency: "EUR", price_valid_until: "2099-12-31T23:59:59Z" });

    sweepExpiredIntents(store, ledger, new Date(Date.now() + 60 * 60 * 1000));

    const expired = ledger.allEntries().filter((e) => e.event_class === EventClass.INTENT_EXPIRED);
    expect(expired).toHaveLength(1);
    expect(expired[0].payload.intent_id).toBe(intent.intent_id);
    expect(JSON.stringify(ledger.allEntries())).not.toContain(BUYER_A);
  });
});

// ── Server-level: revoke_intent tool ────────────────────────────────────────────────────
interface Ctx {
  client: Client;
  ledger: AuditLedger;
  intentStore: IntentStore;
  issuer: TokenIssuer;
}

async function setup(): Promise<Ctx> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const validator = new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD);
  const issuer = new TokenIssuer(keyPair.privateKey);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger = createMemoryLedger();
  const intentStore = new IntentStore();

  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_INTENT_CONFIG),
    issuer,
    validator,
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger,
    replayGuard: new ReplayGuard(),
    intentStore,
  });

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-buyer-agent", version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, ledger, intentStore, issuer };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

async function tokenFor(ctx: Ctx, sub: string): Promise<string> {
  return (await ctx.issuer.issue(sub, BUYER_AUD)).token;
}

async function createIntent(ctx: Ctx, token: string): Promise<string> {
  const res = await ctx.client.callTool({ name: "create_intent", arguments: { token, family_id: FAMILY, period: "Q4-2026", price_ref: FIRM_PRICE } });
  return JSON.parse(firstText(res)).intent_id;
}

describe("revoke_intent tool", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });

  it("revokes the buyer's own active intent and emits INTENT_REVOKED", async () => {
    const token = await tokenFor(ctx, BUYER_A);
    const intentId = await createIntent(ctx, token);

    const res = await ctx.client.callTool({ name: "revoke_intent", arguments: { token, intent_id: intentId } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(firstText(res));
    expect(body.intent_id).toBe(intentId);
    expect(body.status).toBe("revoked");

    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.INTENT_REVOKED)).toHaveLength(1);
    expect(ctx.intentStore.size()).toBe(0);
  });

  it("denies revoking another buyer's intent (cross-buyer) and leaves it active", async () => {
    const intentId = await createIntent(ctx, await tokenFor(ctx, BUYER_A));

    const res = await ctx.client.callTool({ name: "revoke_intent", arguments: { token: await tokenFor(ctx, BUYER_B), intent_id: intentId } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(firstText(res)).code).toBe("INVALID_REQUEST");
    // A's intent is untouched, and no revoke event was emitted.
    expect(ctx.intentStore.get(intentId, BUYER_A)?.intent_id).toBe(intentId);
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.INTENT_REVOKED)).toHaveLength(0);
  });

  it("returns INVALID_REQUEST for an unknown intent id", async () => {
    const res = await ctx.client.callTool({ name: "revoke_intent", arguments: { token: await tokenFor(ctx, BUYER_A), intent_id: "does-not-exist" } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(firstText(res)).code).toBe("INVALID_REQUEST");
  });

  it("denies revoke with no token", async () => {
    const res = await ctx.client.callTool({ name: "revoke_intent", arguments: { intent_id: "whatever" } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(firstText(res)).code).toBe("AUTH_FAILED");
  });
});
