import { SignJWT, compactDecrypt, jwtVerify, type KeyLike } from "jose";
import { randomUUID } from "crypto";
import type { DeploymentConfig } from "../config/deployment.js";

const CONTRACT_VERSION = "0.1.0";

// Well-known capability document schema — e12-discovery-trust-anchor-signoff.md §7.
// Content minimum: node_id, version, posture, capability_families, issued_at, signature.
// privacy_posture block: privacy-consent-layer-fable-2026-07-03.md Pilar 2 (PROPUESTA, Pilar 2).
//
// What MUST NOT appear: raw GAM IDs, GAM topology, avails, pricing, buyer data,
// policy internals, credential internals, stack traces, endpoints, definitive schemas.
export interface WellKnownDocument {
  node_id: string;
  version: string;
  posture: string;
  capability_families: string[];
  issued_at: string;
  privacy_posture: PrivacyPosture;
  // signature: RS256 JWS compact — added by sign()
}

// Pilar 2 — machine-readable privacy posture block, v1.1.
// Values reflect PATH A (audience-blind, Z3 SIGNED 03/07/26).
// v1.1 additions (s6-consent-hardening-acts A2/A3): dsr_contact from deployment config,
// controller_model declared, audit_retention declared machine-readable.
// A buyer agent (or a publisher's auditor) can verify the node's data posture AND its
// retention commitment cryptographically before the first request.
export interface PrivacyPosture {
  end_user_personal_data: "none" | "pseudonymous" | "identified";
  audience_segmentation: "not_offered_v1" | "offered";
  tc_string_consumption: "none" | "optional" | "required";
  device_storage_access: "none" | "read" | "read_write";
  jurisdiction: string[];
  regulatory_alignment_declared: string[];
  consent_context_reserved: boolean;
  dsr_contact: string;
  controller_model: string;
  audit_retention: { hot_days: number; archive_months: number };
  posture_version: string;
}

const POSTURE_VERSION = "1.1";

// Static PATH A invariants — these do NOT vary per deployment (Z3 SIGNED).
const PATH_A_POSTURE_BASE = {
  end_user_personal_data: "none" as const,           // Z3 SIGNED: audience-blind invariant v1
  audience_segmentation: "not_offered_v1" as const,  // PATH A, no audience surfaces
  tc_string_consumption: "none" as const,            // S2S, no TC String consumption
  device_storage_access: "none" as const,            // S2S, no device storage (ePrivacy N/A)
  jurisdiction: ["ES", "EU"],
  regulatory_alignment_declared: [
    "GDPR",
    "AEPD-orientaciones-IA-agentica-2026",
  ],
  consent_context_reserved: true,                    // Pilar 3: field reserved in canonical model
};

function buildPrivacyPosture(deployment: DeploymentConfig): PrivacyPosture {
  return {
    ...PATH_A_POSTURE_BASE,
    jurisdiction: [...PATH_A_POSTURE_BASE.jurisdiction],
    regulatory_alignment_declared: [...PATH_A_POSTURE_BASE.regulatory_alignment_declared],
    dsr_contact: deployment.dsr_contact,
    controller_model: deployment.controller_model,
    audit_retention: { ...deployment.retention },
    posture_version: POSTURE_VERSION,
  };
}

// WellKnownService generates and signs the capability document.
// Same RS256 key family as domain-2 identity (e12-signoff §4, no new key material).
// Cache TTL ≤ 15 min — e12-signoff §6.
export const WELL_KNOWN_PATH = "/.well-known/seller-mcp-capabilities";
export const WELL_KNOWN_CACHE_TTL_SECONDS = 840; // 14 min, within ≤15 min SLO

// Renew at 90% of the JWT TTL, not 100% — leaves margin so a cached doc handed to a buyer
// is never seen expiring mid-flight (effective cache lifetime ~756s of the 840s TTL).
const CACHE_FRESH_MS = WELL_KNOWN_CACHE_TTL_SECONDS * 1000 * 0.9;

export class WellKnownService {
  private readonly privacyPosture: PrivacyPosture;
  private cachedSigned?: string;
  private cachedAtMs?: number;

  constructor(
    private readonly privateKey: KeyLike,
    private readonly publicKey: KeyLike,
    deployment: DeploymentConfig,
    private readonly nodeId = "seller-mcp-node-mvp"
  ) {
    this.privacyPosture = buildPrivacyPosture(deployment);
  }

  // C2 (Fase C): the well-known endpoint is public and unauthenticated — re-signing RS256
  // on every call is a free CPU-exhaustion vector for an attacker. Cache and reuse the JWS
  // while it's still fresh instead.
  async sign(): Promise<string> {
    if (this.cachedSigned !== undefined && this.cachedAtMs !== undefined && Date.now() - this.cachedAtMs < CACHE_FRESH_MS) {
      return this.cachedSigned;
    }

    const doc: WellKnownDocument = {
      node_id: this.nodeId,
      version: CONTRACT_VERSION,
      posture: "read-only-mvp",
      capability_families: ["discovery"],
      issued_at: new Date().toISOString(),
      privacy_posture: this.privacyPosture,
    };

    // Sign the document as a JWT — payload is the document, alg RS256.
    // The JWS compact form IS the signed document; buyer verifies signature before trusting content.
    const signed = await new SignJWT(doc as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "RS256", typ: "seller-mcp-capabilities+jwt" })
      .setIssuedAt()
      .setExpirationTime(`${WELL_KNOWN_CACHE_TTL_SECONDS}s`)
      .setJti(randomUUID())
      .sign(this.privateKey);

    this.cachedSigned = signed;
    this.cachedAtMs = Date.now();
    return signed;
  }

  // Verify a signed capability document. Returns the parsed document or throws.
  async verify(signedDoc: string): Promise<WellKnownDocument> {
    const { payload } = await jwtVerify(signedDoc, this.publicKey, {
      algorithms: ["RS256"],
    });
    return payload as unknown as WellKnownDocument;
  }

  getPrivacyPosture(): PrivacyPosture {
    return { ...this.privacyPosture };
  }

  // Test/ops hook — forces the next sign() to re-sign instead of reusing the cache.
  clearCache(): void {
    this.cachedSigned = undefined;
    this.cachedAtMs = undefined;
  }
}
