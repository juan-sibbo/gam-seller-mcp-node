import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
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
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";

// Network egress contract — declared and bounded egress, not "egress deny-all".
//
// The node's buyer request path makes no outbound network calls. Outbound network activity is
// operator-opted and runs at boot and on a timer, never inside a buyer request: the external audit
// anchor (MCP_ANCHOR_SINK=tsa|s3|<module>) and the live GAM forecast refresh (config/gam.json). This suite pins
// that architecture with two guarantees:
//
//   1. Egress surface allowlist — network capabilities may only live in the modules declared
//      below. A new capability anywhere else turns CI red until it is declared here on purpose
//      (with its data, trigger and operator switch documented in the README).
//   2. The buyer cannot steer a destination — anchor backends are reached only through the
//      operator-config resolver, which is wired outside buildServer(), and no buyer-facing tool
//      accepts a destination-like argument.
//
// This is a static + structural check, not a proof: it catches the usual ways a capability
// enters the codebase (global fetch, network modules, non-literal dynamic imports), which is
// what a reviewer needs to be told about. It replaces an older grep for the text "fetch(" that
// passed while the TSA backend POSTed through an injected fetch reference.

const srcDir = join(fileURLToPath(import.meta.url), "../../src");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Drop comments so prose about the design ("no fetch/got/axios") never counts as a capability.
// Inline comments are only stripped after whitespace, so "https://…" inside a string survives.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

const NETWORK_MODULES =
  "(?:node:)?(?:http|https|http2|net|tls|dgram|dns)|undici|axios|got|node-fetch|cross-fetch|superagent|ws|@aws-sdk\\/[\\w-]+";

const DETECTORS: Array<[string, RegExp]> = [
  ["global-fetch", /\bfetch\b/],
  ["network-module-import", new RegExp(`(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"](?:${NETWORK_MODULES})['"]`)],
  // A dynamic import whose specifier is not a string literal can load anything at runtime.
  ["dynamic-import", /\bimport\s*\(\s*(?!['"`])/],
  ["browser-network-api", /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/],
];

function capabilitiesOf(file: string): string[] {
  const code = stripComments(readFileSync(file, "utf-8"));
  return DETECTORS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

// The declared egress surface. Keys are paths relative to src/. Changing this map is a
// deliberate act: document what leaves, when, and which operator switch enables it.
const DECLARED_EGRESS_SURFACE: Record<string, string[]> = {
  // RFC 3161 TSA backend (MCP_ANCHOR_SINK=tsa): POSTs the ledger head hash to the operator's TSA.
  "audit/anchor-tsa.ts": ["global-fetch"],
  // S3 Object Lock backend (MCP_ANCHOR_SINK=s3): lazily loads @aws-sdk/client-s3, writes the
  // anchor record to the operator's bucket.
  "audit/anchor-s3.ts": ["dynamic-import"],
  // Anchor resolver: loads an operator-supplied custom sink module (MCP_ANCHOR_SINK=<module>).
  "audit/anchor-sink.ts": ["dynamic-import"],
  // Live GAM forecast (config/gam.json), boot + 30-min refresh cycle only: OAuth token exchange
  // with Google for the operator's service account…
  "gam/auth.ts": ["global-fetch"],
  // …and read-only SOAP calls (getCurrentNetwork, getAvailabilityForecast) to the fixed Ad Manager
  // endpoint for the operator-configured network.
  "gam/soap.ts": ["global-fetch"],
  // INBOUND only: the HTTP transport serves requests; it never acts as a client (pinned below).
  "http.ts": ["network-module-import"],
};

describe("egress surface allowlist — network capabilities live only in declared modules", () => {
  it("the detected network capabilities match the declared egress surface exactly", () => {
    const detected: Record<string, string[]> = {};
    for (const file of collectTsFiles(srcDir)) {
      const caps = capabilitiesOf(file);
      if (caps.length > 0) detected[relative(srcDir, file).split("\\").join("/")] = caps;
    }
    expect(detected).toEqual(DECLARED_EGRESS_SURFACE);
  });

  it("http.ts uses node:http only to serve, never as a client", () => {
    const code = stripComments(readFileSync(join(srcDir, "http.ts"), "utf-8"));
    const importLine = code.match(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?http['"]/);
    expect(importLine, "http.ts is expected to import from node:http").not.toBeNull();
    const names = importLine![1].split(",").map((n) => n.replace(/\btype\b/, "").trim()).filter(Boolean);
    expect(names.sort()).toEqual(["IncomingMessage", "Server", "ServerResponse", "createServer"].sort());
    expect(code).not.toMatch(/\b(?:request|get)\s*\(\s*['"`]https?:/);
  });
});

describe("the buyer cannot steer an egress destination", () => {
  it("anchor backends are imported only by the operator-config resolver", () => {
    const importers = collectTsFiles(srcDir)
      .filter((file) => /['"]\.\/anchor-(?:tsa|s3)\.js['"]/.test(stripComments(readFileSync(file, "utf-8"))))
      .map((file) => relative(srcDir, file).split("\\").join("/"));
    expect(importers).toEqual(["audit/anchor-sink.ts"]);
  });

  it("buildServer (the buyer request path) never reaches the anchor sink or its network cycle", () => {
    const code = stripComments(readFileSync(join(srcDir, "server.ts"), "utf-8"));
    const start = code.indexOf("function buildServer(");
    expect(start, "buildServer not found in server.ts").toBeGreaterThanOrEqual(0);
    // Extract the function body by brace matching from its opening brace.
    const open = code.indexOf("{", code.indexOf(")", start));
    let depth = 0;
    let end = open;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = code.slice(open, end + 1);
    for (const forbidden of ["resolveAnchorSink", "HeadHashAnchor", "anchorHead", ".reconcile("]) {
      expect(body.includes(forbidden), `buildServer must not reference ${forbidden}`).toBe(false);
    }
  });

  it("no buyer-facing tool accepts a destination-like argument", async () => {
    const keyPair = await generateDevKeyPair();
    const denylist = createMemoryDenylist();
    const server = buildServer({
      store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
      issuer: new TokenIssuer(keyPair.privateKey),
      validator: new TokenValidator(keyPair.publicKey, denylist, BUYER_ISS, BUYER_AUD),
      wellKnown: new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG),
      catalog: new CatalogStore(TEST_CATALOG_CONFIG),
      pricingStore: new PricingStore(TEST_PRICING_CONFIG),
      rateLimiter: new RateLimiter(),
      forecastEngine: new ForecastEngine(),
      forecastRateLimiter: new RateLimiter(),
      ledger: createMemoryLedger(),
      replayGuard: new ReplayGuard(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "egress-surface-test", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const destinationLike = /url|uri|host|endpoint|bucket|webhook|callback|destination/i;
    for (const tool of tools) {
      const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      const offending = props.filter((p) => destinationLike.test(p));
      expect(offending, `${tool.name} exposes destination-like arguments`).toEqual([]);
    }
  });
});
