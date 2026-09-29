import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ForecastEngine, MAX_ALTERNATIVES } from "../src/forecast/engine.js";
import { GamForecastSource, viewableAvailable } from "../src/forecast/gam-source.js";
import type { AvailabilityEstimate, ForecastSource, ListedAvailability } from "../src/forecast/source.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { projectFamily } from "../src/catalog/projection.js";
import { GamSoapClient } from "../src/gam/soap.js";
import { buildServer } from "../src/server.js";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { BUYER_ISS, BUYER_AUD } from "../src/identity/types.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { PricingStore, TEST_PRICING_CONFIG } from "../src/pricing/store.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { ReplayGuard } from "../src/audit/replay.js";

// Enrichments on top of check_availability / discover_products: viewable impressions, alternatives
// when a request does not fit, and a media-kit description of each family.

// A source over a fixed table of family × period estimates.
function tableSource(rows: Array<[string, string, number, number | null]>): ForecastSource {
  const estimate = (units: number, viewableUnits: number | null): AvailabilityEstimate => ({ units, viewableUnits, asOf: null });
  return {
    live: true,
    async getAvailsBucket() {
      return "low";
    },
    async getAvailability(family_id, period) {
      const row = rows.find(([f, p]) => f === family_id && p === period);
      if (!row) throw new Error("not in table");
      return estimate(row[2], row[3]);
    },
    async listAvailability(): Promise<ListedAvailability[]> {
      return rows.map(([family_id, period, units, viewable]) => ({ family_id, period, estimate: estimate(units, viewable) }));
    },
  };
}

describe("viewable impressions", () => {
  it("reads the VIEWABLE_IMPRESSIONS alternative forecast from the GAM response", () => {
    const xml =
      `<rval><availableUnits>5956</availableUnits>` +
      `<alternativeUnitTypeForecasts><unitType>IMPRESSIONS</unitType><availableUnits>5956</availableUnits></alternativeUnitTypeForecasts>` +
      `<alternativeUnitTypeForecasts><unitType>VIEWABLE_IMPRESSIONS</unitType><matchedUnits>2948</matchedUnits><availableUnits>2948</availableUnits></alternativeUnitTypeForecasts></rval>`;
    expect(viewableAvailable(xml)).toBe(2948);
    expect(viewableAvailable("<rval><availableUnits>1</availableUnits></rval>")).toBeNull();
  });

  it("reports the viewable share rounded like the total", async () => {
    const engine = new ForecastEngine(tableSource([["display-ros", "2026-10", 2_784_312, 1_391_000]]));
    const r = await engine.checkAvailability("display-ros", "2026-10", 1_000_000);
    expect(r).toMatchObject({ deliverable_up_to: 2_700_000, viewable_up_to: 1_300_000 });
  });

  it("is null when the source does not forecast viewability", async () => {
    const engine = new ForecastEngine(tableSource([["display-ros", "2026-10", 50_000, null]]));
    expect((await engine.checkAvailability("display-ros", "2026-10", 1)).viewable_up_to).toBeNull();
  });

  it("the GAM snapshot keeps the viewable figure from the forecast", async () => {
    const NS = "https://www.google.com/apis/ads/publisher/v202608";
    const client = new GamSoapClient({ networkCode: "12345678", apiVersion: "v202608", applicationName: "t" }, { getAccessToken: async () => "t" }, async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.endsWith("/NetworkService")
          ? `<r xmlns="${NS}"><timeZone>Europe/Madrid</timeZone><currencyCode>EUR</currencyCode><effectiveRootAdUnitId>555</effectiveRootAdUnitId></r>`
          : `<r xmlns="${NS}"><availableUnits>10000</availableUnits><alternativeUnitTypeForecasts><unitType>VIEWABLE_IMPRESSIONS</unitType><availableUnits>4200</availableUnits></alternativeUnitTypeForecasts></r>`,
    }));
    const source = new GamForecastSource(
      client,
      { families: new Map([["display-ros", { sizes: [{ width: 300, height: 250 }], environment: "BROWSER" }]]), thresholds: { mid: 1e6, high: 1e7 }, periods: ["2026-10"] },
      () => Date.UTC(2026, 9, 15, 10)
    );
    await source.refresh();
    expect((await source.getAvailability("display-ros", "2026-10")).viewableUnits).toBe(4200);
  });
});

