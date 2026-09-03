import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SeededForecastSource,
  loadForecastSourceFromFile,
  DEFAULT_FORECAST_THRESHOLDS,
  FORECAST_CONFIG_FILE,
} from "../src/forecast/seeded-source.js";
import { ForecastEngine, SyntheticForecastSource, FORECAST_BUCKET } from "../src/forecast/engine.js";
import type { ForecastSource } from "../src/forecast/source.js";

// Seeded forecast source — lets a pilot run on the publisher's REAL availability shape (a one-time
// GAM report export) without wiring the live SOAP adapter. HONESTY INVARIANT under test: seeded
// buckets are honored, but ForecastEngine still labels every result synthetic:true (pre-loaded is
// not a live avail — see tests/readme-claims.test.ts, which guards the same claim from the README).

// A fallback that records whether it was consulted — proves an unseeded lookup falls through.
class RecordingFallback implements ForecastSource {
  public calls: Array<[string, string]> = [];
  constructor(private readonly bucket: typeof FORECAST_BUCKET.MID | typeof FORECAST_BUCKET.LOW = FORECAST_BUCKET.MID) {}
  async getAvailsBucket(family_id: string, period: string): Promise<typeof FORECAST_BUCKET.MID | typeof FORECAST_BUCKET.LOW> {
    this.calls.push([family_id, period]);
    return this.bucket;
  }
}

describe("SeededForecastSource — fromConfig", () => {
  it("returns the seeded bucket for a seeded family/period", async () => {
    const src = SeededForecastSource.fromConfig({
      buckets: [{ family_id: "display-ros", period: "Q4-2026", bucket: "high" }],
    });
    expect(await src.getAvailsBucket("display-ros", "Q4-2026")).toBe(FORECAST_BUCKET.HIGH);
    expect(src.seedCount()).toBe(1);
  });

  it("maps avail_impressions through the DEFAULT thresholds", async () => {
    const src = SeededForecastSource.fromConfig({
      buckets: [
        { family_id: "a", period: "P", avail_impressions: DEFAULT_FORECAST_THRESHOLDS.high },     // >= high → high
        { family_id: "b", period: "P", avail_impressions: DEFAULT_FORECAST_THRESHOLDS.mid },      // >= mid  → mid
        { family_id: "c", period: "P", avail_impressions: DEFAULT_FORECAST_THRESHOLDS.mid - 1 },  // <  mid  → low
      ],
    });
    expect(await src.getAvailsBucket("a", "P")).toBe(FORECAST_BUCKET.HIGH);
    expect(await src.getAvailsBucket("b", "P")).toBe(FORECAST_BUCKET.MID);
    expect(await src.getAvailsBucket("c", "P")).toBe(FORECAST_BUCKET.LOW);
  });

  it("honors custom thresholds", async () => {
    const src = SeededForecastSource.fromConfig({
      thresholds: { mid: 10, high: 100 },
      buckets: [
        { family_id: "a", period: "P", avail_impressions: 100 },
        { family_id: "b", period: "P", avail_impressions: 50 },
        { family_id: "c", period: "P", avail_impressions: 9 },
      ],
    });
    expect(await src.getAvailsBucket("a", "P")).toBe(FORECAST_BUCKET.HIGH);
    expect(await src.getAvailsBucket("b", "P")).toBe(FORECAST_BUCKET.MID);
    expect(await src.getAvailsBucket("c", "P")).toBe(FORECAST_BUCKET.LOW);
  });

  it("falls through to the fallback source for an UNSEEDED family/period (partial seed)", async () => {
    const fallback = new RecordingFallback(FORECAST_BUCKET.LOW);
    const src = SeededForecastSource.fromConfig(
      { buckets: [{ family_id: "seeded", period: "P", bucket: "high" }] },
      fallback
    );
    expect(await src.getAvailsBucket("seeded", "P")).toBe(FORECAST_BUCKET.HIGH);
    expect(fallback.calls).toHaveLength(0); // a seeded hit never consults the fallback
    expect(await src.getAvailsBucket("other", "P")).toBe(FORECAST_BUCKET.LOW);
    expect(fallback.calls).toEqual([["other", "P"]]);
  });

  it("uses collision-proof keys across family/period boundaries", async () => {
    const src = SeededForecastSource.fromConfig({
      buckets: [
        { family_id: "a", period: "b c", bucket: "high" },
        { family_id: "a b", period: "c", bucket: "low" },
      ],
    });
    expect(await src.getAvailsBucket("a", "b c")).toBe(FORECAST_BUCKET.HIGH);
    expect(await src.getAvailsBucket("a b", "c")).toBe(FORECAST_BUCKET.LOW);
  });
});

