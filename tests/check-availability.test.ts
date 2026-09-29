import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_DISCLOSURE_POLICY,
  isDisclosableQuantity,
  loadDisclosurePolicyFromFile,
  parseDisclosurePolicy,
  quantizeAvailability,
  type DisclosurePolicy,
} from "../src/forecast/disclosure-policy.js";
import {
  AVAILABILITY_STATUS,
  ForecastEngine,
  SyntheticForecastSource,
  decideAvailability,
} from "../src/forecast/engine.js";
import { SeededForecastSource } from "../src/forecast/seeded-source.js";
import { GamForecastSource, loadGamForecastSourceFromFile, parsePeriod, prospectiveLineItemXml } from "../src/forecast/gam-source.js";
import type { ForecastSource } from "../src/forecast/source.js";
import { GamSoapClient } from "../src/gam/soap.js";
import type { FetchLike } from "../src/gam/auth.js";
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
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";

// check_availability — "can you deliver N impressions?" answered from the publisher's commercial
// availability (forecast estimate → disclosure policy), never from the raw forecast.

// Deterministic PRNG so the property tests are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A raw estimate spread over 1 … 10^9 (log-uniform), the range real forecasts live in.
const randomEstimate = (rand: () => number) => Math.floor(10 ** (rand() * 9));

const fixedSource = (units: number, live = true): ForecastSource => ({
  live,
  async getAvailsBucket() {
    return "low";
  },
  async getAvailability() {
    return { units, asOf: Date.UTC(2026, 9, 3, 10, 30) };
  },
});

describe("disclosure policy — quantization", () => {
  it("floors to the ladder step (1-2-5 by default)", () => {
    const q = (n: number) => quantizeAvailability(n, DEFAULT_DISCLOSURE_POLICY);
    expect(q(2_780_000)).toBe(2_000_000);
    expect(q(9_999_999)).toBe(5_000_000);
    expect(q(10_000_000)).toBe(10_000_000); // exact powers of ten stay exact
    expect(q(1_999)).toBe(1_000);
    expect(q(5_956)).toBe(5_000);
  });

  it("hides the long tail below min_quantity and never goes negative", () => {
    const q = (n: number) => quantizeAvailability(n, DEFAULT_DISCLOSURE_POLICY);
    expect(q(999)).toBe(0);
    expect(q(0)).toBe(0);
    expect(q(-5)).toBe(0);
    expect(q(Number.NaN)).toBe(0);
  });

  it("applies the haircut before rounding, and honours custom ladders", () => {
    expect(quantizeAvailability(2_600_000, { ...DEFAULT_DISCLOSURE_POLICY, haircut: 0.8 })).toBe(2_000_000);
    expect(quantizeAvailability(2_600_000, { ...DEFAULT_DISCLOSURE_POLICY, ladder: [1, 2.5, 5] })).toBe(2_500_000);
    expect(quantizeAvailability(2_600_000, { ...DEFAULT_DISCLOSURE_POLICY, ladder: [1] })).toBe(1_000_000);
  });

  it("only ever produces disclosable quantities, never above the offered estimate", () => {
    const rand = mulberry32(7);
    const policies: DisclosurePolicy[] = [
      DEFAULT_DISCLOSURE_POLICY,
      { ladder: [1, 2.5, 5], haircut: 0.8, minQuantity: 10_000 },
      { ladder: [1, 1.5, 2, 3, 5, 7], haircut: 0.95, minQuantity: 0 },
    ];
    for (let i = 0; i < 5_000; i++) {
      const policy = policies[i % policies.length]!;
      const estimate = randomEstimate(rand);
      const commercial = quantizeAvailability(estimate, policy);
      expect(isDisclosableQuantity(commercial, policy)).toBe(true);
      expect(commercial).toBeLessThanOrEqual(estimate * policy.haircut);
    }
  });

  it("parses the disclosure block fail-closed", () => {
    expect(parseDisclosurePolicy(undefined, "t")).toEqual(DEFAULT_DISCLOSURE_POLICY);
    expect(parseDisclosurePolicy({ ladder: [1, 2.5, 5], haircut: 0.9, min_quantity: 5000 }, "t")).toEqual({
      ladder: [1, 2.5, 5],
      haircut: 0.9,
      minQuantity: 5000,
    });
    for (const bad of [
      { ladder: [2, 5] }, // must start at 1
      { ladder: [1, 5, 2] }, // ascending
      { ladder: [1, 10] }, // mantissas < 10
      { ladder: [] },
      { haircut: 0 },
      { haircut: 1.2 },
      { min_quantity: -1 },
      { min_quantity: 1.5 },
      "coarse",
    ]) {
      expect(() => parseDisclosurePolicy(bad, "t")).toThrow(/disclosure/);
    }
  });
});

