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

// Buyer→node identity axis (BLOQUEANTE 1, plan-core-v04 Bloque A). SEPARATE from the
// Domain-2 node↔adapter axis: a buyer token is audienced at the node itself, and its
// `sub` IS the buyer_id (bound to the resource in authenticate()). MVP is self-issued
// (iss = node); Decisión 2 migrates toward bearer-per-buyer / JWKS without changing the
// binding contract. Reuses DOMAIN2_ISS as issuer and DOMAIN2_TTL_SECONDS as TTL.
export const BUYER_AUD = "seller-mcp-node";

// Token TTL in seconds. Must satisfy D3 SLO ≤ 15 min (900s).
// Set to 840s (14 min) to leave 60s headroom for denylist propagation.
export const DOMAIN2_TTL_SECONDS = 840;

export interface ValidationResult {
  valid: boolean;
  claims?: Domain2Claims;
  error?: string;
}
