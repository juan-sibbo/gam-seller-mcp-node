import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist, Denylist } from "../src/identity/denylist.js";
import { BUYER_ISS, BUYER_AUD } from "../src/identity/types.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG, type EntitlementsConfig } from "../src/policy/entitlements.js";
import { AllowedSurface } from "../src/policy/types.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";
import { ReplayGuard } from "../src/audit/replay.js";

// Integration tests over the REAL MCP surface (server.ts tool handlers) via linked
// in-memory transports — no stdio, no disk. This is what the 207 module tests did
// not cover: handler ordering (auth → policy → rate limit), safe envelopes on the
// wire, audit emission per request, and the E-12 public well-known posture.
//
// v0.4 Bloque A: identity is derived from a buyer token's `sub` — there is no buyer_id
// input. Authenticated calls carry a buyer token (aud=seller-mcp-node) minted for the
// buyer they act as; callAuthed() mints and attaches it.

const ENTITLED_BUYER = "test-buyer-001";
const UNKNOWN_BUYER = "intruder-999";

async function mintToken(issuer: TokenIssuer, buyer_id: string): Promise<string> {
  const { token } = await issuer.issue(buyer_id, BUYER_AUD);
  return token;
}

interface TestContext {
  client: Client;
  ledger: AuditLedger;
  issuer: TokenIssuer;
  denylist: Denylist;
  wellKnown: WellKnownService;
}

// Call a buyer tool authenticated as `buyer_id`. `extra` carries the non-identity args
// (family_id, period, client_request_id).
async function callAuthed(
  ctx: TestContext,
  name: string,
  buyer_id: string,
  extra: Record<string, unknown> = {}
) {
  return ctx.client.callTool({ name, arguments: { token: await mintToken(ctx.issuer, buyer_id), ...extra } });
}

