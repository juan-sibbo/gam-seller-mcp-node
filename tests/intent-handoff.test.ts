import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_INTENT_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";
import { IntentStore } from "../src/intent/store.js";
import { MetricsRegistry } from "../src/metrics/registry.js";
import {
  NullHandoffSink,
  FileHandoffSink,
  resolveHandoffSink,
  type HandoffSink,
  type HandoffRecord,
} from "../src/intent/handoff.js";

const SAMPLE: HandoffRecord = {
  intent_id: "i-1",
  buyer_id: "test-buyer-001",
  family_id: "display-ros",
  period: "Q4-2026",
  firm_price: 4.5,
  currency: "EUR",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2026-01-01T00:15:00.000Z",
};

// ── Sinks ──────────────────────────────────────────────────────────────────────────────────
describe("HandoffSink implementations", () => {
  it("NullHandoffSink delivers nothing and resolves", async () => {
    const sink = new NullHandoffSink();
    expect(sink.kind).toBe("null");
    await expect(sink.emit(SAMPLE)).resolves.toBeUndefined();
  });

  it("FileHandoffSink appends one parseable JSONL line per record (with buyer_id + firm_price)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-file-"));
    const file = join(dir, "intent-handoff.jsonl");
    try {
      const sink = new FileHandoffSink(file);
      await sink.emit(SAMPLE);
      await sink.emit({ ...SAMPLE, intent_id: "i-2" });
      const lines = readFileSync(file, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]) as HandoffRecord;
      expect(first.intent_id).toBe("i-1");
      expect(first.buyer_id).toBe("test-buyer-001"); // first-party drop MAY carry raw buyer_id
      expect(first.firm_price).toBe(4.5); // …and the firm price (this is not the pseudonymized ledger)
      expect((JSON.parse(lines[1]) as HandoffRecord).intent_id).toBe("i-2");
      expect(sink.isHealthy()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── resolveHandoffSink (env-selected, fail-closed, egress deny-all) ──────────────────────────
describe("resolveHandoffSink", () => {
  it("returns NullHandoffSink when MCP_INTENT_HANDOFF is unset", () => {
    expect(resolveHandoffSink({} as NodeJS.ProcessEnv)).toBeInstanceOf(NullHandoffSink);
  });

  it('returns a FileHandoffSink for "file"', () => {
    const sink = resolveHandoffSink({
      MCP_INTENT_HANDOFF: "file",
      MCP_INTENT_HANDOFF_FILE: "/tmp/x.jsonl",
    } as unknown as NodeJS.ProcessEnv);
    expect(sink).toBeInstanceOf(FileHandoffSink);
  });

  it("throws (egress deny-all) on an http(s):// URL — the node makes no outbound calls", () => {
    expect(() =>
      resolveHandoffSink({ MCP_INTENT_HANDOFF: "https://sales.example/handoff" } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/outbound|egress/i);
    expect(() =>
      resolveHandoffSink({ MCP_INTENT_HANDOFF: "http://sales.example/handoff" } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/outbound|egress/i);
  });

  it("throws (fail-closed) on an unrecognized value", () => {
    expect(() =>
      resolveHandoffSink({ MCP_INTENT_HANDOFF: "smtp-relay" } as unknown as NodeJS.ProcessEnv)
    ).toThrow();
  });
});

// ── Integration: create_intent delivery is fire-and-forget (never blocks or fails the commit) ──
const ENTITLED_BUYER = "test-buyer-001";
const FAMILY = "display-ros";
const FIRM_PRICE = 4.5;

class CapturingSink implements HandoffSink {
  readonly kind = "capture";
  public records: HandoffRecord[] = [];
  async emit(record: HandoffRecord): Promise<void> {
    this.records.push(record);
  }
}
class ThrowingSink implements HandoffSink {
  readonly kind = "throw";
  async emit(): Promise<void> {
    throw new Error("sink is down");
  }
}

interface Ctx {
  client: Client;
  metrics: MetricsRegistry;
  issuer: TokenIssuer;
}

async function setup(handoffSink: HandoffSink): Promise<Ctx> {
  const keyPair = await generateDevKeyPair();
  const validator = new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD);
  const issuer = new TokenIssuer(keyPair.privateKey);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const metrics = new MetricsRegistry();
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
    ledger: createMemoryLedger(),
    replayGuard: new ReplayGuard(),
    intentStore: new IntentStore(),
    metricsRegistry: metrics,
    handoffSink,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handoff-test-buyer", version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, metrics, issuer };
}

async function createIntent(ctx: Ctx): Promise<{ isError: boolean; json: Record<string, unknown> }> {
  const { token } = await ctx.issuer.issue(ENTITLED_BUYER, BUYER_AUD);
  const res = await ctx.client.callTool({
    name: "create_intent",
    arguments: { token, family_id: FAMILY, period: "Q4-2026", price_ref: FIRM_PRICE },
  });
  const text = (res.content as Array<{ text: string }>)[0].text;
  return { isError: Boolean(res.isError), json: JSON.parse(text) as Record<string, unknown> };
}

// Let the fire-and-forget .then/.catch microtask settle after the tool response returns.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("create_intent — handoff delivery (fire-and-forget)", () => {
  it("delivers the committed intent (raw buyer_id + firm_price) and counts a success", async () => {
    const sink = new CapturingSink();
    const ctx = await setup(sink);
    const out = await createIntent(ctx);
    expect(out.isError).toBe(false);
    expect(typeof out.json.intent_id).toBe("string");
    await flush();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].buyer_id).toBe(ENTITLED_BUYER);
    expect(sink.records[0].firm_price).toBe(FIRM_PRICE);
    expect(sink.records[0].family_id).toBe(FAMILY);
    expect(ctx.metrics.render()).toContain('mcp_intent_handoff_total{outcome="delivered"} 1');
  });

  it("still SUCCEEDS when the sink throws — the commit is never blocked or failed", async () => {
    const ctx = await setup(new ThrowingSink());
    const out = await createIntent(ctx);
    // The buyer's commit succeeded regardless of the (failed) downstream delivery: the ledger is
    // the record of record, and delivery is off the critical path.
    expect(out.isError).toBe(false);
    expect(typeof out.json.intent_id).toBe("string");
    await flush();
    // The failure is surfaced on the metric, not swallowed.
    expect(ctx.metrics.render()).toContain('mcp_intent_handoff_total{outcome="failed"} 1');
  });
});
