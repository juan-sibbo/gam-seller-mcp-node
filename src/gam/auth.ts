import { readFileSync } from "fs";
import { importPKCS8, SignJWT } from "jose";

// Service-account → OAuth2 access token for the Ad Manager API (JWT bearer grant, RFC 7523).
// Uses jose (already a dependency) instead of google-auth-library: one signed assertion, one POST.
//
// EGRESS (declared in tests/egress-surface.test.ts): POSTs a signed assertion to Google's token
// endpoint. Triggered only by the GAM forecast refresh cycle (boot + timer), never by a buyer
// request. The key file is read from an operator-supplied path; its contents never leave the
// process except as the signed assertion.

export const GAM_OAUTH_SCOPE = "https://www.googleapis.com/auth/dfp";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ASSERTION_TTL_SECONDS = 3600;
// Refresh a little before expiry so an in-flight SOAP call never carries a just-expired token.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export function loadServiceAccountKey(path: string): ServiceAccountKey {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    // Never echo the file contents — only the shape problem.
    throw new Error(`[gam] Service-account key at the configured path lacks client_email/private_key.`);
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

export class ServiceAccountTokenProvider implements AccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    const privateKey = await importPKCS8(this.key.private_key, "RS256");
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: GAM_OAUTH_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.key.client_email)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_TTL_SECONDS)
      .sign(privateKey);

    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      // Status only: the body can carry account identifiers.
      throw new Error(`[gam] OAuth token exchange failed (HTTP ${res.status}).`);
    }
    const body = JSON.parse(await res.text()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") {
      throw new Error(`[gam] OAuth token exchange returned no access_token.`);
    }
    const ttlSeconds = typeof body.expires_in === "number" ? body.expires_in : ASSERTION_TTL_SECONDS;
    this.cached = { token: body.access_token, expiresAt: this.now() + ttlSeconds * 1000 };
    return body.access_token;
  }
}
