import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { operatorConfigDir } from "../config/resolve.js";
import { loadServiceAccountKey, ServiceAccountTokenProvider } from "../gam/auth.js";
import { DEFAULT_GAM_API_VERSION, firstTagText, GamSoapClient, xmlEscape } from "../gam/soap.js";
import { FORECAST_TTL_SECONDS, type ForecastBucket } from "./engine.js";
import {
  bucketForImpressions,
  DEFAULT_FORECAST_THRESHOLDS,
  validateThresholds,
  type ForecastThresholds,
} from "./seeded-source.js";
import type { ForecastSource } from "./source.js";

// GamForecastSource — live availability from GAM's ForecastService (DP-AB-01 §5.2, issue #4).
//
// SNAPSHOT MODEL: the source asks GAM for every configured (family, period) pair at boot and then
// every FORECAST_TTL_SECONDS, and answers buyers from that snapshot. A buyer request never causes
// an outbound call (tests/egress-surface.test.ts), buyers cannot generate load on the publisher's
// GAM, and the call volume is fixed by operator config (families × periods per cycle).
//
// Each forecast is a PROSPECTIVE line item — built in memory, sent to getAvailabilityForecast,
// never saved. Nothing in GAM is created, modified or reserved. Only `availableUnits` is used, and
// it is reduced to a Low/Mid/High bucket before it leaves this module (no raw avails to buyers or
// to the ledger — KANON §Logs-y-Audit).
//
// Config (config/gam.json — OPT-IN; absent → seeded/synthetic source, unchanged behavior):
//   {
//     "network_code": "12345678",
//     "service_account_key_path": "/secure/key.json",     // or env GAM_SA_KEY_PATH (wins)
//     "api_version": "v202608",                           // optional
//     "thresholds": { "mid": 1000000, "high": 10000000 },  // optional; same semantics as forecast.json
//     "periods": ["2026-10", "Q4-2026"],                  // optional; default: rolling window
//     "families": {
//       "display-ros":    { "sizes": ["300x250", "728x90"] },                       // whole network
//       "video-pre-roll": { "sizes": ["640x480"], "environment": "VIDEO_PLAYER",
//                           "ad_unit_ids": ["21700000000"] }
//     }
//   }

export const GAM_CONFIG_FILE = "gam.json";
export const GAM_SA_KEY_ENV = "GAM_SA_KEY_PATH";
export const GAM_APPLICATION_NAME = "gam-seller-mcp-node";
export const GAM_REFRESH_INTERVAL_MS = FORECAST_TTL_SECONDS * 1000;
// A snapshot entry older than this is withheld instead of served (GAM unreachable for 3 cycles).
export const GAM_MAX_STALENESS_MS = 3 * GAM_REFRESH_INTERVAL_MS;
// Goal of the prospective line item. availableUnits does not depend on it; GAM echoes it back as
// reservedUnits, which is why reservedUnits is ignored.
const PROSPECTIVE_GOAL_UNITS = 1000;
const ROLLING_MONTHS = 3;
// GAM rejects video line items without a max creative duration; 30 s covers standard pre-roll.
const VIDEO_MAX_DURATION_MS = 30_000;

const ENVIRONMENTS = new Set(["BROWSER", "VIDEO_PLAYER"]);

export interface GamFamilyTargeting {
  sizes: Array<{ width: number; height: number }>;
  environment: "BROWSER" | "VIDEO_PLAYER";
  adUnitIds?: string[]; // absent → the network's effective root ad unit, descendants included
}

export interface GamForecastSourceConfig {
  families: ReadonlyMap<string, GamFamilyTargeting>;
  thresholds: ForecastThresholds;
  periods?: string[]; // absent → rolling window recomputed each cycle
}

