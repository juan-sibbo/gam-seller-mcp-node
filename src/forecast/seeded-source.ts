import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { operatorConfigDir } from "../config/resolve.js";
import { FORECAST_BUCKET, SyntheticForecastSource, type ForecastBucket } from "./engine.js";
import type { ForecastSource } from "./source.js";

// SeededForecastSource — a GAM-less forecast source seeded from operator-provided data (a
// ONE-TIME GAM report export, NOT the live ForecastService/SOAP API). It lets a pilot run on the
// publisher's REAL availability shape while the live adapter (GamForecastSource, still a stub that
// throws) stays unwired pending a service account (DP-AB-01 §5.2 / issue #4).
//
// HONESTY INVARIANT: seeded data is still pre-loaded, not a live avail. ForecastEngine keeps
// `synthetic: true` on every result regardless of source — flipping it to false is a future
// production-gate act tied to the live GAM adapter, out of scope here. Seeding makes the buckets
// realistic; it does NOT make the forecast live. This keeps the README/code parity honest
// (tests/readme-claims.test.ts) while moving the pilot onto real numbers.
//
// Config (config/forecast.json — OPT-IN; absent → the deterministic SyntheticForecastSource):
//   {
//     "thresholds": { "mid": 1000000, "high": 10000000 },   // optional; avails >= high → high, >= mid → mid, else low
//     "buckets": [
//       { "family_id": "display-ros",   "period": "Q4-2026", "avail_impressions": 8200000 },
//       { "family_id": "video-pre-roll", "period": "Q4-2026", "bucket": "low" }
//     ]
//   }
// Each entry carries EXACTLY ONE of `bucket` (a literal low/mid/high) or `avail_impressions`
// (a count mapped through `thresholds`). An unseeded family/period falls through to the fallback
// source, so a PARTIAL seed still answers every request. Supplying real impression counts also
// resolves blocker #6 (bucket thresholds) with the publisher's own numbers instead of placeholders.

const VALID_BUCKETS: ReadonlySet<string> = new Set<string>(Object.values(FORECAST_BUCKET));

export interface ForecastThresholds {
  mid: number;
  high: number;
}

// Default thresholds when the operator omits them. Deliberately round placeholders — a real
// pilot sets these from the publisher's own inventory scale (see docs/PUBLISHER-DEPLOYMENT.md).
export const DEFAULT_FORECAST_THRESHOLDS: ForecastThresholds = { mid: 1_000_000, high: 10_000_000 };

interface SeededBucketEntry {
  family_id: string;
  period: string;
  bucket?: string;
  avail_impressions?: number;
}

interface SeededForecastConfig {
  thresholds?: ForecastThresholds;
  buckets: SeededBucketEntry[];
}

// A JSON-encoded pair is a collision-proof composite key: ["a","b c"] and ["a b","c"] can never
// serialize to the same string, so no family_id/period boundary ambiguity is possible.
function seedKey(family_id: string, period: string): string {
  return JSON.stringify([family_id, period]);
}

function bucketForImpressions(avails: number, t: ForecastThresholds): ForecastBucket {
  if (avails >= t.high) return FORECAST_BUCKET.HIGH;
  if (avails >= t.mid) return FORECAST_BUCKET.MID;
  return FORECAST_BUCKET.LOW;
}

export class SeededForecastSource implements ForecastSource {
  private readonly seeds: ReadonlyMap<string, ForecastBucket>;
  private readonly fallback: ForecastSource;

  constructor(
    seeds: ReadonlyMap<string, ForecastBucket>,
    fallback: ForecastSource = new SyntheticForecastSource()
  ) {
    this.seeds = seeds;
    this.fallback = fallback;
  }

  async getAvailsBucket(family_id: string, period: string): Promise<ForecastBucket> {
    const seeded = this.seeds.get(seedKey(family_id, period));
    if (seeded !== undefined) return seeded;
    // Partial seed: an unseeded family/period still answers, deterministically, via the fallback.
    return this.fallback.getAvailsBucket(family_id, period);
  }

  // Number of (family_id, period) pairs actually seeded — used for boot logging / tests.
  seedCount(): number {
    return this.seeds.size;
  }

