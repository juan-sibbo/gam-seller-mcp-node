import { readFileSync } from "fs";
import { resolveConfigPath } from "./resolve.js";

// Per-deployment legal configuration — s6-consent-hardening-acts-2026-07-05.md (A2 + A3).
// Everything the GDPR analysis identified as a LEGAL VARIABLE (who is the controller,
// where DSR requests go, how long the ledger retains data) lives here, not in code.
// The same binary serves a Sibbo dev deployment and a publisher-controller deployment
// by swapping this file — no code change, no new governance act.

// Controller models — gdpr-analysis §Q2. Determines who answers DSR requests and
// which Art. 30 register variant applies (30.1 controller vs 30.2 processor).
export const ControllerModel = {
  // Operator (Sibbo) decides purposes and means — dev/demo posture.
  OPERATOR: "operator-controller",
  // Publisher is controller, node operator is processor under an Art. 28 DPA —
  // the recommended pilot posture (gdpr-analysis §Q2).
  PUBLISHER: "publisher-controller-node-processor",
} as const;

export type ControllerModel = (typeof ControllerModel)[keyof typeof ControllerModel];

// Retention values — SIGNED A3 (05/07/26): 90d hot / 12m archive.
// Head-hash anchors survive purge indefinitely (a hash without its ledger is not personal data).
export interface RetentionConfig {
  hot_days: number;
  archive_months: number;
}

export interface DeploymentConfig {
  dsr_contact: string;
  controller_model: ControllerModel;
  controller_name: string;
  retention: RetentionConfig;
  // v0.4 Bloque A: buyer surfaces require a valid buyer token; identity is derived from
  // token.sub (there is no anonymous path). Declarative posture — see validation below.
  require_auth: boolean;
}

const VALID_CONTROLLER_MODELS: ReadonlySet<string> = new Set(Object.values(ControllerModel));

// Fail-closed validation: a deployment with an invalid legal config must not start.
// A node serving buyers without a resolvable DSR contact would violate Art. 12 GDPR
// (facilitating the exercise of rights) — refusing to boot is the safe failure mode.
export function validateDeploymentConfig(raw: unknown): DeploymentConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("deployment config: not an object");
  }
  const cfg = raw as Record<string, unknown>;

  const dsrContact = cfg["dsr_contact"];
  if (typeof dsrContact !== "string" || dsrContact.trim() === "" || dsrContact.includes("[[")) {
    throw new Error("deployment config: dsr_contact must be a concrete contact (no placeholders)");
  }

  const controllerModel = cfg["controller_model"];
  if (typeof controllerModel !== "string" || !VALID_CONTROLLER_MODELS.has(controllerModel)) {
    throw new Error(`deployment config: controller_model must be one of ${[...VALID_CONTROLLER_MODELS].join(", ")}`);
  }

  const controllerName = cfg["controller_name"];
  if (typeof controllerName !== "string" || controllerName.trim() === "") {
    throw new Error("deployment config: controller_name required");
  }

  const retention = cfg["retention"] as Record<string, unknown> | undefined;
  const hotDays = retention?.["hot_days"];
  const archiveMonths = retention?.["archive_months"];
  if (typeof hotDays !== "number" || !Number.isInteger(hotDays) || hotDays <= 0) {
    throw new Error("deployment config: retention.hot_days must be a positive integer");
  }
  if (typeof archiveMonths !== "number" || !Number.isInteger(archiveMonths) || archiveMonths <= 0) {
    throw new Error("deployment config: retention.archive_months must be a positive integer");
  }

  // require_auth — v0.4 Bloque A. Defaults to true (secure default) when absent.
  // Fail-closed: require_auth:false is NOT supported. Buyer identity is derived from the
  // token's sub; with no token there is no anonymous identity to serve, so disabling auth
  // cannot open a usable path — it would only signal a dangerous misconfiguration. Refuse
  // to boot rather than pretend to honor it (same posture as a placeholder dsr_contact).
  const requireAuthRaw = cfg["require_auth"];
  if (requireAuthRaw !== undefined && typeof requireAuthRaw !== "boolean") {
    throw new Error("deployment config: require_auth must be a boolean");
  }
  const requireAuth = requireAuthRaw ?? true;
  if (requireAuth === false) {
    throw new Error(
      "deployment config: require_auth:false is not supported — buyer identity is derived from the token (no anonymous path). Remove the flag or set it to true."
    );
  }

  return {
    dsr_contact: dsrContact,
    controller_model: controllerModel as ControllerModel,
    controller_name: controllerName,
    retention: { hot_days: hotDays, archive_months: archiveMonths },
    require_auth: requireAuth,
  };
}

export function loadDeploymentConfigFromFile(configPath?: string): DeploymentConfig {
  const path = configPath ?? resolveConfigPath("deployment.json");
  const raw = readFileSync(path, "utf-8");
  return validateDeploymentConfig(JSON.parse(raw));
}

// Test fixture — mirrors the signed dev values (A2 + A3).
export const TEST_DEPLOYMENT_CONFIG: DeploymentConfig = {
  dsr_contact: "privacy@sibboventures.com",
  controller_model: ControllerModel.OPERATOR,
  controller_name: "Sibbo (dev/demo deployment)",
  retention: { hot_days: 90, archive_months: 12 },
  require_auth: true,
};
