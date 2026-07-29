import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildServer } from "../src/server.js";
import { startHttpServer, httpOptionsFromEnv, MCP_PATH } from "../src/http.js";
import { loadOrCreateKeyPair } from "../src/identity/keystore.js";
import { generateDevKeyPair, type KeyPairBundle } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { BUYER_ISS, BUYER_AUD } from "../src/identity/types.js";
import { WellKnownService, WELL_KNOWN_PATH, WELL_KNOWN_CACHE_TTL_SECONDS } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";

// Fase A — HTTP transport integration tests.
// Real node:http server on an ephemeral port; real StreamableHTTP MCP client.

const ENTITLED_BUYER = "test-buyer-001";
const UNKNOWN_BUYER = "intruder-999";

describe("keystore — persistent RS256 keys (I-9)", () => {
  it("creates on first boot and reloads the SAME key on the second", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keystore-test-"));
    const path = join(dir, "node.private.jwk.json");

    const first = await loadOrCreateKeyPair(path);
    const second = await loadOrCreateKeyPair(path);
    // Same RSA modulus = same identity across restarts
    expect(second.publicJwk.n).toBe(first.publicJwk.n);

    // The persisted file is a private RSA JWK
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored.kty).toBe("RSA");
    expect(stored.d).toBeTruthy();
  });

  it("FAIL-CLOSED: corrupt key file refuses to boot instead of silently rotating identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keystore-test-"));
    const path = join(dir, "corrupt.jwk.json");
    writeFileSync(path, "{ not json", "utf-8");
    await expect(loadOrCreateKeyPair(path)).rejects.toThrow(/fail-closed/i);
  });

  it("a token issued before 'restart' validates after reload (persistence is the point)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keystore-test-"));
    const path = join(dir, "node.private.jwk.json");

    const boot1 = await loadOrCreateKeyPair(path);
    const { token } = await new TokenIssuer(boot1.privateKey).issue();

    const boot2 = await loadOrCreateKeyPair(path); // simulated restart
    const validator = new TokenValidator(boot2.publicKey, createMemoryDenylist());
    expect((await validator.validate(token)).valid).toBe(true);
  });
});

describe("httpOptionsFromEnv", () => {
  it("defaults to 127.0.0.1:3900 (external bind is an infra act)", () => {
    const opts = httpOptionsFromEnv({});
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.port).toBe(3900);
  });

  it("rejects a non-numeric port", () => {
    expect(() => httpOptionsFromEnv({ MCP_HTTP_PORT: "abc" })).toThrow(/Invalid MCP_HTTP_PORT/);
  });
});

describe("HTTP transport — E-12 canonical route + MCP endpoint", () => {
  let httpServer: Server;
  let baseUrl: string;
  let wellKnown: WellKnownService;
  let keyPair: KeyPairBundle;
  let issuer: TokenIssuer;

  beforeAll(async () => {
    keyPair = await generateDevKeyPair();
    const denylist = createMemoryDenylist();
    wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
    issuer = new TokenIssuer(keyPair.privateKey);
    const deps = {
      store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
      issuer,
      validator: new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD),
      wellKnown,
      catalog: new CatalogStore(TEST_CATALOG_CONFIG),
      pricingStore: new PricingStore(TEST_PRICING_CONFIG),
      rateLimiter: new RateLimiter(),
      forecastEngine: new ForecastEngine(),
      forecastRateLimiter: new RateLimiter(),
      ledger: createMemoryLedger(),
    };
    httpServer = await startHttpServer(
      { makeServer: () => buildServer(deps), wellKnown },
      { host: "127.0.0.1", port: 0 } // ephemeral port
    );
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    httpServer.close();
  });

  it("GET /.well-known/seller-mcp-capabilities is PUBLIC and RS256-verifiable", async () => {
    const res = await fetch(baseUrl + WELL_KNOWN_PATH);
    expect(res.status).toBe(200);
    const signedDoc = await res.text();
    const doc = await wellKnown.verify(signedDoc);
    expect(doc.node_id).toBeTruthy();
    expect(doc.privacy_posture.end_user_personal_data).toBe("none");
  });

  it("well-known Cache-Control honors the ratified ≤15 min buyer-side TTL (e12 §6)", async () => {
    const res = await fetch(baseUrl + WELL_KNOWN_PATH);
    const cacheControl = res.headers.get("cache-control") ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
    expect(maxAge).toBe(WELL_KNOWN_CACHE_TTL_SECONDS);
    expect(maxAge).toBeLessThanOrEqual(900);
  });

  it("unknown routes → 404 with empty body (no surface disclosure)", async () => {
    const res = await fetch(baseUrl + "/admin");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("POST /mcp without a session and without initialize → 400", async () => {
    const res = await fetch(baseUrl + MCP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("full MCP flow over HTTP: initialize → discover_products (entitled) → DENY (unknown)", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_PATH));
    const client = new Client({ name: "http-test-buyer", version: "0.0.1" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["discover_products", "get_forecast", "well_known_capabilities"]);

    const ok = await client.callTool({ name: "discover_products", arguments: { token: (await issuer.issue(ENTITLED_BUYER, BUYER_AUD)).token } });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse((ok.content as Array<{ text: string }>)[0].text);
    expect(Array.isArray(body.families)).toBe(true);

    const denied = await client.callTool({ name: "discover_products", arguments: { token: (await issuer.issue(UNKNOWN_BUYER, BUYER_AUD)).token } });
    expect(denied.isError).toBe(true);
    expect(JSON.parse((denied.content as Array<{ text: string }>)[0].text).code).toBe("AUTH_FAILED");

    await client.close();
  });
});
