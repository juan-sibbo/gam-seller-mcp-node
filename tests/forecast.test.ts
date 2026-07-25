import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ForecastEngine, SyntheticForecastSource, FORECAST_TTL_SECONDS, FORECAST_BUCKET, BUCKET_LABELS } from "../src/forecast/engine.js";
import { GamForecastSource, type ForecastSource } from "../src/forecast/source.js";
import { RateLimiter, RATE_LIMIT_WINDOW_MS } from "../src/rate-limiter/limiter.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { AllowedSurface, DeniedSurface } from "../src/policy/types.js";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { createMemoryDenylist } from "../src/identity/denylist.js";
import { makeSafeError, ErrorCode } from "../src/errors/envelope.js";
import type { KeyLike } from "jose";

// S5 — forecast demo mode (s5-forecast-demo-mode-authorization-2026-07-04.md)

// ─────────────────────────────────────────────
// ForecastEngine — synthetic buckets
// ─────────────────────────────────────────────
describe("ForecastEngine — synthetic demo forecast (S5)", () => {
  let engine: ForecastEngine;

  beforeEach(() => {
    engine = new ForecastEngine();
  });

  it("returns a valid forecast result for a known family + period", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    expect(result.family_id).toBe("display-ros");
    expect(result.period).toBe("Q4-2026");
    expect(Object.values(FORECAST_BUCKET)).toContain(result.bucket);
    expect(result.bucket_label).toBeTruthy();
    expect(result.ttl_seconds).toBe(FORECAST_TTL_SECONDS);
  });

  it("synthetic flag is always true (demo mode authorization)", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    expect(result.synthetic).toBe(true);
  });

  it("TTL is 1800 seconds (30 min, blocker-#6 §4 RATIFIED)", async () => {
    expect(FORECAST_TTL_SECONDS).toBe(1800);
    const result = await engine.forecast("video-pre-roll", "Q1-2027");
    expect(result.ttl_seconds).toBe(1800);
  });

  it("bucket is deterministic — same input always produces same bucket", async () => {
    const r1 = await engine.forecast("branded-content", "Q3-2026");
    const r2 = await engine.forecast("branded-content", "Q3-2026");
    expect(r1.bucket).toBe(r2.bucket);
  });

  it("different family+period combinations produce all three bucket values", async () => {
    const inputs = [
      ["display-ros", "Q1-2026"],
      ["video-pre-roll", "Q2-2026"],
      ["branded-content", "Q3-2026"],
      ["native-feed", "Q4-2026"],
      ["display-ros", "Q4-2026"],
      ["video-pre-roll", "Q1-2027"],
    ];
    const buckets = new Set(
      await Promise.all(inputs.map(async ([f, p]) => (await engine.forecast(f!, p!)).bucket))
    );
    expect(buckets.size).toBeGreaterThan(1); // variety in demo
  });

  it("bucket_label matches the bucket value", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    expect(result.bucket_label).toBe(BUCKET_LABELS[result.bucket]);
  });

  it("all three bucket labels are defined", () => {
    expect(BUCKET_LABELS.low).toBeTruthy();
    expect(BUCKET_LABELS.mid).toBeTruthy();
    expect(BUCKET_LABELS.high).toBeTruthy();
  });
});

