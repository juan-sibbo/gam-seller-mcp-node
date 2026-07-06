import { jwtVerify, type KeyLike } from "jose";
import { DOMAIN2_ISS, DOMAIN2_AUD, type ValidationResult } from "./types.js";
import type { Denylist } from "./denylist.js";

// Token validator — domain2-identity-signoff §4a + §4b + §7.
// Fail-closed: any validation step failure → valid: false, never true.
// Step order:
//   1. Signature verification (local JWK, no per-token network call)
//   2. Standard claim checks (exp, aud, iss)
//   3. Denylist check (jti) — denylist PREVAILS over valid signature
export class TokenValidator {
  constructor(
    private readonly publicKey: KeyLike,
    private readonly denylist: Denylist,
    private readonly iss: string = DOMAIN2_ISS,
    private readonly aud: string = DOMAIN2_AUD
  ) {}

  async validate(token: string): Promise<ValidationResult> {
    // Step 1 + 2: signature + claims (jose throws on any failure)
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.publicKey, {
        issuer: this.iss,
        audience: this.aud,
        algorithms: ["RS256"],
      });
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : "jwt_invalid" };
    }

    const jti = payload["jti"];
    if (typeof jti !== "string" || !jti) {
      return { valid: false, error: "jti_missing" };
    }

    // Step 3: denylist check — prevails over valid signature (hard rule #1)
    if (this.denylist.has(jti)) {
      return { valid: false, error: "jti_revoked" };
    }

    return {
      valid: true,
      claims: {
        iss: String(payload["iss"] ?? ""),
        sub: String(payload["sub"] ?? ""),
        aud: String(payload["aud"] ?? ""),
        exp: Number(payload["exp"]),
        iat: Number(payload["iat"]),
        jti,
        scope: String(payload["scope"] ?? ""),
      },
    };
  }
}