// Raised when a buyer asks for something the snapshot cannot answer. Buyer-safe by construction:
// the server maps it to NOT_FOUND / UNAVAILABLE without the message.
export class ForecastUnavailableError extends Error {
  constructor(readonly reason: "unknown_family" | "unknown_period" | "not_ready" | "stale") {
    super(`forecast unavailable: ${reason}`);
  }
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface PeriodRange {
  start: DateParts;
  end: DateParts; // inclusive last day
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// "2026-10" → October 2026; "Q4-2026" (or "2026-Q4") → Oct–Dec 2026. Anything else → null.
export function parsePeriod(period: string): PeriodRange | null {
  const month = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (month) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    return { start: { year, month: m, day: 1 }, end: { year, month: m, day: lastDayOfMonth(year, m) } };
  }
  const quarterFirst = period.match(/^Q([1-4])-(\d{4})$/i);
  const yearFirst = period.match(/^(\d{4})-Q([1-4])$/i);
  if (quarterFirst || yearFirst) {
    const q = Number(quarterFirst ? quarterFirst[1] : yearFirst![2]);
    const year = Number(quarterFirst ? quarterFirst[2] : yearFirst![1]);
    const first = (q - 1) * 3 + 1;
    return {
      start: { year, month: first, day: 1 },
      end: { year, month: first + 2, day: lastDayOfMonth(year, first + 2) },
    };
  }
  return null;
}

function compareDates(a: DateParts, b: DateParts): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

// Calendar date "now" in the network's timezone.
export function todayIn(timeZone: string, now: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// Current month + the next ROLLING_MONTHS-1, plus the current and next quarter.
export function rollingPeriods(today: DateParts): string[] {
  const months = Array.from({ length: ROLLING_MONTHS }, (_, i) => {
    const index = today.month - 1 + i;
    const year = today.year + Math.floor(index / 12);
    return `${year}-${String((index % 12) + 1).padStart(2, "0")}`;
  });
  const q = Math.floor((today.month - 1) / 3) + 1;
  const quarters = [`Q${q}-${today.year}`, q === 4 ? `Q1-${today.year + 1}` : `Q${q + 1}-${today.year}`];
  return [...months, ...quarters];
}

function dateTimeXml(tag: string, d: DateParts, endOfDay: boolean, timeZone: string): string {
  const [h, m, s] = endOfDay ? [23, 59, 59] : [0, 0, 0];
  return (
    `<${tag}><date><year>${d.year}</year><month>${d.month}</month><day>${d.day}</day></date>` +
    `<hour>${h}</hour><minute>${m}</minute><second>${s}</second>` +
    `<timeZoneId>${xmlEscape(timeZone)}</timeZoneId></${tag}>`
  );
}

// Prospective line item for getAvailabilityForecast. Element order = XSD sequence of LineItem.
export function prospectiveLineItemXml(args: {
  range: PeriodRange;
  startsImmediately: boolean;
  targeting: GamFamilyTargeting;
  adUnitIds: string[];
  timeZone: string;
  currencyCode: string;
}): string {
  const { range, startsImmediately, targeting, adUnitIds, timeZone, currencyCode } = args;
  const start = startsImmediately
    ? `<startDateTimeType>IMMEDIATELY</startDateTimeType>`
    : dateTimeXml("startDateTime", range.start, false, timeZone);
  const placeholders = targeting.sizes
    .map(
      (s) =>
        `<creativePlaceholders><size><width>${s.width}</width><height>${s.height}</height>` +
        `<isAspectRatio>false</isAspectRatio></size></creativePlaceholders>`
    )
    .join("");
  const adUnits = adUnitIds
    .map((id) => `<targetedAdUnits><adUnitId>${xmlEscape(id)}</adUnitId><includeDescendants>true</includeDescendants></targetedAdUnits>`)
    .join("");
  return (
    `<lineItem><lineItem>` +
    start +
    dateTimeXml("endDateTime", range.end, true, timeZone) +
    `<lineItemType>STANDARD</lineItemType>` +
    `<costPerUnit><currencyCode>${xmlEscape(currencyCode)}</currencyCode><microAmount>1000000</microAmount></costPerUnit>` +
    `<costType>CPM</costType>` +
    placeholders +
    `<environmentType>${targeting.environment}</environmentType>` +
    (targeting.environment === "VIDEO_PLAYER" ? `<videoMaxDuration>${VIDEO_MAX_DURATION_MS}</videoMaxDuration>` : "") +
    `<primaryGoal><goalType>LIFETIME</goalType><unitType>IMPRESSIONS</unitType><units>${PROSPECTIVE_GOAL_UNITS}</units></primaryGoal>` +
    `<targeting><inventoryTargeting>${adUnits}</inventoryTargeting>` +
    // GAM requires an explicit request platform on video line items (NotNullError otherwise).
    (targeting.environment === "VIDEO_PLAYER"
      ? `<requestPlatformTargeting><targetedRequestPlatforms>VIDEO_PLAYER</targetedRequestPlatforms></requestPlatformTargeting>`
      : "") +
    `</targeting>` +
    `</lineItem></lineItem>` +
    `<forecastOptions><includeTargetingCriteriaBreakdown>false</includeTargetingCriteriaBreakdown>` +
    `<includeContendingLineItems>false</includeContendingLineItems></forecastOptions>`
  );
}

interface NetworkInfo {
  timeZone: string;
  currencyCode: string;
  rootAdUnitId: string;
}

interface SnapshotEntry {
  bucket: ForecastBucket;
  fetchedAt: number;
}

export interface RefreshReport {
  ok: number;
  failed: number;
  skipped: number;
  errors: string[]; // operator log only
}

// Operator-log description. Node's fetch hides the network cause ("fetch failed") in err.cause.
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? `${err.message} (${cause.code})` : err.message;
}

function seedKey(family_id: string, period: string): string {
  return JSON.stringify([family_id, period]);
}

export class GamForecastSource implements ForecastSource {
  // Declares the data as a live ad-server read: ForecastEngine reports synthetic:false for it.
  readonly live = true;
  private readonly snapshot = new Map<string, SnapshotEntry>();
  private network: NetworkInfo | null = null;

