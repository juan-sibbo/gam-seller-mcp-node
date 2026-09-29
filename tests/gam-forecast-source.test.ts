import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exportPKCS8, generateKeyPair, decodeJwt } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ForecastUnavailableError,
  GAM_MAX_STALENESS_MS,
  GamForecastSource,
  loadGamForecastSourceFromFile,
  parsePeriod,
  prospectiveLineItemXml,
  rollingPeriods,
  todayIn,
  type GamFamilyTargeting,
} from "../src/forecast/gam-source.js";
import { ForecastEngine, FORECAST_BUCKET } from "../src/forecast/engine.js";
import { GAM_OAUTH_SCOPE, GOOGLE_TOKEN_URL, ServiceAccountTokenProvider, type FetchLike } from "../src/gam/auth.js";
import { GamApiError, GamSoapClient, firstTagText, xmlEscape } from "../src/gam/soap.js";
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

// Live GAM forecast adapter — exercised against a fake Google (token endpoint + Ad Manager SOAP),
// no network. The live smoke run against a real network is an operator act, not a CI test.

const NS = "https://www.google.com/apis/ads/publisher/v202608";
const NETWORK_XML =
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
  `<getCurrentNetworkResponse xmlns="${NS}"><rval><networkCode>12345678</networkCode>` +
  `<timeZone>Europe/Madrid</timeZone><currencyCode>EUR</currencyCode>` +
  `<effectiveRootAdUnitId>555</effectiveRootAdUnitId></rval></getCurrentNetworkResponse></soap:Body></soap:Envelope>`;
const forecastXml = (available: number) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
  `<getAvailabilityForecastResponse xmlns="${NS}"><rval><unitType>IMPRESSIONS</unitType>` +
  `<availableUnits>${available}</availableUnits><matchedUnits>${available}</matchedUnits>` +
  `<reservedUnits>1000</reservedUnits></rval></getAvailabilityForecastResponse></soap:Body></soap:Envelope>`;
