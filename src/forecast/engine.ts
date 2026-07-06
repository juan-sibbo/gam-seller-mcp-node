// Synthetic forecast engine — s5-forecast-demo-mode-authorization-2026-07-04.md
// Produces Low/Mid/High availability buckets from config, zero GAM.
// synthetic: true is ALWAYS set — this field must never be false until a production gate.
// Z3 invariant: response contains no user-level attributes (audience, segment, TC String).
// Rate limit: N=1/T=30s per buyer_id applied in server.ts (same class as discover_products).

// Bucket values — s5-forecast-demo-mode-authorization §bucket-ranges (placeholder for demo).
// Production ranges are [[por definir]] pending pilot publisher inventory data (blocker #6).
export const FORECAST_BUCKET = {
  LOW: "low",
  MID: "mid",
  HIGH: "high",
} as const;

export type ForecastBucket = (typeof FORECAST_BUCKET)[keyof typeof FORECAST_BUCKET];

export const BUCKET_LABELS: Record<ForecastBucket, string> = {
  low: "Limited availability",
  mid: "Moderate availability",
  high: "Strong availability",
};

// TTL 30 min — blocker-#6 §4 RATIFIED
export const FORECAST_TTL_SECONDS = 1800;

export interface ForecastResult {
  family_id: string;
  period: string;
  bucket: ForecastBucket;
  bucket_label: string;
  ttl_seconds: number;
  synthetic: true; // always true in demo mode — see authorization doc
  consent_context: null;        // Pilar 3 reserved field
  legal_basis_provenance: null; // Pilar 3 reserved field
}

export class ForecastEngine {
  // Deterministic bucket assignment from family_id + period.
  // Same input always produces the same bucket — demo is reproducible across runs.
  forecast(family_id: string, period: string): ForecastResult {
    const bucket = this.assignBucket(family_id, period);
    return {
      family_id,
      period,
      bucket,
      bucket_label: BUCKET_LABELS[bucket],
      ttl_seconds: FORECAST_TTL_SECONDS,
      synthetic: true,
      consent_context: null,
      legal_basis_provenance: null,
    };
  }

  private assignBucket(family_id: string, period: string): ForecastBucket {
    const seed = family_id + period;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const buckets: ForecastBucket[] = [FORECAST_BUCKET.LOW, FORECAST_BUCKET.MID, FORECAST_BUCKET.HIGH];
    return buckets[hash % 3];
  }
}
