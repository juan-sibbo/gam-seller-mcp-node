import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { RateLimiter, RATE_LIMIT_WINDOW_MS } from "../src/rate-limiter/limiter.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_WITH_PRODUCTS_CONFIG } from "../src/policy/entitlements.js";
import { AllowedSurface, DeniedSurface } from "../src/policy/types.js";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { ErrorCode, makeSafeError } from "../src/errors/envelope.js";
import { ReplayGuard } from "../src/audit/replay.js";
import type { KeyLike } from "jose";

// S4 — GAM Seller MCP Node
// SEC-GATE-2 + subset SEC-GATE-3 + Z3 invariant

// ─────────────────────────────────────────────
// CatalogStore — product families (Pilar 3)
// ─────────────────────────────────────────────
describe("CatalogStore — synthetic catalog (S4, zero GAM)", () => {
  let store: CatalogStore;

  beforeEach(() => {
    store = new CatalogStore(TEST_CATALOG_CONFIG);
  });

  it("returns families for an entitled buyer", () => {
    const families = store.discover("test-buyer-001");
    expect(families.length).toBeGreaterThan(0);
  });

  it("returns empty array for unknown buyer (Default-Deny posture)", () => {
    expect(store.discover("unknown-buyer")).toHaveLength(0);
  });

  it("each family has the required schema fields", () => {
    const families = store.discover("test-buyer-001");
    for (const f of families) {
      expect(f.family_id).toBeDefined();
      expect(typeof f.family_id).toBe("string");
      expect(f.label).toBeDefined();
      expect(typeof f.label).toBe("string");
      // Pilar 3: reserved fields must exist and be null (not undefined)
      expect(f).toHaveProperty("consent_context");
      expect(f.consent_context).toBeNull();
      expect(f).toHaveProperty("legal_basis_provenance");
      expect(f.legal_basis_provenance).toBeNull();
    }
  });

  it("buyer access is scoped — different buyers get different slices", () => {
    const buyer1 = store.discover("test-buyer-001");
    const buyer2 = store.discover("pilot-buyer-001");
    // Both should get results but not necessarily the same set
    expect(buyer1.length).toBeGreaterThan(0);
    expect(buyer2.length).toBeGreaterThan(0);
    const ids1 = new Set(buyer1.map((f) => f.family_id));
    const ids2 = new Set(buyer2.map((f) => f.family_id));
    // Verify they are not identical (cross-buyer isolation is maintained)
    const allSame = buyer1.every((f) => ids2.has(f.family_id)) && buyer1.length === buyer2.length;
    // At minimum, one buyer should have access to a family the other doesn't
    // (TEST_CATALOG_CONFIG gives them different sets)
    const atLeastOneDifference = [...ids1].some((id) => !ids2.has(id)) || [...ids2].some((id) => !ids1.has(id));
    expect(atLeastOneDifference).toBe(true);
  });

  it("familyCount returns total families in catalog (not per buyer)", () => {
    expect(store.familyCount()).toBe(TEST_CATALOG_CONFIG.families.length);
  });
});