describe("alternatives when the request does not fit", () => {
  const rows: Array<[string, string, number, number | null]> = [
    ["display-ros", "2026-10", 2_000_000, null],
    ["display-ros", "2026-11", 3_150_000, 1_500_000],
    ["display-ros", "Q4-2026", 9_000_000, null],
    ["display-ros", "2026-12", 1_000_000, null], // too small — never suggested
    ["native-feed", "2026-10", 4_000_000, null],
    ["video-pre-roll", "2026-10", 5_000_000, null],
  ];

  it("suggests where the volume fits: same family first, then by period, then other families", async () => {
    const engine = new ForecastEngine(tableSource(rows));
    const r = await engine.checkAvailability("display-ros", "2026-10", 2_800_000);
    expect(r.status).toBe("partial");
    expect(r.alternatives.map((a) => `${a.family_id}/${a.period}`)).toEqual([
      "display-ros/Q4-2026", // quarter starting Oct 1 sorts before November
      "display-ros/2026-11",
      "native-feed/2026-10",
    ]);
    expect(r.alternatives[1]).toEqual({ family_id: "display-ros", period: "2026-11", deliverable_up_to: 3_100_000, viewable_up_to: 1_500_000 });
    expect(r.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
  });

  it("only names families the buyer is entitled to", async () => {
    const engine = new ForecastEngine(tableSource(rows));
    const r = await engine.checkAvailability("display-ros", "2026-10", 3_500_000, new Set(["display-ros", "video-pre-roll"]));
    expect(r.alternatives.map((a) => a.family_id)).not.toContain("native-feed");
    expect(r.alternatives.map((a) => `${a.family_id}/${a.period}`)).toEqual(["display-ros/Q4-2026", "video-pre-roll/2026-10"]);
  });

  it("is empty when the request fits, or when the source cannot list its snapshot", async () => {
    const engine = new ForecastEngine(tableSource(rows));
    expect((await engine.checkAvailability("display-ros", "2026-10", 1_000_000)).alternatives).toEqual([]);
    const { listAvailability: _omit, ...noList } = tableSource(rows);
    expect((await new ForecastEngine(noList).checkAvailability("display-ros", "2026-10", 9e9)).alternatives).toEqual([]);
  });
});

describe("media-kit description of a family", () => {
  const withKit = {
    ...TEST_CATALOG_CONFIG,
    families: [
      { ...TEST_CATALOG_CONFIG.families[0]!, formats: ["300x250", "728x90"], channel: "display" as const, properties: ["example.com", "news.example.es"] },
      ...TEST_CATALOG_CONFIG.families.slice(1),
    ],
  };

  it("projects formats, channel and properties when configured", () => {
    const [family] = new CatalogStore(withKit).discover("test-buyer-001");
    expect(projectFamily(family!)).toMatchObject({ formats: ["300x250", "728x90"], channel: "display", properties: ["example.com", "news.example.es"] });
  });

  it("omits them when not configured", () => {
    const [family] = new CatalogStore(TEST_CATALOG_CONFIG).discover("test-buyer-001");
    expect(Object.keys(projectFamily(family!))).not.toEqual(expect.arrayContaining(["formats"]));
  });

  it("fills formats and channel from the forecast targeting; catalog.json wins", () => {
    const hints = new Map([
      ["display-ros", { formats: ["1x1"], channel: "video" as const }],
      ["video-pre-roll", { formats: ["640x480"], channel: "video" as const }],
    ]);
    const store = new CatalogStore(withKit).withMediaKitDefaults(hints);
    const [display, video] = store.discover("test-buyer-001");
    expect(display).toMatchObject({ formats: ["300x250", "728x90"], channel: "display" });
    expect(video).toMatchObject({ formats: ["640x480"], channel: "video" });
  });

  it.each([
    ["formats", { formats: ["big"] }],
    ["channel", { channel: "ctv" }],
    ["properties", { properties: ["not a domain"] }],
  ])("refuses a malformed %s at load", (_label, bad) => {
    const cfg = { ...TEST_CATALOG_CONFIG, families: [{ ...TEST_CATALOG_CONFIG.families[0]!, ...bad }] };
    expect(() => new CatalogStore(cfg as never)).toThrow(/catalog/);
  });
});

describe("over MCP", () => {
  it("discover_products carries the media kit and check_availability the enrichments", async () => {
    const keyPair = await generateDevKeyPair();
    const issuer = new TokenIssuer(keyPair.privateKey);
    const catalog = new CatalogStore(TEST_CATALOG_CONFIG).withMediaKitDefaults(
      new Map([["display-ros", { formats: ["300x250"], channel: "display" as const }]])
    );
    const server = buildServer({
      store: new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG),
      issuer,
      validator: new TokenValidator(keyPair.publicKey, createMemoryDenylist(), BUYER_ISS, BUYER_AUD),
      wellKnown: new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG),
      catalog,
      pricingStore: new PricingStore(TEST_PRICING_CONFIG),
      rateLimiter: new RateLimiter(0),
      forecastEngine: new ForecastEngine(
        tableSource([
          ["display-ros", "2026-10", 2_000_000, 900_000],
          ["display-ros", "2026-11", 3_150_000, null],
          ["branded-content", "2026-10", 9_000_000, null], // not entitled to test-buyer-001
        ])
      ),
      forecastRateLimiter: new RateLimiter(0),
      availabilityRateLimiter: new RateLimiter(0),
      ledger: createMemoryLedger(),
      replayGuard: new ReplayGuard(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "b", version: "0.0.1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const token = (await issuer.issue("test-buyer-001", BUYER_AUD)).token;
    const text = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

    const discovered = await client.callTool({ name: "discover_products", arguments: { token, client_request_id: "d-1" } });
    expect(discovered.isError).toBeFalsy();
    expect(text(discovered).families.find((f: { family_id: string }) => f.family_id === "display-ros")).toMatchObject({
      formats: ["300x250"],
      channel: "display",
    });

    const checked = await client.callTool({
      name: "check_availability",
      arguments: { token, client_request_id: "c-1", family_id: "display-ros", period: "2026-10", impressions: 2_800_000 },
    });
    expect(checked.isError).toBeFalsy();
    const body = text(checked);
    expect(body).toMatchObject({ status: "partial", deliverable_up_to: 2_000_000, viewable_up_to: 900_000 });
    expect(body.alternatives).toEqual([{ family_id: "display-ros", period: "2026-11", deliverable_up_to: 3_100_000, viewable_up_to: null }]);
  });
});
