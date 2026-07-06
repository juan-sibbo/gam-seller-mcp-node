import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "url";
import { PolicyEngine } from "./policy/engine.js";
import { EntitlementStore, DEFAULT_ENTITLEMENTS_CONFIG } from "./policy/entitlements.js";
import { AllowedSurface } from "./policy/types.js";
import { ErrorCode, makeSafeError } from "./errors/envelope.js";
import { loadOrCreateKeyPair } from "./identity/keystore.js";
import { TokenIssuer } from "./identity/issuer.js";
import { TokenValidator } from "./identity/validator.js";
import { Denylist, DEV_DENYLIST_PATH } from "./identity/denylist.js";
import { WellKnownService } from "./discovery/well-known.js";
import { CatalogStore, loadCatalogFromFile } from "./catalog/store.js";
import { RateLimiter } from "./rate-limiter/limiter.js";
import { ForecastEngine } from "./forecast/engine.js";
import { loadDeploymentConfigFromFile } from "./config/deployment.js";
import { AuditLedger, DEV_LEDGER_PATH } from "./audit/ledger.js";
import { ReplayGuard } from "./audit/replay.js";
import { PseudonymService, DEV_PSEUDONYM_KEYS_PATH } from "./audit/pseudonym.js";
import { HeadHashAnchor, DEV_ANCHOR_PATH, ANCHOR_INTERVAL_MS } from "./audit/anchor.js";
import { EventClass } from "./audit/event.js";
import { startHttpServer, httpOptionsFromEnv } from "./http.js";
import { randomUUID } from "crypto";

const CONTRACT_VERSION = "0.1.0";

interface ServerDeps {
  store: EntitlementStore;
  issuer: TokenIssuer;
  validator: TokenValidator;
  wellKnown: WellKnownService;
  catalog: CatalogStore;
  rateLimiter: RateLimiter;
  forecastEngine: ForecastEngine;
  forecastRateLimiter: RateLimiter;
  ledger: AuditLedger;
  replayGuard: ReplayGuard;
}

