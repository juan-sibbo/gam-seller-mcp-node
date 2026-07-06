import { SignJWT } from "jose";
import { randomUUID } from "crypto";
import type { KeyLike } from "jose";
import {
  DOMAIN2_ISS,
  DOMAIN2_AUD,
  DOMAIN2_SCOPE,
  DOMAIN2_TTL_SECONDS,
  type Domain2Claims,
} from "./types.js";

// Self-issued sidecar token issuer — domain2-identity-signoff §3 (self-issued sidecar).
// Signs inter-service JWTs with RS256. Buyer never sees these tokens —
// they are used by the MCP server when calling the (future) GAM Adapter.
export class TokenIssuer {
  private readonly privateKey: KeyLike;
  private readonly ttl: number;

  constructor(privateKey: KeyLike, ttlSeconds = DOMAIN2_TTL_SECONDS) {
    this.privateKey = privateKey;
    this.ttl = ttlSeconds;
  }

  async issue(sub: string = DOMAIN2_ISS, aud: string = DOMAIN2_AUD): Promise<{ token: string; claims: Domain2Claims }> {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const claims: Domain2Claims = {
      iss: DOMAIN2_ISS,
      sub,
      aud,
      exp: now + this.ttl,
      iat: now,
      jti,
      scope: DOMAIN2_SCOPE,
    };

    const token = await new SignJWT({ scope: claims.scope })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(claims.iss)
      .setSubject(claims.sub)
      .setAudience(claims.aud)
      .setExpirationTime(claims.exp)
      .setIssuedAt(claims.iat)
      .setJti(claims.jti)
      .sign(this.privateKey);

    return { token, claims };
  }

  getTtlSeconds(): number {
    return this.ttl;
  }
}