describe("SeededForecastSource — fail-closed validation", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", 42],
    ["missing buckets array", { thresholds: { mid: 1, high: 2 } }],
    ["empty family_id", { buckets: [{ family_id: "", period: "P", bucket: "high" }] }],
    ["empty period", { buckets: [{ family_id: "a", period: "", bucket: "high" }] }],
    ["neither bucket nor avails", { buckets: [{ family_id: "a", period: "P" }] }],
    ["both bucket and avails", { buckets: [{ family_id: "a", period: "P", bucket: "high", avail_impressions: 5 }] }],
    ["invalid bucket literal", { buckets: [{ family_id: "a", period: "P", bucket: "huge" }] }],
    ["negative avails", { buckets: [{ family_id: "a", period: "P", avail_impressions: -1 }] }],
    ["non-finite avails", { buckets: [{ family_id: "a", period: "P", avail_impressions: Infinity }] }],
    ["thresholds high < mid", { thresholds: { mid: 100, high: 10 }, buckets: [] }],
    ["threshold not a number", { thresholds: { mid: "x", high: 10 }, buckets: [] }],
  ];
  for (const [label, cfg] of cases) {
    it(`throws on ${label}`, () => {
      expect(() => SeededForecastSource.fromConfig(cfg)).toThrow();
    });
  }
});

describe("loadForecastSourceFromFile — opt-in loader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forecast-seed-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the given fallback when no forecast.json exists (opt-in — v1 behavior unchanged)", () => {
    const fallback = new SyntheticForecastSource();
    expect(loadForecastSourceFromFile(fallback, dir)).toBe(fallback);
  });

  it("returns a SeededForecastSource when forecast.json is present and valid", async () => {
    writeFileSync(
      join(dir, FORECAST_CONFIG_FILE),
      JSON.stringify({ buckets: [{ family_id: "display-ros", period: "Q4-2026", bucket: "high" }] })
    );
    const src = loadForecastSourceFromFile(new SyntheticForecastSource(), dir);
    expect(src).toBeInstanceOf(SeededForecastSource);
    expect(await src.getAvailsBucket("display-ros", "Q4-2026")).toBe(FORECAST_BUCKET.HIGH);
  });

  it("throws (fail-closed) when forecast.json is present but not valid JSON", () => {
    writeFileSync(join(dir, FORECAST_CONFIG_FILE), "{ not json");
    expect(() => loadForecastSourceFromFile(new SyntheticForecastSource(), dir)).toThrow();
  });

  it("throws (fail-closed) when forecast.json is present but semantically invalid", () => {
    writeFileSync(join(dir, FORECAST_CONFIG_FILE), JSON.stringify({ buckets: [{ family_id: "a", period: "P" }] }));
    expect(() => loadForecastSourceFromFile(new SyntheticForecastSource(), dir)).toThrow();
  });
});

describe("ForecastEngine keeps synthetic:true even with a seeded source (honesty invariant)", () => {
  it("honors the seeded bucket but still labels the result synthetic", async () => {
    const seeded = SeededForecastSource.fromConfig({
      buckets: [{ family_id: "display-ros", period: "Q4-2026", bucket: "high" }],
    });
    const result = await new ForecastEngine(seeded).forecast("display-ros", "Q4-2026");
    expect(result.bucket).toBe(FORECAST_BUCKET.HIGH); // seeded value honored
    expect(result.synthetic).toBe(true); // …but pre-loaded is not a live avail
  });
});
