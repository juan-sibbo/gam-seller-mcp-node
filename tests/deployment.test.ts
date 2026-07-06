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