function buildServer(deps: ServerDeps): McpServer {
  const { store, validator, wellKnown, catalog, rateLimiter, forecastEngine, forecastRateLimiter, ledger, replayGuard } = deps;
  const policy = new PolicyEngine(store);

  const server = new McpServer({
    name: "gam-seller-mcp-node",
    version: CONTRACT_VERSION,
  });

  // Validate an optional domain-2 token and audit the outcome.
  // Revocation or invalid token → AUTH_FAILED (soap-fault-redaction-signoff §4 Option A).
  // Emits BUYER_AUTHENTICATION (decision-package Bloque 2 §2.4) — the ledger pseudonymizes buyer_id.
  async function authenticate(
    token: string | undefined,
    buyer_id: string,
    surface: AllowedSurface,
    request_id: string
  ): Promise<boolean> {
    if (!token) return true; // token optional in dev context — policy still gates below
    const validation = await validator.validate(token);
    ledger.append(
      EventClass.BUYER_AUTHENTICATION,
      { outcome: validation.valid ? "allow" : "deny", surface },
      { buyer_id, request_id }
    );
    return validation.valid;
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
      return { content: [{ type: "text", text: signedDoc }] };
    }
  );

  // Product discovery — adapter-boundary-allowed-surfaces-signoff.md §3 (allowlist MVP surface 2)
  // Order: token auth → policy → rate limit. Rate state is only consumed on authorized requests.
  server.tool(
    "discover_products",
    "Discover coarse product families available to this buyer.",
    {
      buyer_id: z.string().describe("Buyer identifier (opaque, B2B)"),
      token: z.string().optional().describe("Domain-2 inter-service JWT (RS256)"),
      client_request_id: z.string().optional().describe("Client-supplied idempotency key for replay detection"),
    },
    async ({ buyer_id, token, client_request_id }) => {
      const request_id = randomUUID();

      // Replay check first (SEC-GATE-3) — before auth, so a replayed request never even
      // reaches token validation. No client_request_id → no dedupe (back-compat).
      if (client_request_id !== undefined) {
        if (replayGuard.isReplay(client_request_id)) {
          return replayResult(request_id);
        }
        replayGuard.record(client_request_id);
      }

      if (!(await authenticate(token, buyer_id, AllowedSurface.PRODUCT_DISCOVERY, request_id))) {
        return authFailedResult(request_id);
      }

      if (!resolveScope(buyer_id, AllowedSurface.PRODUCT_DISCOVERY, request_id)) {
        return authFailedResult(request_id);
      }

      // Rate limit check — N=1/T=30s per buyer_id (blocker-#6 §4 RATIFIED).
      if (!rateLimiter.check(buyer_id)) {
        return rateLimitedResult(request_id);
      }

      // Synthetic catalog from config — zero GAM (S4).
      // consent_context and legal_basis_provenance are Pilar 3 reserved fields (null in v1).
      const families = catalog.discover(buyer_id);
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
      buyer_id: z.string().describe("Buyer identifier (opaque, B2B)"),
      family_id: z.string().describe("Product family ID from discover_products"),
      period: z.string().describe("Target period (e.g. Q4-2026, 2026-10)"),
      token: z.string().optional().describe("Domain-2 inter-service JWT (RS256)"),
      client_request_id: z.string().optional().describe("Client-supplied idempotency key for replay detection"),
    },
    async ({ buyer_id, family_id, period, token, client_request_id }) => {
      const request_id = randomUUID();

      // Replay check first (SEC-GATE-3) — before auth, so a replayed request never even
      // reaches token validation. No client_request_id → no dedupe (back-compat).
      if (client_request_id !== undefined) {
        if (replayGuard.isReplay(client_request_id)) {
          return replayResult(request_id);
        }
        replayGuard.record(client_request_id);
      }

      if (!(await authenticate(token, buyer_id, AllowedSurface.FORECAST, request_id))) {
        return authFailedResult(request_id);
      }

      if (!resolveScope(buyer_id, AllowedSurface.FORECAST, request_id)) {
        return authFailedResult(request_id);
      }

      // Separate rate limiter for forecast — N=1/T=30s (blocker-#6 §4 RATIFIED).
      if (!forecastRateLimiter.check(buyer_id)) {
        return rateLimitedResult(request_id);
      }

      const result = forecastEngine.forecast(family_id, period);
      // FORECAST_REQUEST payload is minimized: bucket + coarse identifiers only
      // (no raw avails — KANON §Logs-y-Audit).
      ledger.append(
        EventClass.FORECAST_REQUEST,
        { family_id, period, bucket: result.bucket, synthetic: true },
        { buyer_id, request_id }
      );
      return { content: [{ type: "text", text: JSON.stringify({ ...result, request_id }) }] };
    }
  );

  return server;
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
  const validator = new TokenValidator(keyPair.publicKey, denylist);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, deployment);
  const store = new EntitlementStore(DEFAULT_ENTITLEMENTS_CONFIG);
  const catalog = loadCatalogFromFile();
  const rateLimiter = new RateLimiter();
  const forecastEngine = new ForecastEngine();
  const forecastRateLimiter = new RateLimiter();
  const replayGuard = new ReplayGuard();

  // Audit chain: pseudonymized ledger + external head-hash anchoring (S3, wired S7).
  const pseudonyms = new PseudonymService(DEV_PSEUDONYM_KEYS_PATH);
  const ledger = new AuditLedger(DEV_LEDGER_PATH, pseudonyms);
  const anchor = new HeadHashAnchor(DEV_ANCHOR_PATH);
  anchorHead(ledger, anchor); // anchor whatever survived the previous run
  setInterval(() => anchorHead(ledger, anchor), ANCHOR_INTERVAL_MS).unref();

  const deps: ServerDeps = { store, issuer, validator, wellKnown, catalog, rateLimiter, forecastEngine, forecastRateLimiter, ledger, replayGuard };

  // Fase A: --http serves StreamableHTTP on 127.0.0.1 (external bind = infra act, #8/#10).
  // Default remains stdio for MCP-host usage.
  if (process.argv.includes("--http")) {
    const opts = httpOptionsFromEnv();
    await startHttpServer({ makeServer: () => buildServer(deps), wellKnown }, opts);
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

export { buildServer, anchorHead };
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