const FAULT_XML =
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>` +
  `<faultcode>soap:Server</faultcode><faultstring>[PermissionError.PERMISSION_DENIED @ ]</faultstring>` +
  `</soap:Fault></soap:Body></soap:Envelope>`;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// availability: body → availableUnits, or "fault" to answer with a SOAP fault.
function fakeGoogle(availability: (body: string) => number | "fault" = () => 5_000_000) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const reply = (status: number, text: string) => ({ ok: status < 400, status, text: async () => text });
    if (url === GOOGLE_TOKEN_URL) return reply(200, JSON.stringify({ access_token: "tok-1", expires_in: 3600 }));
    if (url.endsWith("/NetworkService")) return reply(200, NETWORK_XML);
    if (url.endsWith("/ForecastService")) {
      const a = availability(init.body);
      return a === "fault" ? reply(500, FAULT_XML) : reply(200, forecastXml(a));
    }
    return reply(404, "");
  };
  return { calls, fetchImpl };
}

const staticTokens = { getAccessToken: async () => "tok-static" };
const DISPLAY: GamFamilyTargeting = { sizes: [{ width: 300, height: 250 }], environment: "BROWSER" };
const VIDEO: GamFamilyTargeting = { sizes: [{ width: 640, height: 480 }], environment: "VIDEO_PLAYER", adUnitIds: ["777"] };
// 2026-10-15 12:00 Madrid.
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

function makeSource(fetchImpl: FetchLike, now: () => number = () => NOW, periods: string[] = ["2026-10", "2026-11"]) {
  const client = new GamSoapClient({ networkCode: "12345678", apiVersion: "v202608", applicationName: "test" }, staticTokens, fetchImpl);
  return new GamForecastSource(
    client,
    { families: new Map([["display-ros", DISPLAY], ["video-pre-roll", VIDEO]]), thresholds: { mid: 1_000_000, high: 10_000_000 }, periods },
    now
  );
}

describe("period handling", () => {
  it("parses months and quarters (both quarter spellings) into inclusive date ranges", () => {
    expect(parsePeriod("2026-10")).toEqual({ start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 10, day: 31 } });
    expect(parsePeriod("2028-02")!.end.day).toBe(29); // leap year
    const q4 = { start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 12, day: 31 } };
    expect(parsePeriod("Q4-2026")).toEqual(q4);
    expect(parsePeriod("2026-Q4")).toEqual(q4);
  });

  it("rejects anything that is not YYYY-MM or Qn-YYYY", () => {
    for (const bad of ["2026-13", "Q5-2026", "next quarter", "2026-10-01", ""]) expect(parsePeriod(bad)).toBeNull();
  });

  it("rolling window = current + next 2 months and current + next quarter, across a year boundary", () => {
    expect(rollingPeriods({ year: 2026, month: 11, day: 3 })).toEqual(["2026-11", "2026-12", "2027-01", "Q4-2026", "Q1-2027"]);
  });

  it("computes today in the network's timezone, not UTC", () => {
    // 23:30 UTC on Oct 31 is already Nov 1 in Madrid.
    expect(todayIn("Europe/Madrid", new Date(Date.UTC(2026, 9, 31, 23, 30)))).toEqual({ year: 2026, month: 11, day: 1 });
  });
});

describe("prospective line item XML", () => {
  const base = { range: parsePeriod("2026-11")!, adUnitIds: ["555"], timeZone: "Europe/Madrid", currencyCode: "EUR" };

  it("follows the LineItem XSD order and never asks GAM to save or reserve", () => {
    const xml = prospectiveLineItemXml({ ...base, startsImmediately: false, targeting: DISPLAY });
    const order = ["startDateTime", "endDateTime", "lineItemType", "costPerUnit", "costType", "creativePlaceholders", "environmentType", "primaryGoal", "targeting"];
    const positions = order.map((tag) => xml.indexOf(`<${tag}>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(xml).toContain("<adUnitId>555</adUnitId>");
    expect(xml).not.toMatch(/reserveAtCreation|skipInventoryCheck/);
    expect(xml).not.toContain("requestPlatformTargeting");
  });

  it("starts IMMEDIATELY when the period is already running", () => {
    const xml = prospectiveLineItemXml({ ...base, startsImmediately: true, targeting: DISPLAY });
    expect(xml).toContain("<startDateTimeType>IMMEDIATELY</startDateTimeType>");
    expect(xml).not.toContain("<startDateTime>");
  });

  it("adds the fields GAM requires on video line items", () => {
    const xml = prospectiveLineItemXml({ ...base, startsImmediately: false, targeting: VIDEO });
    expect(xml.indexOf("<videoMaxDuration>")).toBeGreaterThan(xml.indexOf("<environmentType>VIDEO_PLAYER"));
    expect(xml.indexOf("<videoMaxDuration>")).toBeLessThan(xml.indexOf("<primaryGoal>"));
    expect(xml).toContain("<targetedRequestPlatforms>VIDEO_PLAYER</targetedRequestPlatforms>");
  });
});

