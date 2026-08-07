import { describe, it, expect, beforeAll } from "vitest";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { WellKnownService, WELL_KNOWN_PATH, WELL_KNOWN_CACHE_TTL_SECONDS } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import type { KeyLike } from "jose";

// e12-discovery-trust-anchor-signoff.md — RATIFIED 18/06/26
// privacy-consent-layer-fable-2026-07-03.md — Pilar 2
// S2 done criterion: well-known signature verifies, privacy_posture block present
// S6 (acts A2/A3): posture v1.1 — dsr_contact/controller_model/audit_retention from config

let privateKey: KeyLike;
let publicKey: KeyLike;
let service: WellKnownService;

beforeAll(async () => {
  const kp = await generateDevKeyPair();
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
  service = new WellKnownService(privateKey, publicKey, TEST_DEPLOYMENT_CONFIG);
});

describe("WellKnownService — signed capability document", () => {
  it("produces a signed JWT string", async () => {
    const signed = await service.sign();
    expect(typeof signed).toBe("string");
    // JWT compact form: 3 base64url segments separated by dots
    expect(signed.split(".")).toHaveLength(3);
  });

  it("signature verifies with the correct public key", async () => {
    const signed = await service.sign();
    const doc = await service.verify(signed);
    expect(doc).toBeDefined();
  });

  it("verified document contains all required minimum fields (e12-signoff §7)", async () => {
    const signed = await service.sign();
    const doc = await service.verify(signed);
    expect(doc.node_id).toBeDefined();
    expect(doc.version).toBeDefined();
    expect(doc.posture).toBeDefined();
    expect(Array.isArray(doc.capability_families)).toBe(true);
    expect(doc.issued_at).toBeDefined();
    expect(doc.privacy_posture).toBeDefined();
  });

  it("posture field is 'read-only-mvp'", async () => {
    const signed = await service.sign();
    const doc = await service.verify(signed);
    expect(doc.posture).toBe("read-only-mvp");
  });

  it("capability_families is non-empty (at least 'discovery')", async () => {
    const signed = await service.sign();
    const doc = await service.verify(signed);
    expect(doc.capability_families).toContain("discovery");
  });

  describe("privacy_posture block — Pilar 2 (privacy-consent-layer §2)", () => {
    it("reflects PATH A: no end-user personal data", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.end_user_personal_data).toBe("none");
    });

    it("audience segmentation is not_offered_v1 (Z3 invariant SIGNED 03/07/26)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.audience_segmentation).toBe("not_offered_v1");
    });

    it("TC String consumption is none (Z3 — no TC String in v1)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.tc_string_consumption).toBe("none");
    });

    it("device storage access is none (S2S only, ePrivacy N/A)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.device_storage_access).toBe("none");
    });

    it("jurisdiction includes ES and EU", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.jurisdiction).toContain("ES");
      expect(doc.privacy_posture.jurisdiction).toContain("EU");
    });

    it("regulatory_alignment_declared includes GDPR and AEPD guidance", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.regulatory_alignment_declared).toContain("GDPR");
      expect(doc.privacy_posture.regulatory_alignment_declared.some((v) => v.includes("AEPD"))).toBe(true);
    });

    it("consent_context_reserved is true (Pilar 3 field reserved)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.consent_context_reserved).toBe(true);
    });

    // S6 posture v1.1 — acts A2/A3 (05/07/26)
    it("dsr_contact comes from deployment config and is never a placeholder", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.dsr_contact).toBe(TEST_DEPLOYMENT_CONFIG.dsr_contact);
      expect(doc.privacy_posture.dsr_contact).not.toContain("[[");
    });

    it("controller_model is declared and matches deployment config", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.controller_model).toBe(TEST_DEPLOYMENT_CONFIG.controller_model);
    });

    it("audit_retention is declared machine-readable (A3: 90d hot / 12m archive)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.audit_retention).toEqual({ hot_days: 90, archive_months: 12 });
    });

    it("posture_version is 1.1", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.posture_version).toBe("1.1");
    });

    it("deployment_mode defaults to 'production' when no mode is passed", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.deployment_mode).toBe("production");
    });

    it("deployment_mode is 'demo' when explicitly set (atomic deployment frontier)", async () => {
      const { generateDevKeyPair } = await import("../src/identity/jwk.js");
      const kp = await generateDevKeyPair();
      const demoService = new WellKnownService(kp.privateKey, kp.publicKey, TEST_DEPLOYMENT_CONFIG, undefined, "demo");
      const signed = await demoService.sign();
      const doc = await demoService.verify(signed);
      expect(doc.privacy_posture.deployment_mode).toBe("demo");
    });

    it("data_source is 'synthetic' (GAM adapter not yet wired)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      expect(doc.privacy_posture.data_source).toBe("synthetic");
    });
  });

  describe("security properties", () => {
    it("signature fails to verify with a different public key", async () => {
      const { publicKey: wrongPubKey } = await generateDevKeyPair();
      const wrongService = new WellKnownService(privateKey, wrongPubKey, TEST_DEPLOYMENT_CONFIG);
      const signed = await service.sign();
      await expect(wrongService.verify(signed)).rejects.toThrow();
    });

    it("tampered document fails signature verification", async () => {
      const signed = await service.sign();
      // Corrupt the payload segment (middle section of JWT)
      const parts = signed.split(".");
      const tamperedPayload = Buffer.from(parts[1], "base64url")
        .toString("utf-8")
        .replace("read-only-mvp", "tampered-posture");
      const tamperedToken = [parts[0], Buffer.from(tamperedPayload).toString("base64url"), parts[2]].join(".");
      await expect(service.verify(tamperedToken)).rejects.toThrow();
    });

    it("document does NOT contain raw GAM IDs (e12-signoff §7 prohibition)", async () => {
      const signed = await service.sign();
      const doc = await service.verify(signed);
      const serialized = JSON.stringify(doc);
      const forbidden = ["gam_id", "line_item_id", "order_id", "creative_id", "product_id", "network_code"];
      for (const f of forbidden) {
        expect(serialized).not.toContain(f);
      }
    });

    it("document does NOT contain audience DATA values (Z3 invariant — distinct from privacy declarations)", async () => {
      // Z3 SIGNED 03/07/26: no audience-level data in buyer-facing responses.
      // NOTE: privacy_posture.audience_segmentation = "not_offered_v1" is a DECLARATION about
      // the absence of audience features — it is NOT an audience data value. The test checks
      // for actual audience data patterns (segment IDs, user profiles, TC Strings, device IDs),
      // not for field names in the privacy posture block itself.
      const signed = await service.sign();
      const doc = await service.verify(signed);
      // These fields must not appear as data-carrying properties (not as privacy declarations)
      expect(doc).not.toHaveProperty("audience_segments");
      expect(doc).not.toHaveProperty("user_id");
      expect(doc).not.toHaveProperty("device_id");
      expect(doc).not.toHaveProperty("tc_string");
      expect(doc).not.toHaveProperty("user_profile");
      expect(doc).not.toHaveProperty("segment_id");
      // The well-known document has no field carrying actual audience membership data
      const serialized = JSON.stringify(doc);
      expect(serialized).not.toMatch(/"segment_id"\s*:/);
      expect(serialized).not.toMatch(/"user_segments"\s*:/);
      expect(serialized).not.toMatch(/"tc_string"\s*:/);
    });

    it("cache TTL is ≤ 15 min (900s) — e12-signoff §6", () => {
      expect(WELL_KNOWN_CACHE_TTL_SECONDS).toBeLessThanOrEqual(900);
    });
  });

  describe("signing cache (C2 — DoS fix: sign() must not re-sign RS256 on every call)", () => {
    it("returns the same signed document on consecutive calls", async () => {
      const svc = new WellKnownService(privateKey, publicKey, TEST_DEPLOYMENT_CONFIG);
      const a = await svc.sign();
      const b = await svc.sign();
      expect(b).toBe(a);
    });

    it("signs a new document once the cache is cleared", async () => {
      const svc = new WellKnownService(privateKey, publicKey, TEST_DEPLOYMENT_CONFIG);
      const a = await svc.sign();
      svc.clearCache();
      const b = await svc.sign();
      expect(b).not.toBe(a);
    });

    it("a cached document still verifies", async () => {
      const svc = new WellKnownService(privateKey, publicKey, TEST_DEPLOYMENT_CONFIG);
      await svc.sign();
      const cached = await svc.sign();
      const doc = await svc.verify(cached);
      expect(doc).toBeDefined();
    });
  });

  describe("well-known URI", () => {
    it("canonical path is /.well-known/seller-mcp-capabilities (e12-signoff §5)", () => {
      expect(WELL_KNOWN_PATH).toBe("/.well-known/seller-mcp-capabilities");
    });
  });
});