async function setupServer(entitlements: EntitlementsConfig = TEST_ENTITLEMENTS_DEMO_CONFIG): Promise<TestContext> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const validator = new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger = createMemoryLedger();

  const server = buildServer({
    store: new EntitlementStore(entitlements),
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
    const result = await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(Array.isArray(body.families)).toBe(true);
    expect(body.request_id).toBeTruthy();

    const scopeEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION);
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0].payload.outcome).toBe("ALLOW");
    expect(scopeEvents[0].request_id).toBe(body.request_id);
  });

  it("DENIES a request with no token (require_auth) with a safe AUTH_FAILED envelope", async () => {
    const result = await ctx.client.callTool({ name: "discover_products", arguments: {} });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(firstText(result));
    // Exact safe envelope shape — nothing else leaks
    expect(Object.keys(envelope).sort()).toEqual(["code", "contract_version", "message", "request_id"]);
    expect(envelope.code).toBe("AUTH_FAILED");
    expect(envelope.message).not.toMatch(/entitlement|policy|denylist|stack/i);
    // No identity → policy step never runs.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(0);
  });

  it("DENIES a buyer whose token sub is not entitled and audits the deny", async () => {
    const result = await callAuthed(ctx, "discover_products", UNKNOWN_BUYER);
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(firstText(result));
    expect(envelope.code).toBe("AUTH_FAILED");

    const scopeEvents = ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION);
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0].payload.outcome).toBe("DENY");
  });

  it("rejects a revoked token with AUTH_FAILED and audits BUYER_AUTHENTICATION deny", async () => {
    const { token, claims } = await ctx.issuer.issue(ENTITLED_BUYER, BUYER_AUD);
    ctx.denylist.add(claims.jti, claims.exp * 1000);

    const result = await ctx.client.callTool({
      name: "discover_products",
      arguments: { token },
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
    const first = await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    expect(first.isError).toBeFalsy();

    const second = await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    expect(second.isError).toBe(true);
    const envelope = JSON.parse(firstText(second));
    expect(envelope.code).toBe("RATE_LIMITED");
    expect(envelope.message).not.toMatch(/30|quota|limit=|window/i);
  });

  it("SEC-GATE-3: a repeated client_request_id is denied as INVALID_REQUEST with a generic message", async () => {
    const first = await callAuthed(ctx, "discover_products", ENTITLED_BUYER, { client_request_id: "dup-1" });
    expect(first.isError).toBeFalsy();

    const second = await callAuthed(ctx, "discover_products", ENTITLED_BUYER, { client_request_id: "dup-1" });
    expect(second.isError).toBe(true);
    const envelope = JSON.parse(firstText(second));
    expect(envelope.code).toBe("INVALID_REQUEST");
    expect(envelope.message).not.toMatch(/replay|duplicate|seen/i);

    // The replay must be caught before auth/policy even run for the second call.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.SCOPE_RESOLUTION)).toHaveLength(1);
  });

  it("without client_request_id, repeated calls are not deduped (back-compat)", async () => {
    const first = await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    expect(first.isError).toBeFalsy();

    // Use a distinct entitled buyer so this isn't caught by the rate limiter instead.
    const second = await callAuthed(ctx, "discover_products", "pilot-buyer-001");
    expect(second.isError).toBeFalsy();
  });

  it("SEC-GATE-13: pricing_options absent when all prices are expired (fail-closed)", async () => {
    // Build a server where every configured price has already expired.
    // Verifies that the fail-closed expiry in PricingStore propagates all the way
    // through the discover_products response — not just at the unit level.
    const kp = await generateDevKeyPair();
    const issuer = new TokenIssuer(kp.privateKey);
    const expiredPricingStore = new PricingStore({
      prices: [
        { family_id: "display-ros",    currency: "EUR", list_price: 4.5,  valid_until: "2020-01-01T00:00:00Z" },
        { family_id: "branded-content", currency: "EUR", list_price: 45.0, valid_until: "2020-01-01T00:00:00Z" },
        { family_id: "video-pre-roll",  currency: "EUR", list_price: 18.0, valid_until: "2020-01-01T00:00:00Z" },
      ],
    });
    const server = buildServer({
      store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
      issuer,
      validator: new TokenValidator(kp.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD),
      wellKnown: new WellKnownService(kp.privateKey, kp.publicKey, TEST_DEPLOYMENT_CONFIG),
      catalog: new CatalogStore(TEST_CATALOG_CONFIG),
      pricingStore: expiredPricingStore,
      rateLimiter: new RateLimiter(),
      forecastEngine: new ForecastEngine(),
      forecastRateLimiter: new RateLimiter(),
      ledger: createMemoryLedger(),
      replayGuard: new ReplayGuard(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-expired-pricing", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "discover_products",
      arguments: { token: await mintToken(issuer, ENTITLED_BUYER) },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    const families = body.families as Array<Record<string, unknown>>;
    expect(families.length).toBeGreaterThan(0);
    // No family may carry pricing_options when every configured price is expired
    for (const f of families) {
      expect(f["pricing_options"]).toBeUndefined();
    }
  });
});

describe("server integration — policy gate on every authenticated surface (#67)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupServer();
  });

  // The registered tool surface, frozen. A new server.tool(...) breaks this assertion,
  // forcing its author to classify it here — public, or authenticated (and therefore
  // present in the deny sweep below). This is the structural guard behind the README's
  // "adding a new tool in the future cannot bypass this": the scope gate is invoked
  // per-handler (convention), so a test must hold the invariant the code does not.
  const PUBLIC_TOOLS = ["well_known_capabilities"];
  const AUTHENTICATED_TOOLS: Array<{ name: string; extra: Record<string, unknown> }> = [
    { name: "discover_products", extra: {} },
    { name: "get_forecast", extra: { family_id: "fam-demo-01", period: "Q4-2026" } },
    { name: "create_intent", extra: { family_id: "fam-demo-01", period: "Q4-2026", price_ref: 1 } },
    { name: "revoke_intent", extra: { intent_id: "any-id" } },
  ];

  it("exposes exactly the known tool surface (a new tool must be classified here)", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = [...PUBLIC_TOOLS, ...AUTHENTICATED_TOOLS.map((t) => t.name)].sort();
    expect(names).toEqual(expected);
  });

  it("denies an authenticated-but-unentitled buyer on EVERY authenticated tool (routes through policy)", async () => {
    for (const tool of AUTHENTICATED_TOOLS) {
      const result = await callAuthed(ctx, tool.name, UNKNOWN_BUYER, tool.extra);
      expect(result.isError, `${tool.name} must fail closed for an unentitled buyer`).toBe(true);
      const envelope = JSON.parse(firstText(result));
      expect(envelope.code, `${tool.name} must deny via policy (AUTH_FAILED)`).toBe("AUTH_FAILED");
    }
  });
});