describe("GamForecastSource snapshot", () => {
  it("answers from a GAM snapshot, bucketed through thresholds, and is live", async () => {
    const google = fakeGoogle((body) => (body.includes("VIDEO_PLAYER") ? 200_000 : 5_000_000));
    const source = makeSource(google.fetchImpl);
    const report = await source.refresh();

    expect(report).toEqual({ ok: 4, failed: 0, skipped: 0, errors: [] });
    expect(await source.getAvailsBucket("display-ros", "2026-10")).toBe(FORECAST_BUCKET.MID);
    expect(await source.getAvailsBucket("video-pre-roll", "2026-11")).toBe(FORECAST_BUCKET.LOW);
    const result = await new ForecastEngine(source).forecast("display-ros", "2026-11");
    expect(result.synthetic).toBe(false);
    expect(JSON.stringify(result)).not.toContain("5000000"); // raw avails never leave the source
  });

  it("sends the network code and bearer token, and uses the network root when no ad units are mapped", async () => {
    const google = fakeGoogle();
    await makeSource(google.fetchImpl).refresh();
    const forecasts = google.calls.filter((c) => c.url.endsWith("/ForecastService"));
    expect(forecasts).toHaveLength(4);
    for (const c of forecasts) {
      expect(c.headers.Authorization).toBe("Bearer tok-static");
      expect(c.body).toContain("<networkCode>12345678</networkCode>");
    }
    expect(forecasts[0]!.body).toContain("<adUnitId>555</adUnitId>"); // display → root
    expect(forecasts[0]!.body).toContain("<startDateTimeType>IMMEDIATELY"); // October is running
    expect(forecasts[1]!.body).toContain("<startDateTime>"); // November is ahead
    expect(forecasts.at(-1)!.body).toContain("<adUnitId>777</adUnitId>"); // video → mapped unit
  });

  it("never calls GAM on a read — buyers are served from the snapshot only", async () => {
    const google = fakeGoogle();
    const source = makeSource(google.fetchImpl);
    await source.refresh();
    const before = google.calls.length;
    await source.getAvailsBucket("display-ros", "2026-10");
    await source.getAvailsBucket("display-ros", "2026-10");
    expect(google.calls.length).toBe(before);
  });

  it("refuses unknown families, unknown periods and reads before the first snapshot", async () => {
    const source = makeSource(fakeGoogle().fetchImpl);
    await expect(source.getAvailsBucket("display-ros", "2026-10")).rejects.toMatchObject({ reason: "not_ready" });
    await source.refresh();
    await expect(source.getAvailsBucket("branded-content", "2026-10")).rejects.toMatchObject({ reason: "unknown_family" });
    await expect(source.getAvailsBucket("display-ros", "2027-06")).rejects.toMatchObject({ reason: "unknown_period" });
  });

  it("skips periods that are already over or unparseable", async () => {
    const google = fakeGoogle();
    const report = await makeSource(google.fetchImpl, () => NOW, ["2026-09", "2026-10"]).refresh();
    expect(report).toMatchObject({ ok: 2, skipped: 2 });
  });

  it("keeps the last good bucket through a failed refresh, then withholds it once stale", async () => {
    let clock = NOW;
    let failing = false;
    const google = fakeGoogle(() => (failing ? "fault" : 50_000_000));
    const source = makeSource(google.fetchImpl, () => clock);
    await source.refresh();

    failing = true;
    clock += 30 * 60 * 1000;
    const report = await source.refresh();
    expect(report.failed).toBe(4);
    expect(report.errors[0]).toContain("PERMISSION_DENIED"); // operator log keeps the GAM fault
    expect(await source.getAvailsBucket("display-ros", "2026-10")).toBe(FORECAST_BUCKET.HIGH);

    clock = NOW + GAM_MAX_STALENESS_MS + 1;
    await expect(source.getAvailsBucket("display-ros", "2026-10")).rejects.toMatchObject({ reason: "stale" });
  });

  it("reports a network-level failure without throwing", async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    };
    const report = await makeSource(fetchImpl).refresh();
    expect(report.ok).toBe(0);
    expect(report.errors).toEqual(["fetch failed (ETIMEDOUT)"]);
  });
});

describe("SOAP client", () => {
  it("turns a SOAP fault into a GamApiError", async () => {
    const client = new GamSoapClient({ networkCode: "1", apiVersion: "v202608", applicationName: "t" }, staticTokens, fakeGoogle(() => "fault").fetchImpl);
    await expect(client.call("ForecastService", "getAvailabilityForecast", "")).rejects.toBeInstanceOf(GamApiError);
  });

  it("escapes XML and reads prefixed or unprefixed tags", () => {
    expect(xmlEscape(`a<b>&"'`)).toBe("a&lt;b&gt;&amp;&quot;&apos;");
    expect(firstTagText("<ns0:availableUnits>42</ns0:availableUnits>", "availableUnits")).toBe("42");
    expect(firstTagText("<x>1</x>", "availableUnits")).toBeUndefined();
  });
});

describe("service-account token provider", () => {
  let privatePem: string;
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    privatePem = await exportPKCS8(privateKey);
  });

  it("exchanges a signed assertion for a token and caches it until near expiry", async () => {
    const google = fakeGoogle();
    let clock = NOW;
    const provider = new ServiceAccountTokenProvider({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: privatePem }, google.fetchImpl, () => clock);

    expect(await provider.getAccessToken()).toBe("tok-1");
    const assertion = new URLSearchParams(google.calls[0]!.body).get("assertion")!;
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({ iss: "sa@proj.iam.gserviceaccount.com", aud: GOOGLE_TOKEN_URL, scope: GAM_OAUTH_SCOPE });

    await provider.getAccessToken();
    expect(google.calls).toHaveLength(1); // cached
    clock += 3600 * 1000;
    await provider.getAccessToken();
    expect(google.calls).toHaveLength(2); // refreshed after expiry
  });

  it("reports a failed exchange by status only", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid_grant","sa":"x"}' });
    const provider = new ServiceAccountTokenProvider({ client_email: "sa@x", private_key: privatePem }, fetchImpl);
    await expect(provider.getAccessToken()).rejects.toThrow(/^\[gam\] OAuth token exchange failed \(HTTP 401\)\.$/);
  });
});

