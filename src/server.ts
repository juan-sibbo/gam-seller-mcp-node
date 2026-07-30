import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "url";
import { PolicyEngine } from "./policy/engine.js";
import { EntitlementStore, loadEntitlementsFromFile } from "./policy/entitlements.js";
import { DEV_DSR_STATE_PATH } from "./policy/dsr-state.js";
import { AllowedSurface } from "./policy/types.js";
import { ErrorCode, makeSafeError } from "./errors/envelope.js";
import { loadOrCreateKeyPair } from "./identity/keystore.js";
import { TokenIssuer } from "./identity/issuer.js";
import { TokenValidator } from "./identity/validator.js";
import { Denylist, DEV_DENYLIST_PATH } from "./identity/denylist.js";
import { BUYER_ISS, BUYER_AUD } from "./identity/types.js";
import { WellKnownService } from "./discovery/well-known.js";
import { CatalogStore, loadCatalogFromFile } from "./catalog/store.js";
import { PricingStore, loadPricingFromFile } from "./pricing/store.js";
import { projectFamily } from "./catalog/projection.js";
import { IntentStore } from "./intent/store.js";
import { RateLimiter } from "./rate-limiter/limiter.js";
import { ForecastEngine } from "./forecast/engine.js";
import { loadDeploymentConfigFromFile } from "./config/deployment.js";
import { AuditLedger, DEV_LEDGER_PATH } from "./audit/ledger.js";
import { ReplayGuard } from "./audit/replay.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "./audit/pseudonym.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH, ANCHOR_INTERVAL_MS } from "./audit/anchor.js";
import { RetentionService, DEV_ARCHIVE_PATH, runRetentionCycle, RETENTION_INTERVAL_MS } from "./audit/retention.js";
import { EventClass } from "./audit/event.js";
import { startHttpServer, httpOptionsFromEnv } from "./http.js";
import { buildHealthReport } from "./health.js";
import { packageVersion } from "./config/paths.js";
import { MetricsRegistry, MetricTool, ToolOutcome, AuthFailReason } from "./metrics/registry.js";
import { randomUUID } from "crypto";

// Buyer contract shape. Bumped 0.1.0 → 0.2.0 in v0.4 Bloque A: buyer surfaces no longer
// accept a buyer_id argument (identity is derived from the token's sub) — a breaking
// change to the tool input shape, so the contract version moves.
const CONTRACT_VERSION = "0.2.0";

// How often the background sweep ages out expired intents (v0.6+ intent lifecycle).
// A minute is fine: the intent TTL is minutes-to-hours and expiry is not latency-sensitive.
const INTENT_SWEEP_INTERVAL_MS = 60_000;

interface ServerDeps {
  store: EntitlementStore;
  issuer: TokenIssuer;
  validator: TokenValidator;
  wellKnown: WellKnownService;
  catalog: CatalogStore;
  pricingStore: PricingStore;
  rateLimiter: RateLimiter;
  forecastEngine: ForecastEngine;
  forecastRateLimiter: RateLimiter;
  ledger: AuditLedger;
  replayGuard: ReplayGuard;
  // Commitment store (v0.5 Bloque B). Optional for back-compat with existing buildServer
  // call sites that predate create_intent; when absent a fresh per-server store is used.
  // main() always passes ONE shared instance so intents survive across HTTP connections
  // (buildServer is called per-connection) — the same reason ledger/replayGuard are shared.
  intentStore?: IntentStore;
  // Per-buyer rate limiter for create_intent (N=1/T=30s). Optional/shared for the same
  // reason as intentStore: main() passes one instance so the throttle holds across
  // connections. Absent → a fresh per-server limiter (fine for single-call tests).
  intentRateLimiter?: RateLimiter;
  // Optional operator metrics. When absent, every handler runs unchanged and no
  // series are recorded — observability is additive, never on the request's critical path.
  metricsRegistry?: MetricsRegistry;
}

