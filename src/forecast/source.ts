// Seam ForecastEngine consumes — DP-AB-01 §5.2 (A′/B: avails-only, no rate cards).
//
// Implementations:
//   - SyntheticForecastSource (engine.ts)      — deterministic, zero GAM. The default.
//   - SeededForecastSource (seeded-source.ts)  — operator-provided one-time GAM report export.
//   - GamForecastSource (gam-source.ts)        — live GAM ForecastService snapshot (config/gam.json).

import type { ForecastBucket } from "./engine.js";

// A source's availability estimate for one family × period. ForecastEngine rounds it with the
// publisher's disclosure policy before it reaches a buyer (disclosure-policy.ts). `asOf` is when
// the estimate was taken (epoch ms), null if it has no meaningful timestamp (synthetic/seeded).
export interface AvailabilityEstimate {
  units: number;
  // Viewable impressions within `units`, when the source forecasts them (GAM does); else null.
  viewableUnits: number | null;
  asOf: number | null;
}

export interface ListedAvailability {
  family_id: string;
  period: string;
  estimate: AvailabilityEstimate;
}

export interface ForecastSource {
  getAvailsBucket(family_id: string, period: string): Promise<ForecastBucket>;
  // Optional: sources that can estimate a volume support check_availability.
  getAvailability?(family_id: string, period: string): Promise<AvailabilityEstimate>;
  // Optional: every family × period the source can currently answer (used to suggest
  // alternatives when a request does not fit). Sources with no finite set omit it.
  listAvailability?(): Promise<ListedAvailability[]>;
  // True only for a source whose buckets come from a live ad-server read. ForecastEngine reports
  // `synthetic: !live`, so pre-loaded or generated data can never be labeled live.
  readonly live?: boolean;
}

// Raised when a source cannot answer a family × period. Buyer-safe by construction: the server
// maps it to NOT_FOUND / UNAVAILABLE without the message.
export class ForecastUnavailableError extends Error {
  constructor(readonly reason: "unknown_family" | "unknown_period" | "not_ready" | "stale") {
    super(`forecast unavailable: ${reason}`);
  }
}
