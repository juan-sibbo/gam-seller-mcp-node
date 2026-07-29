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
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";
import { MetricsRegistry } from "../src/metrics/registry.js";

// Metrics instrumentation tests over the REAL tool handlers (server.ts) via linked
// in-memory transports. We inject a fresh MetricsRegistry, exercise each terminal
// outcome, and assert the exposed series — including the hard invariant that no
// buyer_id ever appears in the rendered output.

const ENTITLED_BUYER = "test-buyer-001";
const UNKNOWN_BUYER = "intruder-999";

// v0.4 Bloque A: identity is derived from a buyer token's sub — no buyer_id input.
async function mintToken(issuer: TokenIssuer, buyer_id: string): Promise<string> {
  const { token } = await issuer.issue(buyer_id, BUYER_AUD);
  return token;
}

interface TestContext {
  client: Client;
  metrics: MetricsRegistry;
  issuer: TokenIssuer;
  denylist: Denylist;
}

async function callAuthed(
  ctx: TestContext,
  name: string,
  buyer_id: string,
  extra: Record<string, unknown> = {}
) {
  return ctx.client.callTool({ name, arguments: { token: await mintToken(ctx.issuer, buyer_id), ...extra } });
}

async function setupServer(): Promise<TestContext> {
  const keyPair: KeyPairBundle = await generateDevKeyPair();
  const denylist = createMemoryDenylist();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const validator = new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const metrics = new MetricsRegistry();

  const server = buildServer({
    store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
    issuer,
    validator,
    wellKnown,
    catalog: new CatalogStore(TEST_CATALOG_CONFIG),
    pricingStore: new PricingStore(TEST_PRICING_CONFIG),
    rateLimiter: new RateLimiter(),
    forecastEngine: new ForecastEngine(),
    forecastRateLimiter: new RateLimiter(),
    ledger: createMemoryLedger(),
    replayGuard: new ReplayGuard(),
    metricsRegistry: metrics,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metrics-test-buyer", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, metrics, issuer, denylist };
}

describe("metrics — tool call outcomes", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupServer();
  });

  it("records success on a clean discover_products call", async () => {
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_tool_calls_total{tool="discover_products",outcome="success"} 1');
  });

  it("records auth_failed + scope_denied for a token whose sub is unentitled", async () => {
    // Valid token (passes auth), sub not entitled → policy DENY → scope_denied.
    await callAuthed(ctx, "discover_products", UNKNOWN_BUYER);
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_tool_calls_total{tool="discover_products",outcome="auth_failed"} 1');
    expect(text).toContain('mcp_auth_failures_total{tool="discover_products",reason="scope_denied"} 1');
  });

  it("records auth_failed + token_invalid for a missing token", async () => {
    // No token → no derivable identity → auth failure at the token step.
    await ctx.client.callTool({ name: "discover_products", arguments: {} });
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_auth_failures_total{tool="discover_products",reason="token_invalid"} 1');
  });

  it("records auth_failed + token_invalid for a revoked token", async () => {
    const { token, claims } = await ctx.issuer.issue(ENTITLED_BUYER, BUYER_AUD);
    ctx.denylist.add(claims.jti, claims.exp * 1000);

    await ctx.client.callTool({
      name: "discover_products",
      arguments: { token },
    });
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_auth_failures_total{tool="discover_products",reason="token_invalid"} 1');
  });

  it("records rate_limited on the second immediate call (N=1/T=30s)", async () => {
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_rate_limited_total{tool="discover_products"} 1');
    expect(text).toContain('mcp_tool_calls_total{tool="discover_products",outcome="rate_limited"} 1');
  });

  it("records replay_rejected on a duplicated client_request_id", async () => {
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER, { client_request_id: "dup-metric-1" });
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER, { client_request_id: "dup-metric-1" });
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_replay_rejected_total{tool="discover_products"} 1');
    expect(text).toContain('mcp_tool_calls_total{tool="discover_products",outcome="replay_rejected"} 1');
  });

  it("records get_forecast success separately from discover_products", async () => {
    await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026" });
    const text = ctx.metrics.render();
    expect(text).toContain('mcp_tool_calls_total{tool="get_forecast",outcome="success"} 1');
  });

  it("reflects the audit ledger size gauge after audited requests", async () => {
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    const text = ctx.metrics.render();
    // discover_products appends exactly one SCOPE_RESOLUTION event → ledger size ≥ 1.
    const match = text.match(/^mcp_audit_ledger_entries_total (\d+)$/m);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });
});

describe("metrics — exposition format and security invariant", () => {
  it("renders valid Prometheus text with HELP and TYPE headers for every metric", () => {
    const text = new MetricsRegistry().render();
    for (const name of [
      "mcp_tool_calls_total",
      "mcp_auth_failures_total",
      "mcp_rate_limited_total",
      "mcp_replay_rejected_total",
      "mcp_active_sessions",
      "mcp_audit_ledger_entries_total",
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
    // Counters typed as counter, gauges as gauge.
    expect(text).toContain("# TYPE mcp_tool_calls_total counter");
    expect(text).toContain("# TYPE mcp_active_sessions gauge");
  });

  it("NEVER leaks a buyer_id into any rendered label (SEC invariant)", async () => {
    const ctx = await setupServer();
    // Drive several outcome classes with real buyer identities carried in the tokens.
    await callAuthed(ctx, "discover_products", ENTITLED_BUYER);
    await callAuthed(ctx, "discover_products", UNKNOWN_BUYER);
    await callAuthed(ctx, "get_forecast", ENTITLED_BUYER, { family_id: "fam-demo-01", period: "Q4-2026" });
    const text = ctx.metrics.render();
    expect(text).not.toContain(ENTITLED_BUYER);
    expect(text).not.toContain(UNKNOWN_BUYER);
  });

  it("throws on an unknown counter or gauge name (fail-loud, no silent drop)", () => {
    const reg = new MetricsRegistry();
    expect(() => reg.increment("mcp_nonexistent_total", {})).toThrow(/unknown counter/);
    expect(() => reg.set("mcp_nonexistent_gauge", 1)).toThrow(/unknown gauge/);
  });
});
