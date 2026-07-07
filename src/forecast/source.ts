// Seam for a real GAM-backed forecast source — DP-AB-01 §5.2 (A′/B: avails-only, no rate cards).
// Not wired into ForecastEngine yet: no service account provisioned for this integration
// (GAM network is FSP, non-360). Existing Cloud service accounts used for order-injection
// scripts prove API access exists at the org level; this integration needs its own credential
// and the network's Forecast Service scope granted inside GAM itself — still pending (07/07/26).

import type { ForecastBucket } from "./engine.js";

export interface ForecastSource {
  getAvailsBucket(family_id: string, period: string): Promise<ForecastBucket>;
}

export interface GamForecastSourceConfig {
  networkCode: string;
  // Path to a service-account key file, or an env var name that holds one — never inline JSON.
  serviceAccountKeyPath: string;
}

// ponytail: stub — throws until the service account lands and the SOAP call is wired in.
// Google ships no official Node client for the Ad Manager API (SOAP-only; official libs are
// Java/PHP/Python/.NET/Ruby), so the real implementation will speak SOAP directly against
// ForecastService.getAvailabilityForecast. Bucket thresholds are still [[por definir]]
// (blocker #6). Upgrade when both land.
export class GamForecastSource implements ForecastSource {
  constructor(private readonly config: GamForecastSourceConfig) {}

  async getAvailsBucket(_family_id: string, _period: string): Promise<ForecastBucket> {
    throw new Error(
      "GamForecastSource not implemented — pending GAM service account provisioning (DP-AB-01 §5.2)"
    );
  }
}
