import { describe, it, expect } from "vitest";
import {
  validateDeploymentConfig,
  loadDeploymentConfigFromFile,
  ControllerModel,
  TEST_DEPLOYMENT_CONFIG,
} from "../src/config/deployment.js";

// S6 F1 — per-deployment legal configuration (acts A2/A3, 05/07/26)

describe("DeploymentConfig — validation (fail-closed)", () => {
  const VALID = {
    dsr_contact: "privacy@example.com",
    controller_model: "operator-controller",
    controller_name: "Test Operator",
    retention: { hot_days: 90, archive_months: 12 },
  };

  it("accepts a valid config", () => {
    const cfg = validateDeploymentConfig(VALID);
    expect(cfg.dsr_contact).toBe("privacy@example.com");
    expect(cfg.retention.hot_days).toBe(90);
  });

  it("rejects placeholder dsr_contact — the node must never serve with [[por definir]]", () => {
    expect(() => validateDeploymentConfig({ ...VALID, dsr_contact: "[[por definir]]" })).toThrow();
  });

  it("rejects empty dsr_contact", () => {
    expect(() => validateDeploymentConfig({ ...VALID, dsr_contact: "  " })).toThrow();
  });

  it("rejects unknown controller_model", () => {
    expect(() => validateDeploymentConfig({ ...VALID, controller_model: "nobody" })).toThrow();
  });

  it("accepts both ratified controller models", () => {
    expect(validateDeploymentConfig({ ...VALID, controller_model: ControllerModel.OPERATOR }).controller_model).toBe("operator-controller");
    expect(validateDeploymentConfig({ ...VALID, controller_model: ControllerModel.PUBLISHER }).controller_model).toBe("publisher-controller-node-processor");
  });

  it("rejects missing retention", () => {
    const { retention: _omitted, ...withoutRetention } = VALID;
    expect(() => validateDeploymentConfig(withoutRetention)).toThrow();
  });

  it("rejects non-positive retention values", () => {
    expect(() => validateDeploymentConfig({ ...VALID, retention: { hot_days: 0, archive_months: 12 } })).toThrow();
    expect(() => validateDeploymentConfig({ ...VALID, retention: { hot_days: 90, archive_months: -1 } })).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => validateDeploymentConfig(null)).toThrow();
    expect(() => validateDeploymentConfig("config")).toThrow();
  });

  // v0.4 Bloque A (A3) — require_auth enforcement.
  it("defaults require_auth to true when absent (secure default)", () => {
    expect(validateDeploymentConfig(VALID).require_auth).toBe(true);
  });

  it("accepts require_auth: true", () => {
    expect(validateDeploymentConfig({ ...VALID, require_auth: true }).require_auth).toBe(true);
  });

  it("FAIL-CLOSED: rejects require_auth:false (no anonymous buyer path under token-only identity)", () => {
    expect(() => validateDeploymentConfig({ ...VALID, require_auth: false })).toThrow(/require_auth/);
  });

  it("rejects a non-boolean require_auth", () => {
    expect(() => validateDeploymentConfig({ ...VALID, require_auth: "yes" })).toThrow(/require_auth/);
  });
});

describe("DeploymentConfig — shipped dev config matches signed acts", () => {
  it("config/deployment.json loads and validates", () => {
    const cfg = loadDeploymentConfigFromFile();
    expect(cfg.dsr_contact).toBe("privacy@sibboventures.com"); // A2 SIGNED
    expect(cfg.retention).toEqual({ hot_days: 90, archive_months: 12 }); // A3 SIGNED
  });

  it("TEST_DEPLOYMENT_CONFIG mirrors the shipped dev config", () => {
    const cfg = loadDeploymentConfigFromFile();
    expect(TEST_DEPLOYMENT_CONFIG.dsr_contact).toBe(cfg.dsr_contact);
    expect(TEST_DEPLOYMENT_CONFIG.retention).toEqual(cfg.retention);
  });
});

// DRIFT-REPORT D4 — node_id_prefix is optional, but when present it becomes part of the
// public, RS256-signed node_id, so it is validated fail-closed rather than silently ignored.
describe("DeploymentConfig — node_id_prefix (D4)", () => {
  const VALID = {
    dsr_contact: "privacy@example.com",
    controller_model: "operator-controller",
    controller_name: "Test Operator",
    retention: { hot_days: 90, archive_months: 12 },
  };

  it("accepts a valid DNS-safe prefix", () => {
    expect(validateDeploymentConfig({ ...VALID, node_id_prefix: "telemadrid" }).node_id_prefix).toBe("telemadrid");
    expect(validateDeploymentConfig({ ...VALID, node_id_prefix: "rtv-3" }).node_id_prefix).toBe("rtv-3");
  });

  it("leaves node_id_prefix undefined when absent (backward compatible)", () => {
    expect(validateDeploymentConfig(VALID).node_id_prefix).toBeUndefined();
  });

  it.each([
    "Telemadrid", // uppercase
    "has space",
    "-lead", // leading hyphen
    "trail-", // trailing hyphen
    "under_score",
    "a".repeat(41), // too long
  ])("rejects invalid prefix %j — it must be safe for a signed public id", (bad) => {
    expect(() => validateDeploymentConfig({ ...VALID, node_id_prefix: bad })).toThrow(/node_id_prefix/);
  });

  it("rejects a non-string node_id_prefix", () => {
    expect(() => validateDeploymentConfig({ ...VALID, node_id_prefix: 42 })).toThrow(/node_id_prefix/);
  });
});