  constructor(
    private readonly client: GamSoapClient,
    private readonly config: GamForecastSourceConfig,
    private readonly now: () => number = Date.now
  ) {}

  async getAvailsBucket(family_id: string, period: string): Promise<ForecastBucket> {
    if (!this.config.families.has(family_id)) throw new ForecastUnavailableError("unknown_family");
    const entry = this.snapshot.get(seedKey(family_id, period));
    if (entry === undefined) {
      throw new ForecastUnavailableError(this.network === null ? "not_ready" : "unknown_period");
    }
    if (this.now() - entry.fetchedAt > GAM_MAX_STALENESS_MS) throw new ForecastUnavailableError("stale");
    return entry.bucket;
  }

  snapshotSize(): number {
    return this.snapshot.size;
  }

  // One refresh cycle. Never throws: a failed pair keeps its previous entry (served until it goes
  // stale), and the report tells the operator what happened.
  async refresh(): Promise<RefreshReport> {
    const report: RefreshReport = { ok: 0, failed: 0, skipped: 0, errors: [] };
    try {
      this.network = await this.fetchNetwork();
    } catch (err) {
      report.failed = this.config.families.size;
      report.errors.push(describeError(err));
      return report;
    }
    const { timeZone, currencyCode, rootAdUnitId } = this.network;
    const today = todayIn(timeZone, new Date(this.now()));
    const periods = this.config.periods ?? rollingPeriods(today);

    for (const [family_id, targeting] of this.config.families) {
      for (const period of periods) {
        const range = parsePeriod(period);
        if (range === null || compareDates(range.end, today) < 0) {
          report.skipped++; // unparseable or already over — nothing to forecast
          continue;
        }
        const body = prospectiveLineItemXml({
          range,
          startsImmediately: compareDates(range.start, today) <= 0,
          targeting,
          adUnitIds: targeting.adUnitIds ?? [rootAdUnitId],
          timeZone,
          currencyCode,
        });
        try {
          const xml = await this.client.call("ForecastService", "getAvailabilityForecast", body);
          const available = Number(firstTagText(xml, "availableUnits"));
          if (!Number.isFinite(available)) throw new Error(`[gam] forecast response without availableUnits`);
          this.snapshot.set(seedKey(family_id, period), {
            bucket: bucketForImpressions(available, this.config.thresholds),
            fetchedAt: this.now(),
          });
          report.ok++;
        } catch (err) {
          report.failed++;
          report.errors.push(`${family_id}/${period}: ${describeError(err)}`);
        }
      }
    }
    return report;
  }