  // Build from parsed config, validating FAIL-CLOSED: a malformed seed must stop the boot, not
  // silently degrade to synthetic — the operator asked for real numbers. Mirrors the fail-closed
  // contract of the catalog / pricing / entitlements loaders.
  static fromConfig(
    config: unknown,
    fallback: ForecastSource = new SyntheticForecastSource()
  ): SeededForecastSource {
    if (
      typeof config !== "object" ||
      config === null ||
      !Array.isArray((config as SeededForecastConfig).buckets)
    ) {
      throw new Error(`[forecast] Invalid forecast.json: expected an object with a "buckets" array.`);
    }
    const cfg = config as SeededForecastConfig;
    const thresholds = cfg.thresholds ?? DEFAULT_FORECAST_THRESHOLDS;
    validateThresholds(thresholds);

    const seeds = new Map<string, ForecastBucket>();
    cfg.buckets.forEach((entry, i) => {
      if (
        typeof entry.family_id !== "string" ||
        entry.family_id === "" ||
        typeof entry.period !== "string" ||
        entry.period === ""
      ) {
        throw new Error(
          `[forecast] forecast.json buckets[${i}]: family_id and period must be non-empty strings.`
        );
      }
      const hasBucket = entry.bucket !== undefined;
      const hasAvails = entry.avail_impressions !== undefined;
      if (hasBucket === hasAvails) {
        throw new Error(
          `[forecast] forecast.json buckets[${i}] (${entry.family_id}/${entry.period}): set ` +
            `EXACTLY one of "bucket" or "avail_impressions".`
        );
      }
      let bucket: ForecastBucket;
      if (hasBucket) {
        if (typeof entry.bucket !== "string" || !VALID_BUCKETS.has(entry.bucket)) {
          throw new Error(
            `[forecast] forecast.json buckets[${i}]: bucket must be one of ` +
              `${[...VALID_BUCKETS].join(", ")} (got ${JSON.stringify(entry.bucket)}).`
          );
        }
        bucket = entry.bucket as ForecastBucket;
      } else {
        if (
          typeof entry.avail_impressions !== "number" ||
          !Number.isFinite(entry.avail_impressions) ||
          entry.avail_impressions < 0
        ) {
          throw new Error(
            `[forecast] forecast.json buckets[${i}]: avail_impressions must be a finite number ` +
              `>= 0 (got ${JSON.stringify(entry.avail_impressions)}).`
          );
        }
        bucket = bucketForImpressions(entry.avail_impressions, thresholds);
      }
      seeds.set(seedKey(entry.family_id, entry.period), bucket);
    });
    return new SeededForecastSource(seeds, fallback);
  }
}

function validateThresholds(t: ForecastThresholds): void {
  if (
    typeof t.mid !== "number" ||
    typeof t.high !== "number" ||
    !Number.isFinite(t.mid) ||
    !Number.isFinite(t.high)
  ) {
    throw new Error(`[forecast] forecast.json thresholds.mid and thresholds.high must be finite numbers.`);
  }
  if (t.mid < 0 || t.high < t.mid) {
    throw new Error(
      `[forecast] forecast.json thresholds must satisfy 0 <= mid <= high (got mid=${t.mid}, high=${t.high}).`
    );
  }
}

export const FORECAST_CONFIG_FILE = "forecast.json";

// Opt-in loader: returns a SeededForecastSource when config/forecast.json exists (operator or
// repo config dir — NOT the demo-example fallback, so a missing seed never trips the demo guard),
// otherwise the given fallback (the deterministic synthetic source — v1 behavior unchanged).
// A PRESENT-but-unreadable/malformed file throws (fail-closed).
export function loadForecastSourceFromFile(
  fallback: ForecastSource = new SyntheticForecastSource(),
  configDir: string = operatorConfigDir()
): ForecastSource {
  const path = join(configDir, FORECAST_CONFIG_FILE);
  if (!existsSync(path)) return fallback; // opt-in: no seed file → synthetic (unchanged behavior)
  const raw = readFileSync(path, "utf-8"); // present-but-unreadable → throw (fail-closed)
  return SeededForecastSource.fromConfig(JSON.parse(raw), fallback);
}