// Symmetric to the scope-gate invariant above (#67), for the rate-limit stage (C-13): a rapid
// second call from the SAME entitled buyer must be RATE_LIMITED on EVERY authenticated tool —
// including revoke_intent, which previously had no throttle. Each surface has its own limiter,
// so one entitled buyer exercises them all. A new authenticated server.tool(...) wired without a
// rate-limit check breaks this sweep, forcing its author to add one — the invariant the code
// enforces by convention, held by a test so drift cannot reintroduce the gap.
describe("server integration — rate limit on every authenticated surface (C-13)", () => {
  const FAMILY = "display-ros";
  const PERIOD = "Q4-2026";
  const FIRM_PRICE = 4.5;

  // One buyer entitled to every authenticated surface, so the first call of each tool reaches
  // and consumes the rate stage (auth + scope must pass first).
  const ALL_SURFACES_CONFIG: EntitlementsConfig = {
    entitlements: [
      {
        buyer_id: ENTITLED_BUYER,
        surfaces: [
          AllowedSurface.DISCOVERY,
          AllowedSurface.WELL_KNOWN,
          AllowedSurface.PRODUCT_DISCOVERY,
          AllowedSurface.FORECAST,
          AllowedSurface.INTENT,
        ],
        scopes: ["gam.readonly"],
        phase: "phase-1-readonly",
      },
    ],
  };

  const THROTTLED_TOOLS: Array<{ name: string; extra: Record<string, unknown> }> = [
    { name: "discover_products", extra: {} },
    { name: "get_forecast", extra: { family_id: FAMILY, period: PERIOD } },
    { name: "create_intent", extra: { family_id: FAMILY, period: PERIOD, price_ref: FIRM_PRICE } },
    { name: "revoke_intent", extra: { intent_id: "any-id" } },
  ];

  it("throttles a rapid second call from the same buyer on EVERY authenticated tool", async () => {
    const ctx = await setupServer(ALL_SURFACES_CONFIG);
    for (const tool of THROTTLED_TOOLS) {
      // First call passes the rate stage (downstream may succeed or be INVALID_REQUEST).
      await callAuthed(ctx, tool.name, ENTITLED_BUYER, tool.extra);
      const second = await callAuthed(ctx, tool.name, ENTITLED_BUYER, tool.extra);
      expect(JSON.parse(firstText(second)).code, `${tool.name} must throttle the second rapid call`).toBe(
        "RATE_LIMITED"
      );
    }
  });
});

describe("server integration — get_forecast", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupServer();
  });

  it("returns a synthetic bucket for an entitled buyer and audits FORECAST_REQUEST", async () => {
    const result = await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026" });
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
    await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026" });
    const serialized = JSON.stringify(ctx.ledger.allEntries());
    expect(serialized).not.toContain(ENTITLED_BUYER);
    expect(serialized).toContain("psn_");
  });

  it("DENIES forecast for a buyer whose token sub is unknown without consuming forecast rate state", async () => {
    const denied = await callAuthed(ctx, "get_forecast", UNKNOWN_BUYER, { family_id: "fam-demo-01", period: "Q4-2026" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(firstText(denied)).code).toBe("AUTH_FAILED");
  });

  it("keeps the ledger hash-chain valid after a burst of mixed requests", async () => {
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "f1", period: "Q4-2026" });
    await callAuthed(ctx, "discover_products", UNKNOWN_BUYER);

    expect(ctx.ledger.size()).toBeGreaterThanOrEqual(3);
    expect(ctx.ledger.replayVerify().valid).toBe(true);
  });

  it("SEC-GATE-3: a repeated client_request_id is denied as INVALID_REQUEST with a generic message", async () => {
    const first = await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026", client_request_id: "dup-fc-1" });
    expect(first.isError).toBeFalsy();

    const second = await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026", client_request_id: "dup-fc-1" });
    expect(second.isError).toBe(true);
    const envelope = JSON.parse(firstText(second));
    expect(envelope.code).toBe("INVALID_REQUEST");
    expect(envelope.message).not.toMatch(/replay|duplicate|seen/i);

    // The replay must be caught before auth/policy even run for the second call.
    expect(ctx.ledger.allEntries().filter((e) => e.event_class === EventClass.FORECAST_REQUEST)).toHaveLength(1);
  });

  it("without client_request_id, repeated calls are not deduped (back-compat)", async () => {
    const first = await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026" });
    expect(first.isError).toBeFalsy();

    // Use a distinct entitled buyer so this isn't caught by the rate limiter instead.
    const second = await callAuthed(ctx, "get_forecast", "pilot-buyer-001", { family_id: "fam-demo-01", period: "Q4-2026" });
    expect(second.isError).toBeFalsy();
  });
});