  private async fetchNetwork(): Promise<NetworkInfo> {
    const xml = await this.client.call("NetworkService", "getCurrentNetwork", "");
    const timeZone = firstTagText(xml, "timeZone");
    const currencyCode = firstTagText(xml, "currencyCode");
    const rootAdUnitId = firstTagText(xml, "effectiveRootAdUnitId");
    if (!timeZone || !currencyCode || !rootAdUnitId) {
      throw new Error(`[gam] getCurrentNetwork response is missing timeZone/currencyCode/effectiveRootAdUnitId`);
    }
    return { timeZone, currencyCode, rootAdUnitId };
  }
}

// ── config/gam.json ──────────────────────────────────────────────────────────

interface RawGamConfig {
  network_code?: unknown;
  service_account_key_path?: unknown;
  api_version?: unknown;
  thresholds?: ForecastThresholds;
  periods?: unknown;
  families?: unknown;
}

function parseSize(value: unknown, where: string): { width: number; height: number } {
  const match = typeof value === "string" ? value.match(/^(\d+)x(\d+)$/) : null;
  if (!match) throw new Error(`[gam] gam.json ${where}: size must look like "300x250" (got ${JSON.stringify(value)}).`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseFamilies(raw: unknown): Map<string, GamFamilyTargeting> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new Error(`[gam] gam.json: "families" must be a non-empty object keyed by family_id.`);
  }
  const families = new Map<string, GamFamilyTargeting>();
  for (const [family_id, value] of Object.entries(raw)) {
    const f = value as { sizes?: unknown; environment?: unknown; ad_unit_ids?: unknown };
    if (!Array.isArray(f.sizes) || f.sizes.length === 0) {
      throw new Error(`[gam] gam.json families.${family_id}: "sizes" must be a non-empty array.`);
    }
    const environment = f.environment ?? "BROWSER";
    if (typeof environment !== "string" || !ENVIRONMENTS.has(environment)) {
      throw new Error(`[gam] gam.json families.${family_id}: environment must be BROWSER or VIDEO_PLAYER.`);
    }
    if (
      f.ad_unit_ids !== undefined &&
      (!Array.isArray(f.ad_unit_ids) || f.ad_unit_ids.length === 0 || !f.ad_unit_ids.every((id) => typeof id === "string" && /^\d+$/.test(id)))
    ) {
      throw new Error(`[gam] gam.json families.${family_id}: ad_unit_ids must be a non-empty array of numeric strings.`);
    }
    families.set(family_id, {
      sizes: f.sizes.map((s, i) => parseSize(s, `families.${family_id}.sizes[${i}]`)),
      environment: environment as GamFamilyTargeting["environment"],
      ...(f.ad_unit_ids ? { adUnitIds: f.ad_unit_ids as string[] } : {}),
    });
  }
  return families;
}

// Opt-in loader: null when config/gam.json is absent (caller keeps its seeded/synthetic source).
// A PRESENT file is validated fail-closed — an operator who asked for live GAM must not silently
// get synthetic buckets.
export function loadGamForecastSourceFromFile(
  configDir: string = operatorConfigDir(),
  env: NodeJS.ProcessEnv = process.env
): GamForecastSource | null {
  const path = join(configDir, GAM_CONFIG_FILE);
  if (!existsSync(path)) return null;
  const cfg = JSON.parse(readFileSync(path, "utf-8")) as RawGamConfig;

  if (typeof cfg.network_code !== "string" || !/^\d+$/.test(cfg.network_code)) {
    throw new Error(`[gam] gam.json: network_code must be a numeric string.`);
  }
  const keyPath = env[GAM_SA_KEY_ENV] ?? cfg.service_account_key_path;
  if (typeof keyPath !== "string" || keyPath === "") {
    throw new Error(`[gam] gam.json: set service_account_key_path or ${GAM_SA_KEY_ENV}.`);
  }
  const apiVersion = cfg.api_version ?? DEFAULT_GAM_API_VERSION;
  if (typeof apiVersion !== "string" || !/^v\d{6}$/.test(apiVersion)) {
    throw new Error(`[gam] gam.json: api_version must look like "v202608".`);
  }
  const thresholds = cfg.thresholds ?? DEFAULT_FORECAST_THRESHOLDS;
  validateThresholds(thresholds);
  if (cfg.periods !== undefined) {
    if (!Array.isArray(cfg.periods) || cfg.periods.length === 0) {
      throw new Error(`[gam] gam.json: "periods" must be a non-empty array when present.`);
    }
    for (const p of cfg.periods) {
      if (typeof p !== "string" || parsePeriod(p) === null) {
        throw new Error(`[gam] gam.json: period ${JSON.stringify(p)} is not YYYY-MM or Qn-YYYY.`);
      }
    }
  }
  const families = parseFamilies(cfg.families);

  const tokens = new ServiceAccountTokenProvider(loadServiceAccountKey(keyPath));
  const client = new GamSoapClient(
    { networkCode: cfg.network_code, apiVersion, applicationName: GAM_APPLICATION_NAME },
    tokens
  );
  return new GamForecastSource(client, {
    families,
    thresholds,
    ...(cfg.periods ? { periods: cfg.periods as string[] } : {}),
  });
}