describe("config/gam.json loader", () => {
  const writeConfig = (cfg: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "gam-cfg-"));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ client_email: "sa@x", private_key: "unused-until-refresh" }));
    writeFileSync(join(dir, "gam.json"), JSON.stringify(cfg));
    return dir;
  };
  const valid = { network_code: "12345678", families: { "display-ros": { sizes: ["300x250"] } } };

  it("is opt-in: no gam.json → null", () => {
    expect(loadGamForecastSourceFromFile(mkdtempSync(join(tmpdir(), "gam-none-")), {})).toBeNull();
  });

  it("builds a live source from a valid file, with GAM_SA_KEY_PATH taking the key path", () => {
    const dir = writeConfig(valid);
    const source = loadGamForecastSourceFromFile(dir, { GAM_SA_KEY_PATH: join(dir, "key.json") });
    expect(source).toBeInstanceOf(GamForecastSource);
    expect(source!.live).toBe(true);
  });

  it.each([
    ["non-numeric network code", { ...valid, network_code: "abc" }, /network_code/],
    ["missing families", { network_code: "1" }, /families/],
    ["bad size", { ...valid, families: { f: { sizes: ["big"] } } }, /size/],
    ["bad environment", { ...valid, families: { f: { sizes: ["1x1"], environment: "CTV" } } }, /environment/],
    ["bad ad unit id", { ...valid, families: { f: { sizes: ["1x1"], ad_unit_ids: ["root"] } } }, /ad_unit_ids/],
    ["bad period", { ...valid, periods: ["soon"] }, /period/],
    ["bad thresholds", { ...valid, thresholds: { mid: 10, high: 1 } }, /thresholds/],
  ])("fails closed on %s", (_label, cfg, message) => {
    const dir = writeConfig(cfg);
    expect(() => loadGamForecastSourceFromFile(dir, { GAM_SA_KEY_PATH: join(dir, "key.json") })).toThrow(message);
  });

  it("fails closed without a key path", () => {
    expect(() => loadGamForecastSourceFromFile(writeConfig(valid), {})).toThrow(/GAM_SA_KEY_PATH/);
  });
});

describe("get_forecast over a live GAM source", () => {
  const BUYER = "test-buyer-001";

  async function setup(forecastEngine: ForecastEngine) {
    const keyPair = await generateDevKeyPair();
    const issuer = new TokenIssuer(keyPair.privateKey);
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
      ledger: createMemoryLedger(),
      replayGuard: new ReplayGuard(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-buyer", version: "0.0.1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const token = (await issuer.issue(BUYER, BUYER_AUD)).token;
    const call = (family_id: string, period: string, id: string) =>
      client.callTool({ name: "get_forecast", arguments: { token, family_id, period, client_request_id: id } });
    return { call };
  }
  const body = (res: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((res.content as Array<{ text: string }>)[0]!.text);

  it("serves a live bucket with synthetic:false", async () => {
    const source = makeSource(fakeGoogle().fetchImpl);
    await source.refresh();
    const { call } = await setup(new ForecastEngine(source));
    const res = await call("display-ros", "2026-10", "r-1");
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ bucket: "mid", synthetic: false });
  });

  it("maps a pair outside the snapshot to NOT_FOUND and a stale/unready snapshot to UNAVAILABLE, without GAM detail", async () => {
    const source = makeSource(fakeGoogle().fetchImpl);
    const { call } = await setup(new ForecastEngine(source));
    const notReady = await call("display-ros", "2026-10", "r-2");
    expect(notReady.isError).toBe(true);
    expect(body(notReady).code).toBe("UNAVAILABLE");

    await source.refresh();
    const unknown = await call("display-ros", "2027-06", "r-3");
    expect(body(unknown).code).toBe("NOT_FOUND");
    expect(JSON.stringify(body(unknown))).not.toMatch(/unknown_period|gam|12345678/i);
  });

  it("maps an unexpected source error to a generic INTERNAL_ERROR without echoing its message", async () => {
    const broken = new ForecastEngine({ live: true, getAvailsBucket: async () => { throw new Error("boom at 12345678"); } });
    const { call } = await setup(broken);
    const res = await call("display-ros", "2026-10", "r-4");
    expect(res.isError).toBe(true);
    expect(body(res).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body(res))).not.toMatch(/boom|12345678/);
  });

  it("ForecastUnavailableError carries only a reason", () => {
    expect(new ForecastUnavailableError("stale").message).toBe("forecast unavailable: stale");
  });
});
