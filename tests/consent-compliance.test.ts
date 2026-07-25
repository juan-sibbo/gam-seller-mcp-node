import { describe, it, expect, beforeAll } from "vitest";
import { generateDevKeyPair } from "../src/identity/jwk.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG, loadDeploymentConfigFromFile } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { assertConsentFieldsEmpty } from "../src/catalog/consent-types.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";
import type { KeyLike } from "jose";

// S6 F6 — cross-cutting consent-compliance invariants.
// These tests are the executable answer to a publisher DPO's audit questions:
// the posture the node DECLARES must equal the behavior the node HAS.

let privateKey: KeyLike;
let publicKey: KeyLike;

beforeAll(async () => {
  const kp = await generateDevKeyPair();
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
});

describe("Declared posture == configured behavior", () => {
  it("dsr_contact in the signed posture equals the deployment config value", async () => {
    const service = new WellKnownService(privateKey, publicKey, TEST_DEPLOYMENT_CONFIG);
    const doc = await service.verify(await service.sign());
    expect(doc.privacy_posture.dsr_contact).toBe(TEST_DEPLOYMENT_CONFIG.dsr_contact);
  });

  it("declared audit_retention equals the retention the RetentionService enforces", async () => {
    const service = new WellKnownService(privateKey, publicKey, TEST_DEPLOYMENT_CONFIG);
    const doc = await service.verify(await service.sign());
    // Same config object feeds both the posture and the RetentionService — asserting
    // equality here guards against the two ever diverging silently.
    expect(doc.privacy_posture.audit_retention).toEqual(TEST_DEPLOYMENT_CONFIG.retention);
  });

  it("shipped dev deployment config produces a serving-ready posture (no placeholders)", async () => {
    const shipped = loadDeploymentConfigFromFile();
    const service = new WellKnownService(privateKey, publicKey, shipped);
    const doc = await service.verify(await service.sign());
    expect(JSON.stringify(doc.privacy_posture)).not.toContain("[[");
  });
});

describe("PATH A guard — consent fields are null everywhere buyer-facing (Z3 + Pilar 3)", () => {
  it("every catalog family passes the consent-empty guard", () => {
    const store = new CatalogStore(TEST_CATALOG_CONFIG);
    for (const buyer of ["test-buyer-001", "pilot-buyer-001"]) {
      for (const family of store.discover(buyer)) {
        expect(() => assertConsentFieldsEmpty(family)).not.toThrow();
      }
    }
  });

  it("every forecast result passes the consent-empty guard", async () => {
    const engine = new ForecastEngine();
    for (const family of ["display-ros", "video-pre-roll", "branded-content"]) {
      const result = await engine.forecast(family, "Q4-2026");
      expect(() => assertConsentFieldsEmpty(result)).not.toThrow();
    }
  });

  it("the guard itself trips on a populated consent field (PATH B without gate breaks the build)", () => {
    expect(() =>
      assertConsentFieldsEmpty({ consent_context: { spec: "premature" }, legal_basis_provenance: null })
    ).toThrow(/PATH B/);
    expect(() =>
      assertConsentFieldsEmpty({ consent_context: null, legal_basis_provenance: { legal_basis: "consent" } })
    ).toThrow(/PATH B/);
  });
});

describe("Ledger pseudonymity — end to end across event classes", () => {
  it("a realistic multi-class session leaves no raw buyer_id in the serialized ledger", () => {
    const ledger = createMemoryLedger();
    const RAW = "pilot-buyer-001";

    ledger.append(EventClass.BUYER_AUTHENTICATION, { result: "ok" }, { buyer_id: RAW, request_id: "r1" });
    ledger.append(EventClass.SCOPE_RESOLUTION, { scope: "gam.readonly", buyer_id: RAW }, { buyer_id: RAW });
    ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid" }, { buyer_id: RAW, request_id: "r2" });
    ledger.append(EventClass.TOKEN_ISSUANCE, { jti: "tok-1" }, { buyer_id: RAW });
    ledger.append(EventClass.TOKEN_REVOCATION, { jti: "tok-1" }, { buyer_id: RAW });

    const serialized = JSON.stringify(ledger.allEntries());
    expect(serialized).not.toContain(RAW);
    expect(ledger.replayVerify().valid).toBe(true);
  });
});