describe("no-oracle property — questions reveal the ladder step, never the forecast", () => {
  const policy: DisclosurePolicy = { ladder: [1, 2, 5], haircut: 0.9, minQuantity: 1000 };

  it("the decision is a function of the commercial availability only", async () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const estimate = randomEstimate(rand);
      const commercial = quantizeAvailability(estimate, policy);
      // Another estimate that rounds to the same step (the smallest one that does).
      const twin = commercial === 0 ? 0 : Math.ceil(commercial / policy.haircut);
      expect(quantizeAvailability(twin, policy)).toBe(commercial);

      const a = new ForecastEngine(fixedSource(estimate), policy);
      const b = new ForecastEngine(fixedSource(twin), policy);
      for (let k = 0; k < 20; k++) {
        const requested = 1 + Math.floor(10 ** (rand() * 9.5));
        const ra = await a.checkAvailability("f", "2026-10", requested);
        const rb = await b.checkAvailability("f", "2026-10", requested);
        expect(ra).toEqual(rb); // indistinguishable to the buyer, whatever it asks
      }
    }
  });

  it("a binary-search prober converges to the ladder step, not the forecast", async () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const estimate = 1000 + randomEstimate(rand);
      const engine = new ForecastEngine(fixedSource(estimate), policy);
      // Prober ignores deliverable_up_to and only uses the yes/no signal.
      let lo = 0;
      let hi = 2 * estimate + 10;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const { status } = await engine.checkAvailability("f", "2026-10", mid);
        if (status === AVAILABILITY_STATUS.AVAILABLE) lo = mid;
        else hi = mid;
      }
      expect(lo).toBe(quantizeAvailability(estimate, policy));
    }
  });
});

