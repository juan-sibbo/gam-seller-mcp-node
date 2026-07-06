// Domain-2 inter-service JWT claims — domain2-identity-emission-validation-rotation-signoff.md §2
// Claims set is RATIFIED. Do not add claims without a signed governance act.
export interface Domain2Claims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  scope: string;
}

// Default issuer/audience values for the MVP sidecar
export const DOMAIN2_ISS = "seller-mcp-node";
export const DOMAIN2_AUD = "gam-adapter";
export const DOMAIN2_SCOPE = "gam.readonly";

// Token TTL in seconds. Must satisfy D3 SLO ≤ 15 min (900s).
// Set to 840s (14 min) to leave 60s headroom for denylist propagation.
export const DOMAIN2_TTL_SECONDS = 840;

export interface ValidationResult {
  valid: boolean;
  claims?: Domain2Claims;
  error?: string;
}