function buildServer(deps: ServerDeps): McpServer {
  const { store, validator, wellKnown, catalog, pricingStore, rateLimiter, forecastEngine, forecastRateLimiter, ledger, replayGuard, metricsRegistry } = deps;
  // Shared commitment store when provided (main() path); a per-server fallback keeps
  // legacy call sites that never touch create_intent working unchanged.
  const intentStore = deps.intentStore ?? new IntentStore();
  const intentRateLimiter = deps.intentRateLimiter ?? new RateLimiter();
  const policy = new PolicyEngine(store);

  // Record a handler's terminal outcome: the labelled call counter plus the current
  // ledger size (which reflects any audit appends this request made). No buyer_id
  // ever reaches these labels — see the MetricsRegistry security invariant.
  function recordOutcome(tool: MetricTool, outcome: ToolOutcome): void {
    metricsRegistry?.increment("mcp_tool_calls_total", { tool, outcome });
    metricsRegistry?.set("mcp_audit_ledger_entries_total", ledger.size());
  }

  const server = new McpServer({
    name: "gam-seller-mcp-node",
    version: CONTRACT_VERSION,
  });

  // Derive the buyer identity from a validated buyer token (v0.4 Bloque A — buyer→node
  // identity binding). Returns { buyer_id } (== token.sub) on success, or null on any
  // failure. There is NO buyer_id input anywhere: a request's identity comes ONLY from
  // its token, so a caller can never act as another buyer (the pre-v0.4 impersonation
  // hole). No token → no derivable identity → deny (require_auth posture, A3).
  // Revocation or invalid token → AUTH_FAILED (soap-fault-redaction-signoff §4 Option A).
  // Emits BUYER_AUTHENTICATION (decision-package Bloque 2 §2.4) — the ledger pseudonymizes buyer_id.
  async function authenticate(
    token: string | undefined,
    surface: AllowedSurface,
    request_id: string
  ): Promise<{ buyer_id: string } | null> {
    if (!token) return null;
    const validation = await validator.validate(token);
    // On a denylist/invalid-audience deny we may have no claims — the auth event then
    // carries no buyer_id (ledger.append drops a falsy buyer_id). Never trust input for it.
    const buyer_id = validation.claims?.sub ?? "";
    ledger.append(
      EventClass.BUYER_AUTHENTICATION,
      { outcome: validation.valid ? "allow" : "deny", surface },
      { buyer_id, request_id }
    );
    if (!validation.valid || buyer_id === "") return null;
    return { buyer_id };
  }

  // Run the Policy Engine and audit the decision.
  // Emits SCOPE_RESOLUTION with outcome + reason (payload is minimized: no entitlement internals).
  function resolveScope(buyer_id: string, surface: AllowedSurface, request_id: string): boolean {
    const decision = policy.decide({
      buyer_id,
      surface,
      scope: "gam.readonly",
      phase: "phase-1-readonly",
      request_id,
    });
    ledger.append(
      EventClass.SCOPE_RESOLUTION,
      { outcome: decision.outcome, surface, reason: decision.reason },
      { buyer_id, request_id }
    );
    return decision.outcome === "ALLOW";
  }

  function authFailedResult(request_id: string) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(makeSafeError(ErrorCode.AUTH_FAILED, "Authentication failed.", request_id, CONTRACT_VERSION)) }],
      isError: true,
    };
  }

  function replayResult(request_id: string) {
    // Generic message — a replayed request must not be distinguishable from any other
    // invalid request (soap-fault-redaction-signoff §2).
    return {
      content: [{ type: "text" as const, text: JSON.stringify(makeSafeError(ErrorCode.INVALID_REQUEST, "Invalid request.", request_id, CONTRACT_VERSION)) }],
      isError: true,
    };
  }

  function invalidRequestResult(request_id: string) {
    // Generic message — a fail-closed price rejection must not leak the real firm price
    // or whether the family exists (soap-fault-redaction-signoff §2). Same envelope as
    // replayResult by design: the buyer cannot distinguish the reason.
    return {
      content: [{ type: "text" as const, text: JSON.stringify(makeSafeError(ErrorCode.INVALID_REQUEST, "Invalid request.", request_id, CONTRACT_VERSION)) }],
      isError: true,
    };
  }

  function rateLimitedResult(request_id: string) {
    // soap-fault-redaction-signoff §2: generic message, no quota value exposed.
    return {
      content: [{ type: "text" as const, text: JSON.stringify(makeSafeError(ErrorCode.RATE_LIMITED, "Too many requests, retry later.", request_id, CONTRACT_VERSION)) }],
      isError: true,
    };
  }

  // /.well-known/seller-mcp-capabilities — e12-discovery-trust-anchor-signoff.md §2 Opción A.
  // PUBLIC BY DESIGN: this document is the trust anchor a buyer verifies BEFORE any
  // authenticated interaction — gating it behind an entitlement would be a bootstrap
  // deadlock (E-12: "legible, cacheable, sin dependencia de registro externo").
  // Its content is coarse and non-sensitive by construction (§7 fija el contenido mínimo).
  // No entitlement check; no audit event (the 16 ratified classes contain no discovery-read
  // class and the set is closed — decision-package Bloque 2 §2.4).
  server.tool(
    "well_known_capabilities",
    "Return the signed RS256 capability document for this Seller MCP Node.",
    {},
    async () => {
      const signedDoc = await wellKnown.sign();
      // Public, unguarded surface — the only terminal outcome is success.
      recordOutcome(MetricTool.WELL_KNOWN_CAPABILITIES, ToolOutcome.SUCCESS);
      return { content: [{ type: "text", text: signedDoc }] };
    }
  );

  // Product discovery — adapter-boundary-allowed-surfaces-signoff.md §3 (allowlist MVP surface 2)
  // Order: token auth → policy → rate limit. Rate state is only consumed on authorized requests.
  server.tool(
    "discover_products",
    "Discover coarse product families available to this buyer.",
    {
      token: z.string().optional().describe("Buyer bearer JWT (RS256, aud=seller-mcp-node). Identity is derived from token.sub."),
      client_request_id: z.string().optional().describe("Client-supplied idempotency key for replay detection"),
    },
    async ({ token, client_request_id }) => {
      const request_id = randomUUID();

      // Replay check first (SEC-GATE-3) — before auth, so a replayed request never even
      // reaches token validation. No client_request_id → no dedupe (back-compat).
      if (client_request_id !== undefined) {
        if (replayGuard.isReplay(client_request_id)) {
          metricsRegistry?.increment("mcp_replay_rejected_total", { tool: MetricTool.DISCOVER_PRODUCTS });
          recordOutcome(MetricTool.DISCOVER_PRODUCTS, ToolOutcome.REPLAY_REJECTED);
          return replayResult(request_id);
        }
        replayGuard.record(client_request_id);
      }

      // Identity is derived from the token — null means no/invalid/revoked token.
      // buyer_id is token.sub, never client input (Bloque A: no impersonation surface).
      const auth = await authenticate(token, AllowedSurface.PRODUCT_DISCOVERY, request_id);
      if (!auth) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.DISCOVER_PRODUCTS, reason: AuthFailReason.TOKEN_INVALID });
        recordOutcome(MetricTool.DISCOVER_PRODUCTS, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }
      const buyer_id = auth.buyer_id;

      if (!resolveScope(buyer_id, AllowedSurface.PRODUCT_DISCOVERY, request_id)) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.DISCOVER_PRODUCTS, reason: AuthFailReason.SCOPE_DENIED });
        recordOutcome(MetricTool.DISCOVER_PRODUCTS, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }

      // Rate limit check — N=1/T=30s per buyer_id (blocker-#6 §4 RATIFIED).
      if (!rateLimiter.check(buyer_id)) {
        metricsRegistry?.increment("mcp_rate_limited_total", { tool: MetricTool.DISCOVER_PRODUCTS });
        recordOutcome(MetricTool.DISCOVER_PRODUCTS, ToolOutcome.RATE_LIMITED);
        return rateLimitedResult(request_id);
      }

      // Synthetic catalog from config — zero GAM (S4).
      // Egress no-leak guard (C4): projectFamily copies ONLY the buyer-facing fields by name,
      // never spreads the raw config object — so a sensitive key added to catalog.json can
      // never reach a buyer. consent_context/legal_basis_provenance are forced to the Pilar 3
      // reserved null. SEC-GATE-13 bisturí: attach the UNIFORM list price when available; only
      // the list price is exposed (per-buyer/exact pricing stays denied — DP-AB-01 §3/§5.1).
      const families = catalog.discover(buyer_id).map((f) =>
        projectFamily(f, pricingStore.priceFor(f.family_id))
      );
      recordOutcome(MetricTool.DISCOVER_PRODUCTS, ToolOutcome.SUCCESS);
      return { content: [{ type: "text", text: JSON.stringify({ families, request_id }) }] };
    }
  );

  // Forecast (bucketized, synthetic) — s5-forecast-demo-mode-authorization-2026-07-04.md
  // Returns Low/Mid/High availability bucket. synthetic: true always set in demo mode.
  // Z3: response contains only inventory-level data — no audience attributes.
  server.tool(
    "get_forecast",
    "Get a coarse availability forecast (Low/Mid/High) for a product family and period. Demo mode: synthetic data only.",
    {
      family_id: z.string().describe("Product family ID from discover_products"),
      period: z.string().describe("Target period (e.g. Q4-2026, 2026-10)"),
      token: z.string().optional().describe("Buyer bearer JWT (RS256, aud=seller-mcp-node). Identity is derived from token.sub."),
      client_request_id: z.string().optional().describe("Client-supplied idempotency key for replay detection"),
    },
    async ({ family_id, period, token, client_request_id }) => {
      const request_id = randomUUID();

      // Replay check first (SEC-GATE-3) — before auth, so a replayed request never even
      // reaches token validation. No client_request_id → no dedupe (back-compat).
      if (client_request_id !== undefined) {
        if (replayGuard.isReplay(client_request_id)) {
          metricsRegistry?.increment("mcp_replay_rejected_total", { tool: MetricTool.GET_FORECAST });
          recordOutcome(MetricTool.GET_FORECAST, ToolOutcome.REPLAY_REJECTED);
          return replayResult(request_id);
        }
        replayGuard.record(client_request_id);
      }

      // Identity derived from the token (Bloque A) — buyer_id is token.sub, never input.
      const auth = await authenticate(token, AllowedSurface.FORECAST, request_id);
      if (!auth) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.GET_FORECAST, reason: AuthFailReason.TOKEN_INVALID });
        recordOutcome(MetricTool.GET_FORECAST, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }
      const buyer_id = auth.buyer_id;

      if (!resolveScope(buyer_id, AllowedSurface.FORECAST, request_id)) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.GET_FORECAST, reason: AuthFailReason.SCOPE_DENIED });
        recordOutcome(MetricTool.GET_FORECAST, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }

      // Separate rate limiter for forecast — N=1/T=30s (blocker-#6 §4 RATIFIED).
      if (!forecastRateLimiter.check(buyer_id)) {
        metricsRegistry?.increment("mcp_rate_limited_total", { tool: MetricTool.GET_FORECAST });
        recordOutcome(MetricTool.GET_FORECAST, ToolOutcome.RATE_LIMITED);
        return rateLimitedResult(request_id);
      }

      const result = await forecastEngine.forecast(family_id, period);
      // FORECAST_REQUEST payload is minimized: bucket + coarse identifiers only
      // (no raw avails — KANON §Logs-y-Audit).
      ledger.append(
        EventClass.FORECAST_REQUEST,
        { family_id, period, bucket: result.bucket, synthetic: true },
        { buyer_id, request_id }
      );
      recordOutcome(MetricTool.GET_FORECAST, ToolOutcome.SUCCESS);
      return { content: [{ type: "text", text: JSON.stringify({ ...result, request_id }) }] };
    }
  );

  // Commitment primitive — plan-core-v04 §3 (Bloque B, v0.5). Registers that an
  // AUTHENTICATED buyer expresses firm intent over a product at its CURRENT firm price,
  // with a TTL. NOT a GAM order nor a real inventory hold (SOFT_LOCK_* deferred to Tier 2)
  // — it is the A′-compatible handoff artifact the classic rails pick up. Zero GAM.
  // Order mirrors the read tools: replay → token auth → policy → firm-price fail-closed → emit.
  server.tool(
    "create_intent",
    "Register a firm buying intent over a product family at its current firm price (soft commitment with TTL). Not a GAM order or inventory hold.",
    {
      family_id: z.string().describe("Product family ID from discover_products"),
      period: z.string().describe("Target period (e.g. Q4-2026, 2026-10)"),
      price_ref: z.number().describe("The firm list price the buyer commits to; must match the family's current firm price"),
      token: z.string().optional().describe("Buyer bearer JWT (RS256, aud=seller-mcp-node). Identity is derived from token.sub."),
      client_request_id: z.string().optional().describe("Client-supplied idempotency key for replay detection"),
    },
    async ({ family_id, period, price_ref, token, client_request_id }) => {
      const request_id = randomUUID();

      // Replay check first (SEC-GATE-3) — a replayed create_intent must never create a
      // second commitment. Request-level dedupe IS the write's idempotency guarantee.
      if (client_request_id !== undefined) {
        if (replayGuard.isReplay(client_request_id)) {
          metricsRegistry?.increment("mcp_replay_rejected_total", { tool: MetricTool.CREATE_INTENT });
          recordOutcome(MetricTool.CREATE_INTENT, ToolOutcome.REPLAY_REJECTED);
          return replayResult(request_id);
        }
        replayGuard.record(client_request_id);
      }

      // Identity derived from the token (Bloque A) — buyer_id is token.sub, never input.
      const auth = await authenticate(token, AllowedSurface.INTENT, request_id);
      if (!auth) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.CREATE_INTENT, reason: AuthFailReason.TOKEN_INVALID });
        recordOutcome(MetricTool.CREATE_INTENT, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }
      const buyer_id = auth.buyer_id;

      if (!resolveScope(buyer_id, AllowedSurface.INTENT, request_id)) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.CREATE_INTENT, reason: AuthFailReason.SCOPE_DENIED });
        recordOutcome(MetricTool.CREATE_INTENT, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }

      // Anti-abuse — create_intent is the only write surface, so it must throttle per buyer
      // like the read tools (N=1/T=30s). Without this a buyer could flood the in-memory
      // commitment store. Checked after policy, before any commitment write.
      if (!intentRateLimiter.check(buyer_id)) {
        metricsRegistry?.increment("mcp_rate_limited_total", { tool: MetricTool.CREATE_INTENT });
        recordOutcome(MetricTool.CREATE_INTENT, ToolOutcome.RATE_LIMITED);
        return rateLimitedResult(request_id);
      }

      // Fail-closed on a stale or non-matching firm price (plan §3): priceFor returns
      // undefined when the family is unknown OR its firm price has expired — never commit
      // over a stale offer. A mismatched price_ref is rejected identically, with the same
      // generic envelope, so neither the real price nor the family's existence leaks.
      const price = pricingStore.priceFor(family_id);
      if (!price || price.list_price !== price_ref) {
        recordOutcome(MetricTool.CREATE_INTENT, ToolOutcome.INVALID_REQUEST);
        return invalidRequestResult(request_id);
      }

      const intent = intentStore.create({
        buyer_id,
        family_id,
        period,
        firm_price: price.list_price,
        currency: price.currency,
        price_valid_until: price.valid_until,
      });

      // INTENT_CREATED — class already ratified (event.ts:11). Payload is minimized: no
      // firm_price (exact pricing stays out of the ledger — KANON §Logs-y-Audit) and no
      // cross-buyer data. The ledger pseudonymizes buyer_id before hashing.
      ledger.append(
        EventClass.INTENT_CREATED,
        { intent_id: intent.intent_id, family_id, period, expires_at: intent.expires_at },
        { buyer_id, request_id }
      );
      recordOutcome(MetricTool.CREATE_INTENT, ToolOutcome.SUCCESS);
      return {
        content: [{ type: "text", text: JSON.stringify({
          intent_id: intent.intent_id,
          status: intent.status,
          firm_price: intent.firm_price,
          expires_at: intent.expires_at,
          request_id,
        }) }],
      };
    }
  );

  // Revoke one of your OWN active intents (v0.6+ intent lifecycle). Within the already-ratified
  // INTENT surface (write/read-your-own) — revoking is affecting your own state, never another
  // buyer's. Order: replay → token auth → policy → buyer-scoped revoke → emit INTENT_REVOKED.
  // A revoke that matches nothing (unknown id, another buyer's intent, already terminal, or
  // lapsed) returns the same generic INVALID_REQUEST — the buyer cannot probe others' intents.
  server.tool(
    "revoke_intent",
    "Revoke one of your own active intents by id. Idempotent per client_request_id.",
    {
      intent_id: z.string().describe("The intent_id returned by create_intent"),
      token: z.string().optional().describe("Buyer bearer JWT (RS256, aud=seller-mcp-node). Identity is derived from token.sub."),
      client_request_id: z.string().optional().describe("Client-supplied idempotency key for replay detection"),
    },
    async ({ intent_id, token, client_request_id }) => {
      const request_id = randomUUID();

      if (client_request_id !== undefined) {
        if (replayGuard.isReplay(client_request_id)) {
          metricsRegistry?.increment("mcp_replay_rejected_total", { tool: MetricTool.REVOKE_INTENT });
          recordOutcome(MetricTool.REVOKE_INTENT, ToolOutcome.REPLAY_REJECTED);
          return replayResult(request_id);
        }
        replayGuard.record(client_request_id);
      }

      const auth = await authenticate(token, AllowedSurface.INTENT, request_id);
      if (!auth) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.REVOKE_INTENT, reason: AuthFailReason.TOKEN_INVALID });
        recordOutcome(MetricTool.REVOKE_INTENT, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }
      const buyer_id = auth.buyer_id;

      if (!resolveScope(buyer_id, AllowedSurface.INTENT, request_id)) {
        metricsRegistry?.increment("mcp_auth_failures_total", { tool: MetricTool.REVOKE_INTENT, reason: AuthFailReason.SCOPE_DENIED });
        recordOutcome(MetricTool.REVOKE_INTENT, ToolOutcome.AUTH_FAILED);
        return authFailedResult(request_id);
      }

      // Buyer-scoped: undefined when the intent is absent, another buyer's, terminal, or lapsed.
      const revoked = intentStore.revoke(intent_id, buyer_id);
      if (!revoked) {
        recordOutcome(MetricTool.REVOKE_INTENT, ToolOutcome.INVALID_REQUEST);
        return invalidRequestResult(request_id);
      }

      // INTENT_REVOKED — ratified class (event.ts:13). Payload minimized; buyer pseudonymized.
      ledger.append(
        EventClass.INTENT_REVOKED,
        { intent_id: revoked.intent_id },
        { buyer_id, request_id }
      );
      recordOutcome(MetricTool.REVOKE_INTENT, ToolOutcome.SUCCESS);
      return {
        content: [{ type: "text", text: JSON.stringify({ intent_id: revoked.intent_id, status: revoked.status, request_id }) }],
      };
    }
  );

  return server;
}