describe("ForecastEngine.checkAvailability", () => {
  it("answers available / partial / unavailable from the commercial availability", async () => {
    const engine = new ForecastEngine(fixedSource(2_780_000));
    expect(await engine.checkAvailability("display-ros", "2026-10", 1_500_000)).toMatchObject({
      status: "available",
      deliverable_up_to: 2_000_000,
      requested_impressions: 1_500_000,
    });
    const partial = await engine.checkAvailability("display-ros", "2026-10", 2_800_000);
    expect(partial).toMatchObject({ status: "partial", deliverable_up_to: 2_000_000 });
    expect(JSON.stringify(partial)).not.toContain("2780000");

    const none = await new ForecastEngine(fixedSource(400)).checkAvailability("display-ros", "2026-10", 10);
    expect(none).toMatchObject({ status: "unavailable", deliverable_up_to: 0 });
  });

  it("dates the answer and labels live data synthetic:false", async () => {
    const result = await new ForecastEngine(fixedSource(5_000)).checkAvailability("f", "p", 1);
    expect(result.as_of).toBe("2026-10-03T10:30:00.000Z");
    expect(result.synthetic).toBe(false);
    expect(result.consent_context).toBeNull();
    expect(result.legal_basis_provenance).toBeNull();
  });

  it("decideAvailability edge cases", () => {
    expect(decideAvailability(0, 1)).toBe("unavailable");
    expect(decideAvailability(1000, 1000)).toBe("available");
    expect(decideAvailability(1000, 1001)).toBe("partial");
  });

  it("refuses a source that cannot estimate volumes", async () => {
    const bucketOnly: ForecastSource = { async getAvailsBucket() { return "mid"; } };
    await expect(new ForecastEngine(bucketOnly).checkAvailability("f", "p", 1)).rejects.toThrow(/does not support/);
  });

  it("synthetic and seeded sources estimate volumes too, labeled synthetic", async () => {
    const synthetic = new ForecastEngine(new SyntheticForecastSource());
    const a = await synthetic.checkAvailability("display-ros", "Q4-2026", 1_000_000);
    const b = await synthetic.checkAvailability("display-ros", "Q4-2026", 1_000_000);
    expect(a).toEqual(b);
    expect(a.synthetic).toBe(true);
    expect(a.as_of).toBeNull();

    const seeded = SeededForecastSource.fromConfig({
      buckets: [
        { family_id: "display-ros", period: "Q4-2026", avail_impressions: 24_500_000 },
        { family_id: "video-pre-roll", period: "Q4-2026", bucket: "low" },
      ],
    });
    const engine = new ForecastEngine(seeded);
    expect((await engine.checkAvailability("display-ros", "Q4-2026", 30_000_000)).deliverable_up_to).toBe(20_000_000);
    // A literal-bucket seed has no count: the synthetic fallback answers.
    const fallback = await engine.checkAvailability("video-pre-roll", "Q4-2026", 1);
    expect(fallback.synthetic).toBe(true);
  });
});

describe("GAM source — availability estimate and product-shaped prospective line item", () => {
  const NS = "https://www.google.com/apis/ads/publisher/v202608";
  const fetchImpl: FetchLike = async (url) => {
    const body = url.endsWith("/NetworkService")
      ? `<getCurrentNetworkResponse xmlns="${NS}"><rval><timeZone>Europe/Madrid</timeZone><currencyCode>EUR</currencyCode><effectiveRootAdUnitId>555</effectiveRootAdUnitId></rval></getCurrentNetworkResponse>`
      : `<getAvailabilityForecastResponse xmlns="${NS}"><rval><availableUnits>2780000</availableUnits></rval></getAvailabilityForecastResponse>`;
    return { ok: true, status: 200, text: async () => body };
  };
  const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

  it("keeps the raw estimate in the snapshot and serves it with its timestamp", async () => {
    const client = new GamSoapClient({ networkCode: "12345678", apiVersion: "v202608", applicationName: "t" }, { getAccessToken: async () => "t" }, fetchImpl);
    const source = new GamForecastSource(
      client,
      { families: new Map([["display-ros", { sizes: [{ width: 300, height: 250 }], environment: "BROWSER" }]]), thresholds: { mid: 1e6, high: 1e7 }, periods: ["2026-10"] },
      () => NOW
    );
    await source.refresh();
    expect(await source.getAvailability("display-ros", "2026-10")).toEqual({ units: 2_780_000, asOf: NOW });
    const result = await new ForecastEngine(source).checkAvailability("display-ros", "2026-10", 2_800_000);
    expect(result).toMatchObject({ status: "partial", deliverable_up_to: 2_000_000, synthetic: false });
  });

  it("sends the family's priority between lineItemType and costPerUnit", () => {
    const xml = prospectiveLineItemXml({
      range: parsePeriod("2026-11")!,
      startsImmediately: false,
      targeting: { sizes: [{ width: 300, height: 250 }], environment: "BROWSER", priority: 6 },
      adUnitIds: ["555"],
      timeZone: "Europe/Madrid",
      currencyCode: "EUR",
    });
    const type = xml.indexOf("<lineItemType>");
    const priority = xml.indexOf("<priority>6</priority>");
    expect(priority).toBeGreaterThan(type);
    expect(priority).toBeLessThan(xml.indexOf("<costPerUnit>"));
  });

  it("validates priority (GAM accepts 6–10 for STANDARD)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gam-prio-"));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ client_email: "sa@x", private_key: "unused" }));
    writeFileSync(join(dir, "gam.json"), JSON.stringify({ network_code: "1", families: { f: { sizes: ["1x1"], priority: 12 } } }));
    expect(() => loadGamForecastSourceFromFile(dir, { GAM_SA_KEY_PATH: join(dir, "key.json") })).toThrow(/priority/);
  });
});