// ─────────────────────────────────────────────
// RateLimiter — N=1/T=30s per buyer_id (blocker-#6 §4 RATIFIED)
// ─────────────────────────────────────────────
describe("RateLimiter — N=1/T=30s per buyer_id", () => {
  it("window is 30 000 ms (RATIFIED)", () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(30_000);
  });

  it("first request from a buyer is allowed", () => {
    const limiter = new RateLimiter();
    expect(limiter.check("buyer-a")).toBe(true);
  });

  it("second request within window is denied", () => {
    const limiter = new RateLimiter();
    limiter.check("buyer-a");
    expect(limiter.check("buyer-a")).toBe(false);
  });

  it("different buyers are independent", () => {
    const limiter = new RateLimiter();
    limiter.check("buyer-a");
    expect(limiter.check("buyer-b")).toBe(true);
  });

  it("request is allowed after window expires", () => {
    // Use a 0ms window to simulate expiry immediately
    const limiter = new RateLimiter(0);
    limiter.check("buyer-a");
    expect(limiter.check("buyer-a")).toBe(true);
  });

  it("size tracks distinct buyer_ids seen", () => {
    const limiter = new RateLimiter();
    limiter.check("buyer-a");
    limiter.check("buyer-b");
    limiter.check("buyer-a"); // second attempt — denied, but buyer still tracked
    expect(limiter.size()).toBe(2);
  });

  it("RATE_LIMITED error envelope contains no quota value (soap-fault-redaction §2)", () => {
    const env = makeSafeError(ErrorCode.RATE_LIMITED, "Too many requests, retry later.", "req-rl");
    // Check the message specifically — it must not reveal N=1 or T=30s
    expect(env.message).not.toMatch(/\b1\b.*request/i);
    expect(env.message).not.toMatch(/\b30\b/);
    expect(env.message).not.toMatch(/quota/i);
    // Code is expected to be RATE_LIMITED — check it doesn't embed numeric quota
    expect(env.message).not.toMatch(/per\s+\d+\s*(s|sec|second|min)/i);
  });
});

// ─────────────────────────────────────────────
// SEC-GATE-2 — auth/revocation + Default-Deny on read-only surface
// g4-phase1-readonly-authorization.md §11
// ─────────────────────────────────────────────
describe("SEC-GATE-2 — auth matrix (g4-phase1 §11)", () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let issuer: TokenIssuer;
  let policy: PolicyEngine;

  const BASE = {
    surface: AllowedSurface.PRODUCT_DISCOVERY,
    scope: "gam.readonly",
    phase: "phase-1-readonly",
    request_id: "sec-gate-2-test",
  };

  beforeAll(async () => {
    const kp = await generateDevKeyPair();
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    issuer = new TokenIssuer(privateKey);
    policy = new PolicyEngine(new EntitlementStore(TEST_ENTITLEMENTS_WITH_PRODUCTS_CONFIG));
  });

  it("Case 1: valid token + entitlement → ALLOW", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token } = await issuer.issue();

    const validation = await validator.validate(token);
    expect(validation.valid).toBe(true);

    const decision = policy.decide({ ...BASE, buyer_id: "test-buyer-001" });
    expect(decision.outcome).toBe("ALLOW");
  });

  it("Case 2: revoked token (jti in identity denylist) → invalid (AUTH_FAILED equivalent)", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token, claims } = await issuer.issue();

    denylist.add(claims.jti, claims.exp * 1000);

    const validation = await validator.validate(token);
    expect(validation.valid).toBe(false);
    expect(validation.error).toBe("jti_revoked");
    // Caller maps this to AUTH_FAILED (soap-fault-redaction §4 Option A)
  });

  it("Case 3: expired token → DENY", async () => {
    const expiredIssuer = new TokenIssuer(privateKey, 0); // 0s TTL = immediately expired
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token } = await expiredIssuer.issue();

    const validation = await validator.validate(token);
    expect(validation.valid).toBe(false);
  });

  it("Case 4: no entitlement for buyer → DENY", () => {
    const decision = policy.decide({ ...BASE, buyer_id: "unknown-buyer-xyz" });
    expect(decision.outcome).toBe("DENY");
    expect(decision.reason).toBeTruthy();
  });

  it("Case 5: identity denylist check occurs before allowing authenticated request", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token, claims } = await issuer.issue();

    // Token initially valid
    const before = await validator.validate(token);
    expect(before.valid).toBe(true);

    // Revoke: denylist prevails over valid signature (hard rule #1)
    denylist.add(claims.jti, claims.exp * 1000);

    const after = await validator.validate(token);
    expect(after.valid).toBe(false);
  });

  it("Case 6: surface in policy denylist §4 + valid credential → DENY (hard rule #1)", () => {
    // Even a fully entitled buyer cannot access a denied surface
    const decision = policy.decide({
      ...BASE,
      buyer_id: "test-buyer-001",
      surface: DeniedSurface.GAM_IDS,
    });
    expect(decision.outcome).toBe("DENY");
    expect(decision.reason).toBe("surface_in_denylist");
  });

  it("Case 6 — every §4 denied surface is blocked regardless of entitlement", () => {
    for (const surface of Object.values(DeniedSurface)) {
      const decision = policy.decide({
        ...BASE,
        buyer_id: "test-buyer-001",
        surface,
      });
      expect(decision.outcome).toBe("DENY");
    }
  });
});

