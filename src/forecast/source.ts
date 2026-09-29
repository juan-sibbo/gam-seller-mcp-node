// Seam ForecastEngine consumes — DP-AB-01 §5.2 (A′/B: avails-only, no rate cards).
//
// Implementations:
//   - SyntheticForecastSource (engine.ts)      — deterministic, zero GAM. The default.
//   - SeededForecastSource (seeded-source.ts)  — operator-provided one-time GAM report export.
//   - GamForecastSource (gam-source.ts)        — live GAM ForecastService snapshot (config/gam.json).

import type { ForecastBucket } from "./engine.js";

export interface ForecastSource {
  getAvailsBucket(family_id: string, period: string): Promise<ForecastBucket>;
  // True only for a source whose buckets come from a live ad-server read. ForecastEngine reports
  // `synthetic: !live`, so pre-loaded or generated data can never be labeled live.
  readonly live?: boolean;
}
