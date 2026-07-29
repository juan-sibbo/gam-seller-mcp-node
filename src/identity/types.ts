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

// Buyer→node identity axis (v0.4 Bloque A). Separate from the Domain-2 node↔adapter
// axis above: buyer bearer tokens are presented TO the node, so the node is both the
// issuer (it mints them via scripts/issue-buyer-token.ts) and the audience. The token's
// `sub` IS the buyer_id — a request's identity is derived from it, never from input.
export const BUYER_ISS = "seller-mcp-node";
export const BUYER_AUD = "seller-mcp-node";

// Token TTL in seconds. Must satisfy D3 SLO ≤ 15 min (900s).
// Set to 840s (14 min) to leave 60s headroom for denylist propagation.
export const DOMAIN2_TTL_SECONDS = 840;

export interface ValidationResult {
  valid: boolean;
  claims?: Domain2Claims;
  error?: string;
}