// ─────────────────────────────────────────────
// ForecastSource seam — engine is source-agnostic (DP-AB-01 §5.2, avails-only)
// ─────────────────────────────────────────────
describe("ForecastSource seam — ForecastEngine consumes an injectable source", () => {
  it("default engine uses the synthetic source (buckets match SyntheticForecastSource)", async () => {
    const engine = new ForecastEngine();
    const source = new SyntheticForecastSource();
    const result = await engine.forecast("display-ros", "Q4-2026");
    const expectedBucket = await source.getAvailsBucket("display-ros", "Q4-2026");
    expect(result.bucket).toBe(expectedBucket);
  });

  it("an injected source drives the bucket (constructor injection)", async () => {
    // A fake source that always returns HIGH — proves the engine defers to the seam,
    // not a hardwired algorithm.
    const fixedHigh: ForecastSource = {
      async getAvailsBucket() {
        return FORECAST_BUCKET.HIGH;
      },
    };
    const engine = new ForecastEngine(fixedHigh);
    const result = await engine.forecast("anything", "any-period");
    expect(result.bucket).toBe(FORECAST_BUCKET.HIGH);
    expect(result.bucket_label).toBe(BUCKET_LABELS.high);
  });

  it("synthetic flag stays true regardless of the injected source (invariant until production gate)", async () => {
    const fixedLow: ForecastSource = {
      async getAvailsBucket() {
        return FORECAST_BUCKET.LOW;
      },
    };
    const result = await new ForecastEngine(fixedLow).forecast("x", "y");
    expect(result.synthetic).toBe(true);
  });

  it("SyntheticForecastSource is deterministic per family+period", async () => {
    const source = new SyntheticForecastSource();
    const a = await source.getAvailsBucket("branded-content", "Q3-2026");
    const b = await source.getAvailsBucket("branded-content", "Q3-2026");
    expect(a).toBe(b);
    expect(Object.values(FORECAST_BUCKET)).toContain(a);
  });

  it("GamForecastSource is a stub — throws until service account provisioning (DP-AB-01 §5.2)", async () => {
    const gam = new GamForecastSource({ networkCode: "12345678", serviceAccountKeyPath: "GAM_SA_KEY" });
    await expect(gam.getAvailsBucket("display-ros", "Q4-2026")).rejects.toThrow(/not implemented/i);
  });

  it("an engine wired to GamForecastSource surfaces the stub error (no silent GAM read)", async () => {
    const gam = new GamForecastSource({ networkCode: "12345678", serviceAccountKeyPath: "GAM_SA_KEY" });
    const engine = new ForecastEngine(gam);
    await expect(engine.forecast("display-ros", "Q4-2026")).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────
// Pilar 3 — consent fields reserved null
// ─────────────────────────────────────────────
describe("Forecast — Pilar 3 reserved fields (privacy-consent-layer §3)", () => {
  const engine = new ForecastEngine();

  it("consent_context is null — Pilar 3 reserved, not interpreted", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    expect(result).toHaveProperty("consent_context");
    expect(result.consent_context).toBeNull();
  });

  it("legal_basis_provenance is null — Pilar 3 reserved, not interpreted", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    expect(result).toHaveProperty("legal_basis_provenance");
    expect(result.legal_basis_provenance).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Z3 invariant — no user-level fields (Z3 SIGNED 03/07/26)
// ─────────────────────────────────────────────
describe("Z3 invariant — forecast response contains no user-level fields", () => {
  const engine = new ForecastEngine();

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

  const GAM_FORBIDDEN = [
    "line_item_id",
    "order_id",
    "creative_id",
    "network_code",
    "gam_product_id",
  ];

  it("forecast response contains no Z3-forbidden user-level fields", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    const serialized = JSON.stringify(result);
    for (const field of Z3_FORBIDDEN) {
      expect(serialized).not.toContain(field);
    }
  });

  it("forecast response contains no GAM internal identifiers", async () => {
    const result = await engine.forecast("video-pre-roll", "Q3-2026");
    const serialized = JSON.stringify(result);
    for (const field of GAM_FORBIDDEN) {
      expect(serialized).not.toContain(field);
    }
  });

  it("forecast response has exactly the allowed schema fields", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    const keys = new Set(Object.keys(result));
    const allowed = new Set(["family_id", "period", "bucket", "bucket_label", "ttl_seconds", "synthetic", "consent_context", "legal_basis_provenance"]);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it("forecast response contains only inventory-level data (not audience-level)", async () => {
    const result = await engine.forecast("display-ros", "Q4-2026");
    // Bucket is about fill/availability — not audience composition
    expect(["low", "mid", "high"]).toContain(result.bucket);
    // No audience metadata attached
    expect(result).not.toHaveProperty("audience");
    expect(result).not.toHaveProperty("segments");
    expect(result).not.toHaveProperty("targeting");
  });
});

// ─────────────────────────────────────────────
// RateLimiter — forecast uses separate limiter per surface
// ─────────────────────────────────────────────
describe("Forecast rate limiter — independent per surface", () => {
  it("forecast limiter is independent from discovery limiter", () => {
    const discoveryLimiter = new RateLimiter();
    const forecastLimiter = new RateLimiter();

    discoveryLimiter.check("buyer-a"); // consume discovery quota
    // Forecast quota for same buyer is unaffected
    expect(forecastLimiter.check("buyer-a")).toBe(true);
  });

  it("second forecast request within 30s window is denied", () => {
    const limiter = new RateLimiter();
    limiter.check("buyer-a");
    expect(limiter.check("buyer-a")).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Policy — FORECAST surface authorization
// ─────────────────────────────────────────────
describe("Policy — FORECAST surface (SEC-GATE-2 extended to S5)", () => {
  let policy: PolicyEngine;

  const BASE = {
    surface: AllowedSurface.FORECAST,
    scope: "gam.readonly",
    phase: "phase-1-readonly",
    request_id: "s5-test",
  };

  beforeEach(() => {
    policy = new PolicyEngine(new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG));
  });

  it("entitled buyer can access FORECAST surface", () => {
    const decision = policy.decide({ ...BASE, buyer_id: "test-buyer-001" });
    expect(decision.outcome).toBe("ALLOW");
  });

  it("unknown buyer is denied FORECAST surface", () => {
    const decision = policy.decide({ ...BASE, buyer_id: "nobody" });
    expect(decision.outcome).toBe("DENY");
  });

  it("denied surfaces are still denied even with forecast entitlement", () => {
    for (const surface of Object.values(DeniedSurface)) {
      const decision = policy.decide({ ...BASE, buyer_id: "test-buyer-001", surface });
      expect(decision.outcome).toBe("DENY");
    }
  });
});

// ─────────────────────────────────────────────
// SEC-GATE-2 — auth on forecast surface (extended)
// ─────────────────────────────────────────────
describe("SEC-GATE-2 — forecast auth (token validation on FORECAST surface)", () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let issuer: TokenIssuer;

  beforeAll(async () => {
    const kp = await generateDevKeyPair();
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    issuer = new TokenIssuer(privateKey);
  });

  it("valid token passes validation", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token } = await issuer.issue();
    const result = await validator.validate(token);
    expect(result.valid).toBe(true);
  });

  it("revoked token → AUTH_FAILED on forecast surface (same rule as discover_products)", async () => {
    const denylist = createMemoryDenylist();
    const validator = new TokenValidator(publicKey, denylist);
    const { token, claims } = await issuer.issue();
    denylist.add(claims.jti, claims.exp * 1000);
    const result = await validator.validate(token);
    expect(result.valid).toBe(false);
  });
});
