import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateEntitlementsConfig,
  loadEntitlementsFromFile,
  EntitlementStore,
} from "../src/policy/entitlements.js";

// C3 (Fase C) — entitlements loaded from config file, same fail-closed criterion as
// config/deployment.ts: an invalid config must prevent the node from starting.

describe("EntitlementsConfig — validation (fail-closed)", () => {
  const VALID = {
    entitlements: [
      {
        buyer_id: "pilot-buyer-001",
        surfaces: ["discovery", "well_known"],
        scopes: ["gam.readonly"],
        phase: "phase-1-readonly",
      },
    ],
  };

  it("accepts a valid config", () => {
    const cfg = validateEntitlementsConfig(VALID);
    expect(cfg.entitlements).toHaveLength(1);
    expect(cfg.entitlements[0].buyer_id).toBe("pilot-buyer-001");
  });

  it("accepts an explicitly empty entitlements list — a valid Default-Deny deployment state", () => {
    const cfg = validateEntitlementsConfig({ entitlements: [] });
    expect(cfg.entitlements).toEqual([]);
  });

  it("rejects an unknown surface", () => {
    expect(() =>
      validateEntitlementsConfig({
        entitlements: [{ ...VALID.entitlements[0], surfaces: ["not_a_real_surface"] }],
      })
    ).toThrow();
  });

  it("rejects an empty buyer_id", () => {
    expect(() =>
      validateEntitlementsConfig({
        entitlements: [{ ...VALID.entitlements[0], buyer_id: "  " }],
      })
    ).toThrow();
  });

  it("rejects empty scopes", () => {
    expect(() =>
      validateEntitlementsConfig({
        entitlements: [{ ...VALID.entitlements[0], scopes: [] }],
      })
    ).toThrow();
  });

  it("rejects a missing phase", () => {
    const { phase: _omitted, ...withoutPhase } = VALID.entitlements[0];
    expect(() => validateEntitlementsConfig({ entitlements: [withoutPhase] })).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => validateEntitlementsConfig(null)).toThrow();
    expect(() => validateEntitlementsConfig("config")).toThrow();
  });

  it("rejects entitlements that isn't an array", () => {
    expect(() => validateEntitlementsConfig({ entitlements: "nope" })).toThrow();
  });
});

describe("loadEntitlementsFromFile", () => {
  it("config/entitlements.json loads, validates, and feeds a working EntitlementStore", () => {
    const cfg = loadEntitlementsFromFile();
    const store = new EntitlementStore(cfg);
    expect(store.has("pilot-buyer-001")).toBe(true);
  });

  it("throws with a clear message when the file is missing", () => {
    const missingPath = join(tmpdir(), "does-not-exist-entitlements.json");
    expect(() => loadEntitlementsFromFile(missingPath)).toThrow();
  });

  it("throws on a malformed file on disk (fail-closed, not silent-default)", () => {
    const badPath = join(tmpdir(), `bad-entitlements-${Date.now()}.json`);
    writeFileSync(badPath, JSON.stringify({ entitlements: [{ buyer_id: "" }] }), "utf-8");
    try {
      expect(() => loadEntitlementsFromFile(badPath)).toThrow();
    } finally {
      unlinkSync(badPath);
    }
  });
});
