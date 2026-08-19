// Buyer-agent walkthrough over the REAL MCP tool surface.
//
// This drives the five native tools through the official MCP client and an in-process linked
// transport (no port, no subprocess) — so what you see is exactly what a buyer agent hits over
// the protocol, refusals included. Data is 100% synthetic (the bundled pilot config); nothing
// touches an ad server.
//
// Run:  npm run demo    (or: npx tsx demo/run-demo.ts)
//
// The point of the demo is not just the happy path (discover → forecast → intent → revoke); it
// is the GOVERNED REFUSALS at the end — the node saying "no" by design (fail-closed auth,
// Default-Deny, fail-closed pricing) — and the audit trail that records every allow AND deny.

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
import { EntitlementStore, type EntitlementsConfig } from "../src/policy/entitlements.js";
import { AllowedSurface } from "../src/policy/types.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger, type AuditLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";

const DEMO_BUYER = "pilot-buyer-001"; // entitled to every surface below
const PRICE_PROBE_BUYER = "pilot-buyer-002"; // entitled to INTENT; used for the price-guard refusal
const CURIOUS_BUYER = "curious-buyer-999"; // authenticated, but entitled to nothing (Default-Deny)
const FAMILY = "display-ros";
const FIRM_PRICE = 4.5; // matches TEST_PRICING_CONFIG for display-ros
const PERIOD = "Q4-2026";

