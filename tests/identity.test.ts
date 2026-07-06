import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { DOMAIN2_ISS, DOMAIN2_AUD, DOMAIN2_TTL_SECONDS } from "../src/identity/types.js";
import type { KeyLike } from "jose";

// domain2-identity-emission-validation-rotation-signoff.md — RATIFIED 18/06/26
// S2 done criteria: revoked token → AUTH_FAILED (<15 min), expired/malformed/wrong-aud → DENY

let privateKey: KeyLike;
let publicKey: KeyLike;
let issuer: TokenIssuer;

beforeAll(async () => {
  const kp = await generateDevKeyPair();
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
});

beforeEach(() => {
  issuer = new TokenIssuer(privateKey);
});

describe("TokenIssuer — RS256 JWT (domain2-identity §2/§3)", () => {
  it("issues a JWT with the ratified claims set", async () => {
    const { claims } = await issuer.issue();
    expect(claims.iss).toBe(DOMAIN2_ISS);
    expect(claims.aud).toBe(DOMAIN2_AUD);
    expect(claims.scope).toBe("gam.readonly");
    expect(typeof claims.jti).toBe("string");
    expect(claims.jti.length).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(DOMAIN2_TTL_SECONDS);
  });

  it("TTL is ≤ 900 seconds (SLO D3 ≤ 15 min)", async () => {
    const { claims } = await issuer.issue();
    const ttl = claims.exp - claims.iat;
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it("each token has a unique jti", async () => {
    const { claims: c1 } = await issuer.issue();
    const { claims: c2 } = await issuer.issue();
    expect(c1.jti).not.toBe(c2.jti);
  });
});

describe("TokenValidator — fail-closed (domain2-identity §4/§7)", () => {
  it("accepts a valid fresh token", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token } = await issuer.issue();
    const result = await validator.validate(token);
    expect(result.valid).toBe(true);
  });

  it("rejects a token revoked (denylist hit) → AUTH_FAILED equivalent (hard rule #1)", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token, claims } = await issuer.issue();

    // Revoke: add jti to denylist
    denylist.add(claims.jti, claims.exp * 1000);

    const result = await validator.validate(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("jti_revoked");
  });

  it("denylist check occurs after valid signature — denylist prevails over valid token", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token, claims } = await issuer.issue();

    // Token is valid, signature is fine — but we revoke it
    const prePolicyResult = await validator.validate(token);
    expect(prePolicyResult.valid).toBe(true);

    denylist.add(claims.jti, claims.exp * 1000);

    const postRevocationResult = await validator.validate(token);
    expect(postRevocationResult.valid).toBe(false);
  });

  it("rejects an expired token", async () => {
    // Issue with 0s TTL (immediately expired)
    const shortIssuer = new TokenIssuer(privateKey, 0);
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token } = await shortIssuer.issue();
    const result = await validator.validate(token);
    expect(result.valid).toBe(false);
  });

  it("rejects a token with wrong audience", async () => {
    const wrongAudIssuer = new TokenIssuer(privateKey);
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist, DOMAIN2_ISS, "wrong-audience");

    // Issue token for DOMAIN2_AUD but validate expecting wrong-audience
    const validatorForRightAud = new TokenValidator(publicKey, denylist, DOMAIN2_ISS, "other-service");
    const { token } = await wrongAudIssuer.issue("seller-mcp-node", DOMAIN2_AUD);

    const result = await validatorForRightAud.validate(token);
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed token string", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const result = await validator.validate("not.a.valid.jwt");
    expect(result.valid).toBe(false);
  });

  it("rejects an empty string token", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const result = await validator.validate("");
    expect(result.valid).toBe(false);
  });

  it("rejects a token signed with a different key", async () => {
    const { privateKey: otherKey } = await generateDevKeyPair();
    const otherIssuer = new TokenIssuer(otherKey);
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist); // validator uses original pubkey
    const { token } = await otherIssuer.issue();
    const result = await validator.validate(token);
    expect(result.valid).toBe(false);
  });

  it("validation result never leaks internal error details buyer-facing", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const result = await validator.validate("garbage.token.value");
    // result.error is INTERNAL ONLY (never buyer-facing per soap-fault-redaction-signoff §2)
    // The buyer only sees AUTH_FAILED — this test confirms the error field exists but is opaque
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    // The error must not contain GAM IDs, env vars, stack traces
    if (result.error) {
      expect(result.error).not.toMatch(/stack|env|gam_id|secret|password/i);
    }
  });
});

describe("Denylist — durability and SLO (domain2-identity §4b/§6)", () => {
  it("newly added jti is found immediately", () => {
    const denylist = createMemoryDenylist();
    const futureExp = Date.now() + 900_000;
    denylist.add("test-jti-001", futureExp);
    expect(denylist.has("test-jti-001")).toBe(true);
  });

  it("unknown jti is not found", () => {
    const denylist = createMemoryDenylist();
    expect(denylist.has("nonexistent-jti")).toBe(false);
  });

  it("naturally expired entries are not found (lazy cleanup)", () => {
    const denylist = createMemoryDenylist();
    // Add with expiry in the past
    const pastExp = Date.now() - 1000;
    denylist.add("expired-jti", pastExp);
    expect(denylist.has("expired-jti")).toBe(false);
  });

  it("prune removes only expired entries", () => {
    const denylist = createMemoryDenylist();
    denylist.add("live-jti", Date.now() + 900_000);
    denylist.add("dead-jti", Date.now() - 1000);
    const removed = denylist.prune();
    expect(removed).toBe(1);
    expect(denylist.has("live-jti")).toBe(true);
    expect(denylist.has("dead-jti")).toBe(false);
  });

  it("FAIL-CLOSED: a corrupt persisted denylist refuses to start (revoked tokens must not resurrect)", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { Denylist } = await import("../src/identity/denylist.js");

    const dir = mkdtempSync(join(tmpdir(), "denylist-test-"));
    const path = join(dir, "denylist.json");
    writeFileSync(path, "{ this is not json", "utf-8");
    expect(() => new Denylist(path)).toThrow(/fail-closed/i);

    // Missing file is a legitimate fresh start — must NOT throw
    expect(() => new Denylist(join(dir, "does-not-exist.json"))).not.toThrow();
  });
});