// Age out expired intents and emit INTENT_EXPIRED for each (v0.6+ intent lifecycle). Wired on
// a timer in main(); exported so the emission logic is unit-testable without a live server.
// The store evicts each lapsed intent, so re-running is a no-op once everything has expired.
function sweepExpiredIntents(intentStore: IntentStore, ledger: AuditLedger, now: Date = new Date()): void {
  for (const intent of intentStore.sweepExpired(now)) {
    ledger.append(
      EventClass.INTENT_EXPIRED,
      { intent_id: intent.intent_id, expires_at: intent.expires_at },
      { buyer_id: intent.buyer_id }
    );
  }
}

// Anchor the ledger head externally — decision-package Bloque 2 §2.2 (60-min batch, RATIFIED).
// Skips when the ledger is empty or the head hasn't moved since the last anchor.
// The ANCHORING event is appended AFTER the anchor write, so the anchored hash always
// covers a stable prefix (same pattern as tests/audit.test.ts).
function anchorHead(ledger: AuditLedger, anchor: HeadHashAnchor): void {
  const headHash = ledger.headHash();
  if (headHash === "" || anchor.latest()?.head_hash === headHash) return;
  const record = anchor.anchor(headHash, ledger.headSeq());
  ledger.append(EventClass.ANCHORING, { anchored_head_hash: record.head_hash, anchor_seq: record.seq });
}