// The demo buyer is entitled to every surface it exercises; the curious buyer is deliberately
// absent, so the node denies it by default (nothing to grant → DENY, never an error leak). A
// second entitled buyer probes the price guard with a fresh rate-limit budget (so the refusal
// is the price check, not the throttle the demo buyer already spent on its own create_intent).
const DEMO_ENTITLEMENTS: EntitlementsConfig = {
  entitlements: [
    {
      buyer_id: DEMO_BUYER,
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
    {
      buyer_id: PRICE_PROBE_BUYER,
      surfaces: [AllowedSurface.INTENT],
      scopes: ["gam.readonly"],
      phase: "phase-1-readonly",
    },
  ],
};

const SEP = "─".repeat(64);
function section(title: string): void {
  process.stdout.write(`\n${SEP}\n${title}\n${SEP}\n`);
}
function line(text: string): void {
  process.stdout.write(`  ${text}\n`);
}
function block(label: string, value: unknown): void {
  line(label);
  if (value !== undefined) {
    process.stdout.write(
      JSON.stringify(value, null, 2)
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n") + "\n"
    );
  }
}

interface ToolReply {
  isError: boolean;
  text: string;
  json: Record<string, unknown>;
}

async function main(): Promise<void> {
  process.stdout.write("\n🎬  GAM Seller MCP Node — buyer-agent walkthrough\n");
  process.stdout.write("    Real MCP tools over an in-process transport · 100% synthetic data\n");

  // ── Wire the node exactly as a deployment would, but in-process. We keep the `ledger`
  //    instance so we can show the audit trail it recorded at the end. ──────────────────────
  const keyPair = await generateDevKeyPair();
  const issuer = new TokenIssuer(keyPair.privateKey);
  const validator = new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const ledger: AuditLedger = createMemoryLedger();

  const server = buildServer({
    store: new EntitlementStore(DEMO_ENTITLEMENTS),
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
  const client = new Client({ name: "demo-buyer-agent", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Tokens are minted by the node operator (here, us) and handed to the buyer. Identity is
  // derived from the token's `sub` — there is no buyer_id argument anywhere.
  const buyerToken = (await issuer.issue(DEMO_BUYER, BUYER_AUD)).token;
  const priceProbeToken = (await issuer.issue(PRICE_PROBE_BUYER, BUYER_AUD)).token;
  const curiousToken = (await issuer.issue(CURIOUS_BUYER, BUYER_AUD)).token;

  async function call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* well_known returns a JWS string, not JSON — handled inline */
    }
    return { isError: Boolean(res.isError), text, json };
  }

  // ── 1 · well_known_capabilities — the signed trust anchor, readable before any request ───
  section("1 · well_known_capabilities — signed trust anchor (public, no token)");
  const wk = await call("well_known_capabilities", {});
  const doc = await wellKnown.verify(wk.text); // RS256 signature verifies against the node key
  block("Signature verified ✓ — the buyer trusts the content before its first request:", {
    node_id: doc.node_id,
    version: doc.version,
    posture: doc.posture,
    capability_families: doc.capability_families,
    privacy_posture: doc.privacy_posture,
  });

  // ── 2 · discover_products — curated families + firm list prices ──────────────────────────
  section("2 · discover_products — what can this buyer buy, and at what firm price?");
  const discover = await call("discover_products", { token: buyerToken });
  block(`Families visible to ${DEMO_BUYER} (deal IDs / raw inventory never returned):`, discover.json.families);

  // ── 3 · get_forecast — coarse availability bucket ────────────────────────────────────────
  section("3 · get_forecast — coarse availability (buckets, never exact impressions)");
  const forecast = await call("get_forecast", { token: buyerToken, family_id: FAMILY, period: PERIOD });
  block(`Forecast for ${FAMILY} · ${PERIOD}:`, forecast.json);

  // ── 4 · create_intent — a firm, time-boxed commitment at the current firm price ──────────
  section("4 · create_intent — commit to the family at its firm price (with TTL)");
  const created = await call("create_intent", {
    token: buyerToken,
    family_id: FAMILY,
    period: PERIOD,
    price_ref: FIRM_PRICE,
  });
  block("Intent recorded (NOT a GAM order, NOT an inventory hold — the handoff artifact):", created.json);
  const intentId = String(created.json.intent_id ?? "");

  // ── 5 · revoke_intent — withdraw your own commitment ─────────────────────────────────────
  section("5 · revoke_intent — withdraw one of your own intents by id");
  const revoked = await call("revoke_intent", { token: buyerToken, intent_id: intentId });
  block(`Intent ${intentId.slice(0, 8)}… withdrawn by its owner:`, revoked.json);

  // ── 6 · GOVERNED REFUSALS — the node saying "no" by design ───────────────────────────────
  section("6 · Governed refusals — the node says no by design (the whole point)");

  const noToken = await call("discover_products", {}); // fail-closed auth: no token, no identity
  line(`⛔ discover_products with NO token       → ${refusal(noToken)}  (auth is fail-closed)`);

  const unentitled = await call("discover_products", { token: curiousToken }); // Default-Deny
  line(`⛔ discover_products as an unentitled buyer → ${refusal(unentitled)}  (Default-Deny: authenticated, but granted nothing)`);

  const stalePrice = await call("create_intent", {
    token: priceProbeToken, // fresh rate-limit budget, so this refusal is the price guard, not the throttle
    family_id: FAMILY,
    period: PERIOD,
    price_ref: 999.0, // does not match the firm price → the same guard that rejects an EXPIRED price
  });
  line(`⛔ create_intent with a mismatched price   → ${refusal(stalePrice)}  (fail-closed pricing; identical envelope for a stale price — the real price never leaks)`);

  // ── 7 · Audit trail — every allow AND deny is on the hash-chained ledger ──────────────────
  section("7 · Audit trail — allows and denies alike, hash-chained and verifiable");
  const replay = ledger.replayVerify();
  block(`${ledger.size()} events recorded this session (buyer_id is HMAC-pseudonymized, never raw):`,
    ledger.allEntries().map((e) => ({ seq: e.seq, event: e.event_class, buyer: e.buyer_id })));
  block("Chain integrity:", { chain_valid: replay.valid, head_hash: ledger.headHash().slice(0, 16) + "…" });
  line("Tampering with any event breaks the chain — and replayVerify() detects it.");

  section("Done — 5 native tools exercised, 3 refusals demonstrated, chain verified");
  process.stdout.write("\n");

  await client.close();
  await server.close();
}

// Format a denied reply: a governed refusal is expected to be an error envelope carrying a
// stable `code` (AUTH_FAILED / INVALID_REQUEST / …) and nothing sensitive.
function refusal(reply: ToolReply): string {
  const code = typeof reply.json.code === "string" ? reply.json.code : "UNKNOWN";
  return reply.isError ? `REFUSED (${code})` : `UNEXPECTEDLY ALLOWED — ${reply.text}`;
}

main().catch((err) => {
  process.stderr.write(`\nDemo failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