describe("disclosure policy loading", () => {
  const dirWith = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
    return dir;
  };

  it("reads gam.json first, then forecast.json, else the default", () => {
    expect(loadDisclosurePolicyFromFile(dirWith({}))).toEqual(DEFAULT_DISCLOSURE_POLICY);
    expect(loadDisclosurePolicyFromFile(dirWith({ "forecast.json": { buckets: [], disclosure: { haircut: 0.7 } } })).haircut).toBe(0.7);
    const both = dirWith({ "gam.json": { disclosure: { haircut: 0.9 } }, "forecast.json": { disclosure: { haircut: 0.7 } } });
    expect(loadDisclosurePolicyFromFile(both).haircut).toBe(0.9);
  });

  it("fails closed on a malformed policy", () => {
    expect(() => loadDisclosurePolicyFromFile(dirWith({ "gam.json": { disclosure: { ladder: [3] } } }))).toThrow(/ladder/);
  });
});

describe("check_availability over MCP", () => {
  const BUYER = "test-buyer-001";

  async function setup(forecastEngine: ForecastEngine) {
    const keyPair = await generateDevKeyPair();
    const issuer = new TokenIssuer(keyPair.privateKey);
    const ledger = createMemoryLedger();
    const server = buildServer({
      store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
      issuer,
      validator: new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD),
      wellKnown: new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG),
      catalog: new CatalogStore(TEST_CATALOG_CONFIG),
      pricingStore: new PricingStore(TEST_PRICING_CONFIG),
      rateLimiter: new RateLimiter(0),
      forecastEngine,
      forecastRateLimiter: new RateLimiter(0),
      availabilityRateLimiter: new RateLimiter(0),
      ledger,
      replayGuard: new ReplayGuard(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-buyer", version: "0.0.1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const token = (await issuer.issue(BUYER, BUYER_AUD)).token;
    let n = 0;
    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: "check_availability", arguments: { token, client_request_id: `r-${n++}`, ...args } });
    return { call, ledger };
  }
  const body = (res: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((res.content as Array<{ text: string }>)[0]!.text);

  it("returns the rounded commercial availability and never the raw forecast", async () => {
    const { call, ledger } = await setup(new ForecastEngine(fixedSource(2_780_000)));
    const res = await call({ family_id: "display-ros", period: "2026-10", impressions: 2_800_000 });
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ status: "partial", deliverable_up_to: 2_000_000, synthetic: false });
    expect(JSON.stringify(res)).not.toContain("2780000");
    // The ledger records the decision, not volumes.
    const entries = JSON.stringify(ledger.allEntries());
    expect(entries).toContain("availability_check");
    expect(entries).not.toMatch(/2780000|2000000|2800000/);
  });

  it("maps source failures to buyer-safe errors", async () => {
    const unknown: ForecastSource = {
      async getAvailsBucket() { return "low"; },
      async getAvailability() {
        const { ForecastUnavailableError } = await import("../src/forecast/source.js");
        throw new ForecastUnavailableError("unknown_period");
      },
    };
    const { call } = await setup(new ForecastEngine(unknown));
    const res = await call({ family_id: "display-ros", period: "2027-06", impressions: 1000 });
    expect(res.isError).toBe(true);
    expect(body(res).code).toBe("NOT_FOUND");
  });

  it("rejects a non-positive or non-integer volume before it reaches the engine", async () => {
    const { call } = await setup(new ForecastEngine(fixedSource(5_000)));
    for (const impressions of [0, -5, 1.5]) {
      const res = await call({ family_id: "display-ros", period: "2026-10", impressions });
      expect(res.isError).toBe(true);
    }
  });
});