async function main() {
  // Fail-closed: an invalid legal config (missing dsr_contact, bad retention) must
  // prevent startup — loadDeploymentConfigFromFile throws before anything serves.
  const deployment = loadDeploymentConfigFromFile();

  // Persistent identity (Fase A): same RS256 key across restarts — outstanding tokens
  // and cached well-known signatures survive a reboot (e12 §6 TTL semantics).
  const keyPair = await loadOrCreateKeyPair();
  process.stderr.write("[identity] RS256 key pair loaded (persistent, keys/ gitignored)\n");

  const denylist = new Denylist(DEV_DENYLIST_PATH);
  const issuer = new TokenIssuer(keyPair.privateKey);
  // Buyer→node identity axis (Bloque A): the validator guarding buyer surfaces accepts
  // ONLY buyer bearer tokens (aud=seller-mcp-node), never Domain-2 node↔adapter tokens.
  const validator = new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, deployment);
  // Fail-closed: an invalid entitlements config (unknown surface, empty buyer_id) must
  // prevent startup — loadEntitlementsFromFile throws before anything serves. The persistent
  // DSR overlay is applied on top, so restrictions/erasures exercised via the DSR CLI are
  // enforced from boot (and a corrupt overlay also fails closed).
  const store = new EntitlementStore(loadEntitlementsFromFile(), DEV_DSR_STATE_PATH);
  const catalog = loadCatalogFromFile();
  // Fail-closed: loadPricingFromFile throws on missing/unparseable valid_until (D7).
  const pricingStore = loadPricingFromFile();
  const rateLimiter = new RateLimiter();
  const forecastEngine = new ForecastEngine();
  const forecastRateLimiter = new RateLimiter();
  const replayGuard = new ReplayGuard();
  // Shared commitment store (v0.5 Bloque B) — one instance for the whole process so
  // intents survive across HTTP connections (buildServer runs per-connection).
  const intentStore = new IntentStore();
  // Shared create_intent rate limiter (N=1/T=30s) — one instance so the throttle holds
  // across connections, same reason as the discover/forecast limiters above.
  const intentRateLimiter = new RateLimiter();
  // Shared metrics registry — the same instance backs both the tool handlers and the
  // /metrics HTTP route, so counters recorded in-handler are visible at scrape time.
  const metricsRegistry = new MetricsRegistry();

  // Audit chain: pseudonymized ledger + external head-hash anchoring (S3, wired S7).
  const pseudonyms = new PseudonymService(DEV_PSEUDONYM_KEYS_PATH);
  const ledger = new AuditLedger(DEV_LEDGER_PATH, pseudonyms);
  const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
  anchorHead(ledger, anchor); // anchor whatever survived the previous run
  setInterval(() => anchorHead(ledger, anchor), ANCHOR_INTERVAL_MS).unref();

  // Enforce ledger retention automatically (A3 SIGNED: 90d hot → 12m archive → purge).
  // Without this scheduled cycle, rotate()/purge() never run and the "automatic" purge
  // would be dead code — the ledger would grow unbounded, breaking storage limitation
  // (GDPR Art. 5(1)(e)). Runs once at startup to catch up on downtime, then on a timer.
  // The same cycle also crypto-shreds pseudonym keys inactive beyond the retention
  // horizon (hot_days + archive_months): the keystore is the only place the clear
  // buyer_id survives, so it obeys the same storage-limitation principle as the ledger.
  const retention = new RetentionService(deployment.retention, anchor, DEV_ARCHIVE_PATH);
  runRetentionCycle(retention, ledger, Date.now(), pseudonyms);
  setInterval(() => runRetentionCycle(retention, ledger, Date.now(), pseudonyms), RETENTION_INTERVAL_MS).unref();

  // Age out expired intents on a timer, emitting INTENT_EXPIRED (v0.6+ intent lifecycle).
  // Without this the TTL would be advisory: a lapsed commitment would linger as "active" and
  // its expiry would never be audited.
  setInterval(() => sweepExpiredIntents(intentStore, ledger), INTENT_SWEEP_INTERVAL_MS).unref();

  const deps: ServerDeps = { store, issuer, validator, wellKnown, catalog, pricingStore, rateLimiter, forecastEngine, forecastRateLimiter, ledger, replayGuard, intentStore, intentRateLimiter, metricsRegistry };

  // Fase A: --http serves StreamableHTTP on 127.0.0.1 (external bind = infra act, #8/#10).
  // Default remains stdio for MCP-host usage.
  if (process.argv.includes("--http")) {
    const opts = httpOptionsFromEnv();
    await startHttpServer(
      {
        makeServer: () => buildServer(deps),
        wellKnown,
        metricsRegistry,
        // Health reflects the shared ledger's live durability flag (v0.6 E1) + node version.
        getHealth: () => buildHealthReport(ledger.isPersistenceHealthy(), packageVersion()),
      },
      opts
    );
    process.stderr.write(
      `GAM Seller MCP Node started on http://${opts.host}:${opts.port} (MCP at /mcp, well-known at canonical route; dev context, read-only MVP)\n`
    );
    return;
  }

  const server = buildServer(deps);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  process.stderr.write("GAM Seller MCP Node started (stdio; dev context, read-only MVP, G5 signed 04/07/26)\n");
}

export { buildServer, anchorHead, sweepExpiredIntents };
export type { ServerDeps };

// Only boot when executed directly — importing buildServer (tests, tooling) must not
// start a transport or touch dev data files.
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