// ─────────────────────────────────────────────
// SEC-GATE-3 subset — three pillars
// g4-phase1-readonly-authorization.md §11
// ─────────────────────────────────────────────
describe("SEC-GATE-3 subset — envelope + replay + SSRF egress deny-all", () => {
  // Pilar 1: Error envelope — no stack/env/secrets/GAM IDs (S1+S3 cross-reference)
  describe("Pilar 1 — error envelope safe serialization (cross-reference S1/S3)", () => {
    it("RATE_LIMITED envelope contains no internal fields", () => {
      const env = makeSafeError(ErrorCode.RATE_LIMITED, "Too many requests, retry later.", "req-p1");
      const keys = Object.keys(env);
      const forbidden = ["stack", "trace", "env", "secret", "gam_id", "line_item", "order_id", "cause", "debug", "internal"];
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
    });

    it("AUTH_FAILED envelope has exactly 4 fields and no internals", () => {
      const env = makeSafeError(ErrorCode.AUTH_FAILED, "Authentication failed.", "req-p1b");
      expect(Object.keys(env)).toHaveLength(4);
      const serialized = JSON.stringify(env);
      expect(serialized).not.toMatch(/stack|trace|gam_id|line_item|soap:Fault/i);
    });
  });

  // Pilar 2: Replay/dedupe — same request_id within window → DENY (S3 cross-reference)
  describe("Pilar 2 — replay guard (cross-reference S3)", () => {
    it("same request_id within window is detected as replay", () => {
      const guard = new ReplayGuard(15 * 60 * 1000);
      guard.record("req-replay-001");
      expect(guard.isReplay("req-replay-001")).toBe(true);
    });

    it("replay detection is consistent across multiple attempts", () => {
      const guard = new ReplayGuard(15 * 60 * 1000);
      guard.record("req-fixed");
      for (let i = 0; i < 5; i++) {
        expect(guard.isReplay("req-fixed")).toBe(true);
      }
    });
  });

  // Pilar 3: SSRF/egress deny-all — static analysis (NEW in S4)
  // No fetch/got/axios in src/. Buyer params not used as URLs.
  describe("Pilar 3 — SSRF/egress deny-all (static grep, SEC-GATE-3 new)", () => {
    const srcDir = join(fileURLToPath(import.meta.url), "../../src");

    function collectTsFiles(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
      return files;
    }

    it("no fetch() calls in src/ (SSRF deny-all)", () => {
      const files = collectTsFiles(srcDir);
      expect(files.length).toBeGreaterThan(0);
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        // Match fetch( but not comments
        if (/(?<!\/\/.*)\bfetch\s*\(/.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toHaveLength(0);
    });

    it("no got() / got.get() / got.post() calls in src/", () => {
      const files = collectTsFiles(srcDir);
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        if (/\bgot\s*[\.(]/.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toHaveLength(0);
    });

    it("no axios calls in src/", () => {
      const files = collectTsFiles(srcDir);
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        if (/\baxios\s*[\.(]/.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toHaveLength(0);
    });

    it("no http.request / https.request calls in src/", () => {
      const files = collectTsFiles(srcDir);
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        if (/\bhttps?\.request\s*\(/.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toHaveLength(0);
    });

    it("buyer_id is not used as a URL component in src/", () => {
      const files = collectTsFiles(srcDir);
      // Check that buyer_id does not appear adjacent to URL-building patterns
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        // Detect patterns like: `https://${buyer_id}` or `http://` + buyer_id
        if (/https?:\/\/.*buyer_id/.test(content) || /buyer_id.*https?:\/\//.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toHaveLength(0);
    });

    it("no node-fetch or cross-fetch imports in src/", () => {
      const files = collectTsFiles(srcDir);
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        if (/from\s+['"](?:node-fetch|cross-fetch|undici|got|axios|superagent)['"]/.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────
// Z3 invariant — no buyer-facing field contains user-level data
// z3-audience-blind-invariant-2026-07-03.md (SIGNED 03/07/26)
// ─────────────────────────────────────────────
describe("Z3 invariant — catalog response contains no user-level or denylist §4 fields (Z3 SIGNED 03/07/26)", () => {
  const store = new CatalogStore(TEST_CATALOG_CONFIG);

  // Z3 forbidden fields in any buyer-facing response
  const Z3_FORBIDDEN = [
    "segment_id",
    "user_id",
    "device_id",
    "tc_string",
    "audience_segment",
    "user_segments",
    "consent_string",
    "gdpr_applies",
    "user_agent",
    "user_profile",
  ];

  // §4 denylist field names that must not appear in buyer-facing output
  const DENYLIST_FIELDS = [
    "order_create",
    "deal_create",
    "media_buy",
    "inventory_reserve",
    "deal_mutate",
    "raw_avails",
    "gam_ids",
    "gam_objects",
    "exact_pricing",
    "cross_buyer_state",
    "gam_admin",
    "soap_faults",
    "credential_internals",
    "soft_lock_state",
  ];

  it("product families contain no Z3-forbidden user-level fields", () => {
    const families = store.discover("test-buyer-001");
    const serialized = JSON.stringify(families);
    for (const field of Z3_FORBIDDEN) {
      expect(serialized).not.toContain(field);
    }
  });

  it("product families contain no denylist §4 field names", () => {
    const families = store.discover("test-buyer-001");
    const serialized = JSON.stringify(families);
    for (const field of DENYLIST_FIELDS) {
      expect(serialized).not.toContain(field);
    }
  });

  it("catalog response schema has exactly the 4 allowed fields per family", () => {
    const families = store.discover("test-buyer-001");
    for (const f of families) {
      const keys = Object.keys(f);
      expect(keys).toContain("family_id");
      expect(keys).toContain("label");
      expect(keys).toContain("consent_context");
      expect(keys).toContain("legal_basis_provenance");
      // No extra fields beyond the schema
      expect(keys).toHaveLength(4);
    }
  });

  it("error envelopes contain no Z3-forbidden fields (including RATE_LIMITED)", () => {
    const envelopes = [
      makeSafeError(ErrorCode.AUTH_FAILED, "Authentication failed.", "req-z3-a"),
      makeSafeError(ErrorCode.RATE_LIMITED, "Too many requests, retry later.", "req-z3-b"),
      makeSafeError(ErrorCode.NOT_FOUND, "Not found.", "req-z3-c"),
    ];
    for (const env of envelopes) {
      const serialized = JSON.stringify(env);
      for (const field of Z3_FORBIDDEN) {
        expect(serialized).not.toContain(field);
      }
    }
  });

  it("catalog response contains no GAM internal identifiers", () => {
    const families = store.discover("test-buyer-001");
    const serialized = JSON.stringify(families);
    const gamForbidden = ["line_item_id", "order_id", "creative_id", "network_code", "gam_product_id"];
    for (const f of gamForbidden) {
      expect(serialized).not.toContain(f);
    }
  });

  it("consent_context is null — Pilar 3 reserved, not interpreted", () => {
    const families = store.discover("test-buyer-001");
    for (const f of families) {
      expect(f.consent_context).toBeNull();
    }
  });

  it("legal_basis_provenance is null — Pilar 3 reserved, not interpreted", () => {
    const families = store.discover("test-buyer-001");
    for (const f of families) {
      expect(f.legal_basis_provenance).toBeNull();
    }
  });
});
